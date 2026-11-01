/**
 * Beiträge: Laden, Abbilden auf DTOs, Slugs, Themen, Bilder. Funktionen mit `tx` laufen in der Modul-Transaktion
 * (nur Datenbank), `build*` danach (Core-Dienste: Namen, Principals, Verweise aus anderen Modulen).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	describePrincipals,
	inList,
	rowsOf,
	toIso,
	toIsoOrNull,
	userLabel,
	type ObjectAccess,
	type RequestContext,
	type Row,
	type StoredShare,
	type Tx
} from '$lib/sdk/server';
import { slugify } from '$lib/sdk/slug';
import type { PrincipalGroupRef } from '$lib/sdk/types/sharing';
import type { EventRefsService } from '$modules/events/contract';
import type { GalleryRefsService } from '$modules/galleries/contract';
import { canPublish } from './access';
import {
	MAX_SLUG,
	MODULE_ID,
	type PostAccess,
	type PostDetail,
	type PostImage,
	type PostListItem,
	type PostShare,
	type PostStatus,
	type RefOption
} from './schemas';

export const SHARE_TYPES = ['user', 'role', 'group', 'member'] as const;
export const EVERYONE_LABEL = 'Stamm';

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Beitrag veröffentlicht und Zeitpunkt erreicht */
export function isLive(status: string, publishedAt: string | null, now = Date.now()): boolean {
	return status === 'published' && !!publishedAt && Date.parse(publishedAt) <= now;
}

export async function loadPostRow(tx: Tx, id: string): Promise<Row | null> {
	const [r] = await rowsOf(tx, sql`SELECT * FROM posts WHERE id = ${id}`);
	return r ?? null;
}

/** Themen je Beitrag (Reihenfolge wie eingegeben) */
export async function tagsFor(tx: Tx, ids: readonly string[]): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	if (ids.length === 0) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT post_id, tag FROM post_tags WHERE post_id IN (${inList(ids)}) ORDER BY post_id, position, tag`
	);
	for (const r of rows) {
		const id = String(r.post_id);
		map.set(id, [...(map.get(id) ?? []), String(r.tag)]);
	}
	return map;
}

export async function groupIdsFor(tx: Tx, id: string): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT group_id FROM post_groups WHERE post_id = ${id} ORDER BY group_id`
	);
	return rows.map((r) => String(r.group_id));
}

export function toImage(r: Row): PostImage {
	return { id: String(r.id), alt: str(r.alt), width: Number(r.width), height: Number(r.height) };
}

export async function imagesFor(tx: Tx, id: string): Promise<Row[]> {
	return rowsOf(tx, sql`SELECT * FROM post_images WHERE post_id = ${id} ORDER BY created_at, id`);
}

export async function replaceTags(tx: Tx, id: string, tags: readonly string[]): Promise<void> {
	await tx.execute(sql`DELETE FROM post_tags WHERE post_id = ${id}`);
	for (const [i, tag] of tags.entries()) {
		await tx.execute(
			sql`INSERT INTO post_tags (post_id, tag, position) VALUES (${id}, ${tag}, ${i}) ON CONFLICT DO NOTHING`
		);
	}
}

export async function replaceGroups(tx: Tx, id: string, groupIds: readonly string[]): Promise<void> {
	await tx.execute(sql`DELETE FROM post_groups WHERE post_id = ${id}`);
	for (const g of new Set(groupIds)) {
		await tx.execute(sql`INSERT INTO post_groups (post_id, group_id) VALUES (${id}, ${g})`);
	}
}

