/**
 * Nachrichten anlegen, einzeln je Empfänger versenden (im Hintergrund) und den Verlauf lesen.
 *
 * Ablauf `createMessage`: Absender prüfen → Empfänger auflösen → Text bereinigen → Anhänge in den Speicher
 * legen → Nachricht + Empfänger in EINER Transaktion speichern → Audit → Versand starten. Der Versand
 * (`deliver`) holt Empfänger in kleinen Blöcken (atomar „beanspruchen“), sendet mit begrenzter
 * Parallelität und schreibt je Empfänger den Status. Hängengebliebene Läufe nimmt der Job `resume` wieder auf.
 * Core-Aufrufe (Speicher, Mail, Audit, Benutzer) immer außerhalb der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	errors,
	inList,
	moduleDb,
	rowsOf,
	safeFileName,
	toIso,
	userLabel,
	type RequestContext
} from '$lib/sdk/server';
import { htmlToText, plainDocument, sanitizeBody } from './html';
import { loadInboxConfig } from './inbound.service';
import { notifyReplied } from './inbox-notify.service';
import { forwardAttachments, loadInboxRow, sentViaAccessibleMailbox } from './inbox.service';
import { MESSAGE_ID_PATTERN, mailboxKeyForSender } from './mailbox';
import { resolveRecipients } from './recipients.service';
import { accountEmail, loadSettings, requireSender } from './sender.service';
import {
	ATTACHMENT_DAYS,
	MAX_BODY_HTML,
	MAX_FILES,
	MAX_TOTAL_BYTES,
	MODULE_ID,
	PERM_VIEW_ALL,
	RETENTION_DAYS,
	type MessageAttachmentInfo,
	type MessageDetail,
	type MessagePreview,
	type MessageRecipientInfo,
	type MessageStatus,
	type MessageSummary,
	type PreviewInput,
	type RecipientStatus,
	type SendInput
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);

/** Gleichzeitige Mails je Nachricht und Größe eines Blocks */
const CONCURRENCY = 3;
const BATCH = 9;
/** Pause zwischen zwei Gruppen paralleler Mails */
const SEND_PAUSE_MS = process.env.VITEST ? 0 : 250;
/** Beanspruchte, aber nie abgeschlossene Empfänger gelten nach so vielen Minuten als hängend */
const STALE_MINUTES = 10;

export interface UploadedAttachment {
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

const system = () => core.auth.systemContext('messages');

// --- Lesen ------------------------------------------------------------------------------------

function summaryOf(r: Record<string, unknown>, names: ReadonlyMap<string, { name: string }>) {
	const createdBy = r.created_by == null ? null : String(r.created_by);
	return {
		id: String(r.id),
		subject: String(r.subject),
		senderAddress: String(r.sender_address),
		senderName: r.sender_name == null ? null : String(r.sender_name),
		createdBy,
		createdByName: userLabel(names, createdBy),
		createdAt: toIso(r.created_at),
		status: String(r.status) as MessageStatus,
		total: Number(r.total),
		sent: Number(r.sent),
		failed: Number(r.failed),
		attachmentCount: Number(r.attachment_count ?? 0)
	} satisfies MessageSummary;
}

function canSeeAll(ctx: RequestContext): boolean {
	return core.permissions.has(ctx, PERM_VIEW_ALL);
}

export async function listMessages(
	ctx: RequestContext,
	opts: { limit: number; offset: number }
): Promise<{ items: MessageSummary[]; total: number }> {
	const own = canSeeAll(ctx) ? null : (ctx.userId ?? '');
	const where = own === null ? sql`TRUE` : sql`m.created_by = ${own}`;
	const { rows, total } = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT m.*, (SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS attachment_count
				FROM messages m WHERE ${where}
				ORDER BY m.created_at DESC, m.id LIMIT ${opts.limit} OFFSET ${opts.offset}`
		);
		const [t] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM messages m WHERE ${where}`);
		return { rows, total: Number(t?.n ?? 0) };
	});
	const names = await core.users.byIds(
		ctx,
		rows.map((r) => (r.created_by == null ? null : String(r.created_by)))
	);
	return { items: rows.map((r) => summaryOf(r, names)), total };
}

