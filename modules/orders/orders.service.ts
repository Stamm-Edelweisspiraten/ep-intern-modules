/**
 * Bestellungen (Mitglieder, Gruppen, Stamm): Laden (in der Transaktion), Aufbereiten (danach: Namen, Zahlstand),
 * Lagerübersicht und Zugriffshilfen. Dienste/Core-Aufrufe nur AUSSERHALB offener Transaktionen.
 */
import { type SQL, sql } from 'drizzle-orm';
import { errors, type RequestContext, type Tx } from '$lib/sdk/server';
import type { Row } from './db';
import {
	groupRows,
	idList,
	iso,
	isoOrNull,
	membersService,
	num,
	rows,
	str,
	treasuryService,
	userNames
} from './db';
import {
	type MemberOption,
	type Order,
	type OrderItem,
	type OrderPayment,
	PERMISSIONS,
	type RecipientKind,
	type StockRow
} from './schemas';
import { billableCents, deficit, openQty, orderStatus } from './stock';

/** Rohdaten einer Bestellung aus der Datenbank */
export interface OrderData {
	order: Row;
	items: Row[];
}

/** SQL: Status einer Bestellung (gleiche Regeln wie `orderStatus`), Alias `o` = orders */
export const ORDER_STATUS_SQL = sql`(
	SELECT CASE
		WHEN o.cancelled_at IS NOT NULL OR coalesce(sum(i.quantity), 0) = 0
			OR coalesce(sum(i.cancelled_qty), 0) >= coalesce(sum(i.quantity), 0) THEN 'cancelled'
		WHEN coalesce(sum(i.quantity - i.delivered_qty - i.cancelled_qty), 0) = 0 THEN 'delivered'
		WHEN coalesce(sum(i.delivered_qty), 0) > 0 THEN 'partial'
		ELSE 'open' END
	FROM order_items i WHERE i.order_id = o.id)`;

/** Lädt Bestellungen samt Positionen (Reihenfolge wie `ids`) */
export async function loadOrders(tx: Tx, ids: string[]): Promise<OrderData[]> {
	if (!ids.length) return [];
	const orders = await rows(tx, sql`SELECT * FROM orders WHERE id IN (${idList(ids)})`);
	const items = await rows(
		tx,
		sql`SELECT i.*, v.article_id, v.stock AS variant_stock
			FROM order_items i LEFT JOIN article_variants v ON v.id = i.variant_id
			WHERE i.order_id IN (${idList(ids)}) ORDER BY i.position, i.id`
	);
	const byId = new Map(orders.map((o) => [String(o.id), o]));
	const itemsBy = groupRows(items, (i) => String(i.order_id));
	return ids
		.map((id) => byId.get(id))
		.filter((o): o is Row => !!o)
		.map((order) => ({ order, items: itemsBy.get(String(order.id)) ?? [] }));
}

/** Eine Bestellung (optional gesperrt); 404, wenn sie fehlt */
export async function loadOrderOr404(tx: Tx, id: string, lock = false): Promise<OrderData> {
	const [order] = await rows(
		tx,
		lock
			? sql`SELECT * FROM orders WHERE id = ${id} FOR UPDATE`
			: sql`SELECT * FROM orders WHERE id = ${id}`
	);
	if (!order) throw errors.notFound('Bestellung nicht gefunden');
	const [data] = await loadOrders(tx, [id]);
	return data ?? { order, items: [] };
}

export const itemQty = (r: Row) => ({
	quantity: num(r.quantity),
	deliveredQty: num(r.delivered_qty),
	cancelledQty: num(r.cancelled_qty)
});

/**
 * Wozu die*der Aufrufende Zugang hat (ohne `manage`): verknüpfte Mitglieder, selbst geleitete Gruppen
 * (nur mit Recht `group`) und Stammesbestellungen (Recht `stamm`). Dienst-Fehler → leer.
 */
export interface OrderAccess {
	linkedIds: Set<string>;
	ledGroupIds: Set<string>;
	stamm: boolean;
}

export const NO_ACCESS: OrderAccess = {
	linkedIds: new Set(),
	ledGroupIds: new Set(),
	stamm: false
};

/** Selbst geleitete Gruppen (Recht `group`; ohne Konto/Leitung oder bei Fehlern leer) */
export async function ledGroups(ctx: RequestContext): Promise<MemberOption[]> {
	if (!ctx.userId || !ctx.permissions.has(PERMISSIONS.group)) return [];
	try {
		const list = await (await membersService()).listLedGroups(ctx);
		return list.map((g) => ({ id: g.id, name: g.name }));
	} catch {
		return [];
	}
}

