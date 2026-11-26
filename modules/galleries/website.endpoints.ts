/**
 * Website-Endpoints (API-Key der Stammeswebsite mit Scope `galleries.website.read`).
 * Liefern NUR Galerien mit `visibility = 'public'` – unabhängig von Freigaben – und nur die Felder
 * der Website-DTOs (keine Eigentümer*innen, Freigaben, Dateinamen oder Uploader).
 * Bilder mit „nur intern“ (`is_private`) gibt es hier nie: nicht in Liste, Detail, Bildanzahl,
 * Titelbild oder als Datei.
 * Core-Aufrufe (`events`-Dienst, Storage) laufen außerhalb der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	type Row,
	rowsOf,
	type Tx,
	toIso
} from '$lib/sdk/server';
import type { EventRefInfo } from '$modules/events/contract';
import {
	db,
	eventsService,
	fileResponse,
	rangeFileResponse,
	VARIANT_COLUMN,
	websiteCoverSql
} from './files';
import {
	CREATED_ON_SQL,
	compareGalleries,
	ENDS_ON_SQL,
	STARTS_ON_SQL,
	sortRowOf
} from './galleries.service';
import { durationOf, mediaTypeOf } from './images.service';
import {
	type ImageCover,
	idParams,
	type WebsiteEventRef,
	type WebsiteGallery,
	type WebsiteGalleryDetail,
	type WebsiteImage,
	websiteListQuery,
	websiteVariantParams
} from './schemas';

const TAGS = ['Modul: galleries'];
const NOT_FOUND = 'Galerie nicht gefunden';
/** Höchstzahl IDs je Aufruf von `websiteEventRefs` (Vertrag `events`) */
const EVENT_REF_CHUNK = 500;

const KEY_HINT =
	'Der API-Key gehört nur auf den Server der Website (nie in den Browser ausliefern); ' +
	'Bilddateien mit demselben Key über `/website/galleries/:id/images/:imageId/:variant` laden ' +
	'und auf der Website zwischenspeichern.';

function textOrNull(v: unknown): string | null {
	return v === null || v === undefined ? null : String(v);
}

function coverOf(r: Row): ImageCover | null {
	if (r.cover_id === null || r.cover_id === undefined) return null;
	return {
		imageId: String(r.cover_id),
		width: Number(r.cover_width),
		height: Number(r.cover_height)
	};
}

function galleryOf(r: Row, events: WebsiteEventRef[]): WebsiteGallery {
	return {
		id: String(r.id),
		title: String(r.title),
		description: textOrNull(r.description),
		startsOn: textOrNull(r.starts_on),
		endsOn: textOrNull(r.ends_on),
		imageCount: Number(r.image_count ?? 0),
		cover: coverOf(r),
		events,
		updatedAt: toIso(r.updated_at)
	};
}

/** Spalten für Galerien inkl. Bildanzahl und Titelbild – nur nicht private Bilder (Alias `g`, Join `c`) */
const GALLERY_SELECT = sql`SELECT g.id, g.title, g.description, g.updated_at,
	${STARTS_ON_SQL} AS starts_on, ${ENDS_ON_SQL} AS ends_on,
	(SELECT count(*)::int FROM gallery_images x WHERE x.gallery_id = g.id AND NOT x.is_private) AS image_count,
	c.id AS cover_id, c.width AS cover_width, c.height AS cover_height
	FROM galleries g
	LEFT JOIN gallery_images c ON c.id = ${websiteCoverSql}`;

/** Termin-Verweise mit „auf der Website“ je Termin-ID (ohne `events` leer) */
async function websiteEventMap(eventIds: readonly string[]): Promise<Map<string, WebsiteEventRef>> {
	const map = new Map<string, WebsiteEventRef>();
	const unique = [...new Set(eventIds)];
	if (unique.length === 0) return map;
	const service = await eventsService();
	if (!service) return map;
	for (let i = 0; i < unique.length; i += EVENT_REF_CHUNK) {
		const refs: EventRefInfo[] = await service.websiteEventRefs(
			unique.slice(i, i + EVENT_REF_CHUNK)
		);
		for (const r of refs) {
			if (!r.onWebsite) continue;
			map.set(r.id, { id: r.id, title: r.title, startsOn: r.startsOn, endsOn: r.endsOn });
		}
	}
	return map;
}

