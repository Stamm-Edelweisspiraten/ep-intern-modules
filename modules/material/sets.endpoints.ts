/**
 * Sets (zusammengehörige Artikel, z. B. „KJ1“ = Kohtenbahnen KJ1.1–KJ1.6) und Zelte (Bauplan aus Typen
 * und Artikeln, z. B. „Jurte“ = Dach 6 × Kohtenbahn aus einem Set + Wand 12 × Kohtenbahn + Abspannseil).
 * Die Artikel eines Sets bleiben normale Lagerartikel ihres Typs.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { reassignLocked } from './assign.service';
import { idList, mdb, num, rows } from './db';
import { loadSets, loadTents } from './inventory';
import {
	PERMISSIONS,
	idParams,
	orderInput,
	setInput,
	setItemsInput,
	setUpdateInput,
	tentInput,
	tentUpdateInput,
	type MaterialSet,
	type Tent,
	type TentPartInput
} from './schemas';

const tags = ['Modul: material'];

async function requireSet(tx: Tx, id: string): Promise<MaterialSet> {
	const [s] = await loadSets(tx, sql`s.id = ${id}`);
	if (!s) throw errors.notFound('Set nicht gefunden');
	return s;
}

async function requireTent(tx: Tx, id: string): Promise<Tent> {
	const [z] = await loadTents(tx, sql`z.id = ${id}`);
	if (!z) throw errors.notFound('Zelt nicht gefunden');
	return z;
}

/** Artikel eines Sets ersetzen: genannte kommen hinein (auch aus anderen Sets), übrige verlassen es */
async function replaceSetItems(tx: Tx, setId: string, itemIds: string[]) {
	const unique = [...new Set(itemIds)];
	if (unique.length) {
		const found = await rows(tx, sql`SELECT id FROM items WHERE id IN (${idList(unique)})`);
		if (found.length !== unique.length) {
			throw errors.validation([{ path: ['itemIds'], message: 'Artikel nicht gefunden' }]);
		}
	}
	await tx.execute(
		sql`UPDATE items SET set_id = NULL, updated_at = now()
			WHERE set_id = ${setId} AND id::text NOT IN (${sql.join(
				[...unique, ''].map((v) => sql`${v}`),
				sql`, `
			)})`
	);
	if (unique.length) {
		await tx.execute(
			sql`UPDATE items SET set_id = ${setId}, updated_at = now() WHERE id IN (${idList(unique)})`
		);
	}
}

/** Teile prüfen (Typ/Artikel vorhanden) und komplett ersetzen */
async function replaceParts(tx: Tx, tentId: string, parts: TentPartInput[]) {
	for (const [i, p] of parts.entries()) {
		const [r] =
			p.kind === 'type'
				? await rows(tx, sql`SELECT 1 AS x FROM types WHERE id = ${p.typeId}`)
				: await rows(tx, sql`SELECT 1 AS x FROM items WHERE id = ${p.itemId}`);
		if (!r) {
			throw errors.validation([
				{
					path: ['parts', i, p.kind === 'type' ? 'typeId' : 'itemId'],
					message: p.kind === 'type' ? 'Typ nicht gefunden' : 'Artikel nicht gefunden'
				}
			]);
		}
	}
	await tx.execute(sql`DELETE FROM tent_parts WHERE tent_id = ${tentId}`);
	for (const [i, p] of parts.entries()) {
		await tx.execute(
			sql`INSERT INTO tent_parts (id, tent_id, label, type_id, item_id, quantity, from_one_set, position)
				VALUES (${crypto.randomUUID()}, ${tentId}, ${p.label ?? ''},
					${p.kind === 'type' ? p.typeId : null}, ${p.kind === 'item' ? p.itemId : null},
					${p.quantity}, ${p.kind === 'type' ? (p.fromOneSet ?? false) : false}, ${i})`
		);
	}
}

async function assertCategory(tx: Tx, categoryId: string | null | undefined) {
	if (!categoryId) return;
	const [r] = await rows(tx, sql`SELECT 1 AS x FROM categories WHERE id = ${categoryId}`);
	if (!r) throw errors.validation([{ path: ['categoryId'], message: 'Kategorie nicht gefunden' }]);
}

