/**
 * Website-Endpoints (API-Key der Stammeswebsite mit Scope `website.content.read`). Nur öffentliche Felder:
 * laufende Banner, aktive Fragen, veröffentlichte Beiträge (Zeitpunkt erreicht) mit Vornamen der Autor*in.
 * Keine Entwürfe, keine Konto-IDs, keine Freigaben.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	rowsOf,
	toIso,
	type AnyApiEndpoint,
	type RequestContext,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { toBanner, toFaq } from './content.endpoints';
import { db, fileResponse } from './files';
import { groupIdsFor, imagesFor, tagsFor, toImage } from './posts.service';
import {
	PERM,
	firstNameOf,
	websiteImageParams,
	websitePostsQuery,
	websiteSlugParams,
	type WebsiteBanner,
	type WebsiteFaq,
	type WebsitePost,
	type WebsitePostImage,
	type WebsitePostPage,
	type WebsitePostSummary
} from './schemas';

const tags = ['Modul: website'];
const KEY_HINT =
	'Der API-Key gehört nur auf den Server der Website (nie in den Browser ausliefern); Bilder mit demselben ' +
	'Key laden und auf der Website zwischenspeichern.';
const LIVE = sql`p.status = 'published' AND p.published_at <= now()`;
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

async function liveBySlug(tx: Tx, slug: string): Promise<Row> {
	const [r] = await rowsOf(tx, sql`SELECT p.* FROM posts p WHERE p.slug = ${slug} AND ${LIVE}`);
	if (!r) throw errors.notFound('Beitrag nicht gefunden');
	return r;
}

async function coverMap(tx: Tx, rows: readonly Row[]): Promise<Map<string, WebsitePostImage>> {
	const ids = rows.map((r) => str(r.cover_image_id)).filter((id): id is string => !!id);
	const map = new Map<string, WebsitePostImage>();
	if (!ids.length) return map;
	const images = await rowsOf(
		tx,
		sql`SELECT * FROM post_images WHERE id IN (${sql.join(
			ids.map((id) => sql`${id}`),
			sql`, `
		)})`
	);
	for (const i of images) map.set(String(i.post_id), toImage(i));
	return map;
}

/** Vornamen der Autor*innen (Override hat Vorrang; deaktivierte/gelöschte Konten → `null`) */
async function authorNames(ctx: RequestContext, rows: readonly Row[]) {
	const users = await core.users.byIds(
		ctx,
		rows.filter((r) => !r.author_name_override).map((r) => str(r.author_id))
	);
	return (r: Row): string | null => {
		if (r.author_name_override) return String(r.author_name_override);
		const name = r.author_id ? users.get(String(r.author_id))?.name : undefined;
		return name ? firstNameOf(name) || null : null;
	};
}

function toSummary(
	r: Row,
	tagList: string[],
	cover: WebsitePostImage | null,
	authorName: string | null
): WebsitePostSummary {
	return {
		slug: String(r.slug),
		title: String(r.title),
		teaser: str(r.teaser),
		publishedAt: toIso(r.published_at),
		cover,
		tags: tagList,
		authorName
	};
}

