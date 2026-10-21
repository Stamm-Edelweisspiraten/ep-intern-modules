/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Daten einer Person im Modul Bestellungen –
 * Bestellungen für die Mitglieder der Person (bei einem Konto: die verknüpften Mitglieder, ergänzt
 * vom Modul `members`) samt Positionen und Ausgaben aus dem Lager, dazu vom Konto aufgegebene
 * Bestellungen für andere Mitglieder (nur Nummer/Datum, keine Daten Dritter). Rechnungen liegen in
 * der Kasse (`treasury`). Eigene Modul-Transaktion, keine Core-Services darin.
 */
import { sql } from 'drizzle-orm';
import type { DataSubject, ModuleSubjectExport } from '$lib/sdk/server';
import { idList, iso, isoOrNull, mdb, num, rows, str } from './db';

async function run({ userId, memberIds }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!userId && !memberIds.length) return null;
	const data = await mdb().transaction(async (tx) => {
		const orders = memberIds.length
			? await rows(
					tx,
					sql`SELECT id, number, member_id, member_name, ordered_by, note, invoice_number,
							cancelled_at, created_at, updated_at
						FROM orders WHERE member_id IN (${idList(memberIds)})
						ORDER BY created_at, id`
				)
			: [];
		const orderIds = orders.map((o) => String(o.id));
		const items = orderIds.length
			? await rows(
					tx,
					sql`SELECT id, order_id, article_title, variant_label, unit_price_cents, quantity,
							delivered_qty, cancelled_qty
						FROM order_items WHERE order_id IN (${idList(orderIds)})
						ORDER BY order_id, position, id`
				)
			: [];
		const itemIds = items.map((i) => String(i.id));
		const movements = itemIds.length
			? await rows(
					tx,
					sql`SELECT order_item_id, kind, delta, created_at FROM stock_movements
						WHERE order_item_id IN (${idList(itemIds)}) AND kind IN ('handout', 'return')
						ORDER BY created_at, id`
				)
			: [];
		const placedForOthers = userId
			? await rows(
					tx,
					sql`SELECT number, cancelled_at, created_at FROM orders
						WHERE ordered_by = ${userId}
							${memberIds.length ? sql`AND member_id NOT IN (${idList(memberIds)})` : sql``}
						ORDER BY created_at, id`
				)
			: [];
		return { orders, items, movements, placedForOthers };
	});
	if (!data.orders.length && !data.placedForOthers.length) return null;

	const itemsByOrder = new Map<string, Record<string, unknown>[]>();
	for (const i of data.items) {
		const list = itemsByOrder.get(String(i.order_id)) ?? [];
		list.push(i);
		itemsByOrder.set(String(i.order_id), list);
	}
	const movesByItem = new Map<string, Record<string, unknown>[]>();
	for (const m of data.movements) {
		const list = movesByItem.get(String(m.order_item_id)) ?? [];
		list.push(m);
		movesByItem.set(String(m.order_item_id), list);
	}
	return {
		orders: data.orders.map((o) => ({
			id: String(o.id),
			number: String(o.number),
			memberId: String(o.member_id),
			memberName: String(o.member_name),
			orderedBySelf: !!userId && o.ordered_by === userId,
			note: str(o.note),
			invoiceNumber: str(o.invoice_number),
			cancelledAt: isoOrNull(o.cancelled_at),
			createdAt: iso(o.created_at),
			updatedAt: iso(o.updated_at),
			items: (itemsByOrder.get(String(o.id)) ?? []).map((i) => ({
				article: String(i.article_title),
				variant: str(i.variant_label) || null,
				unitPriceCents: num(i.unit_price_cents),
				quantity: num(i.quantity),
				deliveredQuantity: num(i.delivered_qty),
				cancelledQuantity: num(i.cancelled_qty),
				// Ausgaben (negativ im Lager) als positive Menge, Rücknahmen negativ
				handouts: (movesByItem.get(String(i.id)) ?? []).map((m) => ({
					kind: String(m.kind),
					quantity: -num(m.delta),
					at: iso(m.created_at)
				}))
			}))
		})),
		ordersPlacedForOthers: data.placedForOthers.map((o) => ({
			number: String(o.number),
			cancelledAt: isoOrNull(o.cancelled_at),
			createdAt: iso(o.created_at)
		}))
	};
}

export const subjectExport: ModuleSubjectExport = { run };
