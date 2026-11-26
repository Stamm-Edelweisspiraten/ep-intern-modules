/**
 * Laden und Aufbauen von Galerien (Liste, Detail) sowie Freigaben schreiben.
 * Funktionen mit `tx` laufen in der Modul-Transaktion (nur Datenbank); alle anderen rufen Core-Dienste
 * auf und dürfen NIE innerhalb einer offenen Modul-Transaktion laufen (PGlite, eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	describePrincipals,
	errors,
	type RequestContext,
	type Row,
	rowsOf,
	type Tx,
	toIso
} from '$lib/sdk/server';
import { loadShares, requireAccess } from './access';
import { effectiveCover, eventsService } from './files';
import { durationOf, mediaTypeOf } from './images.service';
import {
	type EventRef,
	type GalleryAccess,
	type GalleryDetail,
	type GalleryImage,
	type GalleryShare,
	MODULE_ID,
	type ShareInput,
	type ShareLevel,
	type Visibility
} from './schemas';

export interface ShareRow {
	type: ShareInput['type'];
	id: string;
	level: ShareLevel;
}

/** Einstellung des Moduls `events` für den Stammesnamen (optional) */
const STAMM_NAME_SETTING = 'events.stamm.name';
const DEFAULT_EVERYONE_LABEL = 'Stamm';
/** Obergrenze von `describeEventRefs` je Aufruf */
const EVENT_REF_CHUNK = 500;

const textOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** Anzeigename für `everyone` (Stammesname aus `events`, sonst „Stamm“) */
export async function everyoneLabel(): Promise<string> {
	try {
		const value = await core.settings.get<unknown>(STAMM_NAME_SETTING);
		if (typeof value === 'string' && value.trim()) return value.trim();
	} catch {
		// Einstellung nicht registriert (events nicht aktiv) → Standard
	}
	return DEFAULT_EVERYONE_LABEL;
}

// ---------------------------------------------------------------------------
// Sortierung der Listen (Zeitraum ?? frühester Termin ?? Anlagedatum)
// ---------------------------------------------------------------------------

/** SQL-Ausdrücke für die Datumsfelder (Alias `g`) als `YYYY-MM-DD` (ohne Zeitzonen-Effekte) */
export const STARTS_ON_SQL = sql`to_char(g.starts_on, 'YYYY-MM-DD')`;
export const ENDS_ON_SQL = sql`to_char(g.ends_on, 'YYYY-MM-DD')`;
/** Anlagedatum als Kalendertag in Berlin */
export const CREATED_ON_SQL = sql`to_char(g.created_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD')`;

/** Daten einer Galerie für die Sortierung */
export interface GallerySortRow {
	id: string;
	title: string;
	/** Eigenes Startdatum `YYYY-MM-DD` oder `null` */
	startsOn: string | null;
	/** Anlagedatum (Berlin) `YYYY-MM-DD` */
	createdOn: string;
	/** Zeitpunkt der letzten Änderung (ms) für Gleichstände */
	updatedMs: number;
	/** Startdaten der (für den Aufrufer sichtbaren) verknüpften Termine */
	eventStarts: readonly string[];
}

/** Sortierdatum: eigenes Startdatum, sonst frühester Termin, sonst Anlagedatum */
export function gallerySortDate(
	g: Pick<GallerySortRow, 'startsOn' | 'createdOn' | 'eventStarts'>
): string {
	if (g.startsOn) return g.startsOn;
	let first: string | null = null;
	for (const d of g.eventStarts) if (!first || d < first) first = d;
	return first ?? g.createdOn;
}

