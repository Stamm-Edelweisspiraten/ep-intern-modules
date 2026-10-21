/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql, type SQL } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea, Tx } from '$lib/sdk/server';

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

/**
 * Personenbezogene Zeilen löschen (Inhaber*innen, Beschreibung, Benachrichtigungs-Einstellungen,
 * Warteschlange). `match` erzeugt die Bedingung für die Spalte `user_id` – gemeinsam genutzt von
 * `resetUsers` (alle außer einer Person) und `onUserDeleted` (eine Person, `user-deleted.ts`).
 */
export async function deletePersonRows(tx: Tx, match: (col: SQL) => SQL): Promise<void> {
	const col = sql.raw('user_id');
	await tx.execute(sql`DELETE FROM office_holders WHERE ${match(col)}`);
	await tx.execute(sql`DELETE FROM holder_profiles WHERE ${match(col)}`);
	await tx.execute(sql`DELETE FROM notification_prefs WHERE ${match(col)}`);
	await tx.execute(sql`DELETE FROM notification_queue WHERE ${match(col)}`);
}

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await deletePersonRows(tx, (col) => sql`${col} <> ${keepUserId}`);
	await tx.execute(
		sql`UPDATE offices SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
};