/** Termin-Zuordnungen (`gallery_id` → Website-Termine, sortiert nach Beginn) auflösen */
async function eventsByGallery(links: Row[]): Promise<Map<string, WebsiteEventRef[]>> {
	const eventMap = await websiteEventMap(links.map((l) => String(l.event_id)));
	const map = new Map<string, WebsiteEventRef[]>();
	for (const l of links) {
		const ref = eventMap.get(String(l.event_id));
		if (!ref) continue;
		const id = String(l.gallery_id);
		map.set(id, [...(map.get(id) ?? []), ref]);
	}
	for (const list of map.values()) {
		list.sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title));
	}
	return map;
}

function imageOf(r: Row): WebsiteImage {
	return {
		id: String(r.id),
		galleryId: String(r.gallery_id),
		description: textOrNull(r.description),
		width: Number(r.width),
		height: Number(r.height),
		position: Number(r.position ?? 0),
		mediaType: mediaTypeOf(r),
		durationSeconds: durationOf(r)
	};
}

async function linksFor(tx: Tx, galleryIds: string[]): Promise<Row[]> {
	if (galleryIds.length === 0) return [];
	return rowsOf(
		tx,
		sql`SELECT gallery_id, event_id FROM gallery_events
			WHERE gallery_id IN (${sql.join(
				galleryIds.map((id) => sql`${id}`),
				sql`, `
			)})
			ORDER BY gallery_id, event_id`
	);
}

