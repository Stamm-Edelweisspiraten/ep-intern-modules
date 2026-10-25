/**
 * Benachrichtigungen zum Blog (core.notifications): zum Mitschreiben eingeladen (neu hinzugekommene
 * Freigaben) und Beitrag veröffentlicht/zurückgezogen (an Autor*in und Mitschreibende mit Bearbeiten-Recht).
 * Nie an die handelnde Person. Immer nach der Transaktion; wirft nie.
 */
import { sql } from 'drizzle-orm';
import {
	addedPrincipals,
	bestEffort,
	core,
	moduleDb,
	principalUserIds,
	rowsOf,
	type Principal,
	type RequestContext
} from '$lib/sdk/server';
import { MODULE_ID, NOTIFY_POST_INVITED, NOTIFY_POST_STATUS, PERM } from './schemas';

const postLink = (id: string) => `/modules/website/posts/${encodeURIComponent(id)}`;

async function postInfo(id: string) {
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const [post] = await rowsOf(tx, sql`SELECT title, author_id FROM posts WHERE id = ${id}`);
		const shares = await rowsOf(
			tx,
			sql`SELECT principal_type, principal_id FROM post_shares
				WHERE post_id = ${id} AND level = 'edit'`
		);
		return post
			? {
					title: String(post.title),
					authorId: post.author_id ? String(post.author_id) : null,
					editors: shares.map((s) => ({
						type: String(s.principal_type),
						id: String(s.principal_id)
					})) as Principal[]
				}
			: null;
	});
}

async function actorName(ctx: RequestContext): Promise<string> {
	const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
	return me?.name ?? 'Jemand';
}

/** Zum Mitschreiben eingeladen */
export async function notifyPostInvited(
	ctx: RequestContext,
	postId: string,
	before: readonly Principal[],
	after: readonly Principal[]
): Promise<void> {
	const added = addedPrincipals(before, after).filter((p) => p.type !== 'everyone');
	if (!added.length) return;
	await bestEffort(
		'website.notify.invited',
		async () => {
			const info = await postInfo(postId);
			if (!info) return;
			const userIds = await principalUserIds(MODULE_ID, added, {
				permission: PERM.postWrite,
				exclude: [ctx.userId]
			});
			if (!userIds.length) return;
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_POST_INVITED,
					userIds,
					title: `Mitschreiben: ${info.title}`,
					body: `${await actorName(ctx)} hat dich eingeladen, am Beitrag „${info.title}“ mitzuschreiben.`,
					link: postLink(postId)
				}
			]);
		},
		{ ctx, target: postId }
	);
}

/** Beitrag veröffentlicht (ggf. geplant) bzw. zurückgezogen */
export async function notifyPostStatus(
	ctx: RequestContext,
	postId: string,
	status: 'published' | 'scheduled' | 'unpublished'
): Promise<void> {
	await bestEffort(
		'website.notify.status',
		async () => {
			const info = await postInfo(postId);
			if (!info) return;
			const userIds = await principalUserIds(
				MODULE_ID,
				[...info.editors, ...(info.authorId ? [{ type: 'user', id: info.authorId } as Principal] : [])],
				{ permission: PERM.postWrite, exclude: [ctx.userId] }
			);
			if (!userIds.length) return;
			const who = await actorName(ctx);
			const text =
				status === 'unpublished'
					? {
							title: `Beitrag zurückgezogen: ${info.title}`,
							body: `${who} hat den Beitrag „${info.title}“ zurückgezogen; er ist wieder ein Entwurf.`
						}
					: {
							title: `Beitrag ${status === 'scheduled' ? 'geplant' : 'veröffentlicht'}: ${info.title}`,
							body:
								status === 'scheduled'
									? `${who} hat den Beitrag „${info.title}“ zur Veröffentlichung eingeplant.`
									: `${who} hat den Beitrag „${info.title}“ auf der Website veröffentlicht.`
						};
			await core.notifications.send(ctx, MODULE_ID, [
				{ type: NOTIFY_POST_STATUS, userIds, ...text, link: postLink(postId) }
			]);
		},
		{ ctx, target: postId }
	);
}
