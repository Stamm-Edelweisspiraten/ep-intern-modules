/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Website-Inhalte',
		description:
			'Löscht alle Banner, Fragen und Blog-Beiträge samt Bildern (auch die Dateien). Die Startfragen werden ' +
			'neu angelegt. Die Stammeswebsite zeigt danach keine Beiträge und Hinweise mehr.',
		// Kind vor Eltern; gelöschte Bilder setzen posts.cover_image_id per FK auf NULL
		tables: ['post_shares', 'post_tags', 'post_groups', 'post_images', 'posts', 'faqs', 'banners'],
		storagePrefixes: 'all',
		rebuild: true
	}
];

const USER_COLUMNS = [
	['posts', 'author_id'],
	['posts', 'created_by'],
	['post_images', 'uploaded_by'],
	['post_shares', 'created_by'],
	['banners', 'created_by'],
	['faqs', 'created_by']
] as const;

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM post_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	for (const [table, column] of USER_COLUMNS) {
		const col = sql.identifier(column);
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${col} = ${keepUserId}
				WHERE ${col} IS NOT NULL AND ${col} <> ${keepUserId}`
		);
	}
};
