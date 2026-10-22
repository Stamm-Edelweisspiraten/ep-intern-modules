/**
 * Benachrichtigungen an Inhaber*innen von Vorlagen-Ämtern (`OfficesService.notify`) und die
 * Tageszusammenfassung (Job `notify-digest`). Mails gehen an die **Konto-Adresse**; Modus je Person
 * und Ereignis aus `notification_prefs` (Standard „sofort“). Core-Aufrufe (Verzeichnis, Mail, Audit)
 * immer außerhalb der Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import { core, type RequestContext } from '$lib/sdk/server';
import type {
	NotifyResult,
	OfficeMailbox,
	OfficeNotification,
	OfficesService,
	OwnOfficeEmails
} from './contract';
import { inList, mdb, rowsOf, textOrNull, usersByIds, type DirectoryUserInfo } from './load';
import { DEFAULT_NOTIFY_MODE, NOTIFY_MODES, type NotifyMode } from './schemas';
import { registeredTemplates } from './templates';

export const MAX_SUBJECT = 150;
export const MAX_TEXT = 4000;
/** Höchstzahl Ereignisse je Aufruf (Schutz vor Riesenmails) */
const MAX_ITEMS = 200;
/** Warteschlange: Höchstalter eines Eintrags (Tage) und Höchstzahl fehlgeschlagener Versuche */
export const QUEUE_MAX_AGE_DAYS = 14;
export const QUEUE_MAX_ATTEMPTS = 5;
const KEY = /^[a-z][a-z0-9-]*$/;

interface CleanItem {
	module: string;
	office: string;
	event: string;
	subject: string;
	text: string;
	link: string | null;
}

/** Ereignis für eine Mail (aus einem Aufruf oder aus der Warteschlange) */
interface MailEvent {
	officeName: string;
	subject: string;
	text: string;
	link: string | null;
}

