/**
 * Vorrat (Lebensmittel): Produkte mit Hersteller-Barcode, Chargen mit MHD, Einlagern und Entnehmen (zuerst
 * ablaufende zuerst), Verlauf, Barcode-Scan mit Vorschlag aus Open Food Facts. Nicht reservierbar.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { formatDateDe } from '$lib/sdk/dates';
import { dateStr, idList, iso, likePattern, mdb, num, rows, str, today, userNames } from './db';
import { lookupBarcode } from './off.service';
import { expiryState, fefoOrder, normalizeBarcode, pickBatches } from './pantry';
import {
	PERMISSIONS,
	barcodeParams,
	batchParams,
	batchUpdateInput,
	checkInInput,
	checkOutInput,
	formatAmount,
	idParams,
	pantryQuery,
	productInput,
	productUpdateInput,
	type BarcodeResult,
	type FoodBatch,
	type FoodProduct,
	type MovementKind,
	type ProductDetail
} from './schemas';

const tags = ['Modul: material'];

const PRODUCT_SELECT = sql`SELECT p.id, p.name, p.brand, p.barcode, p.unit, p.package_size, p.location_id,
		l.name AS location_name, p.notes, p.archived_at
	FROM food_products p LEFT JOIN locations l ON l.id = p.location_id`;

/** Produkte nach Bedingung (Alias `p`, `l`) mit ihren Chargen (nur mit Bestand) */
export async function loadProducts(tx: Tx, where: SQL = sql`TRUE`): Promise<FoodProduct[]> {
	const list = await rows(tx, sql`${PRODUCT_SELECT} WHERE ${where} ORDER BY lower(p.name), p.id`);
	if (!list.length) return [];
	const batches = await rows(
		tx,
		sql`SELECT b.id, b.product_id, b.quantity, to_char(b.best_before, 'YYYY-MM-DD') AS best_before,
				b.location_id, l.name AS location_name, b.created_at
			FROM food_batches b LEFT JOIN locations l ON l.id = b.location_id
			WHERE b.quantity > 0 AND b.product_id IN (${idList(list.map((r) => String(r.id)))})`
	);
	const t = today();
	const byProduct = new Map<string, FoodBatch[]>();
	for (const b of batches) {
		const bestBefore = b.best_before ? dateStr(b.best_before) : null;
		const arr = byProduct.get(String(b.product_id)) ?? [];
		arr.push({
			id: String(b.id),
			quantity: num(b.quantity),
			bestBefore,
			state: expiryState(bestBefore, t),
			locationId: str(b.location_id) || null,
			locationName: str(b.location_name) || null,
			createdAt: iso(b.created_at)
		});
		byProduct.set(String(b.product_id), arr);
	}
	return list.map((r) => {
		const own = fefoOrder(byProduct.get(String(r.id)) ?? []);
		const next = own.find((b) => b.bestBefore)?.bestBefore ?? null;
		return {
			id: String(r.id),
			name: String(r.name),
			brand: str(r.brand),
			barcode: str(r.barcode) || null,
			unit: str(r.unit),
			packageSize: str(r.package_size),
			locationId: str(r.location_id) || null,
			locationName: str(r.location_name) || null,
			notes: str(r.notes),
			archived: !!r.archived_at,
			quantity: own.reduce((n, b) => n + b.quantity, 0),
			nextBestBefore: next,
			state: expiryState(next, t),
			batches: own
		};
	});
}

async function requireProduct(tx: Tx, id: string): Promise<FoodProduct> {
	const [p] = await loadProducts(tx, sql`p.id = ${id}`);
	if (!p) throw errors.notFound('Produkt nicht gefunden');
	return p;
}

async function assertLocation(tx: Tx, id: string | null | undefined) {
	if (!id) return;
	const [r] = await rows(tx, sql`SELECT 1 AS x FROM locations WHERE id = ${id}`);
	if (!r) throw errors.validation([{ path: ['locationId'], message: 'Lagerort nicht gefunden' }]);
}

async function assertBarcodeFree(tx: Tx, barcode: string | null | undefined, except?: string) {
	if (!barcode) return;
	const [r] = await rows(
		tx,
		sql`SELECT name FROM food_products WHERE barcode = ${barcode} AND id::text <> ${except ?? ''}`
	);
	if (r) throw errors.conflict(`Dieser Strichcode gehört schon zu „${String(r.name)}“`);
}