export async function orderAccess(ctx: RequestContext): Promise<OrderAccess> {
	const [linkedIds, groups] = await Promise.all([linkedMemberIds(ctx), ledGroups(ctx)]);
	return {
		linkedIds,
		ledGroupIds: new Set(groups.map((g) => g.id)),
		stamm: ctx.permissions.has(PERMISSIONS.stamm)
	};
}

/** Darf die*der Aufrufende diese Bestellung sehen (selbst bestellt, verknüpftes Mitglied, geleitete Gruppe, Stamm)? */
export function isOwnOrder(order: Row, ctx: RequestContext, access: OrderAccess): boolean {
	if (ctx.userId && order.ordered_by === ctx.userId) return true;
	const kind = String(order.recipient_kind ?? 'member');
	if (kind === 'group') return access.ledGroupIds.has(String(order.group_id));
	if (kind === 'stamm') return access.stamm;
	return access.linkedIds.has(String(order.member_id));
}

/** SQL-Filter „eigene“ Bestellungen (gleiche Regeln wie `isOwnOrder`), `alias` = Tabellen-Alias von `orders` */
export function ownOrdersSql(ctx: RequestContext, access: OrderAccess, alias: string): SQL {
	const a = sql.raw(alias);
	const conds: SQL[] = [sql`${a}.ordered_by = ${ctx.userId}`];
	const linked = [...access.linkedIds];
	if (linked.length) {
		conds.push(sql`(${a}.recipient_kind = 'member' AND ${a}.member_id IN (${idList(linked)}))`);
	}
	const groups = [...access.ledGroupIds];
	if (groups.length) {
		conds.push(sql`(${a}.recipient_kind = 'group' AND ${a}.group_id IN (${idList(groups)}))`);
	}
	if (access.stamm) conds.push(sql`${a}.recipient_kind = 'stamm'`);
	return sql`(${sql.join(conds, sql` OR `)})`;
}

/** Recht zum Selbst-Stornieren je Empfängerart (Mitglied → create, Gruppe → group, Stamm → stamm) */
export function ownCancelPermission(order: Row): string {
	const kind = String(order.recipient_kind ?? 'member');
	return kind === 'group'
		? PERMISSIONS.group
		: kind === 'stamm'
			? PERMISSIONS.stamm
			: PERMISSIONS.create;
}

export const canManage = (ctx: RequestContext) => ctx.permissions.has(PERMISSIONS.manage);

/** IDs aller mit dem Konto verknüpften Mitglieder (auch ausgetretene; Fehler → leer) */
export async function linkedMemberIds(ctx: RequestContext): Promise<Set<string>> {
	if (!ctx.userId) return new Set();
	try {
		const list = await (await membersService()).listLinkedMembers(ctx);
		return new Set(list.map((m) => m.id));
	} catch {
		return new Set();
	}
}

/** Verknüpfte, nicht ausgetretene Mitglieder als Auswahl („Vorname Nachname (Pfadfindername)“) */
export async function linkedMemberOptions(ctx: RequestContext): Promise<MemberOption[]> {
	if (!ctx.userId) return [];
	const members = await membersService();
	const [linked, active] = await Promise.all([
		members.listLinkedMembers(ctx),
		members.principalIdsForUser(ctx.userId)
	]);
	const activeIds = new Set(active.memberIds);
	return linked
		.filter((m) => activeIds.has(m.id))
		.map((m) => ({
			id: m.id,
			name: `${m.firstName} ${m.lastName}${m.scoutName ? ` (${m.scoutName})` : ''}`
		}));
}

/** Darf stornieren? eigene (Recht je Empfängerart) solange nichts ausgegeben; manage: offene Mengen */
export function canCancelOrder(data: OrderData, ctx: RequestContext, access: OrderAccess): boolean {
	const qty = data.items.map(itemQty);
	const status = orderStatus(qty, isoOrNull(data.order.cancelled_at));
	const open = qty.reduce((s, q) => s + openQty(q), 0);
	if (status === 'cancelled' || open === 0) return false;
	if (canManage(ctx)) return true;
	if (!ctx.permissions.has(ownCancelPermission(data.order))) return false;
	if (!isOwnOrder(data.order, ctx, access)) return false;
	return qty.every((q) => q.deliveredQty === 0);
}

