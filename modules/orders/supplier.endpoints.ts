/**
 * Einkauf: Bestellungen beim Lieferanten mit Teillieferung, Rest stornieren, Abschluss und
 * Lieferantenrechnung als Auszahlung in der Kasse.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	type ApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import {
	idParams,
	MAX_RECEIPT_BYTES,
	PERMISSIONS,
	RECEIPT_CONTENT_TYPES,
	supplierInvoiceInput,
	supplierOrderInput,
	supplierOrderListQuery,
	supplierOrderUpdateInput,
	supplierReceiveInput,
	type PaymentStatus,
	type SupplierOrder,
	type SupplierOrderItem,
	type SupplierSuggestion
} from './schemas';
import {
	idList,
	iso,
	isoOrNull,
	mdb,
	nextNumber,
	num,
	rows,
	str,
	treasuryService,
	userNames,
	type Row
} from './db';
import { loadStock } from './orders.service';
import { pushPayable } from './treasury-link';
import { inTransitQty, supplierStatus } from './stock';

const TAGS = ['Modul: orders'];
const PERM = PERMISSIONS.stock;

type Issue = { path: (string | number)[]; message: string };
interface SupplierData {
	order: Row;
	items: Row[];
}

async function loadSupplierOrders(tx: Tx, ids?: string[]): Promise<SupplierData[]> {
	const orders = await rows(
		tx,
		ids
			? ids.length
				? sql`SELECT *, to_char(ordered_on, 'YYYY-MM-DD') AS ordered_on_text
						FROM supplier_orders WHERE id IN (${idList(ids)})`
				: sql`SELECT * FROM supplier_orders WHERE FALSE`
			: sql`SELECT *, to_char(ordered_on, 'YYYY-MM-DD') AS ordered_on_text
					FROM supplier_orders ORDER BY (closed_at IS NULL) DESC, ordered_on DESC, number DESC`
	);
	if (!orders.length) return [];
	const items = await rows(
		tx,
		sql`SELECT si.*, v.article_id FROM supplier_order_items si
			LEFT JOIN article_variants v ON v.id = si.variant_id
			WHERE si.supplier_order_id IN (${idList(orders.map((o) => String(o.id)))})
			ORDER BY si.position, si.id`
	);
	return orders.map((order) => ({
		order,
		items: items.filter((i) => i.supplier_order_id === order.id)
	}));
}

async function loadOr404(tx: Tx, id: string, lock = false): Promise<SupplierData> {
	const [order] = await rows(
		tx,
		lock
			? sql`SELECT id FROM supplier_orders WHERE id = ${id} FOR UPDATE`
			: sql`SELECT id FROM supplier_orders WHERE id = ${id}`
	);
	if (!order) throw errors.notFound('Lieferantenbestellung nicht gefunden');
	const [data] = await loadSupplierOrders(tx, [id]);
	return data!;
}

const qtyOf = (r: Row) => ({
	quantity: num(r.quantity),
	receivedQty: num(r.received_qty),
	cancelledQty: num(r.cancelled_qty)
});

/** DTOs: Namen und Zahlstand der Kasse NACH der Transaktion */
async function buildSupplierOrders(
	ctx: RequestContext,
	list: SupplierData[]
): Promise<SupplierOrder[]> {
	if (!list.length) return [];
	const names = await userNames(
		ctx,
		list.map((d) => str(d.order.created_by))
	);
	const refs = list.map((d) => str(d.order.payable_ref)).filter((v): v is string => !!v);
	let status: Record<string, { status: PaymentStatus; amountCents: number; paidCents: number }> =
		{};
	if (refs.length) {
		const treasury = await treasuryService();
		if (treasury) {
			try {
				status = await treasury.payableStatus(refs);
			} catch (e) {
				console.error('[orders] Zahlstand der Lieferantenrechnungen nicht lesbar:', e);
			}
		}
	}
	return list.map(({ order: o, items: rawItems }) => {
		const items: SupplierOrderItem[] = rawItems.map((r) => {
			const q = qtyOf(r);
			return {
				id: String(r.id),
				variantId: String(r.variant_id),
				articleId: str(r.article_id),
				articleTitle: String(r.article_title),
				variantLabel: String(r.variant_label ?? ''),
				...q,
				openQty: inTransitQty(q),
				unitCostCents: r.unit_cost_cents == null ? null : num(r.unit_cost_cents)
			};
		});
		const by = str(o.created_by);
		const ref = str(o.payable_ref);
		const pay = ref ? status[ref] : undefined;
		return {
			id: String(o.id),
			number: String(o.number),
			supplier: String(o.supplier),
			orderedOn: String(o.ordered_on_text),
			note: str(o.note),
			status: supplierStatus(items, isoOrNull(o.closed_at)),
			items,
			estimatedCents: items.reduce(
				(s, i) => s + (i.unitCostCents == null ? 0 : i.unitCostCents * i.quantity),
				0
			),
			invoice:
				o.invoice_amount_cents == null
					? null
					: {
							amountCents: num(o.invoice_amount_cents),
							recipientName: String(o.invoice_recipient ?? ''),
							inTreasury: o.payable_synced_at != null,
							payment: pay
								? { status: pay.status, amountCents: pay.amountCents, paidCents: pay.paidCents }
								: null
						},
			createdBy: by ? { id: by, name: names.get(by) ?? 'Unbekannt' } : null,
			createdAt: iso(o.created_at),
			closedAt: isoOrNull(o.closed_at)
		};
	});
}

