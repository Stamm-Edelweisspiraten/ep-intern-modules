/**
 * Abruf des Catch-all-Postfachs (IMAP) und Ablage im Posteingang.
 *
 * Ablauf je Lauf (`pollInbox`, Job `inbox-poll` jede Minute oder „Jetzt abrufen“):
 * 1. Postfach-Verzeichnis laden (persönliche, Amts-, Gruppen-, Stamm-Adressen) und Adressindex bauen.
 * 2. Bis zu `INBOX_FETCH_LIMIT` Mails aus dem Eingangsordner lesen.
 * 3. Je Mail: parsen → eigene Benachrichtigungen überspringen → Empfänger zuordnen (`Delivered-To` & Co.
 *    zuerst, dann An/Cc) → je Postfach eine Zeile (ohne Treffer: „Nicht zugeordnet“) → Doppelimport über
 *    (Postfach, Message-ID bzw. Hash) ausschließen → Anhänge in den Speicher → EINE Transaktion.
 * 4. Erst danach werden die erfolgreich gespeicherten Mails im IMAP-Postfach in den Ablageordner verschoben;
 *    bricht der Lauf vorher ab, verhindert der Doppelimport-Schutz Duplikate beim nächsten Lauf.
 * 5. Benachrichtigungen (`inbox-notify.service.ts`) und Audit (nur Zähler).
 * Core-Aufrufe nie innerhalb einer Modul-Transaktion (PGlite).
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	errors,
	inList,
	moduleDb,
	rowsOf,
	safeFileName,
	type RequestContext
} from '$lib/sdk/server';
import { htmlToText, sanitizeInbound, textToHtml } from './html';
import { openImap, type ImapConfig, type ImapMessage } from './imap.client';
import { parseInbound, type ParsedInbound } from './inbound-parse';
import { notifyNewMail } from './inbox-notify.service';
import { UNASSIGNED, buildAddressIndex, routeAddresses } from './mailbox';
import { loadMailboxDirectory, type MailboxEntry } from './mailbox.service';
import { isValidDomain } from './sender';
import { evaluateSpam, loadSpamEnvironment, type SpamEnvironment } from './spam.service';
import { loadSettings } from './sender.service';
import {
	INBOX_FETCH_LIMIT,
	INBOX_MAX_BYTES,
	INBOX_SETTING_KEYS,
	INBOX_SPAM_DAYS,
	INBOX_TRASH_DAYS,
	MODULE_ID,
	UNASSIGNED_DAYS,
	type PollResult
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const system = () => core.auth.systemContext(MODULE_ID);

export interface InboxConfig extends ImapConfig {
	enabled: boolean;
	retentionDays: number;
}

export async function loadInboxConfig(): Promise<InboxConfig> {
	const s = await core.settings.getMany(Object.values(INBOX_SETTING_KEYS));
	const port = Number(s[INBOX_SETTING_KEYS.port]);
	const days = Number(s[INBOX_SETTING_KEYS.retentionDays]);
	return {
		enabled: s[INBOX_SETTING_KEYS.enabled] === true,
		host: String(s[INBOX_SETTING_KEYS.host] ?? '').trim(),
		port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 993,
		secure: s[INBOX_SETTING_KEYS.secure] !== false,
		user: String(s[INBOX_SETTING_KEYS.user] ?? '').trim(),
		password: String(s[INBOX_SETTING_KEYS.password] ?? ''),
		folder: String(s[INBOX_SETTING_KEYS.folder] ?? '').trim() || 'INBOX',
		processedFolder: String(s[INBOX_SETTING_KEYS.processedFolder] ?? '').trim() || 'Importiert',
		retentionDays: Number.isInteger(days) && days >= 30 ? days : 365
	};
}

/** Fehlende Angaben für den Abruf (leer = vollständig) */
function missingConfig(cfg: InboxConfig): string | null {
	if (!cfg.host || !cfg.user || !cfg.password) {
		return 'IMAP-Server, Benutzer und Passwort fehlen in den Einstellungen des Moduls Nachrichten.';
	}
	return null;
}

/** Eingefügte Zeile (für Benachrichtigungen) */
export interface ImportedMail {
	id: string;
	mailboxKey: string;
	mailboxName: string;
	mailboxAddress: string;
	from: { address: string; name: string | null };
	subject: string;
	text: string;
	notify: boolean;
}

interface Directory {
	entries: MailboxEntry[];
	index: ReturnType<typeof buildAddressIndex>;
	ownDomains: Set<string>;
}

