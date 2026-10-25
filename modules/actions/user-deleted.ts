/**
 * Hook `onUserDeleted` (Core `deleteUser`): Aktionen und Abrechnungen sind Stammesdaten und bleiben
 * erhalten. Eigentum geht an die löschende Person (`transferTo`, ohne sie – Systemaufruf – bleibt es
 * unverändert). Freigaben an die Person werden gelöscht; Anmeldungen verlieren den Bezug zum Konto
 * (`user_id` → `NULL`, die Anmeldedaten selbst bleiben), Verweise in `created_by` → `NULL`.
 */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition } from '$lib/sdk/server';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (
	tx,
	{ userId, transferTo }
) => {
	await tx.execute(
		sql`DELETE FROM action_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	if (transferTo) {
		await tx.execute(sql`UPDATE actions SET owner_id = ${transferTo} WHERE owner_id = ${userId}`);
	}
	await tx.execute(sql`UPDATE action_participants SET user_id = NULL WHERE user_id = ${userId}`);
	await tx.execute(
		sql`UPDATE accounting_entries SET created_by = NULL WHERE created_by = ${userId}`
	);
	await tx.execute(
		sql`UPDATE accounting_interims SET created_by = NULL WHERE created_by = ${userId}`
	);
};
