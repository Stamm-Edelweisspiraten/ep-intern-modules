/**
 * Objektbezogene Zugriffsprüfung für Beiträge – Konfiguration des SDK-Bausteins `createShareAccess`.
 * Autor*in (`author_id`) und Personen mit `edit`-Freigabe („Mitschreiben“) bearbeiten; `website.post.publish`
 * sieht und bearbeitet alle Beiträge. `keys` = `principalKeysFor(ctx, 'website')`, VOR der Transaktion.
 */
import type { SQL } from 'drizzle-orm';
import { core, createShareAccess, type RequestContext } from '$lib/sdk/server';
import { PERM } from './schemas';

export const postAccess = createShareAccess({
	table: 'posts',
	shareTable: 'post_shares',
	fk: 'post_id',
	ownerColumn: 'author_id',
	perms: { viewAll: PERM.postPublish, editAll: PERM.postPublish },
	notFoundText: 'Beitrag nicht gefunden',
	forbiddenText: 'Keine Berechtigung zum Bearbeiten dieses Beitrags'
});

export const { requireAccess, accessForMany, loadShares, replaceShares } = postAccess;

/** Darf veröffentlichen, zurückziehen, löschen und Freigaben ändern (alle Beiträge) */
export const canPublish = (ctx: RequestContext): boolean =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, PERM.postPublish);

/** SQL-Bedingung für Listen (Alias `p`): alles mit `publish`, sonst eigene + freigegebene */
export const visiblePostsFilter = (ctx: RequestContext, keys: readonly string[]): SQL =>
	postAccess.visibleFilter(ctx, keys, 'p');
