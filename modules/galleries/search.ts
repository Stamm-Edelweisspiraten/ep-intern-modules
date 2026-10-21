/**
 * Globale Suche (Befehlspalette): Galerien nach Titel und Beschreibung. Sichtbar wie in
 * `GET /galleries` (`visibleGalleriesFilter`: eigene, öffentliche, freigegebene bzw. alle mit
 * `view-all`); Principal-Schlüssel VOR der Transaktion. Zuletzt geänderte zuerst.
 */
import { sql } from 'drizzle-orm';
import {
	type ModuleSearchProvider,
	moduleDb,
	principalKeysFor,
	rowsOf,
	type SearchHit
} from '$lib/sdk/server';
import { visibleGalleriesFilter } from './access';
import { MODULE_ID } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const galleriesSearch: ModuleSearchProvider = {
	permission: 'galleries.gallery.view',
	async run(ctx, query, limit) {
		const keys = await principalKeysFor(ctx, MODULE_ID);
		const p = like(query);
		const found = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT g.id, g.title, g.visibility,
						(SELECT count(*)::int FROM gallery_images x WHERE x.gallery_id = g.id) AS image_count
					FROM galleries g
					WHERE ${visibleGalleriesFilter(ctx, keys)}
						AND (g.title ILIKE ${p} OR g.description ILIKE ${p})
					ORDER BY (g.title ILIKE ${p}) DESC, g.updated_at DESC, g.title, g.id
					LIMIT ${limit}`
			)
		);
		return found.map((r): SearchHit => {
			const n = Number(r.image_count ?? 0);
			return {
				id: String(r.id),
				title: String(r.title),
				subtitle: [
					`${n} ${n === 1 ? 'Bild' : 'Bilder'}`,
					r.visibility === 'public' ? 'öffentlich' : null
				]
					.filter(Boolean)
					.join(' · '),
				href: `/modules/galleries/${encodeURIComponent(String(r.id))}`,
				icon: 'images',
				type: 'Galerie'
			};
		});
	}
};