async function buildOne(ctx: RequestContext, id: string): Promise<SupplierOrder> {
	const data = await mdb().transaction((tx) => loadSupplierOrders(tx, [id]));
	const [one] = await buildSupplierOrders(ctx, data);
	if (!one) throw errors.notFound('Lieferantenbestellung nicht gefunden');
	return one;
}

type ItemIn = { variantId: string; quantity: number; unitCostCents: number | null };

/** Prüft die Varianten (vorhanden, nicht archiviert) und schreibt die Positionen */
async function insertItems(tx: Tx, supplierOrderId: string, items: ItemIn[]): Promise<void> {
	const variants = await rows(
		tx,
		sql`SELECT v.id, v.label, v.archived_at, a.title, a.archived_at AS article_archived_at
			FROM article_variants v JOIN articles a ON a.id = v.article_id
			WHERE v.id IN (${idList(items.map((i) => i.variantId))})`
	);
	const byId = new Map(variants.map((v) => [String(v.id), v]));
	const issues: Issue[] = [];
	items.forEach((it, i) => {
		const v = byId.get(it.variantId);
		if (!v || v.archived_at || v.article_archived_at) {
			issues.push({ path: ['items', i, 'variantId'], message: 'Artikel nicht gefunden' });
		}
	});
	if (issues.length) throw errors.validation(issues);
	let position = 0;
	for (const it of items) {
		const v = byId.get(it.variantId)!;
		await tx.execute(
			sql`INSERT INTO supplier_order_items (id, supplier_order_id, variant_id, position, article_title,
					variant_label, quantity, unit_cost_cents)
				VALUES (${crypto.randomUUID()}, ${supplierOrderId}, ${it.variantId}, ${position++},
					${String(v.title)}, ${String(v.label ?? '')}, ${it.quantity}, ${it.unitCostCents})`
		);
	}
}

function assertOpen(data: SupplierData) {
	if (data.order.closed_at) throw errors.conflict('Lieferantenbestellung ist abgeschlossen');
}

