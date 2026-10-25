/**
 * Datenschutz-Hooks. Beiträge sind Stammesinhalte und bleiben beim Löschen eines Kontos erhalten:
 * `author_id`/`created_by`/`uploaded_by` → `NULL` (die Website zeigt dann keine Autor*in, außer einer eingetragenen
 * Anzeige), Freigaben an das Konto entfallen. Datenauskunft: eigene Beiträge (ohne Text) und Freigaben.
 */
import { sql } from 'drizzle-orm';
import {
	rowsOf,
	toIso,
	toIsoOrNull,
	type ModuleDefinition,
	type ModuleSubjectExport
} from '$lib/sdk/server';
import { db } from './files';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	await tx.execute(
		sql`DELETE FROM post_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	await tx.execute(sql`UPDATE posts SET author_id = NULL WHERE author_id = ${userId}`);
	await tx.execute(sql`UPDATE posts SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE post_images SET uploaded_by = NULL WHERE uploaded_by = ${userId}`);
	await tx.execute(sql`UPDATE post_shares SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE banners SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE faqs SET created_by = NULL WHERE created_by = ${userId}`);
};

export const subjectExport: ModuleSubjectExport = {
	run: async ({ userId }) => {
		if (!userId) return null;
		const data = await db().transaction(async (tx) => ({
			posts: await rowsOf(
				tx,
				sql`SELECT id, slug, title, status, published_at, author_name_override, created_at, updated_at
					FROM posts WHERE author_id = ${userId} ORDER BY created_at, id`
			),
			shares: await rowsOf(
				tx,
				sql`SELECT s.post_id, p.title, s.created_at FROM post_shares s JOIN posts p ON p.id = s.post_id
					WHERE s.principal_type = 'user' AND s.principal_id = ${userId} ORDER BY s.created_at, s.post_id`
			)
		}));
		if (!data.posts.length && !data.shares.length) return null;
		return {
			authoredPosts: data.posts.map((r) => ({
				id: String(r.id),
				slug: String(r.slug),
				title: String(r.title),
				status: String(r.status),
				publishedAt: toIsoOrNull(r.published_at),
				authorNameOverride: r.author_name_override ? String(r.author_name_override) : null,
				createdAt: toIso(r.created_at),
				updatedAt: toIso(r.updated_at)
			})),
			coAuthorShares: data.shares.map((r) => ({
				postId: String(r.post_id),
				postTitle: String(r.title),
				createdAt: toIso(r.created_at)
			}))
		};
	}
};
