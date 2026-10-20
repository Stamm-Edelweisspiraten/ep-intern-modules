/**
 * Artikel laden (Katalog und Verwaltung) – nur Datenbankzugriffe, in einer offenen
 * `mdb().transaction` aufrufen. Von Endpoints anderer Bereiche (Bestellungen, Lager) nutzbar.
 */
import { sql } from 'drizzle-orm';
import { core, errors, type Tx } from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import { idList, iso, num, rows, str, type Row } from './db';
import { priceRange } from './stock';
import {
	PERMISSIONS,
	imageUrl,
	type Article,
	type ArticleImage,
	type ArticleVariant
} from './schemas';

export interface LoadArticlesOptions {
	/**
	 * `true` = Verwaltungsansicht: auch inaktive und archivierte Artikel (mit `manage` auch
	 * archivierte Varianten). `false` = Katalog: nur aktive, nicht archivierte Artikel mit
	 * mindestens einer aktiven Variante.
	 */
	includeArchived: boolean;
	/** Verwaltungsfelder (`notes`, `reorderUrl`, `stock`, `minStock`) ausgeben, sonst `null` */
	manage: boolean;
	/** Nur diese Artikel (leere Liste → keine) */
	ids?: string[];
}

/** Darf Verwaltungsfelder sehen und inaktive/archivierte Artikel abrufen */
export function canManageArticles(ctx: RequestContext): boolean {
	return (
		core.permissions.has(ctx, PERMISSIONS.articles) || core.permissions.has(ctx, PERMISSIONS.stock)
	);
}

/** Bildzeile → DTO */
export function toArticleImage(r: Row): ArticleImage {
	const articleId = String(r.article_id);
	const id = String(r.id);
	return {
		id,
		width: num(r.width),
		height: num(r.height),
		position: num(r.position),
		thumbUrl: imageUrl(articleId, id, 'thumb'),
		webUrl: imageUrl(articleId, id, 'web')
	};
}

function toVariant(r: Row, manage: boolean): ArticleVariant {
	return {
		id: String(r.id),
		label: String(r.label ?? ''),
		priceCents: num(r.price_cents),
		reorderUrl: manage ? str(r.reorder_url) : null,
		stock: manage ? num(r.stock) : null,
		minStock: manage ? num(r.min_stock) : null,
		position: num(r.position),
		archived: r.archived_at != null
	};
}

/** Artikel nach `position`, `title` (Varianten und Bilder nach `position`) */
export async function loadArticles(tx: Tx, opts: LoadArticlesOptions): Promise<Article[]> {
	if (opts.ids && opts.ids.length === 0) return [];
	const filters = [sql`TRUE`];
	if (opts.ids) filters.push(sql`a.id IN (${idList(opts.ids)})`);
	if (!opts.includeArchived) {
		filters.push(sql`a.active AND a.archived_at IS NULL`);
		filters.push(
			sql`EXISTS (SELECT 1 FROM article_variants v WHERE v.article_id = a.id AND v.archived_at IS NULL)`
		);
	}
	const articleRows = await rows(
		tx,
		sql`SELECT a.id, a.title, a.description, a.notes, a.reorder_url, a.active, a.position,
				a.archived_at, a.created_at, a.updated_at
			FROM articles a
			WHERE ${sql.join(filters, sql` AND `)}
			ORDER BY a.position, a.title, a.id`
	);
	if (!articleRows.length) return [];
	const ids = articleRows.map((r) => String(r.id));
	const withArchivedVariants = opts.includeArchived && opts.manage;

	const variantRows = await rows(
		tx,
		sql`SELECT v.id, v.article_id, v.label, v.price_cents, v.reorder_url, v.stock, v.min_stock,
				v.position, v.archived_at
			FROM article_variants v
			WHERE v.article_id IN (${idList(ids)})
				${withArchivedVariants ? sql`` : sql`AND v.archived_at IS NULL`}
			ORDER BY v.position, v.label, v.id`
	);
	const imageRows = await rows(
		tx,
		sql`SELECT i.id, i.article_id, i.width, i.height, i.position
			FROM article_images i
			WHERE i.article_id IN (${idList(ids)})
			ORDER BY i.position, i.created_at, i.id`
	);

	const variantsBy = new Map<string, ArticleVariant[]>();
	for (const r of variantRows) {
		const key = String(r.article_id);
		const list = variantsBy.get(key) ?? [];
		list.push(toVariant(r, opts.manage));
		variantsBy.set(key, list);
	}
	const imagesBy = new Map<string, ArticleImage[]>();
	for (const r of imageRows) {
		const key = String(r.article_id);
		const list = imagesBy.get(key) ?? [];
		list.push(toArticleImage(r));
		imagesBy.set(key, list);
	}

	return articleRows.map((r): Article => {
		const id = String(r.id);
		const variants = variantsBy.get(id) ?? [];
		const active = variants.filter((v) => !v.archived);
		const range = priceRange(active.map((v) => v.priceCents));
		const images = imagesBy.get(id) ?? [];
		return {
			id,
			title: String(r.title),
			description: str(r.description),
			notes: opts.manage ? str(r.notes) : null,
			reorderUrl: opts.manage ? str(r.reorder_url) : null,
			active: r.active === true || r.active === 't',
			archived: r.archived_at != null,
			position: num(r.position),
			variants,
			hasSizes: active.length > 1 || active.some((v) => v.label !== ''),
			priceMinCents: range.min,
			priceMaxCents: range.max,
			images,
			cover: images[0] ?? null,
			createdAt: iso(r.created_at),
			updatedAt: iso(r.updated_at)
		};
	});
}

/** Ein Artikel oder 404 (Katalog: inaktiv/archiviert → 404) */
export async function loadArticleOr404(
	tx: Tx,
	id: string,
	opts: Omit<LoadArticlesOptions, 'ids'>
): Promise<Article> {
	const [article] = await loadArticles(tx, { ...opts, ids: [id] });
	if (!article) throw errors.notFound('Artikel nicht gefunden');
	return article;
}

/** Artikelzeile (ohne Filter) oder 404 – für Änderungen in der Verwaltung */
export async function requireArticleRow(tx: Tx, id: string): Promise<Row> {
	const [row] = await rows(
		tx,
		sql`SELECT id, title, active, archived_at FROM articles WHERE id = ${id} FOR UPDATE`
	);
	if (!row) throw errors.notFound('Artikel nicht gefunden');
	return row;
}

/** Wird die Variante irgendwo verwendet (Bestellung, Einkauf, Lagerbewegung, Bestand > 0)? */
export async function usedVariantIds(tx: Tx, variantIds: string[]): Promise<Set<string>> {
	if (!variantIds.length) return new Set();
	const list = idList(variantIds);
	const found = await rows(
		tx,
		sql`SELECT variant_id AS id FROM order_items WHERE variant_id IN (${list})
			UNION SELECT variant_id FROM supplier_order_items WHERE variant_id IN (${list})
			UNION SELECT variant_id FROM stock_movements WHERE variant_id IN (${list})
			UNION SELECT id FROM article_variants WHERE id IN (${list}) AND stock > 0`
	);
	return new Set(found.map((r) => String(r.id)));
}
