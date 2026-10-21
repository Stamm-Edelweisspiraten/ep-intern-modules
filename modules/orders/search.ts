/**
 * Globale Suche (Befehlspalette): Artikel nach Titel und Bestellungen nach Nummer oder Mitgliedsname.
 * Sichtbarkeit wie in der Oberfläche: Katalog = aktive Artikel mit mindestens einer aktiven Größe,
 * mit `orders.article.manage` auch inaktive; Bestellungen wie `GET /orders?scope=mine` (eigene bzw.
 * die verknüpfter Mitglieder), mit `orders.order.manage` alle.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ModuleSearchProvider, RequestContext } from '$lib/sdk/server';
import type { SearchHit } from '$lib/sdk/types/search';
import { formatEuro } from '$lib/components/layout/money';
import { idList, iso, mdb, num, rows } from './db';
import { canManage, linkedMemberIds, ORDER_STATUS_SQL } from './orders.service';
import { formatDateDe } from '$lib/sdk/dates';
import { priceRange } from './stock';
import { ORDER_STATUS_LABELS, PERMISSIONS, type OrderStatus } from './schemas';

function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const formatDate = (iso: string): string => formatDateDe(iso);

function priceText(prices: number[]): string | undefined {
	if (!prices.length) return undefined;
	const { min, max } = priceRange(prices);
	return min === max ? formatEuro(min) : `${formatEuro(min)} – ${formatEuro(max)}`;
}

async function run(ctx: RequestContext, query: string, limit: number): Promise<SearchHit[]> {
	const manageArticles = ctx.permissions.has(PERMISSIONS.articles);
	const manageOrders = canManage(ctx);
	// Verknüpfte Mitglieder über den Dienst `members` – vor der Transaktion
	const linked = manageOrders ? [] : [...(await linkedMemberIds(ctx))];
	const pattern = likePattern(query);

	const ownFilter: SQL = manageOrders
		? sql`TRUE`
		: linked.length
			? sql`(o.ordered_by = ${ctx.userId} OR o.member_id IN (${idList(linked)}))`
			: sql`o.ordered_by = ${ctx.userId}`;
	const articleFilter: SQL = manageArticles
		? sql`a.archived_at IS NULL`
		: sql`a.active AND a.archived_at IS NULL`;

	const data = await mdb().transaction(async (tx) => {
		const articles = await rows(
			tx,
			sql`SELECT a.id, a.title, a.active,
					array_remove(array_agg(v.price_cents), NULL) AS prices
				FROM articles a
				LEFT JOIN article_variants v ON v.article_id = a.id AND v.archived_at IS NULL
				WHERE ${articleFilter} AND a.title ILIKE ${pattern} ESCAPE '\\'
				GROUP BY a.id, a.title, a.active, a.position
				HAVING ${manageArticles ? sql`TRUE` : sql`count(v.id) > 0`}
				ORDER BY a.position, a.title, a.id
				LIMIT ${limit}`
		);
		const orders = await rows(
			tx,
			sql`SELECT o.id, o.number, o.member_name, o.created_at, ${ORDER_STATUS_SQL} AS status
				FROM orders o
				WHERE ${ownFilter}
					AND (o.number ILIKE ${pattern} ESCAPE '\\' OR o.member_name ILIKE ${pattern} ESCAPE '\\')
				ORDER BY o.created_at DESC, o.number DESC
				LIMIT ${limit}`
		);
		return { articles, orders };
	});

	const hits: SearchHit[] = [];
	for (const a of data.articles) {
		const prices = (Array.isArray(a.prices) ? a.prices : []).map(num);
		const title = String(a.title);
		const parts = [priceText(prices), a.active ? undefined : 'Inaktiv'].filter(Boolean);
		hits.push({
			id: `article:${String(a.id)}`,
			title,
			subtitle: parts.length ? parts.join(' · ') : undefined,
			href: manageArticles
				? '/modules/orders?tab=artikel'
				: `/modules/orders?q=${encodeURIComponent(title)}`,
			icon: 'shopping-basket',
			type: 'Artikel'
		});
	}
	for (const o of data.orders) {
		const status = String(o.status) as OrderStatus;
		hits.push({
			id: `order:${String(o.id)}`,
			title: String(o.number),
			subtitle: [
				o.member_name ? String(o.member_name) : null,
				ORDER_STATUS_LABELS[status] ?? null,
				formatDate(iso(o.created_at))
			]
				.filter(Boolean)
				.join(' · '),
			href: manageOrders ? '/modules/orders?tab=bestellungen' : '/modules/orders?tab=meine',
			icon: 'shopping-basket',
			type: 'Bestellung'
		});
	}
	// Bestellnummern zuerst, wenn danach gesucht wurde
	if (/^b-/i.test(query))
		hits.sort((a, b) => Number(b.type === 'Bestellung') - Number(a.type === 'Bestellung'));
	return hits.slice(0, limit);
}

export const ordersSearch: ModuleSearchProvider = {
	permission: PERMISSIONS.view,
	run
};
