/**
 * Hook `onUserDeleted` (Core `deleteUser`): Inhaber*innen-Zeilen, persönliche Beschreibung,
 * Benachrichtigungs-Einstellungen und Warteschlange der Person löschen; `offices.created_by` → `NULL`.
 * Danach die verliehenen Rollen neu abgleichen (`syncGrants`, Core-Service → nach dem Commit).
 * Die Zeilen in `user_role_grant` entfernt der Core bereits per FK-Kaskade.
 */
import { sql } from 'drizzle-orm';
import { core, type ModuleDefinition } from '$lib/sdk/server';
import { syncGrants } from './grants.service';
import { deletePersonRows } from './reset';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	await deletePersonRows(tx, (col) => sql`${col} = ${userId}`);
	await tx.execute(sql`UPDATE offices SET created_by = NULL WHERE created_by = ${userId}`);
	return {
		afterCommit: async () => {
			await syncGrants(core.auth.systemContext('offices'));
		}
	};
};