/** Neueste zuerst; bei gleichem Datum zuletzt geändert zuerst, dann Titel, dann ID */
export function compareGalleries(a: GallerySortRow, b: GallerySortRow): number {
	const da = gallerySortDate(a);
	const dbb = gallerySortDate(b);
	if (da !== dbb) return da < dbb ? 1 : -1;
	if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs;
	return a.title.localeCompare(b.title, 'de') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Zeile aus `SELECT g.id, g.title, <STARTS_ON_SQL> AS starts_on, <CREATED_ON_SQL> AS created_on, g.updated_at` */
export function sortRowOf(r: Row, eventStarts: readonly string[]): GallerySortRow {
	return {
		id: String(r.id),
		title: String(r.title),
		startsOn: textOrNull(r.starts_on),
		createdOn: String(r.created_on),
		updatedMs: new Date(toIso(r.updated_at)).getTime(),
		eventStarts
	};
}

/** `%`, `_` und `\` für ILIKE maskieren */
export const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------------------
// In der Transaktion
// ---------------------------------------------------------------------------

/** Termin-IDs einer Galerie (in der Transaktion), sortiert */
export async function loadEventIds(tx: Tx, galleryId: string): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT event_id FROM gallery_events WHERE gallery_id = ${galleryId} ORDER BY event_id`
	);
	return rows.map((r) => String(r.event_id));
}

/** Termin-IDs je Galerie für mehrere Galerien (in der Transaktion) */
export async function eventIdsByGallery(
	tx: Tx,
	galleryIds: readonly string[]
): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	if (galleryIds.length === 0) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT gallery_id, event_id FROM gallery_events
			WHERE gallery_id IN (${sql.join(
				galleryIds.map((id) => sql`${id}`),
				sql`, `
			)})
			ORDER BY gallery_id, event_id`
	);
	for (const r of rows) {
		const key = String(r.gallery_id);
		const list = map.get(key) ?? [];
		list.push(String(r.event_id));
		map.set(key, list);
	}
	return map;
}

/** Termine einer Galerie vollständig ersetzen (in der Transaktion) */
export async function replaceGalleryEvents(
	tx: Tx,
	galleryId: string,
	eventIds: readonly string[]
): Promise<void> {
	await tx.execute(sql`DELETE FROM gallery_events WHERE gallery_id = ${galleryId}`);
	for (const eventId of eventIds) {
		await tx.execute(
			sql`INSERT INTO gallery_events (gallery_id, event_id) VALUES (${galleryId}, ${eventId})
				ON CONFLICT DO NOTHING`
		);
	}
}

interface DetailData {
	gallery: Row;
	access: GalleryAccess;
	images: Row[];
	eventIds: string[];
	cover: Awaited<ReturnType<typeof effectiveCover>>;
	shares: ShareRow[];
}

/** Alle Detaildaten (Zugriff `read` wird geprüft: fremd → 404) */
export async function loadDetailData(
	tx: Tx,
	ctx: RequestContext,
	galleryId: string,
	keys: readonly string[]
): Promise<DetailData> {
	const access = await requireAccess(tx, ctx, galleryId, keys, 'read');
	const [gallery] = await rowsOf(
		tx,
		sql`SELECT g.id, g.title, g.description, g.visibility, g.owner_id, g.created_at, g.updated_at,
				g.public_confirmed_at, g.public_confirmed_by,
				${STARTS_ON_SQL} AS starts_on, ${ENDS_ON_SQL} AS ends_on
			FROM galleries g WHERE g.id = ${galleryId}`
	);
	if (!gallery) throw errors.notFound('Galerie nicht gefunden');
	const images = await rowsOf(
		tx,
		sql`SELECT id, description, width, height, size_bytes, content_type, original_name,
				uploaded_by, created_at, is_private, media_type, duration_seconds
			FROM gallery_images WHERE gallery_id = ${galleryId} ORDER BY created_at, id`
	);
	const eventIds = await loadEventIds(tx, galleryId);
	const cover = await effectiveCover(tx, galleryId);
	const shares = access.level === 'edit' ? await loadShares(tx, galleryId) : [];
	return { gallery, access, images, eventIds, cover, shares };
}

// ---------------------------------------------------------------------------
// Außerhalb der Transaktion (Core-Aufrufe)
// ---------------------------------------------------------------------------

/**
 * Prüft Termin-IDs über den events-Dienst (nur für `ctx` sichtbare Termine), sonst 422
 * (Pfad `['eventIds', i]`; ohne aktives `events` bei nicht leerer Liste immer Pfad `['eventIds']`).
 * `keep`: bereits gespeicherte IDs – werden ohne Prüfung akzeptiert (gelöschte/unsichtbare
 * Termine sollen ein Speichern nicht blockieren).
 */
export async function validateEventIds(
	ctx: RequestContext,
	eventIds: readonly string[],
	keep: ReadonlySet<string> = new Set()
): Promise<void> {
	if (eventIds.length === 0) return;
	const service = await eventsService();
	if (!service) {
		throw errors.validation([
			{ path: ['eventIds'], message: 'Termine sind nicht verfügbar (Modul Termine inaktiv)' }
		]);
	}
	const check = eventIds.filter((id) => !keep.has(id));
	if (check.length === 0) return;
	const found = new Set((await service.describeEventRefs(ctx, check)).map((e) => e.id));
	const issues: { path: (string | number)[]; message: string }[] = [];
	eventIds.forEach((id, index) => {
		if (!keep.has(id) && !found.has(id)) {
			issues.push({ path: ['eventIds', index], message: 'Termin nicht gefunden' });
		}
	});
	if (issues.length) throw errors.validation(issues);
}

