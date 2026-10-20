/**
 * Laden und Aufbauen von Galerien (Liste, Detail) sowie Freigaben schreiben.
 * Funktionen mit `tx` laufen in der Modul-Transaktion (nur Datenbank); alle anderen rufen Core-Dienste
 * auf und dürfen NIE innerhalb einer offenen Modul-Transaktion laufen (PGlite, eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import { core, describePrincipals, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import { requireAccess, rowsOf } from './access';
import { db, effectiveCover, eventsService } from './files';
import {
	MODULE_ID,
	type EventRef,
	type GalleryAccess,
	type GalleryDetail,
	type GalleryImage,
	type GalleryShare,
	type ShareInput,
	type ShareLevel,
	type Visibility
} from './schemas';

type Row = Record<string, unknown>;

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

export const iso = (v: unknown): string => new Date(String(v)).toISOString();
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

/** `%`, `_` und `\` für ILIKE maskieren */
export const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------------------
// In der Transaktion
// ---------------------------------------------------------------------------

export async function loadShares(tx: Tx, galleryId: string): Promise<ShareRow[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT principal_type, principal_id, level FROM gallery_shares
			WHERE gallery_id = ${galleryId} ORDER BY created_at, principal_type, principal_id`
	);
	return rows.map((r) => ({
		type: String(r.principal_type) as ShareRow['type'],
		id: String(r.principal_id),
		level: String(r.level) as ShareLevel
	}));
}

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

/** Freigaben vollständig ersetzen */
export async function replaceShares(
	tx: Tx,
	ctx: RequestContext,
	galleryId: string,
	shares: readonly ShareInput[]
): Promise<void> {
	await tx.execute(sql`DELETE FROM gallery_shares WHERE gallery_id = ${galleryId}`);
	for (const s of shares) {
		await tx.execute(
			sql`INSERT INTO gallery_shares (gallery_id, principal_type, principal_id, level, created_by)
				VALUES (${galleryId}, ${s.type}, ${s.id}, ${s.level}, ${ctx.userId ?? null})`
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
		sql`SELECT id, title, description, visibility, owner_id, created_at, updated_at
			FROM galleries WHERE id = ${galleryId}`
	);
	if (!gallery) throw errors.notFound('Galerie nicht gefunden');
	const images = await rowsOf(
		tx,
		sql`SELECT id, description, width, height, size_bytes, content_type, original_name,
				uploaded_by, created_at
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
	const [ownerUser] = await core.users.directory(ctx, { ids: [ownerId], limit: 1 });
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
			uploadedBy: textOrNull(r.uploaded_by),
			createdAt: iso(r.created_at)
		};
	});

	return {
		id: String(d.gallery.id),
		title: String(d.gallery.title),
		description: textOrNull(d.gallery.description),
		visibility: String(d.gallery.visibility) as Visibility,
		imageCount: images.length,
		cover: d.cover
			? { imageId: d.cover.imageId, width: d.cover.width, height: d.cover.height }
			: null,
		events,
		ownerId,
		access: d.access,
		createdAt: iso(d.gallery.created_at),
		updatedAt: iso(d.gallery.updated_at),
		owner:
			ownerUser && ownerUser.id === ownerId
				? { id: ownerUser.id, name: ownerUser.name, image: ownerUser.image }
				: null,
		coverImageId: d.cover?.imageId ?? null,
		coverIsDefault: d.cover ? d.cover.isDefault : true,
		shares,
		images
	};
}

/**
 * Galerie-Detail komplett laden und aufbauen (Zugriff `read` wird geprüft: fremd → 404).
 * Öffnet eine eigene Transaktion: nur AUSSERHALB einer offenen Modul-Transaktion aufrufen.
 * `keys` = `principalKeysFor(ctx, 'galleries')`.
 */
export async function buildGalleryDetail(
	ctx: RequestContext,
	galleryId: string,
	keys: readonly string[]
): Promise<GalleryDetail> {
	const data = await db().transaction((tx) => loadDetailData(tx, ctx, galleryId, keys));
	return finishDetail(ctx, data);
}