/** DTOs bauen: Namen und Zahlstand NACH der Transaktion auflösen */
export async function buildOrders(
	ctx: RequestContext,
	list: OrderData[],
	opts: { manage: boolean; access?: OrderAccess }
): Promise<Order[]> {
	if (!list.length) return [];
	const access = opts.access ?? NO_ACCESS;
	const names = await userNames(
		ctx,
		list.map((d) => str(d.order.ordered_by))
	);
	const invoiceIds = list.map((d) => str(d.order.invoice_id)).filter((v): v is string => !!v);
	let payments: Record<string, OrderPayment> = {};
	if (invoiceIds.length) {
		const treasury = await treasuryService();
		if (treasury) {
			try {
				const status = await treasury.invoiceStatus(invoiceIds);
				payments = Object.fromEntries(
					Object.entries(status).map(([id, s]) => [
						id,
						{
							invoiceId: s.invoiceId,
							invoiceNumber: s.number,
							status: s.status,
							dueCents: s.dueCents,
							paidCents: s.paidCents,
							openCents: s.openCents,
							dueOn: s.dueOn,
							overdue: s.overdue
						}
					])
				);
			} catch (e) {
				console.error('[orders] Zahlstand aus der Kasse nicht lesbar:', e);
			}
		}
	}
	return list.map((d) => {
		const o = d.order;
		const items: OrderItem[] = d.items.map((r) => {
			const q = itemQty(r);
			const unitPriceCents = num(r.unit_price_cents);
			return {
				id: String(r.id),
				variantId: String(r.variant_id),
				articleId: str(r.article_id),
				articleTitle: String(r.article_title),
				variantLabel: String(r.variant_label ?? ''),
				unitPriceCents,
				...q,
				openQty: openQty(q),
				totalCents: billableCents({ ...q, unitPriceCents }),
				stock: opts.manage && r.variant_stock != null ? num(r.variant_stock) : null
			};
		});
		const orderedBy = str(o.ordered_by);
		const invoiceId = str(o.invoice_id);
		const kind = (String(o.recipient_kind ?? 'member') as RecipientKind) || 'member';
		const recipientId =
			kind === 'member' ? str(o.member_id) : kind === 'group' ? str(o.group_id) : null;
		const name = String(o.member_name);
		return {
			id: String(o.id),
			number: String(o.number),
			recipient: { kind, id: recipientId, name },
			member: kind === 'member' ? { id: String(o.member_id), name } : null,
			orderedBy: orderedBy ? { id: orderedBy, name: names.get(orderedBy) ?? 'Unbekannt' } : null,
			note: str(o.note),
			status: orderStatus(items, isoOrNull(o.cancelled_at)),
			items,
			totalCents: items.reduce((s, i) => s + i.totalCents, 0),
			invoiceNumber: str(o.invoice_number),
			payment: invoiceId ? (payments[invoiceId] ?? null) : null,
			canCancel: canCancelOrder(d, ctx, access),
			canEdit: ctx.permissions.has(PERMISSIONS.edit),
			canDelete: ctx.permissions.has(PERMISSIONS.delete),
			createdAt: iso(o.created_at),
			cancelledAt: isoOrNull(o.cancelled_at)
		};
	});
}

/** Lagerzeilen: nicht archivierte Varianten nicht archivierter Artikel (aktiv und inaktiv) */
export async function loadStock(tx: Tx, variantIds?: string[]): Promise<StockRow[]> {
	const where: SQL = variantIds
		? variantIds.length
			? sql`v.id IN (${idList(variantIds)})`
			: sql`FALSE`
		: sql`v.archived_at IS NULL AND a.archived_at IS NULL`;
	const list = await rows(
		tx,
		sql`SELECT v.id, v.label, v.price_cents, v.stock, v.min_stock, v.reorder_url,
				a.id AS article_id, a.title, a.active, a.reorder_url AS article_url,
				coalesce((SELECT sum(oi.quantity - oi.delivered_qty - oi.cancelled_qty)
					FROM order_items oi JOIN orders o ON o.id = oi.order_id
					WHERE oi.variant_id = v.id AND o.cancelled_at IS NULL), 0) AS demand,
				coalesce((SELECT sum(si.quantity - si.received_qty - si.cancelled_qty)
					FROM supplier_order_items si JOIN supplier_orders so ON so.id = si.supplier_order_id
					WHERE si.variant_id = v.id AND so.closed_at IS NULL), 0) AS in_transit
			FROM article_variants v JOIN articles a ON a.id = v.article_id
			WHERE ${where}
			ORDER BY a.position, a.title, a.id, v.position, v.id`
	);
	return list.map((r) => {
		const stock = num(r.stock);
		const minStock = num(r.min_stock);
		const demand = num(r.demand);
		const inTransit = num(r.in_transit);
		return {
			articleId: String(r.article_id),
			articleTitle: String(r.title),
			variantId: String(r.id),
			variantLabel: String(r.label ?? ''),
			priceCents: num(r.price_cents),
			stock,
			minStock,
			demand,
			inTransit,
			deficit: deficit({ stock, minStock, demand, inTransit }),
			reorderUrl: str(r.reorder_url) ?? str(r.article_url),
			articleActive: Boolean(r.active)
		};
	});
}
