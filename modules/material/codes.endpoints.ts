/**
 * Codes: gescannten Code auflösen (Artikel → Lagerort → vorab vergeben) und Leer-Codes für vorab
 * gedruckte Etiketten vergeben.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint } from '$lib/sdk/server';
import { mdb, nextCodes, rows } from './db';
import { normalizeBarcode } from './pantry';
import {
	PERMISSIONS,
	codeFromScan,
	codeParams,
	reserveCodesInput,
	type CodeTarget
} from './schemas';

const tags = ['Modul: material'];

export const codesEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/codes/:code',
		summary: 'Code auflösen (Code oder volle Scan-URL)',
		tags,
		permission: PERMISSIONS.view,
		params: codeParams,
		handler: async ({ params }): Promise<CodeTarget> => {
			const code = codeFromScan(params.code);
			if (!code) throw errors.notFound('Unbekannter Code');
			return mdb().transaction(async (tx) => {
				const [item] = await rows(tx, sql`SELECT id, code, name FROM items WHERE code = ${code}`);
				if (item) {
					return { type: 'item', id: String(item.id), code, name: String(item.name) };
				}
				const [loc] = await rows(
					tx,
					sql`SELECT id, code, name FROM locations WHERE code = ${code}`
				);
				if (loc) return { type: 'location', id: String(loc.id), code, name: String(loc.name) };
				const [reserved] = await rows(
					tx,
					sql`SELECT code FROM reserved_codes WHERE code = ${code}`
				);
				if (reserved) return { type: 'reserved', code };
				const barcode = normalizeBarcode(code);
				if (barcode) {
					const [food] = await rows(
						tx,
						sql`SELECT id, name FROM food_products WHERE barcode = ${barcode}`
					);
					if (food) {
						return { type: 'food', id: String(food.id), code: barcode, name: String(food.name) };
					}
				}
				throw errors.notFound('Unbekannter Code');
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/codes/reserve',
		summary: 'Leer-Codes vergeben (für vorab gedruckte Etiketten)',
		tags,
		permission: PERMISSIONS.view,
		body: reserveCodesInput,
		handler: async ({ ctx, body }) => {
			if (!ctx.permissions.has(PERMISSIONS.manage) && !ctx.permissions.has(PERMISSIONS.labels)) {
				throw errors.forbidden('Nur mit Bestands- oder Etikettenrecht');
			}
			const codes = await mdb().transaction(async (tx) => {
				const list = await nextCodes(tx, 'item', body.count);
				for (const code of list) {
					await tx.execute(
						sql`INSERT INTO reserved_codes (code, created_by) VALUES (${code}, ${ctx.userId ?? null})`
					);
				}
				return list;
			});
			await core.audit.logFromContext(ctx, 'material.codes.reserved', {
				metadata: { count: codes.length }
			});
			return { codes };
		}
	})
];
