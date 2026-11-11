/**
 * Bestellungen von Mitgliedern: Auswahl der Mitglieder, Bestellen (Rechnung sofort über die Kasse),
 * Liste/Detail, Storno (auch teilweise), Ausgabe aus dem Lager, nachträgliches Bearbeiten und Löschen.
 * Übersicht für die Verwaltung.
 */
import { notifyCustomer } from './customer-notify';
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	logBestEffort,
	type ApiEndpoint,
	type RequestContext
} from '$lib/sdk/server';
import {
	idParams,
	memberSearchQuery,
	orderCancelInput,
	orderCreateInput,
	orderHandoutInput,
	orderListQuery,
	orderUpdateInput,
	invoiceSourceKey,
	payableRef,
	PERMISSIONS,
	type MemberOption,
	type Order,
	type OrderCreated,
	type OrderDeleted,
	type OrderList,
	type OrdersOverview
} from './schemas';
import { idList, mdb, membersService, nextNumber, num, rows, str, treasuryService } from './db';
import {
	buildOrders,
	canManage,
	isOwnOrder,
	itemQty,
	linkedMemberIds,
	linkedMemberOptions,
	loadOrderOr404,
	loadOrders,
	loadStock,
	ORDER_STATUS_SQL
} from './orders.service';
import { notifyOrderCreated } from './notify';
import { pushInvoice } from './treasury-link';
import { openQty } from './stock';

const TAGS = ['Modul: orders'];

type Issue = { path: (string | number)[]; message: string };

async function buildOne(
	ctx: Parameters<typeof buildOrders>[0],
	id: string,
	linkedIds?: Set<string>
): Promise<Order> {
	const data = await mdb().transaction((tx) => loadOrders(tx, [id]));
	const [order] = await buildOrders(ctx, data, { manage: canManage(ctx), linkedIds });
	if (!order) throw errors.notFound('Bestellung nicht gefunden');
	return order;
}

/**
 * Kopfzahlen für die Verwaltung (`GET /overview`, Übersicht „Zu erledigen“). Ohne Rechteprüfung –
 * Aufrufer prüfen `orders.order.manage` bzw. `orders.stock.manage` selbst.
 */
export async function loadOrdersOverview(ctx: RequestContext): Promise<OrdersOverview> {
	const data = await mdb().transaction(async (tx) => {
		const [o] = await rows(
			tx,
			sql`SELECT count(*) FILTER (WHERE s.status IN ('open', 'partial')) AS open_orders,
					coalesce(sum(s.open_qty) FILTER (WHERE s.status IN ('open', 'partial')), 0) AS open_items
				FROM (SELECT ${ORDER_STATUS_SQL} AS status,
					(SELECT coalesce(sum(i.quantity - i.delivered_qty - i.cancelled_qty), 0)
						FROM order_items i WHERE i.order_id = o.id) AS open_qty
					FROM orders o) s`
		);
		const [so] = await rows(
			tx,
			sql`SELECT count(*) AS n FROM supplier_orders WHERE closed_at IS NULL`
		);
		const refs = await rows(tx, sql`SELECT id FROM supplier_orders WHERE payable_ref IS NOT NULL`);
		const stock = await loadStock(tx);
		return {
			openOrders: num(o?.open_orders),
			openItems: num(o?.open_items),
			openSupplierOrders: num(so?.n),
			deficitVariants: stock.filter((r) => r.deficit > 0).length,
			refs: refs.map((r) => payableRef(String(r.id)))
		};
	});
	const treasury = await treasuryService();
	let unpaid = 0;
	if (treasury && data.refs.length) {
		try {
			const status = await treasury.payableStatus(data.refs);
			unpaid = Object.values(status).filter(
				(s) => s.status === 'open' || s.status === 'partial'
			).length;
		} catch (e) {
			// nie das rohe Fehlerobjekt loggen (SQL-Parameter, #56)
			logBestEffort('orders.overview.payable-status', e, { ctx });
		}
	}
	return {
		openOrders: data.openOrders,
		openItems: data.openItems,
		deficitVariants: data.deficitVariants,
		openSupplierOrders: data.openSupplierOrders,
		unpaidSupplierInvoices: unpaid,
		treasuryActive: !!treasury
	};
}