/** Nachricht mit Empfängern und Anhängen; fremde Nachricht ohne `view-all` → 404 */
export async function getMessage(ctx: RequestContext, id: string): Promise<MessageDetail> {
	const data = await mdb().transaction(async (tx) => {
		const [m] = await rowsOf(
			tx,
			sql`SELECT m.*, (SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS attachment_count
				FROM messages m WHERE m.id = ${id}`
		);
		if (!m) return null;
		const recipients = await rowsOf(
			tx,
			sql`SELECT id, name, address, status, error, sent_at FROM message_recipients
				WHERE message_id = ${id} ORDER BY name NULLS LAST, address`
		);
		const attachments = await rowsOf(
			tx,
			sql`SELECT id, filename, content_type, size, removed_at FROM message_attachments
				WHERE message_id = ${id} ORDER BY filename, id`
		);
		return { m, recipients, attachments };
	});
	if (!data) throw errors.notFound('Nachricht nicht gefunden');
	const owner = data.m.created_by == null ? null : String(data.m.created_by);
	if (!canSeeAll(ctx) && owner !== ctx.userId && !(await sentViaAccessibleMailbox(ctx, data.m))) {
		throw errors.notFound('Nachricht nicht gefunden');
	}
	const names = await core.users.byIds(ctx, [owner]);
	return {
		...summaryOf(data.m, names),
		bodyHtml: String(data.m.body_html),
		layout: data.m.layout === 'plain' ? 'plain' : 'stamm',
		replyTo: data.m.reply_to == null ? null : String(data.m.reply_to),
		replyOf: data.m.reply_of == null ? null : String(data.m.reply_of),
		forwardOf: data.m.forward_of == null ? null : String(data.m.forward_of),
		attachments: data.attachments.map((a): MessageAttachmentInfo => ({
			id: String(a.id),
			filename: String(a.filename),
			contentType: String(a.content_type),
			size: Number(a.size),
			removed: a.removed_at != null
		})),
		recipients: data.recipients.map((r): MessageRecipientInfo => ({
			id: String(r.id),
			name: r.name == null ? null : String(r.name),
			address: String(r.address),
			status: String(r.status) as RecipientStatus,
			error: r.error == null ? null : String(r.error),
			sentAt: r.sent_at == null ? null : toIso(r.sent_at)
		}))
	};
}

// --- Anlegen ------------------------------------------------------------------------------------

