/**
 * Benachrichtigungen zum Posteingang (Versand über `core.notifications`, Kanal je Person im Profil unter
 * „Benachrichtigungen“, je Postfach):
 * - `inbox-new`: „Neue Nachricht von …“ mit dem Inhalt (gekürzt) und Link,
 * - `inbox-replied`: in gemeinsamen Postfächern (Amt, Gruppe, Stamm) „<Name> hat geantwortet“ an alle anderen.
 *
 * Mails tragen `X-Atrium` (früher `X-EP-Intern`)/`Auto-Submitted` (setzt der Core): Landen sie selbst im Catch-all (Konto-Adresse
 * auf der eigenen Domain), überspringt der Abruf sie – keine Schleife. Spam und automatische Mails
 * (Abwesenheitsnotizen) lösen keine Benachrichtigung aus. Wirft nie.
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	moduleDb,
	rowsOf,
	type NotificationItem,
	type NotificationScopeEntry,
	type RequestContext
} from '$lib/sdk/server';
import { isSharedMailbox } from './mailbox';
import { accessibleMailboxes, loadMailboxDirectory, type MailboxEntry } from './mailbox.service';
import { BASE_PATH, MODULE_ID, NOTIFY_TEXT_MAX } from './schemas';
import type { ImportedMail } from './inbound.service';

const mdb = () => moduleDb(MODULE_ID);

/** Benachrichtigungstypen im Core (je Postfach: Bereich = Postfach-Schlüssel) */
export const NOTIFY_NEW = 'inbox-new';
export const NOTIFY_REPLIED = 'inbox-replied';

/** Text kürzen (mit Hinweis) */
export function clip(text: string, max = NOTIFY_TEXT_MAX): string {
	const clean = text.replace(/\r\n/g, '\n').trim();
	return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}\n\n[… gekürzt]`;
}

const senderLabel = (from: { address: string; name: string | null }) =>
	from.name ? `${from.name} <${from.address}>` : from.address;

const inboxPath = (id: string) => `${BASE_PATH}/inbox/${id}`;

/** Nach einem Abruf: neue Mails an die Berechtigten melden (ohne „Nicht zugeordnet“, Spam, Automatik) */
export async function notifyNewMail(
	items: ImportedMail[],
	directory?: MailboxEntry[]
): Promise<{ sent: number }> {
	const relevant = items.filter((i) => i.notify && i.mailboxKey !== 'unassigned');
	if (!relevant.length) return { sent: 0 };
	const result = await bestEffort('messages.inbox.notify-new', async () => {
		await migrateLegacyPrefs();
		const entries = directory ?? (await loadMailboxDirectory());
		const byKey = new Map(entries.map((e) => [e.key, e]));
		const list: NotificationItem[] = [];
		for (const m of relevant) {
			const userIds = byKey.get(m.mailboxKey)?.userIds ?? [];
			if (!userIds.length) continue;
			const fromName = m.from.name || m.from.address;
			list.push({
				type: NOTIFY_NEW,
				scope: m.mailboxKey,
				userIds,
				title: `Neue Nachricht von ${fromName}: ${m.subject || '(kein Betreff)'}`,
				body: [
					`Neue Nachricht von ${senderLabel(m.from)} an ${m.mailboxName} (${m.mailboxAddress}).`,
					'',
					`Betreff: ${m.subject || '(kein Betreff)'}`,
					'',
					clip(m.text) || '(kein Text)',
					'',
					'Lesen, antworten und Anhänge:'
				].join('\n'),
				pushBody: m.text || m.subject,
				link: inboxPath(m.id),
				group: m.mailboxName
			});
		}
		if (!list.length) return 0;
		const r = await core.notifications.send(core.auth.systemContext(MODULE_ID), MODULE_ID, list);
		return r.email + r.push;
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
		await migrateLegacyPrefs();
		const entry = (await loadMailboxDirectory()).find((e) => e.key === input.mailboxKey);
		if (!entry) return 0;
		const others = entry.userIds.filter((id) => id !== ctx.userId);
		if (!others.length) return 0;
		const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
		const name = me?.name ?? 'Jemand';
		const verb = input.kind === 'reply' ? 'geantwortet' : 'weitergeleitet';
		const r = await core.notifications.send(ctx, MODULE_ID, [
			{
				type: NOTIFY_REPLIED,
				scope: input.mailboxKey,
				userIds: others,
				title: `${name} hat ${verb}: ${input.originalSubject || '(kein Betreff)'}`,
				body: [
					`${name} hat die Nachricht „${input.originalSubject || '(kein Betreff)'}“ von ${input.originalFrom} im Postfach ${entry.name} (${entry.address}) ${verb}.`,
					'',
					`An: ${input.recipients.join(', ')}`,
					'',
					clip(input.text, 2000) || '(kein Text)',
					'',
					'Verlauf ansehen:'
				].join('\n'),
				pushBody: `An ${input.recipients.join(', ')}: ${input.text}`,
				link: inboxPath(input.inboxId),
				group: entry.name
			}
		]);
		return r.email + r.push;
	});
	return { sent: result ?? 0 };
}

// --- Einstellungen im Profil (Core-Reiter „Benachrichtigungen“) ---------------------------------

/** Je eigenem Postfach „Neue Nachricht“, bei gemeinsamen Postfächern zusätzlich „… hat geantwortet“ */
export async function notificationScopesFor(
	ctx: RequestContext
): Promise<NotificationScopeEntry[]> {
	await migrateLegacyPrefs();
	const mailboxes = (await accessibleMailboxes(ctx)).filter((m) => m.kind !== 'unassigned');
	const out: NotificationScopeEntry[] = [];
	for (const m of mailboxes) {
		const group = `${m.name} (${m.address})`;
		out.push({ key: NOTIFY_NEW, scope: m.key, label: 'Neue Nachricht', group });
		if (m.shared) {
			out.push({
				key: NOTIFY_REPLIED,
				scope: m.key,
				label: 'Jemand hat geantwortet oder weitergeleitet',
				description: 'Wenn eine andere Person aus diesem gemeinsamen Postfach antwortet.',
				group
			});
		}
	}
	return out;
}

let legacyDone = false;

/**
 * Einmalige Übernahme der alten Einstellungen (`inbox_notification_prefs`, nur „aus“ gespeichert) in den
 * Core; danach werden die Zeilen gelöscht (idempotent).
 */
export async function migrateLegacyPrefs(): Promise<number> {
	if (legacyDone) return 0;
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT user_id, mailbox_key, event FROM inbox_notification_prefs WHERE NOT enabled`
		)
	);
	if (rows.length) {
		await core.notifications.migratePreferences(
			MODULE_ID,
			rows.map((r) => ({
				userId: String(r.user_id),
				type: r.event === 'replied' ? NOTIFY_REPLIED : NOTIFY_NEW,
				scope: String(r.mailbox_key),
				channel: 'off' as const
			}))
		);
	}
	await mdb().transaction((tx) => tx.execute(sql`DELETE FROM inbox_notification_prefs`));
	legacyDone = true;
	return rows.length;
}

/** Nur für Tests: Übernahme erneut prüfen */
export function resetLegacyPrefsMigrationForTests(): void {
	legacyDone = false;
}