async function loadDirectory(): Promise<Directory> {
	const entries = await loadMailboxDirectory();
	const settings = await loadSettings();
	const ownDomains = new Set(entries.map((e) => e.address.split('@').pop() ?? ''));
	if (isValidDomain(settings.domain)) ownDomains.add(settings.domain);
	return { entries, index: buildAddressIndex(entries), ownDomains };
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Thread der Mail: über In-Reply-To/References im selben Postfach oder in gesendeten Nachrichten */
async function findThread(mailboxKey: string, parsed: ParsedInbound): Promise<string | null> {
	const refs = [parsed.inReplyTo, ...[...parsed.references].reverse()].filter(
		(r): r is string => !!r
	);
	if (!refs.length) return null;
	return mdb().transaction(async (tx) => {
		const [inbound] = await rowsOf(
			tx,
			sql`SELECT thread_id FROM inbox_messages
				WHERE mailbox_key = ${mailboxKey} AND message_id_header IN (${inList(refs)})
				ORDER BY received_at DESC LIMIT 1`
		);
		if (inbound) return String(inbound.thread_id);
		const [sent] = await rowsOf(
			tx,
			sql`SELECT COALESCE(m.thread_id, m.id) AS thread_id FROM message_recipients r
				JOIN messages m ON m.id = r.message_id
				WHERE r.message_id_header IN (${inList(refs)})
				ORDER BY m.created_at DESC LIMIT 1`
		);
		return sent ? String(sent.thread_id) : null;
	});
}

interface StoredAttachment {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	contentId: string | null;
	inline: boolean;
	path: string;
}

/** Anhänge ablegen; nicht erlaubte Dateitypen werden nur vermerkt */
async function storeAttachments(
	rowId: string,
	parsed: ParsedInbound
): Promise<{ stored: StoredAttachment[]; skipped: StoredAttachment[] }> {
	const stored: StoredAttachment[] = [];
	const skipped: StoredAttachment[] = [];
	for (const a of parsed.attachments) {
		const id = crypto.randomUUID();
		const path = `inbox/${rowId}/${id}-${safeFileName(a.filename, { fallback: 'anhang' })}`;
		const entry = {
			id,
			filename: a.filename,
			contentType: a.contentType,
			size: a.size,
			contentId: a.contentId,
			inline: a.inline,
			path
		};
		try {
			await core.storage.upload(system(), {
				module: MODULE_ID,
				path,
				file: a.content,
				contentType: a.contentType,
				name: a.filename
			});
			stored.push(entry);
		} catch (e) {
			// Speicher nicht eingerichtet → ganze Mail später erneut versuchen
			if ((e as { status?: number })?.status === 503) throw e;
			skipped.push(entry);
		}
	}
	return { stored, skipped };
}

async function removePaths(paths: string[]): Promise<void> {
	if (!paths.length) return;
	await bestEffort('messages.inbox.remove-files', () =>
		core.storage.removeMany(system(), { module: MODULE_ID, paths })
	);
}

/** Eine Mail importieren: `true` = erledigt (verschieben), `false` = übersprungen (auch verschieben) */
async function importOne(
	msg: ImapMessage,
	dir: Directory,
	spamEnv: SpamEnvironment,
	imported: ImportedMail[]
): Promise<'imported' | 'skipped'> {
	const parsed = await parseInbound(msg.source);
	if (parsed.ownNotification) return 'skipped';
	const verdict = await evaluateSpam(spamEnv, parsed);
	const candidates = [
		...parsed.envelopeTo,
		...parsed.to.map((a) => a.address),
		...parsed.cc.map((a) => a.address)
	];
	const route = routeAddresses(candidates, dir.index, dir.ownDomains);
	const targets: { key: string; name: string; address: string }[] = route.targets.map((t) => ({
		key: t.mailbox.key,
		name: t.mailbox.name,
		address: t.address
	}));
	if (route.unassigned) {
		targets.push({ key: UNASSIGNED, name: 'Nicht zugeordnet', address: route.unassigned.address });
	}
	const dedupeKey = parsed.messageId ?? `sha256:${sha256(msg.source)}`;
	const sanitized = parsed.html ? sanitizeInbound(parsed.html) : { html: '', blockedImages: 0 };
	const bodyHtml = sanitized.html || textToHtml(parsed.text);
	let bodyText = (parsed.text || htmlToText(sanitized.html)).trim();
	if (msg.truncated) {
		const mb = Math.ceil(msg.size / 1024 / 1024);
		bodyText = `[Die Nachricht ist zu groß (${mb} MB) und wurde nur teilweise übernommen; Anhänge fehlen. Sie liegt vollständig im Ablageordner des Postfachs.]\n\n${bodyText}`;
	}
	const from = parsed.from ?? { address: 'unbekannt@invalid', name: null };
	const receivedAt = (parsed.date ?? new Date()).toISOString();

	for (const target of targets) {
		const exists = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT 1 FROM inbox_messages WHERE mailbox_key = ${target.key} AND dedupe_key = ${dedupeKey}`
			)
		);
		if (exists.length) continue;
		const id = crypto.randomUUID();
		const threadId = (await findThread(target.key, parsed)) ?? id;
		const files = msg.truncated ? { stored: [], skipped: [] } : await storeAttachments(id, parsed);
		let inserted: boolean;
		try {
			inserted = await mdb().transaction(async (tx) => {
				const rows = await rowsOf(
					tx,
					sql`INSERT INTO inbox_messages (id, mailbox_key, mailbox_address, dedupe_key, message_id_header,
							in_reply_to, references_list, thread_id, from_address, from_name, reply_to, to_list, cc_list,
							subject, body_html, body_text, received_at, size, spam, auto_submitted, auth_result,
							unassigned_reason, truncated, skipped_attachments, blocked_images,
							spam_score, spam_reasons, spam_source)
						VALUES (${id}, ${target.key}, ${target.address}, ${dedupeKey}, ${parsed.messageId},
							${parsed.inReplyTo}, ${parsed.references.join(' ') || null}, ${threadId},
							${from.address}, ${from.name}, ${parsed.replyTo},
							${JSON.stringify(parsed.to)}::jsonb, ${JSON.stringify(parsed.cc)}::jsonb,
							${parsed.subject}, ${bodyHtml}, ${bodyText}, ${receivedAt}::timestamptz, ${msg.size},
							${verdict.spam}, ${parsed.autoSubmitted}, ${parsed.authResult},
							${target.key === UNASSIGNED ? (route.unassigned?.reason ?? 'unknown') : null},
							${msg.truncated},
							${JSON.stringify(files.skipped.map((s) => ({ filename: s.filename, contentType: s.contentType, size: s.size })))}::jsonb,
							${sanitized.blockedImages},
							${verdict.score}, ${JSON.stringify(verdict.reasons)}::jsonb, ${verdict.source})
						ON CONFLICT (mailbox_key, dedupe_key) DO NOTHING
						RETURNING id`
				);
				if (!rows.length) return false;
				for (const a of files.stored) {
					await tx.execute(
						sql`INSERT INTO inbox_attachments (id, inbox_message_id, filename, content_type, size,
								content_id, inline, storage_path)
							VALUES (${a.id}, ${id}, ${a.filename}, ${a.contentType}, ${a.size}, ${a.contentId},
								${a.inline}, ${a.path})`
					);
				}
				return true;
			});
		} catch (e) {
			await removePaths(files.stored.map((a) => a.path));
			throw e;
		}
		if (!inserted) {
			await removePaths(files.stored.map((a) => a.path));
			continue;
		}
		imported.push({
			id,
			mailboxKey: target.key,
			mailboxName: target.name,
			mailboxAddress: target.address,
			from,
			subject: parsed.subject,
			text: bodyText,
			notify: !verdict.spam && !parsed.autoSubmitted
		});
	}
	return 'imported';
}

let current: Promise<PollResult> | null = null;

/**
 * Ein Abruf. Läuft je Prozess höchstens einmal gleichzeitig (Job und „Jetzt abrufen“ teilen sich den Lauf).
 * Wirft bei Verbindungsfehlern (Job meldet Fehler, Endpunkt 503).
 */
export function pollInbox(ctx: RequestContext): Promise<PollResult> {
	if (!current) {
		current = runPoll(ctx)
			.then(async (r) => {
				await savePollState('ok', r.message);
				return r;
			})
			.catch(async (e: unknown) => {
				await savePollState('error', shortError(e));
				throw e;
			})
			.finally(() => {
				current = null;
			});
	}
	return current;
}

/** Letzten Abruf merken (Anzeige im Posteingang für die Verwaltung) */
async function savePollState(status: 'ok' | 'error', message: string): Promise<void> {
	await bestEffort('messages.inbox.poll-state', () =>
		mdb().transaction((tx) =>
			tx.execute(
				sql`INSERT INTO inbox_poll_state (id, last_at, status, message) VALUES (1, now(), ${status}, ${message})
					ON CONFLICT (id) DO UPDATE SET last_at = now(), status = excluded.status, message = excluded.message`
			)
		)
	);
}

async function runPoll(ctx: RequestContext): Promise<PollResult> {
	const cfg = await loadInboxConfig();
	if (!cfg.enabled) {
		return { imported: 0, skipped: 0, failed: 0, message: 'Posteingang ist ausgeschaltet' };
	}
	const missing = missingConfig(cfg);
	if (missing) throw errors.unavailable(missing);
	const dir = await loadDirectory();
	let session;
	try {
		session = await openImap(cfg);
	} catch (e) {
		throw errors.unavailable(`IMAP-Verbindung fehlgeschlagen: ${shortError(e)}`);
	}
	const imported: ImportedMail[] = [];
	let skipped = 0;
	let failed = 0;
	let mails = 0;
	try {
		const messages = await session.fetch(INBOX_FETCH_LIMIT, INBOX_MAX_BYTES);
		const done: number[] = [];
		// Listen und bekannte Absender nur laden, wenn es etwas zu bewerten gibt (der Job läuft jede Minute)
		const spamEnv = messages.length ? await loadSpamEnvironment(dir.ownDomains) : null;
		for (const msg of messages) {
			try {
				const result = await importOne(msg, dir, spamEnv!, imported);
				if (result === 'skipped') skipped++;
				else mails++;
				done.push(msg.uid);
			} catch (e) {
				failed++;
				console.error(`[messages] Mail ${msg.uid} nicht übernommen:`, shortError(e));
			}
		}
		await session.move(done);
	} finally {
		await session.close().catch(() => undefined);
	}
	if (imported.length) await notifyNewMail(imported, dir.entries);
	if (mails || failed) {
		await core.audit.logFromContext(ctx, 'messages.inbox.received', {
			metadata: { mails, rows: imported.length, skipped, failed }
		});
	}
	return {
		imported: mails,
		skipped,
		failed,
		message: `${mails} Mails übernommen${skipped ? `, ${skipped} übersprungen` : ''}${failed ? `, ${failed} fehlgeschlagen` : ''}`
	};
}

/** Verbindung prüfen (Anmeldung + Ordner öffnen), ohne etwas zu verändern */
export async function testConnection(): Promise<{ ok: true; message: string }> {
	const cfg = await loadInboxConfig();
	const missing = missingConfig(cfg);
	if (missing) throw errors.validation([{ path: ['host'], message: missing }], missing);
	let session;
	try {
		session = await openImap(cfg);
	} catch (e) {
		throw errors.unavailable(`IMAP-Verbindung fehlgeschlagen: ${shortError(e)}`);
	}
	await session.close().catch(() => undefined);
	return {
		ok: true,
		message: `Verbindung zu ${cfg.host} hergestellt, Ordner „${cfg.folder}“ geöffnet.`
	};
}

/**
 * Aufbewahrung im Posteingang (Job `cleanup`): Papierkorb nach `INBOX_TRASH_DAYS`, Spam nach
 * `INBOX_SPAM_DAYS` (ab Import bzw. Markierung), „Nicht zugeordnet“
 * nach `UNASSIGNED_DAYS`, alles nach `messages.inbox.retentionDays` Tagen löschen (inkl. Anhänge).
 */
export async function cleanupInbox(): Promise<string> {
	const { retentionDays } = await loadInboxConfig();
	const expired = sql`(i.deleted_at IS NOT NULL AND i.deleted_at < now() - make_interval(days => ${INBOX_TRASH_DAYS}))
		OR (i.spam AND i.deleted_at IS NULL AND COALESCE(i.spam_marked_at, i.imported_at) < now() - make_interval(days => ${INBOX_SPAM_DAYS}))
		OR (i.mailbox_key = ${UNASSIGNED} AND i.imported_at < now() - make_interval(days => ${UNASSIGNED_DAYS}))
		OR i.received_at < now() - make_interval(days => ${retentionDays})`;
	const result = await mdb().transaction(async (tx) => {
		const files = await rowsOf(
			tx,
			sql`SELECT a.storage_path FROM inbox_attachments a JOIN inbox_messages i ON i.id = a.inbox_message_id
				WHERE ${expired}`
		);
		const gone = await rowsOf(
			tx,
			sql`DELETE FROM inbox_messages i WHERE ${expired} RETURNING i.id`
		);
		return { paths: files.map((f) => String(f.storage_path)), gone: gone.length };
	});
	await removePaths(result.paths);
	return `${result.gone} Mails im Posteingang entfernt`;
}

/** Kurze Fehlermeldung ohne Zugangsdaten */
function shortError(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return raw.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unbekannter Fehler';
}
