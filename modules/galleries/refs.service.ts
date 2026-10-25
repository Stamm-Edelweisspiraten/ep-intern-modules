/** Dienst `GalleryRefsService` (siehe `contract.ts`): Verweise auf öffentliche Galerien für andere Module */
import { sql } from 'drizzle-orm';
import { inList, rowsOf, type Row } from '$lib/sdk/server';
import type { GalleryRefInfo, GalleryRefsService } from './contract';
import { db } from './files';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const toRef = (r: Row): GalleryRefInfo => ({
	id: String(r.id),
	title: String(r.title),
	imageCount: Number(r.image_count ?? 0)
});

const IMAGE_COUNT = sql`(SELECT count(*)::int FROM gallery_images i WHERE i.gallery_id = g.id)`;

export const galleryRefsService: GalleryRefsService = {
	async searchPublicGalleryRefs(opts = {}) {
		const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
		const search = opts.search?.trim();
		const rows = await db().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT g.id, g.title, ${IMAGE_COUNT} AS image_count FROM galleries g
					WHERE g.visibility = 'public' ${search ? sql`AND g.title ILIKE ${like(search)}` : sql``}
					ORDER BY g.updated_at DESC, g.id LIMIT ${limit}`
			)
		);
		return rows.map(toRef);
	},
	async publicGalleryRefs(ids) {
		const list = [...new Set(ids)].slice(0, 100);
		if (list.length === 0) return [];
		const rows = await db().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT g.id, g.title, ${IMAGE_COUNT} AS image_count FROM galleries g
					WHERE g.visibility = 'public' AND g.id IN (${inList(list)})`
			)
		);
		const byId = new Map(rows.map((r) => [String(r.id), toRef(r)]));
		return list.map((id) => byId.get(id)).filter((r): r is GalleryRefInfo => !!r);
	}
};
