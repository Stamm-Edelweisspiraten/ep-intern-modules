/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

/**
 * Das Modul speichert keine Dateien – daher keine `storagePrefixes`. Bei `rebuild` löscht der Core
 * die vom Modul verliehenen Rollen (`user_role_grant`) automatisch mit.
 */
export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Ämter',
		description:
			'Löscht alle Ämter samt E-Mail-Adressen, verknüpften Rollen, Inhaber*innen und ' +
			'persönlichen Beschreibungen sowie Benachrichtigungs-Einstellungen. Vorlagen-Ämter aus Modulen ' +
			'werden neu angelegt. Die über Ämter verliehenen Rollen werden entzogen; ' +
			'Ämter auf der Stammeswebsite verschwinden ebenfalls.',
		tables: [
			'notification_queue',
			'notification_prefs',
			'office_templates_applied',
			'holder_profiles',
			'office_holders',
			'office_emails',
			'office_roles',
			'offices'
		],
		rebuild: true
	}
];

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(sql`DELETE FROM office_holders WHERE user_id <> ${keepUserId}`);
	await tx.execute(sql`DELETE FROM holder_profiles WHERE user_id <> ${keepUserId}`);
	await tx.execute(sql`DELETE FROM notification_prefs WHERE user_id <> ${keepUserId}`);
	await tx.execute(sql`DELETE FROM notification_queue WHERE user_id <> ${keepUserId}`);
	await tx.execute(
		sql`UPDATE offices SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
};