export const supplierEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/supplier-orders/suggestion',
		summary: 'Vorschlag für eine Lieferantenbestellung aus den aktuellen Fehlmengen',
		tags: TAGS,
		permission: PERM,
		handler: async (): Promise<SupplierSuggestion> => {
			const stock = await mdb().transaction((tx) => loadStock(tx));
			return {
				items: stock
					.filter((r) => r.deficit > 0)
					.map((r) => ({
						variantId: r.variantId,
						articleTitle: r.articleTitle,
						variantLabel: r.variantLabel,
						quantity: r.deficit,
						reorderUrl: r.reorderUrl
					}))
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/supplier-orders',
		summary: 'Lieferantenbestellungen (offene zuerst)',
		tags: TAGS,
		permission: PERM,
		query: supplierOrderListQuery,
		handler: async ({ ctx, query }): Promise<SupplierOrder[]> => {
			const { status } = query as { status: string };
			const list = await buildSupplierOrders(
				ctx,
				await mdb().transaction((tx) => loadSupplierOrders(tx))
			);
			if (status === 'all') return list;
			if (status === 'active') return list.filter((o) => o.status !== 'closed');
			return list.filter((o) => o.status === status);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/supplier-orders',
		summary: 'Beim Lieferanten bestellen',
		tags: TAGS,
		permission: PERM,
		body: supplierOrderInput,
		handler: async ({ ctx, body }): Promise<SupplierOrder> => {
			const input = body as {
				supplier: string;
				orderedOn: string;
				note: string | null;
				items: ItemIn[];
			};
			const id = crypto.randomUUID();
			const number = await mdb().transaction(async (tx) => {
				const n = await nextNumber(tx, 'supplier_orders', input.orderedOn);
				await tx.execute(
					sql`INSERT INTO supplier_orders (id, number, year, seq, supplier, ordered_on, note, created_by)
						VALUES (${id}, ${n.number}, ${n.year}, ${n.seq}, ${input.supplier}, ${input.orderedOn},
							${input.note}, ${ctx.userId})`
				);
				await insertItems(tx, id, input.items);
				return n.number;
			});
			await core.audit.logFromContext(ctx, 'orders.supplier-order.created', {
				target: id,
				metadata: {
					number,
					items: input.items.length,
					quantity: input.items.reduce((s, i) => s + i.quantity, 0)
				}
			});
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/supplier-orders/:id',
		summary: 'Lieferantenbestellung mit Positionen und Rechnung',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		handler: async ({ ctx, params }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			await mdb().transaction((tx) => loadOr404(tx, id));
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/supplier-orders/:id',
		summary: 'Lieferantenbestellung ändern (Positionen nur, solange nichts eingegangen ist)',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		body: supplierOrderUpdateInput,
		handler: async ({ ctx, params, body }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			const input = body as {
				supplier?: string;
				orderedOn?: string;
				note?: string | null;
				items?: ItemIn[];
			};
			await mdb().transaction(async (tx) => {
				const data = await loadOr404(tx, id, true);
				assertOpen(data);
				if (input.items) {
					if (data.items.some((r) => num(r.received_qty) > 0 || num(r.cancelled_qty) > 0)) {
						throw errors.conflict(
							'Positionen lassen sich nach dem ersten Wareneingang nicht mehr ändern'
						);
					}
					await tx.execute(sql`DELETE FROM supplier_order_items WHERE supplier_order_id = ${id}`);
					await insertItems(tx, id, input.items);
				}
				if (input.supplier !== undefined) {
					await tx.execute(
						sql`UPDATE supplier_orders SET supplier = ${input.supplier} WHERE id = ${id}`
					);
				}
				if (input.orderedOn !== undefined) {
					await tx.execute(
						sql`UPDATE supplier_orders SET ordered_on = ${input.orderedOn} WHERE id = ${id}`
					);
				}
				if (input.note !== undefined) {
					await tx.execute(sql`UPDATE supplier_orders SET note = ${input.note} WHERE id = ${id}`);
				}
				await tx.execute(sql`UPDATE supplier_orders SET updated_at = now() WHERE id = ${id}`);
			});
			await core.audit.logFromContext(ctx, 'orders.supplier-order.updated', {
				target: id,
				metadata: { fields: Object.keys(input), items: input.items?.length ?? null }
			});
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/supplier-orders/:id/receive',
		summary: 'Wareneingang buchen (Teillieferung möglich); erhöht den Lagerbestand',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		body: supplierReceiveInput,
		handler: async ({ ctx, params, body }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			const input = body as {
				items: { itemId: string; quantity: number }[];
				note: string | null;
			};
			const result = await mdb().transaction(async (tx) => {
				const data = await loadOr404(tx, id, true);
				assertOpen(data);
				const issues: Issue[] = [];
				const changes: { row: Row; qty: number }[] = [];
				input.items.forEach((it, i) => {
					const row = data.items.find((r) => r.id === it.itemId);
					if (!row) {
						issues.push({ path: ['items', i, 'itemId'], message: 'Position nicht gefunden' });
						return;
					}
					const open = inTransitQty(qtyOf(row));
					if (it.quantity > open) {
						issues.push({ path: ['items', i, 'quantity'], message: `Höchstens ${open} offen` });
						return;
					}
					if (it.quantity > 0) changes.push({ row, qty: it.quantity });
				});
				if (issues.length) throw errors.validation(issues);
				if (!changes.length) {
					throw errors.validation([{ path: ['items'], message: 'Keine Menge angegeben' }]);
				}
				for (const c of changes) {
					const itemId = String(c.row.id);
					const variantId = String(c.row.variant_id);
					await tx.execute(
						sql`UPDATE supplier_order_items SET received_qty = received_qty + ${c.qty} WHERE id = ${itemId}`
					);
					await tx.execute(
						sql`UPDATE article_variants SET stock = stock + ${c.qty} WHERE id = ${variantId}`
					);
					await tx.execute(
						sql`INSERT INTO stock_movements (id, variant_id, delta, kind, supplier_item_id, note, created_by)
							VALUES (${crypto.randomUUID()}, ${variantId}, ${c.qty}, 'receipt', ${itemId},
								${input.note}, ${ctx.userId})`
					);
				}
				await tx.execute(sql`UPDATE supplier_orders SET updated_at = now() WHERE id = ${id}`);
				return { items: changes.length, quantity: changes.reduce((s, c) => s + c.qty, 0) };
			});
			await core.audit.logFromContext(ctx, 'orders.supplier-order.received', {
				target: id,
				metadata: result
			});
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/supplier-orders/:id/cancel-rest',
		summary: 'Nicht gelieferte Restmengen stornieren und die Bestellung abschließen',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		handler: async ({ ctx, params }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			const cancelled = await mdb().transaction(async (tx) => {
				const data = await loadOr404(tx, id, true);
				assertOpen(data);
				const open = data.items.reduce((s, r) => s + inTransitQty(qtyOf(r)), 0);
				await tx.execute(
					sql`UPDATE supplier_order_items SET cancelled_qty = quantity - received_qty
						WHERE supplier_order_id = ${id}`
				);
				await tx.execute(
					sql`UPDATE supplier_orders SET closed_at = now(), updated_at = now() WHERE id = ${id}`
				);
				return open;
			});
			await core.audit.logFromContext(ctx, 'orders.supplier-order.closed', {
				target: id,
				metadata: { cancelledRest: cancelled }
			});
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/supplier-orders/:id/close',
		summary: 'Lieferantenbestellung abschließen (offene Mengen gelten nicht mehr als unterwegs)',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		handler: async ({ ctx, params }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			await mdb().transaction(async (tx) => {
				assertOpen(await loadOr404(tx, id, true));
				await tx.execute(
					sql`UPDATE supplier_orders SET closed_at = now(), updated_at = now() WHERE id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'orders.supplier-order.closed', { target: id });
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/supplier-orders/:id/reopen',
		summary: 'Abgeschlossene Lieferantenbestellung wieder öffnen',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		handler: async ({ ctx, params }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			await mdb().transaction(async (tx) => {
				const data = await loadOr404(tx, id, true);
				if (!data.order.closed_at)
					throw errors.conflict('Lieferantenbestellung ist nicht abgeschlossen');
				await tx.execute(
					sql`UPDATE supplier_orders SET closed_at = NULL, updated_at = now() WHERE id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'orders.supplier-order.reopened', { target: id });
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/supplier-orders/:id/invoice',
		summary:
			'Lieferantenrechnung erfassen (multipart, optional Beleg im Feld "file") → Auszahlung in der Kasse',
		description:
			'Textfelder: `amountCents`, `recipientName`, optional `iban` (fehlt = unverändert, leer = entfernen), ' +
			'`bic`, `dueOn`, `note`. Ohne aktive Kasse 409.',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const fields: Record<string, string> = {};
			for (const key of ['amountCents', 'recipientName', 'iban', 'bic', 'dueOn', 'note']) {
				const v = form.get(key);
				if (typeof v === 'string') fields[key] = v;
			}
			const input = supplierInvoiceInput.parse(fields);
			let receipt: { bytes: Uint8Array; contentType: string; name: string } | null = null;
			const file = form.get('file');
			if (file instanceof File && file.size > 0) {
				const contentType = (file.type || '').split(';')[0]!.trim().toLowerCase();
				if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
					throw errors.validation([
						{ path: ['file'], message: 'Dateityp nicht erlaubt (PDF, JPEG, PNG oder WebP)' }
					]);
				}
				if (file.size > MAX_RECEIPT_BYTES) throw errors.tooLarge('Datei überschreitet 10 MB');
				receipt = {
					bytes: new Uint8Array(await file.arrayBuffer()),
					contentType,
					name: file.name?.trim() || 'lieferantenrechnung'
				};
			}
			await mdb().transaction((tx) => loadOr404(tx, id));
			const { payableId, ref } = await pushPayable(
				ctx,
				id,
				{
					amountCents: input.amountCents,
					recipientName: input.recipientName,
					iban: input.iban,
					bic: input.bic,
					dueOn: input.dueOn,
					note: input.note
				},
				receipt
			);
			await mdb().transaction((tx) =>
				tx.execute(
					sql`UPDATE supplier_orders SET invoice_amount_cents = ${input.amountCents},
						invoice_recipient = ${input.recipientName}, payable_ref = ${ref},
						payable_synced_at = now(), updated_at = now() WHERE id = ${id}`
				)
			);
			await core.audit.logFromContext(ctx, 'orders.supplier-order.invoice-set', {
				target: id,
				metadata: { payableId, amountCents: input.amountCents, receipt: !!receipt }
			});
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/supplier-orders/:id/invoice',
		summary: 'Lieferantenrechnung entfernen (storniert die Auszahlung; bezahlt → 409)',
		tags: TAGS,
		permission: PERM,
		params: idParams,
		handler: async ({ ctx, params }): Promise<SupplierOrder> => {
			const { id } = params as { id: string };
			const data = await mdb().transaction((tx) => loadOr404(tx, id));
			const ref = str(data.order.payable_ref);
			if (!ref && data.order.invoice_amount_cents == null) {
				throw errors.notFound('Keine Lieferantenrechnung erfasst');
			}
			if (ref) {
				const treasury = await treasuryService();
				if (!treasury) throw errors.conflict('Kasse ist nicht aktiv');
				await treasury.cancelOrderPayable(ctx, ref);
			}
			await mdb().transaction((tx) =>
				tx.execute(
					sql`UPDATE supplier_orders SET invoice_amount_cents = NULL, invoice_recipient = NULL,
						payable_ref = NULL, payable_synced_at = NULL, updated_at = now() WHERE id = ${id}`
				)
			);
			await core.audit.logFromContext(ctx, 'orders.supplier-order.invoice-removed', {
				target: id
			});
			return buildOne(ctx, id);
		}
	})
] as ApiEndpoint[];
