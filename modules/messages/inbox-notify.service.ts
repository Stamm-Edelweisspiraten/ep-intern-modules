/**
 * Benachrichtigungen zum Posteingang an die **Konto-Adresse** der berechtigten Personen:
 * - `new`: „Sie haben eine neue Nachricht von …“ mit dem Inhalt (gekürzt) und Link,
 * - `replied`: in gemeinsamen Postfächern (Amt, Gruppe, Stamm) „<Name> hat geantwortet“ an alle anderen.
 * Je Person, Postfach und Ereignis abschaltbar (Profil, Tabelle `inbox_notification_prefs`, Standard an).
 *
 * Mails tragen `X-EP-Intern`/`Auto-Submitted` (`core.mail.send` mit `autoSubmitted`): Landen sie selbst im
 * Catch-all (Konto-Adresse auf der eigenen Domain), überspringt der Abruf sie – keine Schleife.
 * Spam und automatische Mails (Abwesenheitsnotizen) lösen keine Benachrichtigung aus. Wirft nie.
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	errors,
	inList,
	moduleDb,
	rowsOf,
	type RequestContext
} from '$lib/sdk/server';
import { isSharedMailbox } from './mailbox';
import { accessibleMailboxes, loadMailboxDirectory, type MailboxEntry } from './mailbox.service';
import {
	BASE_PATH,
	INBOX_EVENTS,
	INBOX_EVENT_LABELS,
	MODULE_ID,
	NOTIFY_TEXT_MAX,
	type InboxEvent,
	type MyInboxNotifications
} from './schemas';
import type { ImportedMail } from './inbound.service';

const mdb = () => moduleDb(MODULE_ID);
const system = () => core.auth.systemContext(MODULE_ID);

/** Mehr neue Mails je Person und Abruf werden in einer Sammelmail zusammengefasst */
const BUNDLE_FROM = 4;

/** Abgeschaltete (Person, Postfach) für ein Ereignis */
async function disabledFor(event: InboxEvent, mailboxKeys: string[]): Promise<Set<string>> {
	if (!mailboxKeys.length) return new Set();
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT user_id, mailbox_key FROM inbox_notification_prefs
				WHERE event = ${event} AND NOT enabled AND mailbox_key IN (${inList(mailboxKeys)})`
		)
	);
	return new Set(rows.map((r) => `${String(r.user_id)}|${String(r.mailbox_key)}`));
}

/** Text kürzen (mit Hinweis) */
export function clip(text: string, max = NOTIFY_TEXT_MAX): string {
	const clean = text.replace(/\r\n/g, '\n').trim();
	return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}\n\n[… gekürzt]`;
}

/** Betreff einzeilig, höchstens 200 Zeichen */
function subjectLine(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 200)
	);
}

const senderLabel = (from: { address: string; name: string | null }) =>
	from.name ? `${from.name} <${from.address}>` : from.address;

const inboxLink = (id: string) => `${core.app.origin()}${BASE_PATH}/inbox/${id}`;

async function emailsOf(userIds: string[]): Promise<Map<string, string>> {
	const users = await core.users.byIds(system(), userIds, { includeEmail: true });
	const out = new Map<string, string>();
	for (const [id, u] of users) if (u.email) out.set(id, u.email);
	return out;
}

async function send(to: string, subject: string, text: string): Promise<boolean> {
	const ok = await bestEffort('messages.inbox.notify', () =>
		core.mail.send({ to, subject: subjectLine(subject), text, autoSubmitted: true })
	);
	return ok !== undefined;
}

/** Nach einem Abruf: neue Mails an die Berechtigten melden (ohne „Nicht zugeordnet“, Spam, Automatik) */
export async function notifyNewMail(
	items: ImportedMail[],
	directory?: MailboxEntry[]
): Promise<{ sent: number }> {
	const relevant = items.filter((i) => i.notify && i.mailboxKey !== 'unassigned');
	if (!relevant.length) return { sent: 0 };
	const result = await bestEffort('messages.inbox.notify-new', async () => {
		const entries = directory ?? (await loadMailboxDirectory());
		const byKey = new Map(entries.map((e) => [e.key, e]));
		const disabled = await disabledFor('new', [...new Set(relevant.map((i) => i.mailboxKey))]);
		const perUser = new Map<string, ImportedMail[]>();
		for (const item of relevant) {
			for (const userId of byKey.get(item.mailboxKey)?.userIds ?? []) {
				if (disabled.has(`${userId}|${item.mailboxKey}`)) continue;
				perUser.set(userId, [...(perUser.get(userId) ?? []), item]);
			}
		}
		const emails = await emailsOf([...perUser.keys()]);
		let sent = 0;
		for (const [userId, mails] of perUser) {
			const to = emails.get(userId);
			if (!to) continue;
			if (mails.length >= BUNDLE_FROM) {
				const list = mails
					.map(
						(m) =>
							`• ${senderLabel(m.from)} an ${m.mailboxName}: ${m.subject || '(kein Betreff)'}\n  ${inboxLink(m.id)}`
					)
					.join('\n');
				if (
					await send(
						to,
						`${mails.length} neue Nachrichten im Posteingang`,
						`Sie haben ${mails.length} neue Nachrichten:\n\n${list}`
					)
				)
					sent++;
				continue;
			}
			for (const m of mails) {
				const text = [
					`Sie haben eine neue Nachricht von ${senderLabel(m.from)} an ${m.mailboxName} (${m.mailboxAddress}).`,
					'',
					`Betreff: ${m.subject || '(kein Betreff)'}`,
					'',
					clip(m.text) || '(kein Text)',
					'',
					`Lesen, antworten und Anhänge: ${inboxLink(m.id)}`
				].join('\n');
				const fromName = m.from.name || m.from.address;
				if (
					await send(to, `Neue Nachricht von ${fromName}: ${m.subject || '(kein Betreff)'}`, text)
				)
					sent++;
			}
		}
		return sent;
	});
	return { sent: result ?? 0 };
}

