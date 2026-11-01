/**
 * Globale Suche (Befehlspalette): Beiträge nach Titel und Teaser, sichtbar wie in `GET /posts`
 * (eigene, zum Mitschreiben freigegebene, mit `website.post.publish` alle). Schlüssel VOR der Transaktion.
 */
import { sql } from 'drizzle-orm';
import {
	type ModuleSearchProvider,
	principalKeysFor,
	rowsOf,
	type SearchHit
} from '$lib/sdk/server';
import { visiblePostsFilter } from './access';
import { db } from './files';
import { MODULE_ID, PERM } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const websiteSearch: ModuleSearchProvider = {
	permission: PERM.postWrite,
	async run(ctx, query, limit) {
		const keys = await principalKeysFor(ctx, MODULE_ID);
		const p = like(query);
		const rows = await db().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT p.id, p.title, p.status FROM posts p
					WHERE ${visiblePostsFilter(ctx, keys)} AND (p.title ILIKE ${p} OR p.teaser ILIKE ${p})
					ORDER BY (p.title ILIKE ${p}) DESC, p.updated_at DESC, p.id LIMIT ${limit}`
			)
		);
		return rows.map((r): SearchHit => ({
			id: String(r.id),
			title: String(r.title),
			subtitle: r.status === 'published' ? 'veröffentlicht' : 'Entwurf',
			href: `/modules/website/posts/${encodeURIComponent(String(r.id))}`,
			icon: 'globe',
			type: 'Blog-Beitrag'
		}));
	}
};
