/**
 * Hook `onUserDeleted` (Core `deleteUser`): Konto-Verknüpfungen der Person lösen (gemeinsame Logik mit
 * `resetUsers`) und Verweise in `created_by`/`updated_by` auf `NULL` setzen. Mitglieder selbst bleiben
 * (Stammdaten des Stammes, nicht der Person mit dem Konto). Danach die Rolle „Gruppenleitung“ abgleichen.
 */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition } from '$lib/sdk/server';
import { syncLeaderGrantsAfterChange } from './leader.service';
import { unlinkUsers } from './reset';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	await unlinkUsers(tx, (col) => sql`${col} = ${userId}`);
	await tx.execute(
		sql`UPDATE member_user_links SET created_by = NULL WHERE created_by = ${userId}`
	);
	await tx.execute(
		sql`UPDATE member_link_codes SET created_by = NULL WHERE created_by = ${userId}`
	);
	await tx.execute(
		sql`UPDATE member_mail_prefs SET updated_by = NULL WHERE updated_by = ${userId}`
	);
	// Rolle „Gruppenleitung“ neu abgleichen (Core-Service → nach dem Commit)
	return { afterCommit: () => syncLeaderGrantsAfterChange() };
};
