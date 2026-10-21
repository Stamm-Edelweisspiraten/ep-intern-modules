/**
 * Artikel-Endpoints des Moduls `orders`: Katalog/Verwaltungsliste, Anlegen, Bearbeiten (Varianten
 * ersetzen, bestellte Varianten archivieren), Löschen bzw. Archivieren, Reihenfolge.
 * Feste Pfade (`/articles/order`) stehen vor `/articles/:id`.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import {
	canManageArticles,
	loadArticleOr404,
	loadArticles,
	requireArticleRow,
	usedVariantIds
} from './articles.service';
import { idList, mdb, rows } from './db';
import { removeFiles } from './files';
import {
	MAX_ARTICLES,
	PERMISSIONS,
	articleInput,
	articleListQuery,
	articleOrderInput,
	articleUpdateInput,
	idParams,
	type Article
} from './schemas';
import type { z } from 'zod';

const tags = ['Modul: orders'];

type VariantList = z.output<typeof articleInput>['variants'];

/** Volle Verwaltungsansicht eines Artikels (nach Änderungen) */
const loadManaged = (tx: Tx, id: string) =>
	loadArticleOr404(tx, id, { includeArchived: true, manage: true });

async function insertVariants(tx: Tx, articleId: string, variants: VariantList): Promise<void> {
	for (const [i, v] of variants.entries()) {
		await tx.execute(
			sql`INSERT INTO article_variants (id, article_id, label, price_cents, reorder_url, min_stock, position)
				VALUES (${crypto.randomUUID()}, ${articleId}, ${v.label}, ${v.priceCents}, ${v.reorderUrl},
					${v.minStock}, ${i})`
		);
	}
}

/**
 * Varianten ersetzen: vorhandene (per `id`) aktualisieren, neue anlegen, fehlende archivieren
 * (verwendet bzw. Bestand > 0) oder löschen. Bestellungen behalten ihren Preis (Snapshot).
 */
async function replaceVariants(
	tx: Tx,
	articleId: string,
	variants: VariantList
): Promise<{ archived: number; removed: number }> {
	const existing = new Set(
		(await rows(tx, sql`SELECT id FROM article_variants WHERE article_id = ${articleId}`)).map(
			(r) => String(r.id)
		)
	);
	const issues: { path: (string | number)[]; message: string }[] = [];
	const seen = new Set<string>();
	variants.forEach((v, i) => {
		if (!v.id) return;
		if (!existing.has(v.id)) {
			issues.push({ path: ['variants', i, 'id'], message: 'Unbekannte Größe' });
		} else if (seen.has(v.id)) {
			issues.push({ path: ['variants', i, 'id'], message: 'Größe doppelt' });
		}
		seen.add(v.id);
	});
	if (issues.length) throw errors.validation(issues);

	for (const [i, v] of variants.entries()) {
		if (v.id) {
			await tx.execute(
				sql`UPDATE article_variants SET label = ${v.label}, price_cents = ${v.priceCents},
						reorder_url = ${v.reorderUrl}, min_stock = ${v.minStock}, position = ${i},
						archived_at = NULL
					WHERE id = ${v.id} AND article_id = ${articleId}`
			);
		} else {
			await tx.execute(
				sql`INSERT INTO article_variants (id, article_id, label, price_cents, reorder_url, min_stock, position)
					VALUES (${crypto.randomUUID()}, ${articleId}, ${v.label}, ${v.priceCents}, ${v.reorderUrl},
						${v.minStock}, ${i})`
			);
		}
	}

	const missing = [...existing].filter((id) => !seen.has(id));
	if (!missing.length) return { archived: 0, removed: 0 };
	const used = await usedVariantIds(tx, missing);
	const toArchive = missing.filter((id) => used.has(id));
	const toDelete = missing.filter((id) => !used.has(id));
	if (toArchive.length) {
		await tx.execute(
			sql`UPDATE article_variants SET archived_at = COALESCE(archived_at, now())
				WHERE id IN (${idList(toArchive)})`
		);
	}
	if (toDelete.length) {
		await tx.execute(sql`DELETE FROM article_variants WHERE id IN (${idList(toDelete)})`);
	}
	return { archived: toArchive.length, removed: toDelete.length };
}