export const websiteEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/website/galleries',
		summary:
			'Öffentliche Galerien für die Stammeswebsite (API-Key mit Scope galleries.website.read)',
		description:
			'Liefert `{ items, total }` mit allen Galerien, die auf „öffentlich“ stehen (unabhängig von ' +
			'Freigaben), nach Datum sortiert, neueste zuerst (`startsOn`, sonst Beginn des frühesten ' +
			'Website-Termins, sonst Anlagedatum; bei Gleichstand zuletzt geändert). Je Galerie: ' +
			'Titel, Beschreibung, Zeitraum (`startsOn`/`endsOn`, optional), Bildanzahl und effektives Titelbild (`cover`: gesetztes Titelbild oder ' +
			'das zuerst hochgeladene Bild, `null` ohne Bilder). Bilder mit „nur intern“ zählen nicht mit ' +
			'und werden nie Titelbild. Nur öffentliche Felder: keine ' +
			'Freigaben, Eigentümer*innen, Dateinamen oder Uploader. `events` = zugeordnete Termine, ' +
			'nur solche mit „auf der Website“. Mit `eventId` nur Galerien zu diesem Termin (steht der ' +
			'Termin nicht auf der Website, ist die Liste leer). Blättern mit `limit`/`offset`. ' +
			KEY_HINT,
		tags: TAGS,
		permission: 'galleries.website.read',
		query: websiteListQuery,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async ({ query }) => {
			if (query.eventId) {
				const event = await websiteEventMap([query.eventId]);
				if (!event.has(query.eventId)) return { items: [] as WebsiteGallery[], total: 0 };
			}
			const where = query.eventId
				? sql`g.visibility = 'public' AND EXISTS (SELECT 1 FROM gallery_events ge
						WHERE ge.gallery_id = g.id AND ge.event_id = ${query.eventId})`
				: sql`g.visibility = 'public'`;
			// Sortierdaten aller öffentlichen Galerien, sortiert wie intern (Zeitraum ?? frühester
			// Website-Termin ?? Anlagedatum), danach volle Daten nur für die Seite
			const { all, links } = await db().transaction(async (tx) => {
				const all = await rowsOf(
					tx,
					sql`SELECT g.id, g.title, g.updated_at,
							${STARTS_ON_SQL} AS starts_on, ${CREATED_ON_SQL} AS created_on
						FROM galleries g WHERE ${where}`
				);
				const links = await linksFor(
					tx,
					all.map((r) => String(r.id))
				);
				return { all, links };
			});
			const events = await eventsByGallery(links);
			const sorted = all
				.map((r) =>
					sortRowOf(
						r,
						(events.get(String(r.id)) ?? []).map((e) => e.startsOn)
					)
				)
				.sort(compareGalleries);
			const pageIds = sorted.slice(query.offset, query.offset + query.limit).map((g) => g.id);
			if (pageIds.length === 0) return { items: [] as WebsiteGallery[], total: sorted.length };
			const rows = await db().transaction((tx) =>
				rowsOf(
					tx,
					sql`${GALLERY_SELECT}
						WHERE g.visibility = 'public' AND g.id IN (${sql.join(
							pageIds.map((id) => sql`${id}`),
							sql`, `
						)})`
				)
			);
			const byId = new Map(rows.map((r) => [String(r.id), r]));
			const items = pageIds
				.map((id) => byId.get(id))
				.filter((r): r is Row => !!r)
				.map((r) => galleryOf(r, events.get(String(r.id)) ?? []));
			return { items, total: sorted.length };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/galleries/:id/images/:imageId/:variant',
		summary:
			'Bild- oder Videodatei einer öffentlichen Galerie (thumb, web oder video) für die Stammeswebsite',
		description:
			'Liefert die Bilddatei (WebP, ohne Metadaten) in der Variante `thumb` (480 px lange Kante) ' +
			'oder `web` (2048 px). Die Originalauflösung (`full`) ist nur intern abrufbar. Das Bild ' +
			'muss zu einer öffentlichen Galerie gehören und darf nicht „nur intern“ sein, sonst 404. Antwort mit ' +
			'`Cache-Control: public, max-age=86400` – bitte auf dem Website-Server zwischenspeichern ' +
			'(der API-Key darf nicht im Browser landen, Bilder also über den eigenen Server ausliefern). ' +
			'Eigenes Rate-Limit für Bilder (1200/60 s), da eine Seite viele Bilder lädt. Bei Videos ' +
			'(`mediaType: video`) sind `thumb`/`web` Vorschaubilder und `video` die Videodatei ' +
			'(MP4/MOV/WebM ohne Metadaten, `Range`-Anfragen → 206); `video` bei einem Bild → 404.',
		tags: TAGS,
		permission: 'galleries.website.read',
		params: websiteVariantParams,
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ params, request }) => {
			const column = sql.raw(`i.${VARIANT_COLUMN[params.variant]}`);
			const found = await db().transaction(async (tx) => {
				const [row] = await rowsOf(
					tx,
					sql`SELECT ${column} AS path, i.media_type, i.content_type
						FROM gallery_images i
						JOIN galleries g ON g.id = i.gallery_id
						WHERE i.id = ${params.imageId} AND i.gallery_id = ${params.id}
							AND g.visibility = 'public' AND NOT i.is_private`
				);
				return row?.path ? row : null;
			});
			if (!found) throw errors.notFound('Bild nicht gefunden');
			const path = String(found.path);
			if (params.variant === 'video') {
				if (mediaTypeOf(found) !== 'video') throw errors.notFound('Kein Video');
				return rangeFileResponse(request, path, {
					cache: 'public, max-age=86400',
					contentType: String(found.content_type),
					name: `${params.imageId}.${path.split('.').pop() ?? 'mp4'}`
				});
			}
			return fileResponse(path, { cache: 'public, max-age=86400' });
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/galleries/:id',
		summary: 'Öffentliche Galerie mit Bildern für die Stammeswebsite',
		description:
			'Liefert eine öffentliche Galerie (inkl. Termine mit „auf der Website“) mit allen Bildern ' +
			'(ID, Beschreibung, Masse, Position), sortiert nach Upload-Zeitpunkt; Bilder mit „nur intern“ ' +
			'fehlen. Private oder unbekannte ' +
			'Galerien → 404. Bilddateien über `/website/galleries/:id/images/:imageId/thumb|web`, ' +
			'Videos (`mediaType: video`, `durationSeconds`) zusätzlich über `…/video`. ' +
			KEY_HINT,
		tags: TAGS,
		permission: 'galleries.website.read',
		params: idParams,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async ({ params }) => {
			const data = await db().transaction(async (tx) => {
				const [gallery] = await rowsOf(
					tx,
					sql`${GALLERY_SELECT}
						WHERE g.id = ${params.id} AND g.visibility = 'public'`
				);
				if (!gallery) return null;
				const images = await rowsOf(
					tx,
					sql`SELECT id, gallery_id, description, width, height, position, media_type,
							duration_seconds
						FROM gallery_images
						WHERE gallery_id = ${params.id} AND NOT is_private
						ORDER BY created_at ASC, id ASC`
				);
				const links = await linksFor(tx, [params.id]);
				return { gallery, images, links };
			});
			if (!data) throw errors.notFound(NOT_FOUND);
			const events = await eventsByGallery(data.links);
			const detail: WebsiteGalleryDetail = {
				...galleryOf(data.gallery, events.get(params.id) ?? []),
				images: data.images.map(imageOf)
			};
			return detail;
		}
	})
];
