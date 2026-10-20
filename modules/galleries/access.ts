/**
 * Objektbezogene Zugriffsprüfung für Galerien. Alle internen Galerie-Endpoints gehen hier durch.
 *
 * Regeln (die Basisberechtigung `galleries.gallery.view` prüft bereits der Router):
 *   - System-Kontext, `galleries.gallery.edit-all`              -> bearbeiten
 *   - Eigentümer*in (`owner_id`)                                -> bearbeiten
 *   - Freigabe `edit` an einen passenden Principal               -> bearbeiten
 *   - Freigabe `read`, `galleries.gallery.view-all`, `public`    -> lesen
 *   - sonst kein Zugriff (404, damit die Existenz nicht verraten wird)
 *
 * `keys` sind die Principal-Schlüssel des Aufrufers (`principalKeysFor(ctx, 'galleries')`),
 * immer VOR der Transaktion ermittelt.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, errors, principalMatchSql, type RequestContext, type Tx } from '$lib/sdk/server';
import type { GalleryAccess } from './schemas';

type Row = Record<string, unknown>;

export async function rowsOf(tx: Tx, query: SQL): Promise<Row[]> {
	const res = (await tx.execute(query)) as unknown as { rows: Row[] };
	return res.rows;
}

export function canEditAll(ctx: RequestContext): boolean {
	return ctx.actor.type === 'system' || core.permissions.has(ctx, 'galleries.gallery.edit-all');
}

export function canViewAll(ctx: RequestContext): boolean {
	return canEditAll(ctx) || core.permissions.has(ctx, 'galleries.gallery.view-all');
}

/** Zugriff des Kontexts auf eine Galerie oder `null` (nicht vorhanden / kein Zugriff). */
export async function resolveAccess(
	tx: Tx,
	ctx: RequestContext,
	galleryId: string,
	keys: readonly string[]
): Promise<GalleryAccess | null> {
	const [gallery] = await rowsOf(
		tx,
		sql`SELECT owner_id, visibility FROM galleries WHERE id = ${galleryId}`
	);
	if (!gallery) return null;
	const isOwner = !!ctx.userId && String(gallery.owner_id) === ctx.userId;

	if (canEditAll(ctx)) return { level: 'edit', isOwner };
	if (isOwner) return { level: 'edit', isOwner: true };

	const shares = await rowsOf(
		tx,
		sql`SELECT s.level FROM gallery_shares s
			WHERE s.gallery_id = ${galleryId} AND ${principalMatchSql('s', keys)}`
	);
	if (shares.some((s) => s.level === 'edit')) return { level: 'edit', isOwner: false };
	if (
		shares.length > 0 ||
		gallery.visibility === 'public' ||
		core.permissions.has(ctx, 'galleries.gallery.view-all')
	) {
		return { level: 'read', isOwner: false };
	}
	return null;
}

/** Wie `resolveAccess`, wirft aber `notFound` ohne Zugriff und `forbidden` bei fehlendem `edit`. */
export async function requireAccess(
	tx: Tx,
	ctx: RequestContext,
	galleryId: string,
	keys: readonly string[],
	need: 'read' | 'edit' = 'read'
): Promise<GalleryAccess> {
	const access = await resolveAccess(tx, ctx, galleryId, keys);
	if (!access) throw errors.notFound('Galerie nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieser Galerie');
	}
	return access;
}

/** SQL-Bedingung für Listen (Alias `g` für `galleries`): alles oder eigene + öffentliche + freigegebene. */
export function visibleGalleriesFilter(ctx: RequestContext, keys: readonly string[]): SQL {
	if (canViewAll(ctx)) return sql`TRUE`;
	const uid = ctx.userId ?? '';
	return sql`(g.owner_id = ${uid} OR g.visibility = 'public' OR EXISTS (
		SELECT 1 FROM gallery_shares s WHERE s.gallery_id = g.id AND ${principalMatchSql('s', keys)}
	))`;
}

/**
 * Zugriffsstufe je Galerie für Listen (ein Abfrageschritt für alle Zeilen). Galerien ohne
 * Bearbeiten-Treffer bekommen `read` (sie sind nur über Freigabe/`public`/`view-all` sichtbar).
 */
export async function accessForMany(
	tx: Tx,
	ctx: RequestContext,
	rows: readonly { id: string; ownerId: string }[],
	keys: readonly string[]
): Promise<Map<string, GalleryAccess>> {
	const map = new Map<string, GalleryAccess>();
	if (rows.length === 0) return map;
	const editAll = canEditAll(ctx);
	const editShared = new Set<string>();
	if (!editAll) {
		const ids = rows.map((r) => r.id);
		const shareRows = await rowsOf(
			tx,
			sql`SELECT DISTINCT s.gallery_id FROM gallery_shares s
				WHERE s.level = 'edit'
					AND s.gallery_id IN (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `
					)})
					AND ${principalMatchSql('s', keys)}`
		);
		for (const r of shareRows) editShared.add(String(r.gallery_id));
	}
	for (const r of rows) {
		const isOwner = !!ctx.userId && r.ownerId === ctx.userId;
		const edit = editAll || isOwner || editShared.has(r.id);
		map.set(r.id, { level: edit ? 'edit' : 'read', isOwner });
	}
	return map;
}
