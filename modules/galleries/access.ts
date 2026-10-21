/**
 * Objektbezogene Zugriffsprüfung für Galerien – Konfiguration des SDK-Bausteins `createShareAccess`
 * (Regeln dort; öffentliche Galerien sind für alle lesbar). `keys` = `principalKeysFor(ctx, 'galleries')`.
 */
import type { SQL } from 'drizzle-orm';
import { createShareAccess, type RequestContext } from '$lib/sdk/server';

export const galleryAccess = createShareAccess({
	table: 'galleries',
	shareTable: 'gallery_shares',
	fk: 'gallery_id',
	perms: { viewAll: 'galleries.gallery.view-all', editAll: 'galleries.gallery.edit-all' },
	readIf: { column: 'visibility', equals: 'public' },
	notFoundText: 'Galerie nicht gefunden',
	forbiddenText: 'Keine Berechtigung zum Bearbeiten dieser Galerie'
});

export const { canEditAll, canViewAll, resolveAccess, requireAccess, accessForMany } =
	galleryAccess;
export const { loadShares, replaceShares } = galleryAccess;

/** SQL-Bedingung für Listen (Alias `g` für `galleries`): alles oder eigene + öffentliche + freigegebene */
export const visibleGalleriesFilter = (ctx: RequestContext, keys: readonly string[]): SQL =>
	galleryAccess.visibleFilter(ctx, keys, 'g');