export async function createMessage(
	ctx: RequestContext,
	input: SendInput,
	files: UploadedAttachment[]
): Promise<MessageDetail> {
	const sender = await requireSender(ctx, input.senderKey);
	if (input.replyOf && input.forwardOf) {
		throw errors.validation([
			{ path: ['forwardOf'], message: 'Antwort oder Weiterleitung, nicht beides' }
		]);
	}
	if (input.forwardAttachmentIds.length && !input.forwardOf) {
		throw errors.validation([
			{ path: ['forwardAttachmentIds'], message: 'Anhänge nur beim Weiterleiten übernehmen' }
		]);
	}
	// Bezug aus dem Posteingang (404 ohne Zugriff auf dessen Postfach)
	const refId = input.replyOf ?? input.forwardOf ?? null;
	const ref = refId ? await loadInboxRow(ctx, refId) : null;
	const forwarded = input.forwardOf
		? await forwardAttachments(input.forwardOf, input.forwardAttachmentIds)
		: [];
	const allFiles = [...forwarded, ...files];
	if (allFiles.length > MAX_FILES) {
		throw errors.validation([{ path: ['files'], message: `Höchstens ${MAX_FILES} Anhänge` }]);
	}
	if (allFiles.reduce((sum, f) => sum + f.bytes.byteLength, 0) > MAX_TOTAL_BYTES) {
		throw errors.tooLarge('Die Anhänge sind zusammen zu groß (höchstens 20 MB).');
	}
	const resolved = await resolveRecipients(ctx, input);
	if (!resolved.recipients.length) {
		throw errors.validation([
			{ path: ['memberIds'], message: 'Es gibt keine Empfänger mit E-Mail-Adresse' }
		]);
	}
	if (resolved.recipients.length > resolved.maxRecipients) {
		throw errors.validation([
			{
				path: ['memberIds'],
				message: `Höchstens ${resolved.maxRecipients} Empfänger auf einmal (gewählt: ${resolved.recipients.length})`
			}
		]);
	}
	const bodyHtml = sanitizeBody(input.bodyHtml);
	const bodyText = htmlToText(bodyHtml);
	if (!bodyText) {
		throw errors.validation([{ path: ['bodyHtml'], message: 'Bitte einen Text eingeben' }]);
	}
	if (bodyHtml.length > MAX_BODY_HTML) {
		throw errors.validation([{ path: ['bodyHtml'], message: 'Der Text ist zu lang' }]);
	}
	const settings = await loadSettings();
	const layout = input.layout ?? settings.layout;
	// Mit Posteingang landen Antworten an der Absenderadresse im passenden Postfach
	const inboxOn = (await loadInboxConfig()).enabled;
	const replyTo =
		input.replyTo ??
		(inboxOn || settings.replyTo === 'sender' ? sender.address : await accountEmail(ctx));

	const id = crypto.randomUUID();
	const mailboxKey = mailboxKeyForSender(sender.key, ctx.userId);
	const threadId = ref ? String(ref.row.thread_id) : id;
	const refMessageId =
		ref?.row.message_id_header && MESSAGE_ID_PATTERN.test(String(ref.row.message_id_header))
			? String(ref.row.message_id_header)
			: null;
	const inReplyTo = input.replyOf ? refMessageId : null;
	const references = input.replyOf
		? [
				...String(ref?.row.references_list ?? '')
					.split(/\s+/)
					.filter((r) => MESSAGE_ID_PATTERN.test(r)),
				...(refMessageId ? [refMessageId] : [])
			].slice(-20)
		: [];
	// Anhänge erst ablegen, dann speichern; bei Fehler wieder entfernen
	const stored: { id: string; path: string; file: UploadedAttachment }[] = [];
	try {
		for (const file of allFiles) {
			const attId = crypto.randomUUID();
			const path = `messages/${id}/${attId}-${safeFileName(file.filename)}`;
			await core.storage.upload(system(), {
				module: MODULE_ID,
				path,
				file: file.bytes,
				contentType: file.contentType,
				name: file.filename
			});
			stored.push({ id: attId, path, file });
		}
		await mdb().transaction(async (tx) => {
			await tx.execute(
				sql`INSERT INTO messages (id, subject, body_html, body_text, sender_address, sender_name,
						reply_to, created_by, total, layout, mailbox_key, thread_id, reply_of, forward_of,
						in_reply_to, references_list)
					VALUES (${id}, ${input.subject}, ${bodyHtml}, ${bodyText}, ${sender.address}, ${sender.name},
						${replyTo}, ${ctx.userId ?? null}, ${resolved.recipients.length}, ${layout}, ${mailboxKey},
						${threadId}, ${input.replyOf ?? null}, ${input.forwardOf ?? null}, ${inReplyTo},
						${references.join(' ') || null})`
			);
			for (const r of resolved.recipients) {
				await tx.execute(
					sql`INSERT INTO message_recipients (id, message_id, address, member_id, name)
						VALUES (${crypto.randomUUID()}, ${id}, ${r.address}, ${r.memberId}, ${r.name})`
				);
			}
			for (const a of stored) {
				await tx.execute(
					sql`INSERT INTO message_attachments (id, message_id, filename, content_type, size, storage_path)
						VALUES (${a.id}, ${id}, ${a.file.filename}, ${a.file.contentType}, ${a.file.bytes.byteLength}, ${a.path})`
				);
			}
		});
	} catch (e) {
		await removeFiles(stored.map((a) => a.path));
		throw e;
	}
	await core.audit.logFromContext(ctx, 'messages.message.created', {
		target: id,
		metadata: {
			recipients: resolved.recipients.length,
			attachments: stored.length,
			...(input.replyOf ? { reply: true } : {}),
			...(input.forwardOf ? { forward: true } : {})
		}
	});
	startDelivery(ctx, id);
	if (ref && refId) {
		const original = ref.row;
		await notifyReplied(ctx, {
			inboxId: refId,
			mailboxKey: String(original.mailbox_key),
			kind: input.replyOf ? 'reply' : 'forward',
			originalSubject: String(original.subject ?? ''),
			originalFrom: original.from_name
				? `${String(original.from_name)} <${String(original.from_address)}>`
				: String(original.from_address),
			recipients: resolved.recipients.map((r) => r.address),
			text: bodyText
		});
	}
	return getMessage(ctx, id);
}

