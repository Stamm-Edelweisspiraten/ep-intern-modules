/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Galerien',
		description:
			'Löscht alle Galerien samt Bildern (auch die Dateien), Termin-Zuordnungen und Freigaben. ' +
			'Öffentliche Galerien verschwinden ebenfalls von der Stammeswebsite.',
		// Kind vor Eltern; gelöschte Bilder setzen galleries.cover_image_id per FK auf NULL
		tables: ['gallery_events', 'gallery_shares', 'gallery_images', 'galleries'],
		storagePrefixes: 'all',
		rebuild: true
	}
];

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM gallery_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE galleries SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE galleries SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE gallery_images SET uploaded_by = ${keepUserId}
			WHERE uploaded_by IS NOT NULL AND uploaded_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE gallery_shares SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
};