export const articlesEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/articles',
		summary: 'Artikel (Katalog oder Verwaltung)',
		description:
			'`scope=catalog` (Standard): aktive Artikel mit mindestens einer aktiven Größe. ' +
			'`scope=all`: alle inkl. inaktiver/archivierter (nur mit Artikel- oder Lagerrecht).',
		tags,
		permission: PERMISSIONS.view,
		query: articleListQuery,
		handler: async ({ ctx, query }): Promise<Article[]> => {
			const manage = canManageArticles(ctx);
			if (query.scope === 'all' && !manage) {
				throw errors.forbidden('Nur mit Artikel- oder Lagerrecht');
			}
			return mdb().transaction((tx) =>
				loadArticles(tx, { includeArchived: query.scope === 'all', manage })
			);
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/articles/order',
		summary: 'Reihenfolge der Artikel festlegen',
		description: '`ids` = alle nicht archivierten Artikel genau einmal.',
		tags,
		permission: PERMISSIONS.articles,
		body: articleOrderInput,
		handler: async ({ ctx, body }): Promise<Article[]> => {
			const list = await mdb().transaction(async (tx) => {
				const current = (
					await rows(tx, sql`SELECT id FROM articles WHERE archived_at IS NULL`)
				).map((r) => String(r.id));
				const given = new Set(body.ids);
				const valid =
					given.size === body.ids.length &&
					body.ids.length === current.length &&
					current.every((id) => given.has(id));
				if (!valid) {
					throw errors.validation([
						{ path: ['ids'], message: 'Alle Artikel müssen genau einmal enthalten sein' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE articles SET position = ${i} WHERE id = ${id}`);
				}
				return loadArticles(tx, { includeArchived: true, manage: true });
			});
			await core.audit.logFromContext(ctx, 'orders.article.reordered', {
				metadata: { count: body.ids.length }
			});
			return list;
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/articles/:id',
		summary: 'Artikel abrufen',
		description: 'Inaktive oder archivierte Artikel nur mit Artikel- oder Lagerrecht (sonst 404).',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Article> => {
			const manage = canManageArticles(ctx);
			return mdb().transaction((tx) =>
				loadArticleOr404(tx, params.id, { includeArchived: manage, manage })
			);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/articles',
		summary: 'Artikel anlegen',
		description: 'Neue Artikel kommen ans Ende der Reihenfolge.',
		tags,
		permission: PERMISSIONS.articles,
		body: articleInput,
		handler: async ({ ctx, body }): Promise<Article> => {
			const id = crypto.randomUUID();
			const article = await mdb().transaction(async (tx) => {
				// Sperre bis Transaktionsende: parallele Anlagen bekommen eindeutige Positionen und die
				// Höchstzahl gilt auch unter Nebenläufigkeit (#73, 07-12)
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('orders:articles'))`);
				const [r] = await rows(
					tx,
					sql`SELECT count(*)::int AS n FROM articles WHERE archived_at IS NULL`
				);
				if (Number(r?.n ?? 0) >= MAX_ARTICLES) {
					throw errors.conflict(`Höchstens ${MAX_ARTICLES} Artikel`);
				}
				await tx.execute(
					sql`INSERT INTO articles (id, title, description, notes, reorder_url, active, position, created_by)
						VALUES (${id}, ${body.title}, ${body.description}, ${body.notes}, ${body.reorderUrl},
							${body.active}, (SELECT COALESCE(MAX(position), -1) + 1 FROM articles),
							${ctx.userId ?? null})`
				);
				await insertVariants(tx, id, body.variants);
				return loadManaged(tx, id);
			});
			await core.audit.logFromContext(ctx, 'orders.article.created', {
				target: id,
				metadata: { title: article.title, variants: body.variants.length, active: body.active }
			});
			return article;
		}
	}),

	defineEndpoint({
		method: 'PATCH',
		path: '/articles/:id',
		summary: 'Artikel bearbeiten',
		description:
			'Nur übergebene Felder. `variants` ersetzt die Liste: vorhandene per `id` aktualisieren, ' +
			'neue anlegen, fehlende archivieren (bestellt/Bestand) oder löschen. Bestehende Bestellungen ' +
			'behalten ihren Preis.',
		tags,
		permission: PERMISSIONS.articles,
		params: idParams,
		body: articleUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Article> => {
			const { article, changes } = await mdb().transaction(async (tx) => {
				await requireArticleRow(tx, params.id);
				const sets = [sql`updated_at = now()`];
				if (body.title !== undefined) sets.push(sql`title = ${body.title}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.reorderUrl !== undefined) sets.push(sql`reorder_url = ${body.reorderUrl}`);
				if (body.active !== undefined) sets.push(sql`active = ${body.active}`);
				await tx.execute(
					sql`UPDATE articles SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				const changes = body.variants
					? await replaceVariants(tx, params.id, body.variants)
					: { archived: 0, removed: 0 };
				return { article: await loadManaged(tx, params.id), changes };
			});
			await core.audit.logFromContext(ctx, 'orders.article.updated', {
				target: params.id,
				metadata: {
					title: article.title,
					fields: Object.keys(body).sort(),
					archivedVariants: changes.archived,
					removedVariants: changes.removed
				}
			});
			return article;
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/articles/:id',
		summary: 'Artikel löschen (oder archivieren, wenn bereits verwendet)',
		description:
			'Mit Bestellungen, Einkauf, Lagerbewegungen oder Bestand wird der Artikel archiviert und ' +
			'deaktiviert (`{ deleted: false, archived: true }`), sonst samt Bildern gelöscht.',
		tags,
		permission: PERMISSIONS.articles,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const result = await mdb().transaction(async (tx) => {
				const row = await requireArticleRow(tx, params.id);
				const variantIds = (
					await rows(tx, sql`SELECT id FROM article_variants WHERE article_id = ${params.id}`)
				).map((r) => String(r.id));
				const used = await usedVariantIds(tx, variantIds);
				if (used.size > 0) {
					await tx.execute(
						sql`UPDATE articles SET archived_at = COALESCE(archived_at, now()), active = false,
								updated_at = now()
							WHERE id = ${params.id}`
					);
					return { title: String(row.title), archived: true, paths: [] as string[] };
				}
				const paths = (
					await rows(
						tx,
						sql`SELECT thumb_path, web_path FROM article_images WHERE article_id = ${params.id}`
					)
				).flatMap((r) => [String(r.thumb_path), String(r.web_path)]);
				await tx.execute(sql`DELETE FROM articles WHERE id = ${params.id}`);
				return { title: String(row.title), archived: false, paths };
			});
			if (result.archived) {
				await core.audit.logFromContext(ctx, 'orders.article.archived', {
					target: params.id,
					metadata: { title: result.title }
				});
				return { deleted: false, archived: true };
			}
			await removeFiles(result.paths);
			await core.audit.logFromContext(ctx, 'orders.article.deleted', {
				target: params.id,
				metadata: { title: result.title, images: result.paths.length / 2 }
			});
			return { deleted: true };
		}
	})
] as ApiEndpoint[];