/**
 * Vorschau: dieselbe Bereinigung und dasselbe Layout wie beim Versand, aber nichts wird gespeichert
 * oder gesendet. Der Absender wird wie beim Senden geprüft (fremder Schlüssel → 403).
 */
export async function previewMessage(
	ctx: RequestContext,
	input: PreviewInput
): Promise<MessagePreview> {
	const sender = input.senderKey ? await requireSender(ctx, input.senderKey) : null;
	const layout = input.layout ?? (await loadSettings()).layout;
	const bodyHtml = sanitizeBody(input.bodyHtml);
	const plain = layout === 'plain';
	const html = await core.mail.preview({
		text: htmlToText(bodyHtml),
		html: plain ? plainDocument(bodyHtml) : bodyHtml,
		layout: !plain
	});
	return {
		html,
		subject: input.subject.trim(),
		from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address) : null
	};
}

/** Fehlgeschlagene Empfänger erneut versuchen (nur eigene Nachricht bzw. mit `view-all`) */
export async function retryMessage(ctx: RequestContext, id: string): Promise<MessageDetail> {
	const current = await getMessage(ctx, id); // 404 für Fremde
	if (current.status === 'sending') throw errors.conflict('Die Nachricht wird noch gesendet');
	if (!current.failed) throw errors.conflict('Es gibt keine fehlgeschlagenen Empfänger');
	if (current.attachments.some((a) => a.removed)) {
		throw errors.conflict('Die Anhänge sind nicht mehr verfügbar – bitte neu verfassen');
	}
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE message_recipients SET status = 'pending', error = NULL, updated_at = now()
				WHERE message_id = ${id} AND status = 'failed'`
		);
		await tx.execute(
			sql`UPDATE messages SET status = 'sending', completed_at = NULL WHERE id = ${id}`
		);
	});
	await core.audit.logFromContext(ctx, 'messages.message.retried', {
		target: id,
		metadata: { recipients: current.failed }
	});
	startDelivery(ctx, id);
	return getMessage(ctx, id);
}

// --- Versand -------------------------------------------------------------------------------------

const running = new Set<Promise<void>>();
const active = new Set<string>();

/** Startet den Versand im Hintergrund (je Nachricht höchstens ein Lauf in diesem Prozess) */
export function startDelivery(ctx: RequestContext, id: string): void {
	if (active.has(id)) return;
	active.add(id);
	const p = deliver(ctx, id)
		.catch((e) => console.error(`[messages] Versand ${id} abgebrochen:`, (e as Error)?.message))
		.finally(() => {
			active.delete(id);
			running.delete(p);
		});
	running.add(p);
}

/** Für Tests: wartet, bis alle laufenden Versandläufe fertig sind */
export async function deliveriesIdleForTests(): Promise<void> {
	while (running.size > 0) await Promise.allSettled([...running]);
}

interface Claimed {
	id: string;
	address: string;
}

async function claimBatch(messageId: string): Promise<Claimed[]> {
	return mdb().transaction(async (tx) => {
		const candidates = await rowsOf(
			tx,
			sql`SELECT id, address FROM message_recipients
				WHERE message_id = ${messageId} AND status = 'pending'
				ORDER BY id LIMIT ${BATCH}`
		);
		const claimed: Claimed[] = [];
		for (const c of candidates) {
			const got = await rowsOf(
				tx,
				sql`UPDATE message_recipients SET status = 'sending', attempts = attempts + 1, updated_at = now()
					WHERE id = ${String(c.id)} AND status = 'pending' RETURNING id`
			);
			if (got.length) claimed.push({ id: String(c.id), address: String(c.address) });
		}
		return claimed;
	});
}

async function markRecipient(
	id: string,
	ok: boolean,
	error?: string,
	messageId?: string | null
): Promise<void> {
	await mdb().transaction((tx) =>
		tx.execute(
			ok
				? sql`UPDATE message_recipients SET status = 'sent', error = NULL, sent_at = now(), updated_at = now(),
						message_id_header = ${messageId ?? null} WHERE id = ${id}`
				: sql`UPDATE message_recipients SET status = 'failed', error = ${error ?? 'Versand fehlgeschlagen'}, updated_at = now() WHERE id = ${id}`
		)
	);
}

/** Kurze, unkritische Fehlermeldung (keine Zugangsdaten, max. 200 Zeichen, eine Zeile) */
function errorText(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return raw.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Versand fehlgeschlagen';
}

async function deliver(ctx: RequestContext, id: string): Promise<void> {
	const loaded = await mdb().transaction(async (tx) => {
		const [m] = await rowsOf(tx, sql`SELECT * FROM messages WHERE id = ${id}`);
		const files = await rowsOf(
			tx,
			sql`SELECT filename, content_type, storage_path FROM message_attachments
				WHERE message_id = ${id} AND removed_at IS NULL ORDER BY id`
		);
		return { m, files };
	});
	const m = loaded.m;
	if (!m) return;
	const attachments: { filename: string; contentType: string; data: Uint8Array }[] = [];
	for (const f of loaded.files) {
		const data = await core.storage.download(system(), {
			module: MODULE_ID,
			path: String(f.storage_path)
		});
		attachments.push({
			filename: String(f.filename),
			contentType: String(f.content_type),
			data: data.buffer
		});
	}
	const plain = m.layout === 'plain';
	const org = await core.settings.getMany(['core.organization.email']);
	const unsubscribe =
		String(org['core.organization.email'] ?? '').trim() || String(m.reply_to ?? '');
	const base = {
		subject: String(m.subject),
		text: String(m.body_text),
		// Einfach: schlankes HTML ohne Layout/Bilder, nur Absätze, Listen und Links
		html: plain ? plainDocument(String(m.body_html)) : String(m.body_html),
		layout: !plain,
		...(unsubscribe ? { unsubscribe } : {}),
		from: String(m.sender_address),
		...(m.sender_name ? { fromName: String(m.sender_name) } : {}),
		...(m.reply_to ? { replyTo: String(m.reply_to) } : {}),
		...(attachments.length ? { attachments } : {}),
		...(m.in_reply_to ? { inReplyTo: String(m.in_reply_to) } : {}),
		...(m.references_list
			? { references: String(m.references_list).split(/\s+/).filter(Boolean) }
			: {})
	};
	// Eigene Message-ID je Empfänger (Domain der Absenderadresse): Antworten lassen sich so zuordnen
	const domain = String(m.sender_address).split('@').pop() || 'localhost';

	for (;;) {
		const batch = await claimBatch(id);
		if (!batch.length) break;
		for (let i = 0; i < batch.length; i += CONCURRENCY) {
			// kleine Pause zwischen den Mails, damit Mailserver-Limits und Spam-Filter nicht anschlagen
			if (i > 0) await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));
			await Promise.all(
				batch.slice(i, i + CONCURRENCY).map(async (r) => {
					try {
						const messageId = `<${crypto.randomUUID()}@${domain}>`;
						const result = await core.mail.sendMessage({ ...base, to: r.address, messageId });
						await markRecipient(r.id, true, undefined, result.messageId ?? messageId);
					} catch (e) {
						await markRecipient(r.id, false, errorText(e));
					}
				})
			);
		}
	}
	const result = await finalize(id);
	await core.audit.logFromContext(ctx, 'messages.message.sent', {
		target: id,
		metadata: { sent: result.sent, failed: result.failed }
	});
}

/** Zähler und Status der Nachricht aus den Empfängern neu berechnen */
async function finalize(
	id: string
): Promise<{ sent: number; failed: number; status: MessageStatus }> {
	return mdb().transaction(async (tx) => {
		const [c] = await rowsOf(
			tx,
			sql`SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
					count(*) FILTER (WHERE status = 'failed')::int AS failed,
					count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS open
				FROM message_recipients WHERE message_id = ${id}`
		);
		const sent = Number(c?.sent ?? 0);
		const failed = Number(c?.failed ?? 0);
		const open = Number(c?.open ?? 0);
		const status: MessageStatus =
			open > 0 ? 'sending' : failed === 0 ? 'done' : sent === 0 ? 'failed' : 'partial';
		await tx.execute(
			sql`UPDATE messages SET sent = ${sent}, failed = ${failed}, status = ${status},
					completed_at = ${open > 0 ? null : sql`now()`} WHERE id = ${id}`
		);
		return { sent, failed, status };
	});
}

// --- Jobs ---------------------------------------------------------------------------------------

/** Hängende Versandläufe wieder aufnehmen (z. B. nach Neustart des Servers) */
export async function resumeDeliveries(ctx: RequestContext): Promise<string> {
	const ids = await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE message_recipients SET status = 'pending', updated_at = now()
				WHERE status = 'sending' AND updated_at < now() - make_interval(mins => ${STALE_MINUTES})`
		);
		const rows = await rowsOf(
			tx,
			sql`SELECT DISTINCT m.id FROM messages m JOIN message_recipients r ON r.message_id = m.id
				WHERE m.status = 'sending' AND r.status = 'pending'`
		);
		return rows.map((r) => String(r.id));
	});
	for (const id of ids) startDelivery(ctx, id);
	return ids.length ? `${ids.length} Nachrichten fortgesetzt` : 'nichts zu tun';
}

