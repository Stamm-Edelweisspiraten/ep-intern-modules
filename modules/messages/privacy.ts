/**
 * Datenschutz im Modul `messages`:
 * - `onUserDeleted`: persönliches Postfach (inkl. Ordner und Anhänge im Speicher), Gelesen-Markierungen und
 *   Benachrichtigungs-Einstellungen der Person löschen; Verweise (`deleted_by`, `spam_marked_by`,
 *   `created_by`, auch an der Sperr-/Vertrauensliste) → `NULL`.
 * - `subjectExport`: Datenauskunft für ein Konto (gesendete Nachrichten, persönliches Postfach als
 *   Metadaten, Einstellungen). Inhalte gemeinsamer Postfächer gehören nicht der Person und fehlen.
 * Keine Core-Dienste innerhalb der Transaktion (Speicher erst in `afterCommit`).
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	moduleDb,
	rowsOf,
	toIso,
	type DataSubject,
	type ModuleDefinition,
	type ModuleSubjectExport
} from '$lib/sdk/server';
import { personalKey } from './mailbox';
import { MODULE_ID } from './schemas';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	const key = personalKey(userId);
	const files = await rowsOf(
		tx,
		sql`SELECT a.storage_path FROM inbox_attachments a JOIN inbox_messages i ON i.id = a.inbox_message_id
			WHERE i.mailbox_key = ${key}`
	);
	// messages.reply_of/forward_of → NULL per Fremdschlüssel (ON DELETE SET NULL)
	await tx.execute(sql`DELETE FROM inbox_messages WHERE mailbox_key = ${key}`);
	await tx.execute(sql`DELETE FROM inbox_folders WHERE mailbox_key = ${key}`);
	await tx.execute(sql`UPDATE inbox_folders SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`DELETE FROM inbox_reads WHERE user_id = ${userId}`);
	await tx.execute(sql`DELETE FROM inbox_notification_prefs WHERE user_id = ${userId}`);
	await tx.execute(sql`UPDATE inbox_messages SET deleted_by = NULL WHERE deleted_by = ${userId}`);
	await tx.execute(
		sql`UPDATE inbox_messages SET spam_marked_by = NULL WHERE spam_marked_by = ${userId}`
	);
	await tx.execute(sql`UPDATE sender_rules SET created_by = NULL WHERE created_by = ${userId}`);
	const paths = files.map((f) => String(f.storage_path));
	return {
		afterCommit: async () => {
			if (!paths.length) return;
			await bestEffort('messages.user-deleted.files', () =>
				core.storage.removeMany(core.auth.systemContext(MODULE_ID), { module: MODULE_ID, paths })
			);
		}
	};
};

async function run(subject: DataSubject): Promise<Record<string, unknown> | null> {
	const userId = subject.userId;
	if (!userId) return null;
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const sent = await rowsOf(
			tx,
			sql`SELECT id, subject, sender_address, created_at, total, status FROM messages
				WHERE created_by = ${userId} ORDER BY created_at, id`
		);
		const inbox = await rowsOf(
			tx,
			sql`SELECT id, from_address, from_name, subject, received_at, deleted_at FROM inbox_messages
				WHERE mailbox_key = ${personalKey(userId)} ORDER BY received_at, id`
		);
		const folders = await rowsOf(
			tx,
			sql`SELECT id, parent_id, name, created_at FROM inbox_folders
				WHERE mailbox_key = ${personalKey(userId)} ORDER BY created_at, id`
		);
		const prefs = await rowsOf(
			tx,
			sql`SELECT mailbox_key, event, enabled FROM inbox_notification_prefs
				WHERE user_id = ${userId} ORDER BY mailbox_key, event`
		);
		if (!sent.length && !inbox.length && !folders.length && !prefs.length) return null;
		return {
			sentMessages: sent.map((r) => ({
				id: String(r.id),
				subject: String(r.subject),
				sender: String(r.sender_address),
				createdAt: toIso(r.created_at),
				recipients: Number(r.total),
				status: String(r.status)
			})),
			personalInbox: inbox.map((r) => ({
				id: String(r.id),
				from: r.from_name
					? `${String(r.from_name)} <${String(r.from_address)}>`
					: String(r.from_address),
				subject: String(r.subject),
				receivedAt: toIso(r.received_at),
				deleted: r.deleted_at != null
			})),
			personalFolders: folders.map((r) => ({
				id: String(r.id),
				parentId: r.parent_id == null ? null : String(r.parent_id),
				name: String(r.name),
				createdAt: toIso(r.created_at)
			})),
			notificationPreferences: prefs.map((r) => ({
				mailbox: String(r.mailbox_key),
				event: String(r.event),
				enabled: r.enabled === true
			}))
		};
	});
}

export const subjectExport: ModuleSubjectExport = { run };
