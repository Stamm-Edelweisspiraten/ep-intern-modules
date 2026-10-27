/**
 * Mengenbestand je Lagerort/Kiste: Liste, Bestand setzen (Zählen), Umlagern.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	type AnyApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { logMovement, mdb, num, rows, str } from './db';
import { holderText, loadPlaceIndex, type PlaceIndex } from './inventory';
import {
	PERMISSIONS,
	stockListQuery,
	stockMoveInput,
	stockSetInput,
	type StockEntry
} from './schemas';

const tags = ['Modul: material'];

type Holder = { locationId: string | null; containerId: string | null };

async function requireBulkArticle(tx: Tx, id: string): Promise<string> {
	const [a] = await rows(tx, sql`SELECT name, kind FROM articles WHERE id = ${id}`);
	if (!a) throw errors.validation([{ path: ['articleId'], message: 'Artikel fehlt' }]);
	if (String(a.kind) !== 'bulk') {
		throw errors.validation([
			{ path: ['articleId'], message: 'Bestand gibt es nur für Mengenartikel' }
		]);
	}
	return String(a.name);
}

function assertHolder(index: PlaceIndex, h: Holder, path: string): void {
	if (h.locationId && !index.locationPaths.has(h.locationId)) {
		throw errors.validation([{ path: [path, 'locationId'], message: 'Lagerort nicht gefunden' }]);
	}
	if (h.containerId && !index.units.get(h.containerId)?.isContainer) {
		throw errors.validation([{ path: [path, 'containerId'], message: 'Kiste nicht gefunden' }]);
	}
}

const holderCond = (h: Holder) =>
	h.locationId ? sql`location_id = ${h.locationId}` : sql`container_id = ${h.containerId}`;

async function currentQty(tx: Tx, articleId: string, h: Holder): Promise<number> {
	const [r] = await rows(
		tx,
		sql`SELECT quantity FROM stock WHERE article_id = ${articleId} AND ${holderCond(h)}`
	);
	return num(r?.quantity);
}

export async function setQty(
	tx: Tx,
	articleId: string,
	h: Holder,
	quantity: number
): Promise<void> {
	const [r] = await rows(
		tx,
		sql`SELECT id FROM stock WHERE article_id = ${articleId} AND ${holderCond(h)}`
	);
	if (r) {
		if (quantity === 0) await tx.execute(sql`DELETE FROM stock WHERE id = ${String(r.id)}`);
		else
			await tx.execute(
				sql`UPDATE stock SET quantity = ${quantity}, updated_at = now() WHERE id = ${String(r.id)}`
			);
	} else if (quantity > 0) {
		await tx.execute(
			sql`INSERT INTO stock (id, article_id, location_id, container_id, quantity)
				VALUES (${crypto.randomUUID()}, ${articleId}, ${h.locationId}, ${h.containerId}, ${quantity})`
		);
	}
}

export async function loadStock(
	tx: Tx,
	filter: { articleId?: string; locationId?: string; containerId?: string } = {}
): Promise<StockEntry[]> {
	const index = await loadPlaceIndex(tx);
	const where = [sql`s.quantity > 0`];
	if (filter.articleId) where.push(sql`s.article_id = ${filter.articleId}`);
	if (filter.locationId) where.push(sql`s.location_id = ${filter.locationId}`);
	if (filter.containerId) where.push(sql`s.container_id = ${filter.containerId}`);
	return (
		await rows(
			tx,
			sql`SELECT s.id, s.article_id, a.name, a.unit_label, s.location_id, s.container_id, s.quantity
				FROM stock s JOIN articles a ON a.id = s.article_id
				WHERE ${sql.join(where, sql` AND `)} ORDER BY lower(a.name)`
		)
	)
		.map((r) => {
			const holder = {
				locationId: r.location_id ? String(r.location_id) : null,
				containerId: r.container_id ? String(r.container_id) : null
			};
			return {
				id: String(r.id),
				articleId: String(r.article_id),
				articleName: String(r.name),
				unitLabel: str(r.unit_label) || 'Stück',
				...holder,
				holderName: holderText(index, holder),
				quantity: num(r.quantity)
			};
		})
		.sort(
			(a, b) =>
				a.articleName.localeCompare(b.articleName, 'de') ||
				a.holderName.localeCompare(b.holderName, 'de')
		);
}

async function logStock(
	tx: Tx,
	ctx: RequestContext,
	kind: string,
	articleId: string,
	quantity: number,
	detail: string,
	note: string
) {
	await logMovement(tx, ctx, { kind, articleId, quantity, detail, note });
}

export const stockEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/stock',
		summary: 'Mengenbestand je Ort/Kiste',
		tags,
		permission: PERMISSIONS.view,
		query: stockListQuery,
		handler: ({ query }) => mdb().transaction((tx) => loadStock(tx, query))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/stock/set',
		summary: 'Bestand an einem Ort setzen (Zählen/Korrektur)',
		tags,
		permission: PERMISSIONS.manage,
		body: stockSetInput,
		handler: async ({ ctx, body }) => {
			const delta = await mdb().transaction(async (tx) => {
				await requireBulkArticle(tx, body.articleId);
				const index = await loadPlaceIndex(tx);
				assertHolder(index, body.holder, 'holder');
				const before = await currentQty(tx, body.articleId, body.holder);
				await setQty(tx, body.articleId, body.holder, body.quantity);
				await logStock(
					tx,
					ctx,
					'stock-set',
					body.articleId,
					body.quantity,
					`${holderText(index, body.holder)}: ${before} → ${body.quantity}`,
					body.note
				);
				return body.quantity - before;
			});
			await core.audit.logFromContext(ctx, 'material.stock.set', {
				target: body.articleId,
				metadata: { delta }
			});
			return mdb().transaction((tx) => loadStock(tx, { articleId: body.articleId }));
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/stock/move',
		summary: 'Menge umlagern (z. B. Tassen in die Kochkiste)',
		tags,
		permission: PERMISSIONS.manage,
		body: stockMoveInput,
		handler: async ({ ctx, body }) => {
			await mdb().transaction(async (tx) => {
				await requireBulkArticle(tx, body.articleId);
				const index = await loadPlaceIndex(tx);
				assertHolder(index, body.from, 'from');
				assertHolder(index, body.to, 'to');
				const have = await currentQty(tx, body.articleId, body.from);
				if (have < body.quantity) throw errors.conflict(`Dort sind nur ${have} vorhanden`);
				await setQty(tx, body.articleId, body.from, have - body.quantity);
				await setQty(
					tx,
					body.articleId,
					body.to,
					(await currentQty(tx, body.articleId, body.to)) + body.quantity
				);
				await logStock(
					tx,
					ctx,
					'stock-moved',
					body.articleId,
					body.quantity,
					`${holderText(index, body.from)} → ${holderText(index, body.to)}`,
					body.note
				);
			});
			await core.audit.logFromContext(ctx, 'material.stock.moved', {
				target: body.articleId,
				metadata: { quantity: body.quantity }
			});
			return mdb().transaction((tx) => loadStock(tx, { articleId: body.articleId }));
		}
	})
];