/** Sichtbare Termine in Reihenfolge der IDs (unsichtbare/gelöschte fehlen) */
export function pickEvents(ids: readonly string[], refs: Map<string, EventRef>): EventRef[] {
	return ids.map((id) => refs.get(id)).filter((e): e is EventRef => !!e);
}

/** Sichtbare Termine zu IDs (ohne `events` leer) */
export async function describeEvents(
	ctx: RequestContext,
	ids: readonly string[]
): Promise<Map<string, EventRef>> {
	const map = new Map<string, EventRef>();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return map;
	const service = await eventsService();
	if (!service) return map;
	for (let i = 0; i < unique.length; i += EVENT_REF_CHUNK) {
		const found = await service.describeEventRefs(ctx, unique.slice(i, i + EVENT_REF_CHUNK));
		for (const e of found) {
			map.set(e.id, {
				id: e.id,
				title: e.title,
				startsOn: e.startsOn,
				endsOn: e.endsOn,
				color: e.color
			});
		}
	}
	return map;
}

/** Freigaben für die Anzeige aufbereiten */
export async function describeShares(
	ctx: RequestContext,
	shares: readonly ShareRow[]
): Promise<GalleryShare[]> {
	if (shares.length === 0) return [];
	const infos = await describePrincipals(ctx, MODULE_ID, shares, {
		everyoneLabel: await everyoneLabel()
	});
	return infos.map((p, i) => ({
		type: p.type,
		id: p.id,
		name: p.name,
		detail: p.detail ?? null,
		color: p.color ?? null,
		image: p.image ?? null,
		level: shares[i]!.level
	}));
}

/** Detail aus den geladenen Daten bauen (Eigentümer*in, Termine, Freigaben auflösen) */
export async function finishDetail(ctx: RequestContext, d: DetailData): Promise<GalleryDetail> {
	const ownerId = String(d.gallery.owner_id);
	const confirmedBy = textOrNull(d.gallery.public_confirmed_by);
	const people = await core.users.directory(ctx, {
		ids: confirmedBy && confirmedBy !== ownerId ? [ownerId, confirmedBy] : [ownerId],
		limit: 2
	});
	const ownerUser = people.find((u) => u.id === ownerId);
	const confirmedUser = confirmedBy ? people.find((u) => u.id === confirmedBy) : undefined;
	const events = pickEvents(d.eventIds, await describeEvents(ctx, d.eventIds));
	const shares = d.access.level === 'edit' ? await describeShares(ctx, d.shares) : [];

	const images: GalleryImage[] = d.images.map((r, position) => {
		return {
			id: String(r.id),
			description: textOrNull(r.description),
			width: Number(r.width),
			height: Number(r.height),
			sizeBytes: Number(r.size_bytes),
			contentType: String(r.content_type),
			originalName: String(r.original_name),
			position,
			mediaType: mediaTypeOf(r),
			durationSeconds: durationOf(r),
			isPrivate: r.is_private === true || r.is_private === 't',
			uploadedBy: textOrNull(r.uploaded_by),
			createdAt: toIso(r.created_at)
		};
	});

	return {
		id: String(d.gallery.id),
		title: String(d.gallery.title),
		description: textOrNull(d.gallery.description),
		visibility: String(d.gallery.visibility) as Visibility,
		startsOn: textOrNull(d.gallery.starts_on),
		endsOn: textOrNull(d.gallery.ends_on),
		imageCount: images.length,
		cover: d.cover
			? { imageId: d.cover.imageId, width: d.cover.width, height: d.cover.height }
			: null,
		events,
		ownerId,
		access: d.access,
		createdAt: toIso(d.gallery.created_at),
		updatedAt: toIso(d.gallery.updated_at),
		owner:
			ownerUser && ownerUser.id === ownerId
				? { id: ownerUser.id, name: ownerUser.name, image: ownerUser.image }
				: null,
		publicConfirmation:
			d.gallery.public_confirmed_at == null
				? null
				: {
						at: toIso(d.gallery.public_confirmed_at),
						by: confirmedUser ? { id: confirmedUser.id, name: confirmedUser.name } : null
					},
		coverImageId: d.cover?.imageId ?? null,
		coverIsDefault: d.cover ? d.cover.isDefault : true,
		shares,
		images
	};
}