export const websiteEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/website/banners',
		summary: 'Laufende Banner/Hinweise für die Stammeswebsite (API-Key mit Scope website.content.read)',
		description:
			'Aktive Banner im Zeitfenster (`startsAt`/`endsAt`) in der festgelegten Reihenfolge; `placement` ' +
			'`bar` = Leiste auf allen Seiten, `home` = Kasten auf der Startseite. ' +
			KEY_HINT,
		tags,
		permission: PERM.contentRead,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async (): Promise<WebsiteBanner[]> => {
			const rows = await db().transaction((tx) =>
				rowsOf(
					tx,
					sql`SELECT * FROM banners
						WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
						ORDER BY position, created_at, id`
				)
			);
			return rows.map((r) => {
				const b = toBanner(r);
				return {
					id: b.id,
					title: b.title,
					text: b.text,
					level: b.level,
					placement: b.placement,
					linkUrl: b.linkUrl,
					linkLabel: b.linkLabel,
					dismissible: b.dismissible,
					updatedAt: b.updatedAt
				};
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/faqs',
		summary: 'Häufige Fragen für die Stammeswebsite (aktive, in Reihenfolge)',
		description: '`featured` = auch auf der Startseite zeigen. Antworten als bereinigtes HTML. ' + KEY_HINT,
		tags,
		permission: PERM.contentRead,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async (): Promise<WebsiteFaq[]> => {
			const rows = await db().transaction((tx) =>
				rowsOf(tx, sql`SELECT * FROM faqs WHERE active ORDER BY position, created_at, id`)
			);
			return rows.map((r) => {
				const f = toFaq(r);
				return { id: f.id, question: f.question, answerHtml: f.answerHtml, featured: f.featured };
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/posts',
		summary: 'Veröffentlichte Blog-Beiträge (neueste zuerst, Filter nach Thema)',
		description:
			'`items` mit Titelbild-Maßen und Vornamen der Autor*in, `total` für die Seitenzahl, `tags` = alle Themen ' +
			'veröffentlichter Beiträge mit Anzahl. ' +
			KEY_HINT,
		tags,
		permission: PERM.contentRead,
		rateLimit: { limit: 600, windowSec: 60 },
		query: websitePostsQuery,
		handler: async ({ ctx, query }): Promise<WebsitePostPage> => {
			const tagCond = query.tag
				? sql`AND EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND lower(t.tag) = lower(${query.tag}))`
				: sql``;
			const data = await db().transaction(async (tx) => {
				const rows = await rowsOf(
					tx,
					sql`SELECT p.* FROM posts p WHERE ${LIVE} ${tagCond}
						ORDER BY p.published_at DESC, p.id LIMIT ${query.limit} OFFSET ${query.offset}`
				);
				const [c] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n FROM posts p WHERE ${LIVE} ${tagCond}`
				);
				const tagRows = await rowsOf(
					tx,
					sql`SELECT min(t.tag) AS tag, count(*)::int AS n FROM post_tags t JOIN posts p ON p.id = t.post_id
						WHERE ${LIVE} GROUP BY lower(t.tag) ORDER BY count(*) DESC, min(t.tag)`
				);
				return {
					rows,
					total: Number(c?.n ?? 0),
					tagMap: await tagsFor(
						tx,
						rows.map((r) => String(r.id))
					),
					covers: await coverMap(tx, rows),
					tags: tagRows.map((t) => ({ tag: String(t.tag), count: Number(t.n) }))
				};
			});
			const nameOf = await authorNames(ctx, data.rows);
			return {
				items: data.rows.map((r) =>
					toSummary(
						r,
						data.tagMap.get(String(r.id)) ?? [],
						data.covers.get(String(r.id)) ?? null,
						nameOf(r)
					)
				),
				total: data.total,
				tags: data.tags
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/posts/:slug',
		summary: 'Ein veröffentlichter Blog-Beitrag mit Text, Bildern und Verknüpfungen',
		description:
			'Bilder im Text als `<img data-image-id="…" alt="…">`, Maße in `images`. `groupIds`, `eventId`, ' +
			'`galleryId` gegen die eigenen Website-Listen prüfen (nur öffentlich gelistete anzeigen). ' +
			KEY_HINT,
		tags,
		permission: PERM.contentRead,
		rateLimit: { limit: 600, windowSec: 60 },
		params: websiteSlugParams,
		handler: async ({ ctx, params }): Promise<WebsitePost> => {
			const data = await db().transaction(async (tx) => {
				const row = await liveBySlug(tx, params.slug);
				const id = String(row.id);
				return {
					row,
					tags: (await tagsFor(tx, [id])).get(id) ?? [],
					groupIds: await groupIdsFor(tx, id),
					images: await imagesFor(tx, id)
				};
			});
			const nameOf = await authorNames(ctx, [data.row]);
			const images = data.images.map(toImage);
			const coverId = str(data.row.cover_image_id);
			return {
				...toSummary(
					data.row,
					data.tags,
					images.find((i) => i.id === coverId) ?? null,
					nameOf(data.row)
				),
				bodyHtml: String(data.row.body_html ?? ''),
				images,
				groupIds: data.groupIds,
				eventId: str(data.row.event_id),
				galleryId: str(data.row.gallery_id),
				updatedAt: toIso(data.row.updated_at)
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/posts/:slug/images/:imageId/:variant',
		summary: 'Bilddatei eines veröffentlichten Beitrags (thumb, web)',
		tags,
		permission: PERM.contentRead,
		rateLimit: IMAGE_RATE_LIMIT,
		params: websiteImageParams,
		handler: async ({ params }) => {
			const path = await db().transaction(async (tx) => {
				const post = await liveBySlug(tx, params.slug);
				const [r] = await rowsOf(
					tx,
					sql`SELECT thumb_path, web_path FROM post_images WHERE id = ${params.imageId} AND post_id = ${String(post.id)}`
				);
				if (!r) throw errors.notFound('Bild nicht gefunden');
				return String(params.variant === 'thumb' ? r.thumb_path : r.web_path);
			});
			return fileResponse(path, 'public, max-age=86400');
		}
	})
];
