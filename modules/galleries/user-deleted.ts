/**
 * Hook `onUserDeleted` (Core `deleteUser`): Galerien sind Stammesdaten und bleiben erhalten. Eigentum geht
 * an die löschende Person (`transferTo`, ohne sie – Systemaufruf – bleibt es unverändert). Freigaben an
 * die Person werden gelöscht, Verweise in `created_by`/`uploaded_by`/`public_confirmed_by` auf `NULL`
 * gesetzt (der Zeitpunkt der Veröffentlichungs-Bestätigung bleibt).
 */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition } from '$lib/sdk/server';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (
	tx,
	{ userId, transferTo }
) => {
	await tx.execute(
		sql`DELETE FROM gallery_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	if (transferTo) {
		await tx.execute(sql`UPDATE galleries SET owner_id = ${transferTo} WHERE owner_id = ${userId}`);
	}
	await tx.execute(sql`UPDATE galleries SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE gallery_images SET uploaded_by = NULL WHERE uploaded_by = ${userId}`);
	await tx.execute(sql`UPDATE gallery_shares SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(
		sql`UPDATE galleries SET public_confirmed_by = NULL WHERE public_confirmed_by = ${userId}`
	);
};
