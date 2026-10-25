/**
 * Benachrichtigung „Galerie mit mir geteilt“ (core.notifications): an alle, die durch neu hinzugekommene
 * Freigaben (Person, Rolle, Gruppe, Mitglied – nicht „ganzer Stamm“) die Galerie sehen dürfen, ohne die
 * handelnde Person. Immer nach der Transaktion; wirft nie.
 */
import {
	addedPrincipals,
	bestEffort,
	core,
	principalUserIds,
	type Principal,
	type RequestContext
} from '$lib/sdk/server';
import { MODULE_ID, NOTIFY_GALLERY_SHARED } from './schemas';

export async function notifyGalleryShared(
	ctx: RequestContext,
	input: {
		galleryId: string;
		title: string;
		before: readonly Principal[];
		after: readonly Principal[];
	}
): Promise<void> {
	const added = addedPrincipals(input.before, input.after).filter((p) => p.type !== 'everyone');
	if (!added.length) return;
	await bestEffort(
		'galleries.notify.shared',
		async () => {
			const userIds = await principalUserIds(MODULE_ID, added, {
				permission: 'galleries.gallery.view',
				exclude: [ctx.userId]
			});
			if (!userIds.length) return;
			const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_GALLERY_SHARED,
					userIds,
					title: `Neue Galerie: ${input.title}`,
					body: `${me?.name ?? 'Jemand'} hat die Galerie „${input.title}“ mit dir geteilt.`,
					link: `/modules/galleries/${encodeURIComponent(input.galleryId)}`
				}
			]);
		},
		{ ctx, target: input.galleryId }
	);
}