function oneLine(v: unknown, max: number): string {
	return String(v ?? '')
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

/** Nur relative App-Pfade (`/…`, nicht `//…`) werden zur absoluten URL */
function cleanLink(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const link = v.trim();
	if (!link.startsWith('/') || link.startsWith('//') || link.includes('\\')) return null;
	if (/[\s<>"]/.test(link) || link.length > 500) return null;
	return link;
}

function clean(item: OfficeNotification): CleanItem | null {
	if (!item || typeof item !== 'object') return null;
	const { module, office, event } = item;
	if (![module, office, event].every((k) => typeof k === 'string' && KEY.test(k))) return null;
	const subject = oneLine(item.subject, MAX_SUBJECT);
	if (!subject) return null;
	return {
		module,
		office,
		event,
		subject,
		text: String(item.text ?? '')
			.replace(/\r\n?/g, '\n')
			.trim()
			.slice(0, MAX_TEXT),
		link: cleanLink(item.link)
	};
}

function absolute(link: string | null): string | null {
	if (!link) return null;
	try {
		return `${core.app.origin()}${link}`;
	} catch {
		return null;
	}
}

function profileUrl(): string | null {
	return absolute('/profile');
}

/** Mail mit einem oder mehreren Ereignissen, nach Amt gruppiert */
export function composeMail(
	name: string,
	events: MailEvent[],
	kind: 'immediate' | 'daily'
): { subject: string; text: string } {
	const offices = [...new Set(events.map((e) => e.officeName))];
	let subject: string;
	if (kind === 'daily') {
		subject = `Tageszusammenfassung: ${events.length} ${events.length === 1 ? 'Hinweis' : 'Hinweise'}`;
	} else if (events.length === 1) {
		subject = events[0]!.subject;
	} else if (offices.length === 1) {
		subject = `${events.length} neue Hinweise für das Amt ${offices[0]}`;
	} else {
		subject = `${events.length} neue Hinweise für deine Ämter`;
	}
	subject = oneLine(subject, 200);

	const parts: string[] = [`Hallo ${name},`];
	parts.push(
		kind === 'daily'
			? 'hier ist die Zusammenfassung der Hinweise für deine Ämter:'
			: offices.length === 1
				? `es gibt Neuigkeiten für das Amt „${offices[0]}“:`
				: 'es gibt Neuigkeiten für deine Ämter:'
	);
	for (const office of offices) {
		const list = events.filter((e) => e.officeName === office);
		if (offices.length > 1 || kind === 'daily') parts.push(`Amt „${office}“`);
		for (const e of list) {
			const lines = [e.subject];
			if (e.text) lines.push(e.text);
			const url = absolute(e.link);
			if (url) lines.push(url);
			parts.push(lines.join('\n'));
		}
	}
	const settings = profileUrl();
	parts.push(
		`Du erhältst diese Mail als Inhaber*in eines Amts. Ob und wann du Benachrichtigungen bekommst ` +
			`(sofort, täglich oder gar nicht), stellst du in deinem Profil ein${settings ? `: ${settings}` : '.'}`
	);
	return { subject, text: parts.join('\n\n') };
}

async function sendTo(user: DirectoryUserInfo, mail: { subject: string; text: string }) {
	try {
		await core.mail.send({ to: user.email, ...mail });
		return true;
	} catch (e) {
		console.warn('[offices] Mailversand fehlgeschlagen:', e instanceof Error ? e.message : e);
		return false;
	}
}

const lookupCtx = () => core.auth.systemContext('offices');

interface Target {
	officeId: string;
	officeName: string;
	module: string;
	key: string;
	holders: string[];
	/** `userId|event` → Modus (nur Abweichungen) */
	prefs: Map<string, NotifyMode>;
}

/** Siehe `OfficesService.notify` – wirft nie */
export async function notify(
	ctx: RequestContext,
	items: OfficeNotification[]
): Promise<NotifyResult> {
	const result: NotifyResult = { sent: 0, queued: 0, skipped: 0 };
	try {
		const list = Array.isArray(items) ? items : [];
		if (list.length > MAX_ITEMS) {
			console.warn(
				`[offices] notify: ${list.length - MAX_ITEMS} Ereignisse verworfen (max. ${MAX_ITEMS})`
			);
			result.skipped += list.length - MAX_ITEMS;
		}
		const templates = registeredTemplates();
		const valid: CleanItem[] = [];
		for (const raw of list.slice(0, MAX_ITEMS)) {
			const item = clean(raw);
			const template = item && templates.get(item.module)?.templates.get(item.office);
			if (!item || !template?.notifications.some((n) => n.key === item.event)) {
				console.warn(
					'[offices] notify: unbekanntes oder ungültiges Ereignis übersprungen:',
					raw && typeof raw === 'object'
						? `${String(raw.module)}.${String(raw.office)}.${String(raw.event)}`
						: typeof raw
				);
				result.skipped++;
				continue;
			}
			valid.push(item);
		}
		if (valid.length === 0) return result;

		// 1) Ämter, Inhaber*innen und Einstellungen lesen
		const groups = [...new Set(valid.map((i) => `${i.module}:${i.office}`))];
		const targets = await mdb().transaction(async (tx) => {
			const map = new Map<string, Target>();
			for (const g of groups) {
				const [module, key] = g.split(':') as [string, string];
				const [office] = await rowsOf(
					tx,
					sql`SELECT id, name FROM offices WHERE source_module = ${module} AND source_key = ${key}`
				);
				if (!office) continue;
				const holders = (
					await rowsOf(
						tx,
						sql`SELECT user_id FROM office_holders WHERE office_id = ${String(office.id)}
							ORDER BY position, user_id`
					)
				).map((r) => String(r.user_id));
				const prefs = new Map<string, NotifyMode>();
				if (holders.length) {
					const rows = await rowsOf(
						tx,
						sql`SELECT user_id, event_key, mode FROM notification_prefs
							WHERE module_id = ${module} AND office_key = ${key}
								AND user_id IN (${inList(holders)})`
					);
					for (const r of rows) {
						const mode = String(r.mode) as NotifyMode;
						if (NOTIFY_MODES.includes(mode)) {
							prefs.set(`${String(r.user_id)}|${String(r.event_key)}`, mode);
						}
					}
				}
				map.set(g, {
					officeId: String(office.id),
					officeName: String(office.name),
					module,
					key,
					holders,
					prefs
				});
			}
			return map;
		});

		// 2) Aktive Konten (Konto-Adresse) – außerhalb der Transaktion
		const allHolders = [...new Set([...targets.values()].flatMap((t) => t.holders))];
		const users = allHolders.length ? await usersByIds(lookupCtx(), allHolders) : new Map();

		// 3) Je Ereignis und Person den Modus bestimmen
		const immediate = new Map<string, MailEvent[]>();
		const queue: { userId: string; item: CleanItem }[] = [];
		const offices = new Set<string>();
		for (const item of valid) {
			const t = targets.get(`${item.module}:${item.office}`);
			if (!t || t.holders.length === 0) {
				result.skipped++;
				continue;
			}
			offices.add(t.officeId);
			for (const userId of t.holders) {
				const mode = t.prefs.get(`${userId}|${item.event}`) ?? DEFAULT_NOTIFY_MODE;
				if (mode === 'off' || !users.has(userId)) {
					result.skipped++;
				} else if (mode === 'daily') {
					queue.push({ userId, item });
				} else {
					const ev = { officeName: t.officeName, ...item };
					const list = immediate.get(userId);
					if (list) list.push(ev);
					else immediate.set(userId, [ev]);
				}
			}
		}

		// 4) Tageszusammenfassung vormerken
		if (queue.length) {
			try {
				await mdb().transaction(async (tx) => {
					for (const { userId, item } of queue) {
						await tx.execute(
							sql`INSERT INTO notification_queue
								(id, user_id, module_id, office_key, event_key, subject, text, link)
								VALUES (${crypto.randomUUID()}, ${userId}, ${item.module}, ${item.office},
									${item.event}, ${item.subject}, ${item.text}, ${item.link})`
						);
					}
				});
				result.queued += queue.length;
			} catch (e) {
				console.warn(
					'[offices] Warteschlange nicht gespeichert:',
					e instanceof Error ? e.message : e
				);
				result.skipped += queue.length;
			}
		}

		// 5) Sofort: eine Mail je Person
		for (const [userId, events] of immediate) {
			const user = users.get(userId)!;
			if (await sendTo(user, composeMail(user.name, events, 'immediate'))) result.sent++;
			else result.skipped += events.length;
		}

		if (result.sent || result.queued) {
			try {
				await core.audit.logFromContext(ctx, 'offices.notification.sent', {
					metadata: {
						events: valid.length,
						offices: offices.size,
						sent: result.sent,
						queued: result.queued,
						skipped: result.skipped
					}
				});
			} catch (e) {
				console.warn('[offices] Audit fehlgeschlagen:', e instanceof Error ? e.message : e);
			}
		}
	} catch (e) {
		console.warn('[offices] notify fehlgeschlagen:', e instanceof Error ? e.message : e);
	}
	return result;
}

export interface DigestResult {
	users: number;
	sent: number;
	events: number;
	failed: number;
	/** Verworfene Einträge insgesamt (inkl. `expired`) */
	dropped: number;
	/** Davon wegen Höchstalter oder zu vieler Fehlversuche verworfen */
	expired: number;
}

/**
 * Tageszusammenfassung: Warteschlange je Person zu einer Mail. Versendete Zeilen und Zeilen inaktiver
 * Konten werden gelöscht; bei Versandfehler bleiben die Zeilen für den nächsten Lauf liegen und
 * zählen einen Versuch. Einträge älter als `QUEUE_MAX_AGE_DAYS` oder nach `QUEUE_MAX_ATTEMPTS`
 * Fehlversuchen werden verworfen (`expired`).
 */
export async function sendDigest(ctx: RequestContext): Promise<DigestResult> {
	const result: DigestResult = {
		users: 0,
		sent: 0,
		events: 0,
		failed: 0,
		dropped: 0,
		expired: 0
	};
	const [old] = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`WITH d AS (
				DELETE FROM notification_queue
				WHERE created_at < now() - make_interval(days => ${QUEUE_MAX_AGE_DAYS})
					OR attempts >= ${QUEUE_MAX_ATTEMPTS}
				RETURNING 1
			) SELECT count(*)::int AS n FROM d`
		)
	);
	result.expired = Number(old?.n ?? 0);
	result.dropped = result.expired;

	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT q.id, q.user_id, q.module_id, q.office_key, q.subject, q.text, q.link, q.created_at,
					o.name AS office_name,
					EXISTS (SELECT 1 FROM office_holders h WHERE h.office_id = o.id AND h.user_id = q.user_id)
						AS is_holder
				FROM notification_queue q
				LEFT JOIN offices o ON o.source_module = q.module_id AND o.source_key = q.office_key
				ORDER BY q.user_id, q.created_at, q.id`
		)
	);
	if (rows.length === 0) {
		await auditDigest(ctx, result);
		return result;
	}

	const byUser = new Map<string, typeof rows>();
	for (const r of rows) {
		const id = String(r.user_id);
		const list = byUser.get(id);
		if (list) list.push(r);
		else byUser.set(id, [r]);
	}
	result.users = byUser.size;
	const users = await usersByIds(lookupCtx(), [...byUser.keys()]);

	const done: string[] = [];
	const failed: string[] = [];
	for (const [userId, all] of byUser) {
		// Amt gelöscht oder Person nicht mehr Inhaber*in → verwerfen
		const list = all.filter((r) => r.is_holder === true || r.is_holder === 't');
		if (list.length < all.length) {
			done.push(...all.filter((r) => !list.includes(r)).map((r) => String(r.id)));
			result.dropped += all.length - list.length;
		}
		if (list.length === 0) continue;
		const user = users.get(userId);
		if (!user) {
			// Konto inaktiv oder gelöscht → verwerfen
			done.push(...list.map((r) => String(r.id)));
			result.dropped += list.length;
			continue;
		}
		const events: MailEvent[] = list.map((r) => ({
			officeName: textOrNull(r.office_name) ?? String(r.office_key),
			subject: String(r.subject),
			text: String(r.text ?? ''),
			link: cleanLink(r.link)
		}));
		if (await sendTo(user, composeMail(user.name, events, 'daily'))) {
			result.sent++;
			result.events += list.length;
			done.push(...list.map((r) => String(r.id)));
		} else {
			result.failed++;
			failed.push(...list.map((r) => String(r.id)));
		}
	}
	if (done.length) {
		for (let i = 0; i < done.length; i += 500) {
			const part = done.slice(i, i + 500);
			await mdb().transaction((tx) =>
				tx.execute(sql`DELETE FROM notification_queue WHERE id IN (${inList(part)})`)
			);
		}
	}
	// Fehlversuch zählen; wer die Höchstzahl erreicht, wird sofort verworfen
	for (let i = 0; i < failed.length; i += 500) {
		const part = failed.slice(i, i + 500);
		const [r] = await mdb().transaction(async (tx) => {
			await tx.execute(
				sql`UPDATE notification_queue SET attempts = attempts + 1 WHERE id IN (${inList(part)})`
			);
			return rowsOf(
				tx,
				sql`WITH d AS (
					DELETE FROM notification_queue
					WHERE id IN (${inList(part)}) AND attempts >= ${QUEUE_MAX_ATTEMPTS}
					RETURNING 1
				) SELECT count(*)::int AS n FROM d`
			);
		});
		const n = Number(r?.n ?? 0);
		result.expired += n;
		result.dropped += n;
	}
	await auditDigest(ctx, result);
	return result;
}

/** Audit nur mit Zählern; auch, wenn nur verworfen wurde */
async function auditDigest(ctx: RequestContext, result: DigestResult): Promise<void> {
	if (!result.sent && !result.expired) return;
	await core.audit.logFromContext(ctx, 'offices.notification.sent', {
		metadata: {
			digest: true,
			sent: result.sent,
			events: result.events,
			failed: result.failed,
			dropped: result.dropped,
			expired: result.expired
		}
	});
}

/** Ämter des Kontos mit Funktions-Adressen (für Absender des Moduls `messages`); ohne Konto leer */
async function listOwnOfficeEmails(ctx: RequestContext): Promise<OwnOfficeEmails[]> {
	if (!ctx.userId) return [];
	const userId = ctx.userId;
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT o.id, o.name, e.label, e.email
				FROM office_holders h
				JOIN offices o ON o.id = h.office_id
				JOIN office_emails e ON e.office_id = o.id
				WHERE h.user_id = ${userId}
				ORDER BY o.position, o.name, e.position, e.id`
		)
	);
	const byOffice = new Map<string, OwnOfficeEmails>();
	for (const r of rows) {
		const id = String(r.id);
		const entry = byOffice.get(id) ?? { officeId: id, officeName: String(r.name), emails: [] };
		entry.emails.push({ label: textOrNull(r.label), email: String(r.email) });
		byOffice.set(id, entry);
	}
	return [...byOffice.values()];
}