/** Freier Slug: `base`, sonst `base-2`, `base-3` … (ohne den Beitrag `exceptId`) */
export async function uniqueSlug(tx: Tx, title: string, exceptId?: string): Promise<string> {
	const base = slugify(title, MAX_SLUG - 4) || 'beitrag';
	const rows = await rowsOf(
		tx,
		sql`SELECT slug FROM posts WHERE (slug = ${base} OR slug LIKE ${`${base}-%`})
			${exceptId ? sql`AND id <> ${exceptId}` : sql``}`
	);
	const taken = new Set(rows.map((r) => String(r.slug)));
	if (!taken.has(base)) return base;
	for (let i = 2; i < 10_000; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function slugTaken(tx: Tx, slug: string, exceptId: string): Promise<boolean> {
	const r = await rowsOf(tx, sql`SELECT 1 FROM posts WHERE slug = ${slug} AND id <> ${exceptId}`);
	return r.length > 0;
}

function accessOf(ctx: RequestContext, access: ObjectAccess): PostAccess {
	return { level: access.level, isOwner: access.isOwner, canPublish: canPublish(ctx) };
}

/** Listeneintrag ohne Namen (Namen kommen in `buildList` nach der Transaktion dazu) */
export function toListItem(
	ctx: RequestContext,
	r: Row,
	tags: string[],
	access: ObjectAccess,
	authorName = ''
): PostListItem {
	const publishedAt = toIsoOrNull(r.published_at);
	const status = String(r.status) as PostStatus;
	return {
		id: String(r.id),
		slug: String(r.slug),
		title: String(r.title),
		teaser: str(r.teaser),
		status,
		publishedAt,
		live: isLive(status, publishedAt),
		coverImageId: str(r.cover_image_id),
		tags,
		authorId: str(r.author_id),
		authorName,
		access: accessOf(ctx, access),
		createdAt: toIso(r.created_at),
		updatedAt: toIso(r.updated_at)
	};
}

/** Anzeigename der Autor*in: Override, sonst Kontoname */
function authorDisplay(
	users: ReadonlyMap<string, { name: string }>,
	authorId: string | null,
	override: string | null
): string {
	if (override) return override;
	return authorId ? userLabel(users, authorId) : 'Unbekannt';
}

export async function buildList(
	ctx: RequestContext,
	items: (PostListItem & { authorNameOverride: string | null })[]
): Promise<PostListItem[]> {
	const users = await core.users.byIds(
		ctx,
		items.map((i) => i.authorId)
	);
	return items.map(({ authorNameOverride, ...i }) => ({
		...i,
		authorName: authorDisplay(users, i.authorId, authorNameOverride)
	}));
}

export interface PostData {
	row: Row;
	access: ObjectAccess;
	tags: string[];
	groupIds: string[];
	images: Row[];
	shares: StoredShare[];
}

export async function loadPostData(
	tx: Tx,
	row: Row,
	access: ObjectAccess,
	loadShares: (tx: Tx, id: string) => Promise<StoredShare[]>
): Promise<PostData> {
	const id = String(row.id);
	return {
		row,
		access,
		tags: (await tagsFor(tx, [id])).get(id) ?? [],
		groupIds: await groupIdsFor(tx, id),
		images: await imagesFor(tx, id),
		shares: await loadShares(tx, id)
	};
}

export const eventsService = () =>
	core.modules.useOptional<EventRefsService>('events', MODULE_ID);
export const galleriesService = () =>
	core.modules.useOptional<GalleryRefsService>('galleries', MODULE_ID);

/** Gruppen aus `members` (ohne aktives Modul eine leere Liste) */
export async function listGroups(): Promise<PrincipalGroupRef[]> {
	const members = await core.modules.useOptional<{ listGroups(): Promise<PrincipalGroupRef[]> }>(
		'members',
		MODULE_ID
	);
	return members ? members.listGroups() : [];
}

async function describeShares(ctx: RequestContext, shares: StoredShare[]): Promise<PostShare[]> {
	if (shares.length === 0) return [];
	const infos = await describePrincipals(ctx, MODULE_ID, shares, {
		everyoneLabel: EVERYONE_LABEL,
		types: SHARE_TYPES
	});
	return infos.map((p) => ({
		type: p.type as PostShare['type'],
		id: p.id,
		name: p.name,
		detail: p.detail ?? null,
		color: p.color ?? null,
		image: p.image ?? null,
		level: 'edit'
	}));
}

/** Detail-DTO (nach der Transaktion: Namen, Freigaben, Verweise) */
export async function buildDetail(ctx: RequestContext, d: PostData): Promise<PostDetail> {
	const r = d.row;
	const users = await core.users.byIds(ctx, [str(r.author_id)]);
	const base = toListItem(ctx, r, d.tags, d.access);
	const eventId = str(r.event_id);
	const galleryId = str(r.gallery_id);
	let eventRef: RefOption | null = null;
	let galleryRef: RefOption | null = null;
	if (eventId) {
		const events = await eventsService();
		const [e] = events ? await events.describeEventRefs(ctx, [eventId]) : [];
		eventRef = e
			? { id: e.id, label: e.title, detail: e.startsOn, color: e.color }
			: { id: eventId, label: 'Unbekannter Termin', detail: null, color: null };
	}
	if (galleryId) {
		const galleries = await galleriesService();
		const [g] = galleries ? await galleries.publicGalleryRefs([galleryId]) : [];
		galleryRef = g
			? { id: g.id, label: g.title, detail: `${g.imageCount} Bilder`, color: null }
			: { id: galleryId, label: 'Galerie nicht öffentlich', detail: null, color: null };
	}
	return {
		...base,
		authorName: authorDisplay(users, base.authorId, str(r.author_name_override)),
		bodyHtml: String(r.body_html ?? ''),
		authorNameOverride: str(r.author_name_override),
		groupIds: d.groupIds,
		eventId,
		galleryId,
		eventRef,
		galleryRef,
		images: d.images.map(toImage),
		shares: d.access.level === 'edit' ? await describeShares(ctx, d.shares) : []
	};
}