async function addMovement(
	tx: Tx,
	m: {
		productId: string;
		batchId: string | null;
		kind: MovementKind;
		quantity: number;
		bestBefore: string | null;
		note: string;
		userId: string | null;
	}
) {
	await tx.execute(
		sql`INSERT INTO food_movements (id, product_id, batch_id, kind, quantity, best_before, note, created_by,
				created_at)
			VALUES (${crypto.randomUUID()}, ${m.productId}, ${m.batchId}, ${m.kind}, ${m.quantity},
				${m.bestBefore}::date, ${m.note}, ${m.userId}, clock_timestamp())`
	);
}

function matchesFilter(p: FoodProduct, filter: 'all' | 'stock' | 'soon' | 'expired'): boolean {
	if (filter === 'stock') return p.quantity > 0;
	if (filter === 'soon') return p.batches.some((b) => b.state === 'soon' || b.state === 'expired');
	if (filter === 'expired') return p.batches.some((b) => b.state === 'expired');
	return true;
}

export const pantryEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/pantry',
		summary: 'Vorrat: Produkte mit Chargen (Filter: mit Bestand, läuft bald ab, abgelaufen)',
		tags,
		permission: PERMISSIONS.view,
		query: pantryQuery,
		handler: async ({ query }): Promise<FoodProduct[]> => {
			const where: SQL[] = [query.archived === '1' ? sql`TRUE` : sql`p.archived_at IS NULL`];
			if (query.search) {
				const p = likePattern(query.search);
				const code = normalizeBarcode(query.search);
				where.push(
					sql`(p.name ILIKE ${p} OR p.brand ILIKE ${p} OR p.notes ILIKE ${p}
						OR p.barcode = ${code ?? query.search.trim()})`
				);
			}
			const list = await mdb().transaction((tx) => loadProducts(tx, sql.join(where, sql` AND `)));
			return list.filter((p) => matchesFilter(p, query.filter));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/pantry/barcode/:code',
		summary: 'Gescannten Strichcode auflösen (Produkt oder Vorschlag aus Open Food Facts)',
		description:
			'Unbekannte Codes werden mit Vorratsrecht bei Open Food Facts nachgeschlagen (nur der Strichcode geht hinaus).',
		tags,
		permission: PERMISSIONS.view,
		params: barcodeParams,
		rateLimit: { limit: 120, windowSec: 60 },
		handler: async ({ ctx, params }): Promise<BarcodeResult> => {
			const barcode = normalizeBarcode(params.code);
			if (!barcode) {
				throw errors.validation([
					{ path: ['code'], message: 'Kein gültiger Strichcode (EAN/GTIN)' }
				]);
			}
			const [product] = await mdb().transaction((tx) =>
				loadProducts(tx, sql`p.barcode = ${barcode}`)
			);
			if (product) return { barcode, product, suggestion: null };
			const suggestion = ctx.permissions.has(PERMISSIONS.pantry)
				? await lookupBarcode(barcode)
				: null;
			return { barcode, product: null, suggestion };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/pantry/products/:id',
		summary: 'Produkt mit Chargen und Verlauf',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<ProductDetail> => {
			const { product, moves } = await mdb().transaction(async (tx) => ({
				product: await requireProduct(tx, params.id),
				moves: await rows(
					tx,
					sql`SELECT id, kind, quantity, to_char(best_before, 'YYYY-MM-DD') AS best_before, note,
							created_by, created_at
						FROM food_movements WHERE product_id = ${params.id}
						ORDER BY created_at DESC, id LIMIT 50`
				)
			}));
			const names = await userNames(
				ctx,
				moves.map((m) => str(m.created_by) || null)
			);
			return {
				...product,
				movements: moves.map((m) => {
					const by = str(m.created_by) || null;
					return {
						id: String(m.id),
						kind: String(m.kind) as MovementKind,
						quantity: num(m.quantity),
						bestBefore: m.best_before ? dateStr(m.best_before) : null,
						note: str(m.note),
						createdByName: by ? (names.get(by) ?? 'Unbekannt') : null,
						createdAt: iso(m.created_at)
					};
				})
			};
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/pantry/products',
		summary: 'Produkt anlegen (Strichcode eindeutig, sonst 409)',
		tags,
		permission: PERMISSIONS.pantry,
		body: productInput,
		handler: async ({ ctx, body }): Promise<FoodProduct> => {
			const id = crypto.randomUUID();
			const product = await mdb().transaction(async (tx) => {
				await assertLocation(tx, body.locationId);
				await assertBarcodeFree(tx, body.barcode);
				await tx.execute(
					sql`INSERT INTO food_products (id, name, brand, barcode, unit, package_size, location_id, notes,
							created_by)
						VALUES (${id}, ${body.name}, ${body.brand}, ${body.barcode}, ${body.unit}, ${body.packageSize},
							${body.locationId}, ${body.notes}, ${ctx.userId ?? null})`
				);
				return requireProduct(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.pantry.product-created', { target: id });
			return product;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/pantry/products/:id',
		summary: 'Produkt bearbeiten oder archivieren',
		tags,
		permission: PERMISSIONS.pantry,
		params: idParams,
		body: productUpdateInput,
		handler: async ({ ctx, params, body }): Promise<FoodProduct> => {
			const product = await mdb().transaction(async (tx) => {
				await requireProduct(tx, params.id);
				await assertLocation(tx, body.locationId);
				await assertBarcodeFree(tx, body.barcode, params.id);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.brand !== undefined) sets.push(sql`brand = ${body.brand}`);
				if (body.barcode !== undefined) sets.push(sql`barcode = ${body.barcode}`);
				if (body.unit !== undefined) sets.push(sql`unit = ${body.unit}`);
				if (body.packageSize !== undefined) sets.push(sql`package_size = ${body.packageSize}`);
				if (body.locationId !== undefined) sets.push(sql`location_id = ${body.locationId}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.archived !== undefined)
					sets.push(
						body.archived
							? sql`archived_at = coalesce(archived_at, now())`
							: sql`archived_at = NULL`
					);
				await tx.execute(
					sql`UPDATE food_products SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				return requireProduct(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.pantry.product-updated', {
				target: params.id
			});
			return product;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/pantry/products/:id',
		summary: 'Produkt löschen (nur ohne Bestand; sonst archivieren)',
		tags,
		permission: PERMISSIONS.pantry,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const p = await requireProduct(tx, params.id);
				if (p.quantity > 0) {
					throw errors.conflict('Das Produkt hat noch Bestand – erst entnehmen oder archivieren');
				}
				await tx.execute(sql`DELETE FROM food_products WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.pantry.product-deleted', {
				target: params.id
			});
			return { deleted: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/pantry/products/:id/check-in',
		summary: 'Einlagern (gleiches MHD und gleicher Ort → in dieselbe Charge)',
		tags,
		permission: PERMISSIONS.pantry,
		params: idParams,
		body: checkInInput,
		handler: async ({ ctx, params, body }): Promise<FoodProduct> => {
			const product = await mdb().transaction(async (tx) => {
				const p = await requireProduct(tx, params.id);
				if (p.archived) throw errors.conflict('Das Produkt ist archiviert');
				await assertLocation(tx, body.locationId);
				const locationId = body.locationId ?? p.locationId;
				const [same] = await rows(
					tx,
					sql`SELECT id FROM food_batches
						WHERE product_id = ${params.id} AND best_before IS NOT DISTINCT FROM ${body.bestBefore}::date
							AND location_id IS NOT DISTINCT FROM ${locationId}::uuid
						ORDER BY created_at LIMIT 1 FOR UPDATE`
				);
				let batchId: string;
				if (same) {
					batchId = String(same.id);
					await tx.execute(
						sql`UPDATE food_batches SET quantity = quantity + ${body.quantity} WHERE id = ${batchId}`
					);
				} else {
					batchId = crypto.randomUUID();
					await tx.execute(
						sql`INSERT INTO food_batches (id, product_id, quantity, best_before, location_id, created_by)
							VALUES (${batchId}, ${params.id}, ${body.quantity}, ${body.bestBefore}::date, ${locationId},
								${ctx.userId ?? null})`
					);
				}
				await addMovement(tx, {
					productId: params.id,
					batchId,
					kind: 'in',
					quantity: body.quantity,
					bestBefore: body.bestBefore,
					note: body.note,
					userId: ctx.userId ?? null
				});
				return requireProduct(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.pantry.checked-in', {
				target: params.id,
				metadata: { quantity: body.quantity }
			});
			return product;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/pantry/products/:id/check-out',
		summary: 'Entnehmen oder entsorgen (zuerst ablaufende zuerst; zu wenig → 409)',
		tags,
		permission: PERMISSIONS.pantry,
		params: idParams,
		body: checkOutInput,
		handler: async ({ ctx, params, body }): Promise<FoodProduct> => {
			const product = await mdb().transaction(async (tx) => {
				const p = await requireProduct(tx, params.id);
				const batches = (
					await rows(
						tx,
						sql`SELECT id, quantity, to_char(best_before, 'YYYY-MM-DD') AS best_before, created_at
							FROM food_batches WHERE product_id = ${params.id} AND quantity > 0 FOR UPDATE`
					)
				).map((b) => ({
					id: String(b.id),
					quantity: num(b.quantity),
					bestBefore: b.best_before ? dateStr(b.best_before) : null,
					createdAt: iso(b.created_at)
				}));
				if (body.batchId && !batches.some((b) => b.id === body.batchId)) {
					throw errors.validation([
						{ path: ['batchId'], message: 'Charge nicht gefunden oder leer' }
					]);
				}
				const picks = pickBatches(batches, body.quantity, body.batchId);
				if (!picks) {
					const have = body.batchId
						? (batches.find((b) => b.id === body.batchId)?.quantity ?? 0)
						: p.quantity;
					throw errors.conflict(`Nur ${formatAmount(have, p.unit)} vorhanden`);
				}
				for (const pick of picks) {
					await tx.execute(
						sql`UPDATE food_batches SET quantity = quantity - ${pick.quantity} WHERE id = ${pick.batchId}`
					);
					await addMovement(tx, {
						productId: params.id,
						batchId: pick.batchId,
						kind: body.kind,
						quantity: pick.quantity,
						bestBefore: batches.find((b) => b.id === pick.batchId)?.bestBefore ?? null,
						note: body.note,
						userId: ctx.userId ?? null
					});
				}
				await tx.execute(
					sql`DELETE FROM food_batches WHERE product_id = ${params.id} AND quantity = 0
						AND id IN (${idList(picks.map((x) => x.batchId))})`
				);
				return requireProduct(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.pantry.checked-out', {
				target: params.id,
				metadata: { quantity: body.quantity, kind: body.kind }
			});
			return product;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/pantry/products/:id/batches/:batchId',
		summary: 'Charge berichtigen (Anzahl, MHD)',
		tags,
		permission: PERMISSIONS.pantry,
		params: batchParams,
		body: batchUpdateInput,
		handler: async ({ ctx, params, body }): Promise<FoodProduct> => {
			const product = await mdb().transaction(async (tx) => {
				const [b] = await rows(
					tx,
					sql`SELECT quantity, to_char(best_before, 'YYYY-MM-DD') AS best_before FROM food_batches
						WHERE id = ${params.batchId} AND product_id = ${params.id} FOR UPDATE`
				);
				if (!b) throw errors.notFound('Charge nicht gefunden');
				const oldQty = num(b.quantity);
				const oldDate = b.best_before ? dateStr(b.best_before) : null;
				const qty = body.quantity ?? oldQty;
				const date = body.bestBefore !== undefined ? body.bestBefore : oldDate;
				if (qty === oldQty && date === oldDate) return requireProduct(tx, params.id);
				const changes: string[] = [];
				if (qty !== oldQty) changes.push(`Anzahl ${oldQty} → ${qty}`);
				if (date !== oldDate) {
					changes.push(`MHD ${formatDateDe(oldDate, 'ohne')} → ${formatDateDe(date, 'ohne')}`);
				}
				if (qty === 0) {
					await tx.execute(sql`DELETE FROM food_batches WHERE id = ${params.batchId}`);
				} else {
					await tx.execute(
						sql`UPDATE food_batches SET quantity = ${qty}, best_before = ${date}::date,
							expiry_notified_at = ${date === oldDate ? sql`expiry_notified_at` : sql`NULL`}
							WHERE id = ${params.batchId}`
					);
				}
				await addMovement(tx, {
					productId: params.id,
					batchId: qty === 0 ? null : params.batchId,
					kind: 'correct',
					quantity: Math.max(1, Math.abs(qty - oldQty) || qty),
					bestBefore: date,
					note: [changes.join(', '), body.note].filter(Boolean).join(' · '),
					userId: ctx.userId ?? null
				});
				return requireProduct(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.pantry.batch-corrected', {
				target: params.id
			});
			return product;
		}
	})
];