/** Alle Ämter mit Adressen und Inhaber*innen (Postfach-Zuordnung in `messages`), ohne Rechteprüfung */
async function listOfficeMailboxes(): Promise<OfficeMailbox[]> {
	const data = await mdb().transaction(async (tx) => ({
		emails: await rowsOf(
			tx,
			sql`SELECT o.id, o.name, e.label, e.email FROM offices o
				JOIN office_emails e ON e.office_id = o.id
				ORDER BY o.position, o.name, e.position, e.id`
		),
		holders: await rowsOf(
			tx,
			sql`SELECT office_id, user_id FROM office_holders ORDER BY office_id, position, user_id`
		)
	}));
	const byOffice = new Map<string, OfficeMailbox>();
	for (const r of data.emails) {
		const id = String(r.id);
		const entry = byOffice.get(id) ?? {
			officeId: id,
			officeName: String(r.name),
			emails: [],
			holderUserIds: []
		};
		entry.emails.push({ label: textOrNull(r.label), email: String(r.email) });
		byOffice.set(id, entry);
	}
	for (const h of data.holders) {
		byOffice.get(String(h.office_id))?.holderUserIds.push(String(h.user_id));
	}
	return [...byOffice.values()];
}

export const officesService: OfficesService = {
	notify,
	listOwnOfficeEmails,
	listOfficeMailboxes
};
