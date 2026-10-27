/**
 * Lagerorte, Kategorien und Artikel des Moduls `material`.
 * Feste Pfade stehen vor `/:id`.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { mdb, nextCodes, num, rows, str, type Row } from './db';
import { removeFiles } from './files';
import { loadPlaceIndex } from './inventory';
import { wouldCycle } from './places';
import {
	PERMISSIONS,
	articleInput,
	articleListQuery,
	articleUpdateInput,
	categoryInput,
	categoryUpdateInput,
	idParams,
	imageUrl,
	locationInput,
	locationUpdateInput,
	type Article,
	type ArticleImage,
	type ArticleKind,
	type Category,
	type Location
} from './schemas';
import { z } from 'zod';

const tags = ['Modul: material'];

// --- Lagerorte -----------------------------------------------------------------

async function loadLocations(tx: Tx): Promise<Location[]> {
	const index = await loadPlaceIndex(tx);
	const list = await rows(
		tx,
		sql`SELECT l.id, l.parent_id, l.name, l.description, l.code, l.position,
				(SELECT count(*) FROM units u WHERE u.location_id = l.id AND u.retired_at IS NULL) AS unit_count
			FROM locations l`
	);
	return list
		.map((r) => ({
			id: String(r.id),
			parentId: r.parent_id ? String(r.parent_id) : null,
			name: String(r.name),
			description: str(r.description),
			code: String(r.code),
			path: index.locationPaths.get(String(r.id)) ?? String(r.name),
			position: num(r.position),
			unitCount: num(r.unit_count)
		}))
		.sort((a, b) => a.path.localeCompare(b.path, 'de'));
}

async function requireLocation(tx: Tx, id: string): Promise<Row> {
	const [r] = await rows(tx, sql`SELECT id, parent_id, name FROM locations WHERE id = ${id}`);
	if (!r) throw errors.notFound('Lagerort nicht gefunden');
	return r;
}

async function assertParent(tx: Tx, id: string | null, parentId: string | null): Promise<void> {
	if (!parentId) return;
	const [p] = await rows(tx, sql`SELECT id FROM locations WHERE id = ${parentId}`);
	if (!p) throw errors.validation([{ path: ['parentId'], message: 'Übergeordneter Ort fehlt' }]);
	if (!id) return;
	const parents = new Map(
		(await rows(tx, sql`SELECT id, parent_id FROM locations`)).map((r) => [
			String(r.id),
			r.parent_id ? String(r.parent_id) : null
		])
	);
	if (wouldCycle(parents, id, parentId)) {
		throw errors.validation([
			{ path: ['parentId'], message: 'Ein Ort kann nicht in sich selbst liegen' }
		]);
	}
}

// --- Kategorien ----------------------------------------------------------------

async function loadCategories(tx: Tx): Promise<Category[]> {
	return (
		await rows(
			tx,
			sql`SELECT c.id, c.name, c.color, c.icon,
					(SELECT count(*) FROM articles a WHERE a.category_id = c.id AND a.archived_at IS NULL) AS n
				FROM categories c ORDER BY c.position, lower(c.name)`
		)
	).map((r) => ({
		id: String(r.id),
		name: String(r.name),
		color: r.color ? String(r.color) : null,
		icon: r.icon ? String(r.icon) : null,
		articleCount: num(r.n)
	}));
}

// --- Artikel -------------------------------------------------------------------

function toImage(r: Row): ArticleImage {
	const articleId = String(r.article_id);
	const id = String(r.id);
	return {
		id,
		width: num(r.width),
		height: num(r.height),
		thumbUrl: imageUrl(articleId, id, 'thumb'),
		webUrl: imageUrl(articleId, id, 'web')
	};
}

export async function loadArticles(
	tx: Tx,
	filter: {
		ids?: string[];
		search?: string;
		categoryId?: string;
		kind?: ArticleKind;
		archived?: boolean;
	} = {}
): Promise<Article[]> {
	const where = [sql`TRUE`];
	if (filter.ids) {
		if (!filter.ids.length) return [];
		where.push(
			sql`a.id::text IN (${sql.join(
				filter.ids.map((id) => sql`${id}`),
				sql`, `
			)})`
		);
	}
	if (!filter.archived) where.push(sql`a.archived_at IS NULL`);
	if (filter.categoryId) where.push(sql`a.category_id = ${filter.categoryId}`);
	if (filter.kind) where.push(sql`a.kind = ${filter.kind}`);
	if (filter.search) {
		const like = `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		where.push(sql`(a.name ILIKE ${like} OR a.description ILIKE ${like})`);
	}
	const list = await rows(
		tx,
		sql`SELECT a.id, a.name, a.category_id, c.name AS category_name, c.color AS category_color,
				c.icon AS category_icon, a.kind, a.unit_label, a.description, a.notes, a.min_quantity,
				a.archived_at,
				(SELECT count(*) FROM units u WHERE u.article_id = a.id AND u.retired_at IS NULL) AS unit_count,
				(SELECT count(*) FROM units u WHERE u.article_id = a.id AND u.retired_at IS NULL
					AND u.condition NOT IN ('defect', 'lost')) AS usable_count,
				(SELECT coalesce(sum(s.quantity), 0) FROM stock s WHERE s.article_id = a.id) AS stock_total,
				(SELECT count(*) FROM units u WHERE u.article_id = a.id AND u.issued_reservation_id IS NOT NULL)
					+ (SELECT coalesce(sum(l.issued_qty - l.returned_qty), 0) FROM reservation_lines l
						JOIN reservations r ON r.id = l.reservation_id
						WHERE l.article_id = a.id AND a.kind = 'bulk' AND r.status = 'issued') AS issued_count
			FROM articles a LEFT JOIN categories c ON c.id = a.category_id
			WHERE ${sql.join(where, sql` AND `)}
			ORDER BY lower(a.name)`
	);
	if (!list.length) return [];
	const images = await rows(
		tx,
		sql`SELECT id, article_id, width, height FROM article_images
			WHERE article_id::text IN (${sql.join(
				list.map((r) => sql`${String(r.id)}`),
				sql`, `
			)})
			ORDER BY position, created_at, id`
	);
	const imagesBy = new Map<string, ArticleImage[]>();
	for (const r of images) {
		const key = String(r.article_id);
		const l = imagesBy.get(key) ?? [];
		l.push(toImage(r));
		imagesBy.set(key, l);
	}
	return list.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		categoryId: r.category_id ? String(r.category_id) : null,
		categoryName: r.category_name ? String(r.category_name) : null,
		categoryColor: r.category_color ? String(r.category_color) : null,
		categoryIcon: r.category_icon ? String(r.category_icon) : null,
		kind: String(r.kind) as ArticleKind,
		unitLabel: str(r.unit_label) || 'Stück',
		description: str(r.description),
		notes: str(r.notes),
		minQuantity: num(r.min_quantity),
		archived: r.archived_at != null,
		images: imagesBy.get(String(r.id)) ?? [],
		unitCount: num(r.unit_count),
		usableCount: num(r.usable_count),
		stockTotal: num(r.stock_total),
		issuedCount: num(r.issued_count)
	}));
}

export async function requireArticle(tx: Tx, id: string): Promise<Article> {
	const [a] = await loadArticles(tx, { ids: [id], archived: true });
	if (!a) throw errors.notFound('Artikel nicht gefunden');
	return a;
}

async function assertCategory(tx: Tx, id: string | null | undefined): Promise<void> {
	if (!id) return;
	const [c] = await rows(tx, sql`SELECT id FROM categories WHERE id = ${id}`);
	if (!c) throw errors.validation([{ path: ['categoryId'], message: 'Kategorie fehlt' }]);
}

export const catalogEndpoints: AnyApiEndpoint[] = [
	// Lagerorte
	defineEndpoint({
		method: 'GET',
		path: '/locations',
		summary: 'Lagerorte (mit Pfad)',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(loadLocations)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/locations',
		summary: 'Lagerort anlegen',
		tags,
		permission: PERMISSIONS.manage,
		body: locationInput,
		handler: async ({ ctx, body }): Promise<Location> => {
			const id = crypto.randomUUID();
			const list = await mdb().transaction(async (tx) => {
				await assertParent(tx, null, body.parentId);
				const [code] = await nextCodes(tx, 'location', 1);
				await tx.execute(
					sql`INSERT INTO locations (id, parent_id, name, description, code, position)
						VALUES (${id}, ${body.parentId}, ${body.name}, ${body.description}, ${code!},
							(SELECT coalesce(max(position), -1) + 1 FROM locations))`
				);
				return loadLocations(tx);
			});
			await core.audit.logFromContext(ctx, 'material.location.created', { target: id });
			return list.find((l) => l.id === id)!;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/locations/:id',
		summary: 'Lagerort bearbeiten',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: locationUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Location> => {
			const list = await mdb().transaction(async (tx) => {
				await requireLocation(tx, params.id);
				if (body.parentId !== undefined) await assertParent(tx, params.id, body.parentId);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				if (body.parentId !== undefined) sets.push(sql`parent_id = ${body.parentId}`);
				await tx.execute(
					sql`UPDATE locations SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				return loadLocations(tx);
			});
			await core.audit.logFromContext(ctx, 'material.location.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body).sort() }
			});
			return list.find((l) => l.id === params.id)!;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/locations/:id',
		summary: 'Lagerort löschen (nur leer)',
		description: 'Mit Unterorten, Stücken oder Bestand → 409.',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				await requireLocation(tx, params.id);
				const [r] = await rows(
					tx,
					sql`SELECT
						(SELECT count(*) FROM locations WHERE parent_id = ${params.id}) AS children,
						(SELECT count(*) FROM units WHERE location_id = ${params.id}) AS units,
						(SELECT count(*) FROM stock WHERE location_id = ${params.id} AND quantity > 0) AS stock`
				);
				if (num(r?.children) > 0) throw errors.conflict('Der Ort hat noch Unterorte');
				if (num(r?.units) > 0 || num(r?.stock) > 0) {
					throw errors.conflict('Am Ort liegt noch Material – bitte erst umlagern');
				}
				await tx.execute(sql`DELETE FROM stock WHERE location_id = ${params.id}`);
				await tx.execute(sql`DELETE FROM locations WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.location.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	// Kategorien
	defineEndpoint({
		method: 'GET',
		path: '/categories',
		summary: 'Kategorien',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(loadCategories)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/categories',
		summary: 'Kategorie anlegen',
		tags,
		permission: PERMISSIONS.manage,
		body: categoryInput,
		handler: async ({ ctx, body }): Promise<Category> => {
			const id = crypto.randomUUID();
			const list = await mdb().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('material:categories'))`);
				await tx.execute(
					sql`INSERT INTO categories (id, name, color, icon, position)
						VALUES (${id}, ${body.name}, ${body.color}, ${body.icon},
							(SELECT coalesce(max(position), -1) + 1 FROM categories))`
				);
				return loadCategories(tx);
			});
			await core.audit.logFromContext(ctx, 'material.category.created', { target: id });
			return list.find((c) => c.id === id)!;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/categories/:id',
		summary: 'Kategorie bearbeiten',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: categoryUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Category> => {
			const list = await mdb().transaction(async (tx) => {
				const sets = [sql`id = id`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.color !== undefined) sets.push(sql`color = ${body.color}`);
				if (body.icon !== undefined) sets.push(sql`icon = ${body.icon}`);
				const res = await rows(
					tx,
					sql`UPDATE categories SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Kategorie nicht gefunden');
				return loadCategories(tx);
			});
			await core.audit.logFromContext(ctx, 'material.category.updated', { target: params.id });
			return list.find((c) => c.id === params.id)!;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/categories/:id',
		summary: 'Kategorie löschen (Artikel bleiben ohne Kategorie)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const res = await rows(
					tx,
					sql`DELETE FROM categories WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Kategorie nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'material.category.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	// Artikel
	defineEndpoint({
		method: 'GET',
		path: '/articles',
		summary: 'Artikel mit Zählern',
		description: '`archived=1` zeigt auch archivierte Artikel.',
		tags,
		permission: PERMISSIONS.view,
		query: articleListQuery,
		handler: ({ query }) =>
			mdb().transaction((tx) =>
				loadArticles(tx, {
					search: query.search,
					categoryId: query.categoryId,
					kind: query.kind,
					archived: query.archived === '1'
				})
			)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/articles/:id',
		summary: 'Artikel abrufen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ params }) => mdb().transaction((tx) => requireArticle(tx, params.id))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/articles',
		summary: 'Artikel anlegen',
		tags,
		permission: PERMISSIONS.manage,
		body: articleInput,
		handler: async ({ ctx, body }): Promise<Article> => {
			const id = crypto.randomUUID();
			const article = await mdb().transaction(async (tx) => {
				await assertCategory(tx, body.categoryId);
				await tx.execute(
					sql`INSERT INTO articles (id, name, category_id, kind, unit_label, description, notes, min_quantity, created_by)
						VALUES (${id}, ${body.name}, ${body.categoryId}, ${body.kind}, ${body.unitLabel},
							${body.description}, ${body.notes}, ${body.minQuantity}, ${ctx.userId ?? null})`
				);
				return requireArticle(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.article.created', {
				target: id,
				metadata: { kind: body.kind }
			});
			return article;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/articles/:id',
		summary: 'Artikel bearbeiten',
		description: 'Die Art (Einzelstücke/Menge) ist nach dem Anlegen fest.',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: articleUpdateInput.extend({ archived: z.boolean().optional() }),
		handler: async ({ ctx, params, body }): Promise<Article> => {
			const article = await mdb().transaction(async (tx) => {
				await requireArticle(tx, params.id);
				if (body.categoryId !== undefined) await assertCategory(tx, body.categoryId);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.categoryId !== undefined) sets.push(sql`category_id = ${body.categoryId}`);
				if (body.unitLabel !== undefined) sets.push(sql`unit_label = ${body.unitLabel}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.minQuantity !== undefined) sets.push(sql`min_quantity = ${body.minQuantity}`);
				if (body.archived !== undefined) {
					sets.push(
						body.archived
							? sql`archived_at = coalesce(archived_at, now())`
							: sql`archived_at = NULL`
					);
				}
				await tx.execute(
					sql`UPDATE articles SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				return requireArticle(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.article.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body).sort() }
			});
			return article;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/articles/:id',
		summary: 'Artikel löschen (oder archivieren, wenn verwendet)',
		description:
			'Mit Stücken, Bestand, Set-Vorlagen oder Reservierungen wird archiviert (`{ deleted: false, archived: true }`).',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const result = await mdb().transaction(async (tx) => {
				await requireArticle(tx, params.id);
				const [r] = await rows(
					tx,
					sql`SELECT
						(SELECT count(*) FROM units WHERE article_id = ${params.id}) +
						(SELECT count(*) FROM stock WHERE article_id = ${params.id} AND quantity > 0) +
						(SELECT count(*) FROM set_template_parts WHERE article_id = ${params.id}) +
						(SELECT count(*) FROM reservation_lines WHERE article_id = ${params.id}) AS used`
				);
				if (num(r?.used) > 0) {
					await tx.execute(
						sql`UPDATE articles SET archived_at = coalesce(archived_at, now()), updated_at = now()
							WHERE id = ${params.id}`
					);
					return { archived: true, paths: [] as string[] };
				}
				const paths = (
					await rows(
						tx,
						sql`SELECT thumb_path, web_path FROM article_images WHERE article_id = ${params.id}`
					)
				).flatMap((x) => [String(x.thumb_path), String(x.web_path)]);
				await tx.execute(sql`DELETE FROM articles WHERE id = ${params.id}`);
				return { archived: false, paths };
			});
			if (result.archived) {
				await core.audit.logFromContext(ctx, 'material.article.archived', { target: params.id });
				return { deleted: false, archived: true };
			}
			await removeFiles(result.paths);
			await core.audit.logFromContext(ctx, 'material.article.deleted', { target: params.id });
			return { deleted: true, archived: false };
		}
	})
];