async function removeFiles(paths: string[]): Promise<void> {
	if (!paths.length) return;
	await bestEffort('messages.remove-files', () =>
		core.storage.removeMany(system(), { module: MODULE_ID, paths })
	);
}

/** Aufbewahrung: Anhänge nach `ATTACHMENT_DAYS` Tagen, Nachrichten nach `RETENTION_DAYS` Tagen löschen */
export async function cleanup(): Promise<string> {
	const old = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT a.id, a.storage_path FROM message_attachments a JOIN messages m ON m.id = a.message_id
				WHERE a.removed_at IS NULL AND m.status <> 'sending'
					AND m.created_at < now() - make_interval(days => ${ATTACHMENT_DAYS})`
		)
	);
	await removeFiles(old.map((a) => String(a.storage_path)));
	if (old.length) {
		await mdb().transaction((tx) =>
			tx.execute(
				sql`UPDATE message_attachments SET removed_at = now() WHERE id IN (${inList(old.map((a) => String(a.id)))})`
			)
		);
	}
	const expired = await mdb().transaction(async (tx) => {
		const leftovers = await rowsOf(
			tx,
			sql`SELECT a.storage_path FROM message_attachments a JOIN messages m ON m.id = a.message_id
				WHERE a.removed_at IS NULL AND m.created_at < now() - make_interval(days => ${RETENTION_DAYS})`
		);
		const gone = await rowsOf(
			tx,
			sql`DELETE FROM messages WHERE status <> 'sending'
				AND created_at < now() - make_interval(days => ${RETENTION_DAYS}) RETURNING id`
		);
		return { gone: gone.length, paths: leftovers.map((a) => String(a.storage_path)) };
	});
	await removeFiles(expired.paths);
	return `${old.length} Anhänge, ${expired.gone} Nachrichten entfernt`;
}
