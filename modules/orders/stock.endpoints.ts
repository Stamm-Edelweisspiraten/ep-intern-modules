/** Lager: Bestand mit Nachfrage/Fehlmengen, Korrekturen und Bewegungen. */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint } from '$lib/sdk/server';
import {
	movementListQuery,
	PERMISSIONS,
	stockCorrectionInput,
	type MovementKind,
	type StockMovement,
	type StockRow
} from './schemas';
import { iso, mdb, num, rows, str, userNames } from './db';
import { loadStock } from './orders.service';

const TAGS = ['Modul: orders'];

export const stockEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/stock',
		summary:
			'Lagerbestand je Größe mit offener Nachfrage, Bestellungen beim Lieferanten und Fehlmenge',
		tags: TAGS,
		permission: PERMISSIONS.stock,
		handler: async (): Promise<StockRow[]> => mdb().transaction((tx) => loadStock(tx))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/stock/corrections',
		summary: 'Bestand korrigieren (absoluter Wert, z. B. nach Inventur)',
		tags: TAGS,
		permission: PERMISSIONS.stock,
		body: stockCorrectionInput,
		handler: async ({ ctx, body }): Promise<StockRow> => {
			const input = body as { variantId: string; stock: number; note: string | null };
			const { delta, row } = await mdb().transaction(async (tx) => {
				const [v] = await rows(
					tx,
					sql`SELECT stock FROM article_variants WHERE id = ${input.variantId} FOR UPDATE`
				);
				if (!v) throw errors.notFound('Artikelgröße nicht gefunden');
				const delta = input.stock - num(v.stock);
				if (delta !== 0) {
					await tx.execute(
						sql`UPDATE article_variants SET stock = ${input.stock} WHERE id = ${input.variantId}`
					);
					await tx.execute(
						sql`INSERT INTO stock_movements (id, variant_id, delta, kind, note, created_by)
							VALUES (${crypto.randomUUID()}, ${input.variantId}, ${delta}, 'correction',
								${input.note}, ${ctx.userId})`
					);
				}
				const [row] = await loadStock(tx, [input.variantId]);
				return { delta, row: row! };
			});
			await core.audit.logFromContext(ctx, 'orders.stock.corrected', {
				target: input.variantId,
				metadata: { delta, stock: input.stock }
			});
			return row;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/stock/movements',
		summary: 'Lagerbewegungen (neueste zuerst), optional je Größe',
		tags: TAGS,
		permission: PERMISSIONS.stock,
		query: movementListQuery,
		handler: async ({ ctx, query }): Promise<{ items: StockMovement[]; total: number }> => {
			const q = query as { variantId?: string; limit: number; offset: number };
			const where = q.variantId ? sql`m.variant_id = ${q.variantId}` : sql`TRUE`;
			const { list, total } = await mdb().transaction(async (tx) => {
				const [c] = await rows(tx, sql`SELECT count(*) AS n FROM stock_movements m WHERE ${where}`);
				const list = await rows(
					tx,
					sql`SELECT m.*, v.label, a.title, o.number AS order_number, so.number AS supplier_number
						FROM stock_movements m
						JOIN article_variants v ON v.id = m.variant_id
						JOIN articles a ON a.id = v.article_id
						LEFT JOIN order_items oi ON oi.id = m.order_item_id
						LEFT JOIN orders o ON o.id = oi.order_id
						LEFT JOIN supplier_order_items si ON si.id = m.supplier_item_id
						LEFT JOIN supplier_orders so ON so.id = si.supplier_order_id
						WHERE ${where}
						ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`
				);
				return { list, total: num(c?.n) };
			});
			const names = await userNames(
				ctx,
				list.map((r) => str(r.created_by))
			);
			return {
				total,
				items: list.map((r) => {
					const by = str(r.created_by);
					return {
						id: String(r.id),
						variantId: String(r.variant_id),
						articleTitle: String(r.title),
						variantLabel: String(r.label ?? ''),
						delta: num(r.delta),
						kind: String(r.kind) as MovementKind,
						orderNumber: str(r.order_number),
						supplierOrderNumber: str(r.supplier_number),
						note: str(r.note),
						createdBy: by ? { id: by, name: names.get(by) ?? 'Unbekannt' } : null,
						createdAt: iso(r.created_at)
					};
				})
			};
		}
	})
] as ApiEndpoint[];