export const setsEndpoints: AnyApiEndpoint[] = [
	// --- Sets ------------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/sets',
		summary: 'Sets mit Artikeln, Vollständigkeit und nächster Verwendung',
		tags,
		permission: PERMISSIONS.view,
		handler: (): Promise<MaterialSet[]> => mdb().transaction((tx) => loadSets(tx))
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/sets/order',
		summary: 'Reihenfolge der Sets',
		tags,
		permission: PERMISSIONS.manage,
		body: orderInput,
		handler: async ({ body }): Promise<MaterialSet[]> =>
			mdb().transaction(async (tx) => {
				const current = (await rows(tx, sql`SELECT id FROM sets`)).map((r) => String(r.id));
				const given = new Set(body.ids);
				if (
					given.size !== body.ids.length ||
					current.length !== body.ids.length ||
					!current.every((id) => given.has(id))
				) {
					throw errors.validation([
						{ path: ['ids'], message: 'Alle Einträge müssen genau einmal enthalten sein' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE sets SET position = ${i} WHERE id = ${id}`);
				}
				return loadSets(tx);
			})
	}),
	defineEndpoint({
		method: 'GET',
		path: '/sets/:id',
		summary: 'Set mit Artikeln',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ params }): Promise<MaterialSet> =>
			mdb().transaction((tx) => requireSet(tx, params.id))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/sets',
		summary: 'Set anlegen (optional gleich mit Artikeln)',
		tags,
		permission: PERMISSIONS.manage,
		body: setInput.extend({ itemIds: setItemsInput.shape.itemIds.optional() }),
		handler: async ({ ctx, body }): Promise<MaterialSet> => {
			const id = crypto.randomUUID();
			const set = await mdb().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'material:sets'}))`);
				const [p] = await rows(tx, sql`SELECT coalesce(max(position), -1) + 1 AS p FROM sets`);
				await tx.execute(
					sql`INSERT INTO sets (id, name, notes, position)
						VALUES (${id}, ${body.name}, ${body.notes}, ${num(p?.p)})`
				);
				if (body.itemIds?.length) {
					await replaceSetItems(tx, id, body.itemIds);
					await reassignLocked(tx);
				}
				return requireSet(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.set.created', {
				target: id,
				metadata: { items: set.items.length }
			});
			return set;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/sets/:id',
		summary: 'Set umbenennen oder Notiz ändern',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: setUpdateInput,
		handler: async ({ ctx, params, body }): Promise<MaterialSet> => {
			const set = await mdb().transaction(async (tx) => {
				await requireSet(tx, params.id);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				await tx.execute(sql`UPDATE sets SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`);
				return requireSet(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.set.updated', { target: params.id });
			return set;
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/sets/:id/items',
		summary: 'Artikel des Sets ersetzen (ein Artikel gehört höchstens zu einem Set)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: setItemsInput,
		handler: async ({ ctx, params, body }): Promise<MaterialSet> => {
			const set = await mdb().transaction(async (tx) => {
				await requireSet(tx, params.id);
				await replaceSetItems(tx, params.id, body.itemIds);
				await reassignLocked(tx);
				return requireSet(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.set.items-changed', {
				target: params.id,
				metadata: { items: set.items.length }
			});
			return set;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/sets/:id',
		summary: 'Set auflösen (die Artikel bleiben im Lager)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				await requireSet(tx, params.id);
				await tx.execute(sql`DELETE FROM sets WHERE id = ${params.id}`);
				await reassignLocked(tx);
			});
			await core.audit.logFromContext(ctx, 'material.set.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	// --- Zelte -----------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/tents',
		summary: 'Zelte (Baupläne) mit Teilen',
		tags,
		permission: PERMISSIONS.view,
		handler: (): Promise<Tent[]> => mdb().transaction((tx) => loadTents(tx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/tents/:id',
		summary: 'Zelt mit Teilen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ params }): Promise<Tent> => mdb().transaction((tx) => requireTent(tx, params.id))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/tents',
		summary: 'Zelt (Bauplan) anlegen',
		tags,
		permission: PERMISSIONS.manage,
		body: tentInput,
		handler: async ({ ctx, body }): Promise<Tent> => {
			const id = crypto.randomUUID();
			const tent = await mdb().transaction(async (tx) => {
				await assertCategory(tx, body.categoryId);
				await tx.execute(
					sql`INSERT INTO tents (id, name, description, category_id, created_by)
						VALUES (${id}, ${body.name}, ${body.description}, ${body.categoryId}, ${ctx.userId ?? null})`
				);
				await replaceParts(tx, id, body.parts);
				return requireTent(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.tent.created', {
				target: id,
				metadata: { parts: tent.parts.length }
			});
			return tent;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/tents/:id',
		summary: 'Zelt bearbeiten (Teile werden komplett ersetzt) oder archivieren',
		description:
			'Bestehende Reservierungen behalten ihre Teile; der neue Bauplan gilt für neue Reservierungen.',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: tentUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Tent> => {
			const tent = await mdb().transaction(async (tx) => {
				await requireTent(tx, params.id);
				await assertCategory(tx, body.categoryId);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				if (body.categoryId !== undefined) sets.push(sql`category_id = ${body.categoryId}`);
				if (body.archived !== undefined) {
					sets.push(
						body.archived
							? sql`archived_at = coalesce(archived_at, now())`
							: sql`archived_at = NULL`
					);
				}
				await tx.execute(sql`UPDATE tents SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`);
				if (body.parts) await replaceParts(tx, params.id, body.parts);
				return requireTent(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.tent.updated', { target: params.id });
			return tent;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/tents/:id',
		summary: 'Zelt löschen (nur ohne Reservierungen; sonst archivieren)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const tent = await requireTent(tx, params.id);
				if (tent.used) {
					throw errors.conflict('Das Zelt steht in Reservierungen – stattdessen archivieren');
				}
				await tx.execute(sql`DELETE FROM tents WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.tent.deleted', { target: params.id });
			return { deleted: true };
		}
	})
];
