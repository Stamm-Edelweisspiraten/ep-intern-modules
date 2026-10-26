/** Dienst `GalleryRefsService` (siehe `contract.ts`): Verweise auf öffentliche Galerien für andere Module */
import { sql } from 'drizzle-orm';
import {
	core,
	inList,
	principalKeysFor,
	type RequestContext,
	rowsOf,
	type Row
} from '$lib/sdk/server';
import { visibleGalleriesFilter } from './access';
import type { GalleryCardInfo, GalleryRefInfo, GalleryRefsService } from './contract';
import { db } from './files';
import { MODULE_ID } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const toRef = (r: Row): GalleryRefInfo => ({
	id: String(r.id),
	title: String(r.title),
	imageCount: Number(r.image_count ?? 0)
});

const IMAGE_COUNT = sql`(SELECT count(*)::int FROM gallery_images i WHERE i.gallery_id = g.id)`;

/** Titelbild bzw. zuerst hochgeladenes Bild */
const COVER_ID = sql`COALESCE(g.cover_image_id, (SELECT i.id FROM gallery_images i WHERE i.gallery_id = g.id
	ORDER BY i.created_at, i.id LIMIT 1))`;

const CARD_SELECT = sql`g.id, g.title, g.visibility, ${IMAGE_COUNT} AS image_count, ${COVER_ID} AS cover_id`;

const toCard = (r: Row): GalleryCardInfo => {
	const id = String(r.id);
	return {
		...toRef(r),
		visibility: r.visibility === 'public' ? 'public' : 'private',
		coverUrl: r.cover_id
			? `/api/v1/modules/galleries/galleries/${encodeURIComponent(id)}/images/${encodeURIComponent(String(r.cover_id))}/thumb`
			: null,
		href: `/modules/galleries/${encodeURIComponent(id)}`
	};
};

/** Principal-Schlüssel (vor der Transaktion) oder `null` ohne Grundrecht */
async function viewerKeys(ctx: RequestContext): Promise<readonly string[] | null> {
	if (ctx.actor.type !== 'system' && !core.permissions.has(ctx, 'galleries.gallery.view'))
		return null;
	return principalKeysFor(ctx, MODULE_ID);
}

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
	},
	async searchGalleryCards(ctx, opts = {}) {
		const keys = await viewerKeys(ctx);
		if (!keys) return [];
		const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
		const search = opts.search?.trim();
		const rows = await db().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT ${CARD_SELECT} FROM galleries g
					WHERE ${visibleGalleriesFilter(ctx, keys)} ${search ? sql`AND g.title ILIKE ${like(search)}` : sql``}
					ORDER BY g.updated_at DESC, g.id LIMIT ${limit}`
			)
		);
		return rows.map(toCard);
	},
	async describeGalleryCards(ctx, ids) {
		const list = [...new Set(ids)].slice(0, 200);
		if (list.length === 0) return [];
		const keys = await viewerKeys(ctx);
		if (!keys) return [];
		const rows = await db().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT ${CARD_SELECT} FROM galleries g
					WHERE g.id IN (${inList(list)}) AND ${visibleGalleriesFilter(ctx, keys)}`
			)
		);
		const byId = new Map(rows.map((r) => [String(r.id), toCard(r)]));
		return list.map((id) => byId.get(id)).filter((r): r is GalleryCardInfo => !!r);
	}
};