export const ordersEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/my/members',
		summary: 'Mit dem eigenen Konto verknüpfte (nicht ausgetretene) Mitglieder zur Auswahl',
		tags: TAGS,
		permission: PERMISSIONS.create,
		handler: async ({ ctx }): Promise<MemberOption[]> => linkedMemberOptions(ctx)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/members',
		summary: 'Mitglieder suchen (Bestellen für jedes Mitglied, ab 2 Zeichen)',
		tags: TAGS,
		permission: PERMISSIONS.manage,
		query: memberSearchQuery,
		handler: async ({ query }): Promise<MemberOption[]> => {
			const { search } = query as { search: string };
			if (search.length < 2) return [];
			const list = await (await membersService()).searchMembers({ search, limit: 20 });
			return list.map((m) => ({ id: m.id, name: m.name }));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/overview',
		summary: 'Kopfzahlen für die Verwaltung (offene Bestellungen, Fehlmengen, Einkauf)',
		tags: TAGS,
		permission: PERMISSIONS.view,
		handler: async ({ ctx }): Promise<OrdersOverview> => {
			if (!canManage(ctx) && !ctx.permissions.has(PERMISSIONS.stock)) {
				throw errors.forbidden('Keine Berechtigung');
			}
			return loadOrdersOverview(ctx);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/orders',
		summary: 'Bestellen (für ein verknüpftes Mitglied; mit Verwaltungsrecht für jedes)',
		description:
			'Legt die Bestellung an und schickt die Rechnung sofort über die Kasse. Ist die Kasse nicht aktiv, ' +
			'folgt die Rechnung über den stündlichen Abgleich (`invoicePending`).',
		tags: TAGS,
		permission: PERMISSIONS.create,
		body: orderCreateInput,
		handler: async ({ ctx, body }): Promise<OrderCreated> => {
			const input = body as {
				memberId: string;
				items: { variantId: string; quantity: number }[];
				note: string | null;
			};
			const manage = canManage(ctx);
			// Mitglied prüfen (Dienst `members`, vor der Transaktion)
			let memberName: string | null = null;
			const linked = await linkedMemberOptions(ctx).catch((e: unknown) => {
				logBestEffort('orders.order.linked-members', e, { ctx, target: input.memberId });
				return [] as MemberOption[];
			});
			const own = linked.find((m) => m.id === input.memberId);
			if (own) {
				const [m] = await (await membersService()).searchMembers({ ids: [input.memberId] });
				memberName = m?.name ?? own.name;
			} else if (manage) {
				const [m] = await (await membersService()).searchMembers({ ids: [input.memberId] });
				if (!m) {
					throw errors.validation([{ path: ['memberId'], message: 'Mitglied nicht gefunden' }]);
				}
				memberName = m.name;
			} else {
				throw errors.notFound('Mitglied nicht gefunden');
			}

			const orderId = crypto.randomUUID();
			const created = await mdb().transaction(async (tx) => {
				const ids = input.items.map((i) => i.variantId);
				const variants = await rows(
					tx,
					sql`SELECT v.id, v.label, v.price_cents, v.archived_at, a.title, a.active,
							a.archived_at AS article_archived_at
						FROM article_variants v JOIN articles a ON a.id = v.article_id
						WHERE v.id IN (${idList(ids)})`
				);
				const byId = new Map(variants.map((v) => [String(v.id), v]));
				const issues: Issue[] = [];
				input.items.forEach((it, i) => {
					const v = byId.get(it.variantId);
					if (!v || v.archived_at || v.article_archived_at || !v.active) {
						issues.push({
							path: ['items', i, 'variantId'],
							message: 'Artikel ist nicht bestellbar'
						});
					}
				});
				if (issues.length) throw errors.validation(issues);
				const { number, year, seq } = await nextNumber(tx, 'orders');
				await tx.execute(
					sql`INSERT INTO orders (id, number, year, seq, member_id, member_name, ordered_by, note)
						VALUES (${orderId}, ${number}, ${year}, ${seq}, ${input.memberId}, ${memberName},
							${ctx.userId}, ${input.note})`
				);
				const lines: {
					articleTitle: string;
					variantLabel: string;
					quantity: number;
					totalCents: number;
				}[] = [];
				let position = 0;
				for (const it of input.items) {
					const v = byId.get(it.variantId)!;
					const price = num(v.price_cents);
					await tx.execute(
						sql`INSERT INTO order_items (id, order_id, variant_id, position, article_title,
								variant_label, unit_price_cents, quantity)
							VALUES (${crypto.randomUUID()}, ${orderId}, ${it.variantId}, ${position++},
								${String(v.title)}, ${String(v.label ?? '')}, ${price}, ${it.quantity})`
					);
					lines.push({
						articleTitle: String(v.title),
						variantLabel: String(v.label ?? ''),
						quantity: it.quantity,
						totalCents: price * it.quantity
					});
				}
				return { number, lines };
			});

			const push = await pushInvoice(ctx, orderId, { send: true });
			const totalCents = created.lines.reduce((s, l) => s + l.totalCents, 0);
			await notifyOrderCreated(ctx, {
				number: created.number,
				memberName: memberName ?? '',
				items: created.lines,
				totalCents
			});
			await core.audit.logFromContext(ctx, 'orders.order.created', {
				target: orderId,
				metadata: {
					number: created.number,
					memberId: input.memberId,
					items: created.lines.length,
					quantity: created.lines.reduce((s, l) => s + l.quantity, 0),
					totalCents,
					invoicePending: push.pending
				}
			});
			await notifyCustomer(ctx, orderId, 'created');
			const order = await buildOne(ctx, orderId, new Set(linked.map((m) => m.id)));
			return { order, mailed: push.mailed, invoicePending: push.pending };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/orders',
		summary: 'Bestellungen (eigene bzw. mit Verwaltungsrecht alle), offene zuerst',
		tags: TAGS,
		permission: PERMISSIONS.view,
		query: orderListQuery,
		handler: async ({ ctx, query }): Promise<OrderList> => {
			const q = query as {
				scope: 'mine' | 'all';
				status: string;
				search: string;
				limit: number;
				offset: number;
			};
			if (q.scope === 'all' && !canManage(ctx)) {
				throw errors.forbidden('Alle Bestellungen nur mit Verwaltungsrecht');
			}
			const linkedIds = await linkedMemberIds(ctx);
			const conds: SQL[] = [];
			if (q.scope === 'mine') {
				const linked = [...linkedIds];
				conds.push(
					linked.length
						? sql`(s.ordered_by = ${ctx.userId} OR s.member_id IN (${idList(linked)}))`
						: sql`s.ordered_by = ${ctx.userId}`
				);
			}
			if (q.status === 'active') conds.push(sql`s.status IN ('open', 'partial')`);
			else if (q.status !== 'all') conds.push(sql`s.status = ${q.status}`);
			if (q.search) {
				const p = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
				conds.push(sql`(s.number ILIKE ${p} OR s.member_name ILIKE ${p})`);
			}
			const where = conds.length ? sql.join(conds, sql` AND `) : sql`TRUE`;
			const base = sql`(SELECT o.*, ${ORDER_STATUS_SQL} AS status FROM orders o) s`;
			const { total, data } = await mdb().transaction(async (tx) => {
				const [c] = await rows(tx, sql`SELECT count(*) AS n FROM ${base} WHERE ${where}`);
				const list = await rows(
					tx,
					sql`SELECT s.id FROM ${base} WHERE ${where}
						ORDER BY (s.status IN ('open', 'partial')) DESC, s.created_at DESC, s.number DESC
						LIMIT ${q.limit} OFFSET ${q.offset}`
				);
				const ids = list.map((r) => String(r.id));
				return { total: num(c?.n), data: await loadOrders(tx, ids) };
			});
			return {
				items: await buildOrders(ctx, data, { manage: canManage(ctx), linkedIds }),
				total
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/orders/:id',
		summary: 'Bestellung mit Positionen und Zahlstand',
		tags: TAGS,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Order> => {
			const { id } = params as { id: string };
			const linkedIds = canManage(ctx) ? new Set<string>() : await linkedMemberIds(ctx);
			const data = await mdb().transaction((tx) => loadOrderOr404(tx, id));
			if (!canManage(ctx) && !isOwnOrder(data.order, ctx, linkedIds)) {
				throw errors.notFound('Bestellung nicht gefunden');
			}
			const [order] = await buildOrders(ctx, [data], { manage: canManage(ctx), linkedIds });
			return order!;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/orders/:id/cancel',
		summary: 'Bestellung (teilweise) stornieren',
		description:
			'Eigene Bestellungen nur, solange nichts ausgegeben ist; mit Verwaltungsrecht jede offene Menge. ' +
			'Ohne `items` wird alles Offene storniert. Die Rechnung in der Kasse wird angepasst.',
		tags: TAGS,
		permission: PERMISSIONS.view,
		params: idParams,
		body: orderCancelInput,
		handler: async ({ ctx, params, body }): Promise<Order> => {
			const { id } = params as { id: string };
			const input = body as {
				items?: { itemId: string; quantity: number }[];
				reason: string | null;
			};
			const manage = canManage(ctx);
			const linkedIds = manage ? new Set<string>() : await linkedMemberIds(ctx);
			const result = await mdb().transaction(async (tx) => {
				const data = await loadOrderOr404(tx, id, true);
				if (!manage) {
					if (!isOwnOrder(data.order, ctx, linkedIds)) {
						throw errors.notFound('Bestellung nicht gefunden');
					}
					if (!ctx.permissions.has(PERMISSIONS.create)) {
						throw errors.forbidden(`Berechtigung fehlt: ${PERMISSIONS.create}`);
					}
					if (data.items.some((r) => num(r.delivered_qty) > 0)) {
						throw errors.conflict(
							'Es wurde bereits Ware ausgegeben – bitte an die*den Kämmerer*in wenden'
						);
					}
				}
				if (data.order.cancelled_at) throw errors.conflict('Bestellung ist bereits storniert');
				const changes = new Map<string, number>();
				if (input.items) {
					const issues: Issue[] = [];
					input.items.forEach((it, i) => {
						const row = data.items.find((r) => r.id === it.itemId);
						if (!row) {
							issues.push({ path: ['items', i, 'itemId'], message: 'Position nicht gefunden' });
							return;
						}
						const open = openQty(itemQty(row));
						if (it.quantity > open) {
							issues.push({
								path: ['items', i, 'quantity'],
								message: `Höchstens ${open} offen`
							});
							return;
						}
						if (it.quantity > 0) changes.set(it.itemId, it.quantity);
					});
					if (issues.length) throw errors.validation(issues);
				} else {
					for (const r of data.items) {
						const open = openQty(itemQty(r));
						if (open > 0) changes.set(String(r.id), open);
					}
				}
				if (!changes.size) throw errors.conflict('Nichts mehr offen zum Stornieren');
				for (const [itemId, qty] of changes) {
					await tx.execute(
						sql`UPDATE order_items SET cancelled_qty = cancelled_qty + ${qty} WHERE id = ${itemId}`
					);
				}
				const [sum] = await rows(
					tx,
					sql`SELECT coalesce(sum(quantity), 0) AS q, coalesce(sum(cancelled_qty), 0) AS c
						FROM order_items WHERE order_id = ${id}`
				);
				const all = num(sum?.c) >= num(sum?.q);
				await tx.execute(
					sql`UPDATE orders SET treasury_dirty = true, updated_at = now(),
						cancelled_at = CASE WHEN ${all} THEN now() ELSE cancelled_at END
						WHERE id = ${id}`
				);
				return {
					items: changes.size,
					quantity: [...changes.values()].reduce((s, n) => s + n, 0),
					all
				};
			});
			await pushInvoice(ctx, id);
			await core.audit.logFromContext(ctx, 'orders.order.cancelled', {
				target: id,
				metadata: { ...result, hasReason: !!input.reason }
			});
			await notifyCustomer(ctx, id, 'cancelled', { quantity: result.quantity, all: result.all });
			return buildOne(ctx, id, linkedIds);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/orders/:id/handout',
		summary: 'Ware ausgeben (auch teilweise); senkt den Lagerbestand',
		tags: TAGS,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: orderHandoutInput,
		handler: async ({ ctx, params, body }): Promise<Order> => {
			const { id } = params as { id: string };
			const input = body as { items: { itemId: string; quantity: number }[] };
			const result = await mdb().transaction(async (tx) => {
				const data = await loadOrderOr404(tx, id, true);
				if (data.order.cancelled_at) throw errors.conflict('Bestellung ist storniert');
				const issues: Issue[] = [];
				const changes: { row: (typeof data.items)[number]; qty: number }[] = [];
				input.items.forEach((it, i) => {
					const row = data.items.find((r) => r.id === it.itemId);
					if (!row) {
						issues.push({ path: ['items', i, 'itemId'], message: 'Position nicht gefunden' });
						return;
					}
					const open = openQty(itemQty(row));
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
				// Bestand prüfen (je Variante gesperrt)
				const need = new Map<string, number>();
				for (const c of changes) {
					const v = String(c.row.variant_id);
					need.set(v, (need.get(v) ?? 0) + c.qty);
				}
				const stock = await rows(
					tx,
					sql`SELECT id, stock FROM article_variants WHERE id IN (${idList([...need.keys()])})
						ORDER BY id FOR UPDATE`
				);
				for (const c of changes) {
					const v = String(c.row.variant_id);
					const have = num(stock.find((s) => s.id === v)?.stock);
					if ((need.get(v) ?? 0) > have) {
						const size = c.row.variant_label ? ` (Gr. ${String(c.row.variant_label)})` : '';
						throw errors.conflict(`Nur ${have} auf Lager: ${String(c.row.article_title)}${size}`);
					}
				}
				for (const c of changes) {
					await tx.execute(
						sql`UPDATE order_items SET delivered_qty = delivered_qty + ${c.qty} WHERE id = ${String(c.row.id)}`
					);
					await tx.execute(
						sql`UPDATE article_variants SET stock = stock - ${c.qty} WHERE id = ${String(c.row.variant_id)}`
					);
					await tx.execute(
						sql`INSERT INTO stock_movements (id, variant_id, delta, kind, order_item_id, created_by)
							VALUES (${crypto.randomUUID()}, ${String(c.row.variant_id)}, ${-c.qty}, 'handout',
								${String(c.row.id)}, ${ctx.userId})`
					);
				}
				await tx.execute(sql`UPDATE orders SET updated_at = now() WHERE id = ${id}`);
				return {
					items: changes.length,
					quantity: changes.reduce((s, c) => s + c.qty, 0)
				};
			});
			await core.audit.logFromContext(ctx, 'orders.order.handed-out', {
				target: id,
				metadata: result
			});
			await notifyCustomer(ctx, id, 'handed-out', { quantity: result.quantity });
			return buildOne(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/orders/:id',
		summary: 'Bestellung nachträglich bearbeiten (Positionen, Mengen, Preise, Notiz)',
		description:
			'`items` ist die vollständige Liste: bestehende Positionen über `itemId`, neue über `variantId`; fehlende ' +
			'bzw. Menge 0 werden entfernt (nur ohne Ausgabe). `quantity` ist die gültige Menge – eine geänderte Menge ' +
			'ersetzt Storniertes der Position, nie unter die ausgegebene Menge. Die Rechnung in der Kasse wird angepasst.',
		tags: TAGS,
		permission: PERMISSIONS.edit,
		params: idParams,
		body: orderUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Order> => {
			const { id } = params as { id: string };
			const input = body as {
				items: {
					itemId?: string | null;
					variantId?: string | null;
					quantity: number;
					unitPriceCents?: number;
				}[];
				note: string | null;
			};
			const result = await mdb().transaction(async (tx) => {
				const data = await loadOrderOr404(tx, id, true);
				const byItem = new Map(data.items.map((r) => [String(r.id), r]));
				const usedVariants = new Set(data.items.map((r) => String(r.variant_id)));
				const newIds = input.items
					.filter((it) => !it.itemId && it.variantId)
					.map((it) => it.variantId!);
				const variants = newIds.length
					? await rows(
							tx,
							sql`SELECT v.id, v.label, v.price_cents, v.archived_at, a.title, a.active,
									a.archived_at AS article_archived_at
								FROM article_variants v JOIN articles a ON a.id = v.article_id
								WHERE v.id IN (${idList(newIds)})`
						)
					: [];
				const byVariant = new Map(variants.map((v) => [String(v.id), v]));
				const issues: Issue[] = [];
				const seen = new Set<string>();
				/** `quantity: null` = nur der Preis ändert sich */
				const updates: { id: string; quantity: number | null; price: number }[] = [];
				const removes: string[] = [];
				const inserts: {
					variantId: string;
					title: string;
					label: string;
					price: number;
					quantity: number;
				}[] = [];
				input.items.forEach((it, i) => {
					if (it.itemId) {
						const row = byItem.get(it.itemId);
						if (!row) {
							issues.push({ path: ['items', i, 'itemId'], message: 'Position nicht gefunden' });
							return;
						}
						seen.add(it.itemId);
						const q = itemQty(row);
						if (it.quantity < q.deliveredQty) {
							issues.push({
								path: ['items', i, 'quantity'],
								message: `Mindestens ${q.deliveredQty} (bereits ausgegeben)`
							});
							return;
						}
						const oldPrice = num(row.unit_price_cents);
						const price = it.unitPriceCents ?? oldPrice;
						const qtyChanged = it.quantity !== q.quantity - q.cancelledQty;
						if (!qtyChanged && price === oldPrice) return;
						if (it.quantity === 0) removes.push(it.itemId);
						else updates.push({ id: it.itemId, quantity: qtyChanged ? it.quantity : null, price });
						return;
					}
					const v = byVariant.get(it.variantId!);
					if (!v || v.archived_at || v.article_archived_at || !v.active) {
						issues.push({
							path: ['items', i, 'variantId'],
							message: 'Artikel ist nicht bestellbar'
						});
					} else if (usedVariants.has(it.variantId!)) {
						issues.push({
							path: ['items', i, 'variantId'],
							message: 'Artikel ist schon in der Bestellung – bitte dort die Menge ändern'
						});
					} else {
						inserts.push({
							variantId: it.variantId!,
							title: String(v.title),
							label: String(v.label ?? ''),
							price: it.unitPriceCents ?? num(v.price_cents),
							quantity: it.quantity
						});
					}
				});
				// Nicht mehr aufgeführte Positionen entfallen – nur, wenn davon nichts ausgegeben ist
				for (const r of data.items) {
					if (seen.has(String(r.id))) continue;
					if (num(r.delivered_qty) > 0) {
						const size = r.variant_label ? ` (${String(r.variant_label)})` : '';
						issues.push({
							path: ['items'],
							message: `${String(r.article_title)}${size} wurde bereits ausgegeben und kann nicht entfernt werden`
						});
					} else removes.push(String(r.id));
				}
				if (issues.length) throw errors.validation(issues);

				for (const u of updates) {
					await tx.execute(
						u.quantity === null
							? sql`UPDATE order_items SET unit_price_cents = ${u.price} WHERE id = ${u.id}`
							: sql`UPDATE order_items SET quantity = ${u.quantity}, cancelled_qty = 0,
									unit_price_cents = ${u.price} WHERE id = ${u.id}`
					);
				}
				if (removes.length) {
					await tx.execute(sql`DELETE FROM order_items WHERE id IN (${idList(removes)})`);
				}
				let position = data.items.reduce((m, r) => Math.max(m, num(r.position)), -1) + 1;
				for (const n of inserts) {
					await tx.execute(
						sql`INSERT INTO order_items (id, order_id, variant_id, position, article_title,
								variant_label, unit_price_cents, quantity)
							VALUES (${crypto.randomUUID()}, ${id}, ${n.variantId}, ${position++},
								${n.title}, ${n.label}, ${n.price}, ${n.quantity})`
					);
				}
				const itemsChanged = updates.length + removes.length + inserts.length > 0;
				const noteChanged = (input.note ?? null) !== (str(data.order.note) ?? null);
				if (itemsChanged || noteChanged) {
					// Mindestens eine Position hat eine gültige Menge (Schema) → nicht mehr storniert
					await tx.execute(
						sql`UPDATE orders SET note = ${input.note}, updated_at = now(),
							treasury_dirty = treasury_dirty OR ${itemsChanged},
							cancelled_at = CASE WHEN ${itemsChanged} THEN NULL ELSE cancelled_at END
							WHERE id = ${id}`
					);
				}
				return {
					number: String(data.order.number),
					itemsChanged,
					noteChanged,
					added: inserts.length,
					updated: updates.length,
					removed: removes.length
				};
			});
			if (result.itemsChanged) await pushInvoice(ctx, id);
			if (result.itemsChanged || result.noteChanged) {
				await core.audit.logFromContext(ctx, 'orders.order.updated', {
					target: id,
					metadata: {
						number: result.number,
						added: result.added,
						updated: result.updated,
						removed: result.removed,
						noteChanged: result.noteChanged
					}
				});
			}
			if (result.itemsChanged) await notifyCustomer(ctx, id, 'updated');
			return buildOne(ctx, id, canManage(ctx) ? undefined : await linkedMemberIds(ctx));
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/orders/:id',
		summary: 'Bestellung ganz löschen (statt nur stornieren)',
		description:
			'Storniert zuerst die Rechnung in der Kasse (sie bleibt dort als Stornierung erhalten; Bezahltes wird ' +
			'Guthaben) und löscht dann die Bestellung samt Positionen. Ausgegebene Ware bleibt ausgegeben, der ' +
			'Lagerbestand ändert sich nicht. Gibt es eine Rechnung und ist die Kasse nicht aktiv oder scheitert das ' +
			'Stornieren → 409, die Bestellung bleibt.',
		tags: TAGS,
		permission: PERMISSIONS.delete,
		params: idParams,
		handler: async ({ ctx, params }): Promise<OrderDeleted> => {
			const { id } = params as { id: string };
			const data = await mdb().transaction((tx) => loadOrderOr404(tx, id));
			const o = data.order;
			const invoiceId = str(o.invoice_id);
			const treasury = await treasuryService();
			let invoiceCancelled = false;
			if (treasury) {
				try {
					const r = await treasury.upsertOrderInvoice(ctx, {
						sourceKey: invoiceSourceKey(id),
						memberId: String(o.member_id),
						orderNumber: String(o.number),
						recipientName: null,
						note: str(o.note),
						lines: [],
						send: false
					});
					invoiceCancelled = !!r.invoiceId;
				} catch (e) {
					logBestEffort('orders.order.delete-invoice', e, { ctx, target: id });
					if (invoiceId) {
						throw errors.conflict(
							'Die Rechnung in der Kasse konnte nicht storniert werden – die Bestellung wurde nicht gelöscht.'
						);
					}
				}
			} else if (invoiceId) {
				throw errors.conflict(
					'Die Kasse ist nicht aktiv, die Rechnung kann nicht storniert werden. Bitte die Kasse aktivieren ' +
						'oder die Bestellung nur stornieren.'
				);
			}
			const deleted = await mdb().transaction((tx) =>
				rows(tx, sql`DELETE FROM orders WHERE id = ${id} RETURNING id`)
			);
			if (!deleted.length) throw errors.notFound('Bestellung nicht gefunden');
			const number = String(o.number);
			await core.audit.logFromContext(ctx, 'orders.order.deleted', {
				target: id,
				metadata: {
					number,
					items: data.items.length,
					delivered: data.items.reduce((s, r) => s + num(r.delivered_qty), 0),
					invoiceCancelled
				}
			});
			await notifyCustomer(ctx, id, 'deleted', { snapshot: o });
			return { number, invoiceCancelled };
		}
	})
] as ApiEndpoint[];