/**
 * Nach dem Versand einer Antwort/Weiterleitung aus einem **gemeinsamen** Postfach: alle anderen
 * Berechtigten informieren („<Name> hat geantwortet“).
 */
export async function notifyReplied(
	ctx: RequestContext,
	input: {
		inboxId: string;
		mailboxKey: string;
		kind: 'reply' | 'forward';
		originalSubject: string;
		originalFrom: string;
		recipients: string[];
		text: string;
	}
): Promise<{ sent: number }> {
	if (!isSharedMailbox(input.mailboxKey)) return { sent: 0 };
	const result = await bestEffort('messages.inbox.notify-replied', async () => {
		const entry = (await loadMailboxDirectory()).find((e) => e.key === input.mailboxKey);
		if (!entry) return 0;
		const disabled = await disabledFor('replied', [input.mailboxKey]);
		const others = entry.userIds.filter(
			(id) => id !== ctx.userId && !disabled.has(`${id}|${input.mailboxKey}`)
		);
		if (!others.length) return 0;
		const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
		const name = me?.name ?? 'Jemand';
		const verb = input.kind === 'reply' ? 'geantwortet' : 'weitergeleitet';
		const emails = await emailsOf(others);
		let sent = 0;
		for (const id of others) {
			const to = emails.get(id);
			if (!to) continue;
			const text = [
				`${name} hat die Nachricht „${input.originalSubject || '(kein Betreff)'}“ von ${input.originalFrom} im Postfach ${entry.name} (${entry.address}) ${verb}.`,
				'',
				`An: ${input.recipients.join(', ')}`,
				'',
				clip(input.text, 2000) || '(kein Text)',
				'',
				`Verlauf ansehen: ${inboxLink(input.inboxId)}`
			].join('\n');
			if (await send(to, `${name} hat ${verb}: ${input.originalSubject || '(kein Betreff)'}`, text))
				sent++;
		}
		return sent;
	});
	return { sent: result ?? 0 };
}

// --- Einstellungen im Profil ---------------------------------------------------------------------

export async function getMyNotifications(ctx: RequestContext): Promise<MyInboxNotifications> {
	const mailboxes = (await accessibleMailboxes(ctx)).filter((m) => m.kind !== 'unassigned');
	const userId = ctx.userId ?? '';
	const prefs = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT mailbox_key, event, enabled FROM inbox_notification_prefs WHERE user_id = ${userId}`
		)
	);
	const off = new Set(
		prefs.filter((p) => p.enabled === false).map((p) => `${String(p.mailbox_key)}|${p.event}`)
	);
	const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
	return {
		email: me?.email || null,
		mailboxes: mailboxes.map((m) => ({
			key: m.key,
			name: m.name,
			address: m.address,
			kind: m.kind,
			shared: m.shared,
			events: INBOX_EVENTS.filter((e) => e === 'new' || m.shared).map((event) => ({
				event,
				label: INBOX_EVENT_LABELS[event],
				enabled: !off.has(`${m.key}|${event}`)
			}))
		}))
	};
}

/** Eigene Einstellung ändern; fremdes Postfach → 404, „replied“ bei persönlichem Postfach → 422 */
export async function setMyNotification(
	ctx: RequestContext,
	input: { mailbox: string; event: InboxEvent; enabled: boolean }
): Promise<MyInboxNotifications> {
	const mailboxes = await accessibleMailboxes(ctx);
	const mailbox = mailboxes.find((m) => m.key === input.mailbox && m.kind !== 'unassigned');
	if (!mailbox) throw errors.notFound('Postfach nicht gefunden');
	if (input.event === 'replied' && !mailbox.shared) {
		throw errors.validation([
			{ path: ['event'], message: 'Nur für gemeinsame Postfächer (Amt, Gruppe, Stamm)' }
		]);
	}
	const userId = ctx.userId ?? '';
	await mdb().transaction((tx) =>
		input.enabled
			? tx.execute(
					sql`DELETE FROM inbox_notification_prefs
						WHERE user_id = ${userId} AND mailbox_key = ${input.mailbox} AND event = ${input.event}`
				)
			: tx.execute(
					sql`INSERT INTO inbox_notification_prefs (user_id, mailbox_key, event, enabled)
						VALUES (${userId}, ${input.mailbox}, ${input.event}, false)
						ON CONFLICT (user_id, mailbox_key, event) DO UPDATE SET enabled = false`
				)
	);
	return getMyNotifications(ctx);
}
