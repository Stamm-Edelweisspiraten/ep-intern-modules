/**
 * Bestand pflegen: Lagerorte (flach), Kategorien (Icon + Farbe), Typen und Lagerartikel, die große
 * Lagertabelle (`GET /inventory`), Umlagern, Zustand/Schaden melden und die Übersicht.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	type AnyApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { addDays } from '$lib/sdk/dates';
import { loadIconSet } from '$lib/sdk/icons';
import {
	canManage,
	claimCode,
	dateStr,
	idList,
	likePattern,
	mdb,
	nextCodes,
	num,
	rows,
	today,
	userNames
} from './db';
import { loadCategories, loadItem, loadItems, loadLocations, loadTypes } from './inventory';
import { reassignLocked } from './assign.service';
import { notifyDamage } from './notify';
import { removeImagesOf } from './images.endpoints';
import { listReservations } from './reservations.service';
import {
	PERMISSIONS,
	batchNames,
	categoryInput,
	categoryUpdateInput,
	conditionInput,
	idParams,
	inventoryQuery,
	itemInput,
	itemUpdateInput,
	locationInput,
	locationUpdateInput,
	moveItemsInput,
	orderInput,
	typeInput,
	typeUpdateInput,
	type Category,
	type Condition,
	type Inventory,
	type Item,
	type ItemDetail,
	type Location,
	type MaterialType,
	type Overview,
	type TypeDetail
} from './schemas';

const tags = ['Modul: material'];

async function assertIcon(icon: string | null | undefined) {
	if (!icon) return;
	if (!(await loadIconSet()).has(icon)) {
		throw errors.validation([{ path: ['icon'], message: 'Unbekanntes Icon' }]);
	}
}

/** Verweise prüfen (422 mit Feldpfad, wenn unbekannt) */
async function assertRefs(
	tx: Tx,
	refs: {
		typeId?: string | null;
		categoryId?: string | null;
		locationId?: string | null;
		setId?: string | null;
	}
) {
	const check = async (table: string, id: string | null | undefined, path: string, msg: string) => {
		if (!id) return;
		const [r] = await rows(tx, sql`SELECT 1 AS x FROM ${sql.identifier(table)} WHERE id = ${id}`);
		if (!r) throw errors.validation([{ path: [path], message: msg }]);
	};
	await check('types', refs.typeId, 'typeId', 'Typ nicht gefunden');
	await check('categories', refs.categoryId, 'categoryId', 'Kategorie nicht gefunden');
	await check('locations', refs.locationId, 'locationId', 'Lagerort nicht gefunden');
	await check('sets', refs.setId, 'setId', 'Set nicht gefunden');
}

async function requireItem(tx: Tx, id: string): Promise<Item> {
	const item = await loadItem(tx, id);
	if (!item) throw errors.notFound('Artikel nicht gefunden');
	return item;
}

async function requireType(tx: Tx, id: string): Promise<MaterialType> {
	const [t] = await loadTypes(tx, sql`t.id = ${id}`);
	if (!t) throw errors.notFound('Typ nicht gefunden');
	return t;
}

/** Reihenfolge setzen (Orte, Kategorien): alle IDs in neuer Reihenfolge */
async function reorder(tx: Tx, table: 'locations' | 'categories', ids: string[]) {
	const current = (await rows(tx, sql`SELECT id FROM ${sql.identifier(table)}`)).map((r) =>
		String(r.id)
	);
	const given = new Set(ids);
	if (
		given.size !== ids.length ||
		ids.length !== current.length ||
		!current.every((id) => given.has(id))
	) {
		throw errors.validation([
			{ path: ['ids'], message: 'Alle Einträge müssen genau einmal enthalten sein' }
		]);
	}
	for (const [i, id] of ids.entries()) {
		await tx.execute(sql`UPDATE ${sql.identifier(table)} SET position = ${i} WHERE id = ${id}`);
	}
}

const nextPosition = async (tx: Tx, table: 'locations' | 'categories') => {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`material:${table}`}))`);
	const [r] = await rows(
		tx,
		sql`SELECT coalesce(max(position), -1) + 1 AS p FROM ${sql.identifier(table)}`
	);
	return num(r?.p);
};

/** Filter der Lagertabelle auf Artikel (Alias `i`, `t`, `c`, `l`, `s`) */
function itemFilter(q: {
	search?: string;
	categoryId?: string;
	locationId?: string;
	condition?: Condition;
	setId?: string;
	archived?: '0' | '1';
}): SQL {
	const parts: SQL[] = [q.archived === '1' ? sql`TRUE` : sql`i.archived_at IS NULL`];
	if (q.search) {
		const p = likePattern(q.search);
		parts.push(
			sql`(i.name ILIKE ${p} OR i.code ILIKE ${p} OR t.name ILIKE ${p} OR i.notes ILIKE ${p}
				OR s.name ILIKE ${p})`
		);
	}
	if (q.categoryId) parts.push(sql`c.id = ${q.categoryId}`);
	if (q.locationId === 'none') parts.push(sql`i.location_id IS NULL`);
	else if (q.locationId) parts.push(sql`i.location_id = ${q.locationId}`);
	if (q.condition) parts.push(sql`i.condition = ${q.condition}`);
	if (q.setId === 'none') parts.push(sql`i.set_id IS NULL`);
	else if (q.setId) parts.push(sql`i.set_id = ${q.setId}`);
	return sql.join(parts, sql` AND `);
}

async function loadInventory(tx: Tx, q: Parameters<typeof itemFilter>[0]): Promise<Inventory> {
	const items = await loadItems(tx, itemFilter(q));
	const filtered = !!(q.search || q.categoryId || q.locationId || q.condition || q.setId);
	const typeWhere: SQL[] = [q.archived === '1' ? sql`TRUE` : sql`t.archived_at IS NULL`];
	const typeIds = [...new Set(items.map((i) => i.typeId).filter((v): v is string => !!v))];
	if (filtered) {
		// Typen mit passenden Artikeln, dazu (nur Suche/Kategorie) Typen, die selbst passen
		const own: SQL[] = [];
		if (q.search) own.push(sql`t.name ILIKE ${likePattern(q.search)}`);
		if (q.categoryId) own.push(sql`t.category_id = ${q.categoryId}`);
		const selfMatch =
			own.length && !q.locationId && !q.condition && !q.setId
				? sql.join(own, sql` AND `)
				: sql`FALSE`;
		typeWhere.push(sql`(t.id IN (${idList(typeIds)}) OR ${selfMatch})`);
	}
	const types = await loadTypes(tx, sql.join(typeWhere, sql` AND `));
	const byType = new Map<string, Item[]>();
	for (const item of items) {
		if (!item.typeId) continue;
		const list = byType.get(item.typeId) ?? [];
		list.push(item);
		byType.set(item.typeId, list);
	}
	return {
		types: types.map((t) => ({ ...t, items: byType.get(t.id) ?? [] })),
		items: items.filter((i) => !i.typeId)
	};
}

async function overview(tx: Tx): Promise<Omit<Overview, 'upcoming' | 'upcomingCount'>> {
	const [c] = await rows(
		tx,
		sql`SELECT
			(SELECT count(*) FROM types WHERE archived_at IS NULL) AS types,
			(SELECT count(*) FROM items WHERE archived_at IS NULL) AS items,
			(SELECT count(*) FROM locations) AS locations,
			(SELECT count(*) FROM items WHERE archived_at IS NULL
				AND condition IN ('damaged', 'defect', 'lost')) AS damaged`
	);
	const damaged = await rows(
		tx,
		sql`SELECT id, name, code, condition FROM items
			WHERE archived_at IS NULL AND condition IN ('damaged', 'defect', 'lost')
			ORDER BY condition_reported_at DESC NULLS LAST, lower(name) LIMIT 10`
	);
	return {
		types: num(c?.types),
		items: num(c?.items),
		locations: num(c?.locations),
		damagedCount: num(c?.damaged),
		damaged: damaged.map((r) => ({
			id: String(r.id),
			name: String(r.name),
			code: String(r.code),
			condition: String(r.condition) as Condition
		}))
	};
}

/** Laufende und kommende Reservierungen eines Artikels (direkt oder über seinen Typ) */
async function itemReservations(tx: Tx, item: Item): Promise<ItemDetail['reservations']> {
	return (
		await rows(
			tx,
			sql`SELECT r.id, r.title, r.status, to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on, sum(l.quantity) AS qty,
					bool_and(l.item_id IS NULL) AS via_type
				FROM reservation_lines l JOIN reservations r ON r.id = l.reservation_id
				WHERE r.status = 'reserved' AND r.ends_on >= ${today()}::date
					AND (l.item_id = ${item.id} OR (l.type_id IS NOT NULL AND l.type_id::text = ${item.typeId ?? ''}))
				GROUP BY r.id ORDER BY r.starts_on, r.id LIMIT 20`
		)
	).map((r) => ({
		id: String(r.id),
		title: String(r.title),
		status: 'reserved' as const,
		startsOn: dateStr(r.starts_on),
		endsOn: dateStr(r.ends_on),
		quantity: num(r.qty),
		viaType: r.via_type === true || r.via_type === 't'
	}));
}

const canReport = (ctx: RequestContext) =>
	ctx.permissions.has(PERMISSIONS.manage) || ctx.permissions.has(PERMISSIONS.reserve);

export const catalogEndpoints: AnyApiEndpoint[] = [
	// --- Übersicht -------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/overview',
		summary: 'Kennzahlen: Bestand, Schäden, anstehende Reservierungen',
		tags,
		permission: PERMISSIONS.view,
		handler: async ({ ctx }): Promise<Overview> => {
			const base = await mdb().transaction(overview);
			const upcoming = await listReservations(ctx, {
				scope: canManage(ctx) || ctx.permissions.has(PERMISSIONS.reservations) ? 'all' : 'mine',
				state: 'open',
				to: addDays(today(), 14),
				limit: 10,
				offset: 0
			});
			return { ...base, upcoming: upcoming.items, upcomingCount: upcoming.total };
		}
	}),

	// --- Lagerorte -------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/locations',
		summary: 'Lagerorte',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(loadLocations)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/locations/order',
		summary: 'Reihenfolge der Lagerorte',
		tags,
		permission: PERMISSIONS.manage,
		body: orderInput,
		handler: async ({ ctx, body }): Promise<Location[]> => {
			const list = await mdb().transaction(async (tx) => {
				await reorder(tx, 'locations', body.ids);
				return loadLocations(tx);
			});
			await core.audit.logFromContext(ctx, 'material.location.reordered', {
				metadata: { count: body.ids.length }
			});
			return list;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/locations',
		summary: 'Lagerort anlegen (Code `L-…` automatisch)',
		tags,
		permission: PERMISSIONS.manage,
		body: locationInput,
		handler: async ({ ctx, body }): Promise<Location> => {
			const id = crypto.randomUUID();
			const loc = await mdb().transaction(async (tx) => {
				const [code] = await nextCodes(tx, 'location', 1);
				const position = await nextPosition(tx, 'locations');
				await tx.execute(
					sql`INSERT INTO locations (id, name, description, code, position)
						VALUES (${id}, ${body.name}, ${body.description}, ${code!}, ${position})`
				);
				return (await loadLocations(tx)).find((l) => l.id === id)!;
			});
			await core.audit.logFromContext(ctx, 'material.location.created', { target: id });
			return loc;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/locations/:id',
		summary: 'Lagerort bearbeiten',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: locationUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Location> => {
			const loc = await mdb().transaction(async (tx) => {
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				const res = await rows(
					tx,
					sql`UPDATE locations SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Lagerort nicht gefunden');
				return (await loadLocations(tx)).find((l) => l.id === params.id)!;
			});
			await core.audit.logFromContext(ctx, 'material.location.updated', { target: params.id });
			return loc;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/locations/:id',
		summary: 'Lagerort löschen (Artikel dort sind danach ohne Ort)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const moved = await mdb().transaction(async (tx) => {
				const [n] = await rows(
					tx,
					sql`SELECT count(*) AS n FROM items WHERE location_id = ${params.id}`
				);
				const res = await rows(tx, sql`DELETE FROM locations WHERE id = ${params.id} RETURNING id`);
				if (!res.length) throw errors.notFound('Lagerort nicht gefunden');
				return num(n?.n);
			});
			await core.audit.logFromContext(ctx, 'material.location.deleted', {
				target: params.id,
				metadata: { itemsWithoutPlace: moved }
			});
			return { deleted: true, itemsWithoutPlace: moved };
		}
	}),

	// --- Kategorien ------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/categories',
		summary: 'Kategorien',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction(loadCategories)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/categories/order',
		summary: 'Reihenfolge der Kategorien',
		tags,
		permission: PERMISSIONS.manage,
		body: orderInput,
		handler: async ({ ctx, body }): Promise<Category[]> => {
			const list = await mdb().transaction(async (tx) => {
				await reorder(tx, 'categories', body.ids);
				return loadCategories(tx);
			});
			await core.audit.logFromContext(ctx, 'material.category.reordered', {
				metadata: { count: body.ids.length }
			});
			return list;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/categories',
		summary: 'Kategorie anlegen (Name, Icon, Farbe)',
		tags,
		permission: PERMISSIONS.manage,
		body: categoryInput,
		handler: async ({ ctx, body }): Promise<Category> => {
			await assertIcon(body.icon);
			const id = crypto.randomUUID();
			const cat = await mdb().transaction(async (tx) => {
				const position = await nextPosition(tx, 'categories');
				await tx.execute(
					sql`INSERT INTO categories (id, name, icon, color, position)
						VALUES (${id}, ${body.name}, ${body.icon}, ${body.color}, ${position})`
				);
				return (await loadCategories(tx)).find((c) => c.id === id)!;
			});
			await core.audit.logFromContext(ctx, 'material.category.created', { target: id });
			return cat;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/categories/:id',
		summary: 'Kategorie bearbeiten',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: categoryUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Category> => {
			await assertIcon(body.icon);
			const cat = await mdb().transaction(async (tx) => {
				const sets = [sql`id = id`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.icon !== undefined) sets.push(sql`icon = ${body.icon}`);
				if (body.color !== undefined) sets.push(sql`color = ${body.color}`);
				const res = await rows(
					tx,
					sql`UPDATE categories SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Kategorie nicht gefunden');
				return (await loadCategories(tx)).find((c) => c.id === params.id)!;
			});
			await core.audit.logFromContext(ctx, 'material.category.updated', { target: params.id });
			return cat;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/categories/:id',
		summary: 'Kategorie löschen (Typen/Artikel bleiben, ohne Kategorie)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const res = await rows(
					tx,
					sql`DELETE FROM categories WHERE id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Kategorie nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'material.category.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	// --- Lagertabelle ------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/inventory',
		summary: 'Lagertabelle: Typen mit ihren Artikeln und Artikel ohne Typ',
		tags,
		permission: PERMISSIONS.view,
		query: inventoryQuery,
		handler: ({ query }) => mdb().transaction((tx) => loadInventory(tx, query))
	}),

	// --- Typen ---------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/types',
		summary: 'Typen (ohne archivierte)',
		tags,
		permission: PERMISSIONS.view,
		handler: () => mdb().transaction((tx) => loadTypes(tx, sql`t.archived_at IS NULL`))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/types/:id',
		summary: 'Typ mit seinen Artikeln',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ params }): Promise<TypeDetail> =>
			mdb().transaction(async (tx) => {
				const t = await requireType(tx, params.id);
				return { ...t, items: await loadItems(tx, sql`i.type_id = ${params.id}`) };
			})
	}),
	defineEndpoint({
		method: 'POST',
		path: '/types',
		summary: 'Typ anlegen',
		tags,
		permission: PERMISSIONS.manage,
		body: typeInput,
		handler: async ({ ctx, body }): Promise<MaterialType> => {
			const id = crypto.randomUUID();
			const t = await mdb().transaction(async (tx) => {
				await assertRefs(tx, { categoryId: body.categoryId });
				await tx.execute(
					sql`INSERT INTO types (id, name, description, notes, category_id, created_by)
						VALUES (${id}, ${body.name}, ${body.description}, ${body.notes}, ${body.categoryId},
							${ctx.userId ?? null})`
				);
				return requireType(tx, id);
			});
			await core.audit.logFromContext(ctx, 'material.type.created', { target: id });
			return t;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/types/:id',
		summary: 'Typ bearbeiten oder archivieren',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: typeUpdateInput,
		handler: async ({ ctx, params, body }): Promise<MaterialType> => {
			const t = await mdb().transaction(async (tx) => {
				await requireType(tx, params.id);
				await assertRefs(tx, { categoryId: body.categoryId });
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.categoryId !== undefined) sets.push(sql`category_id = ${body.categoryId}`);
				if (body.archived !== undefined)
					sets.push(
						body.archived
							? sql`archived_at = coalesce(archived_at, now())`
							: sql`archived_at = NULL`
					);
				await tx.execute(sql`UPDATE types SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`);
				return requireType(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.type.updated', { target: params.id });
			return t;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/types/:id',
		summary: 'Typ löschen (nur ohne Artikel und ohne Reservierungen; sonst archivieren)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				await requireType(tx, params.id);
				const [used] = await rows(
					tx,
					sql`SELECT (SELECT count(*) FROM items WHERE type_id = ${params.id})
						+ (SELECT count(*) FROM reservation_lines WHERE type_id = ${params.id})
						+ (SELECT count(*) FROM tent_parts WHERE type_id = ${params.id}) AS n`
				);
				if (num(used?.n) > 0) {
					throw errors.conflict(
						'Der Typ hat noch Artikel, Reservierungen oder steht in einem Zelt – stattdessen archivieren'
					);
				}
			});
			await removeImagesOf('types', params.id);
			await mdb().transaction((tx) => tx.execute(sql`DELETE FROM types WHERE id = ${params.id}`));
			await core.audit.logFromContext(ctx, 'material.type.deleted', { target: params.id });
			return { deleted: true };
		}
	}),

	// --- Lagerartikel ----------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/items/:id',
		summary: 'Lagerartikel mit Reservierungen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<ItemDetail> => {
			const { item, reservations } = await mdb().transaction(async (tx) => {
				const item = await loadItem(tx, params.id);
				if (!item) throw errors.notFound('Artikel nicht gefunden');
				return { item, reservations: await itemReservations(tx, item) };
			});
			const names = await userNames(ctx, [item.reportedBy]);
			const { reportedBy, ...rest } = item;
			return {
				...rest,
				conditionReportedByName: reportedBy ? (names.get(reportedBy) ?? 'Unbekannt') : null,
				reservations
			};
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/items',
		summary: 'Lagerartikel anlegen (auch mehrere nummeriert)',
		description:
			'`count` > 1 legt so viele Artikel an; der Name bekommt eine fortlaufende Nummer ab `numberFrom` ' +
			'(„K1.“ → „K1.1“, „K1.2“ …). Codes `M-…` automatisch, ein eigener Code nur für einen einzelnen Artikel.',
		tags,
		permission: PERMISSIONS.manage,
		body: itemInput,
		handler: async ({ ctx, body }): Promise<Item[]> => {
			const names = batchNames(body.name, body.count, body.numberFrom);
			const ids = names.map(() => crypto.randomUUID());
			const items = await mdb().transaction(async (tx) => {
				await assertRefs(tx, body);
				const codes = body.code
					? [await claimCode(tx, body.code)]
					: await nextCodes(tx, 'item', names.length);
				const now = new Date().toISOString();
				for (const [i, id] of ids.entries()) {
					await tx.execute(
						sql`INSERT INTO items (id, type_id, name, category_id, quantity, location_id, set_id, code,
								condition, condition_note, condition_reported_by, condition_reported_at, notes, created_by)
							VALUES (${id}, ${body.typeId}, ${names[i]!}, ${body.typeId ? null : body.categoryId},
								${body.quantity}, ${body.locationId}, ${body.setId}, ${codes[i]!}, ${body.condition},
								${body.conditionNote},
								${body.condition === 'ok' ? null : (ctx.userId ?? null)},
								${body.condition === 'ok' ? null : now}, ${body.notes}, ${ctx.userId ?? null})`
					);
				}
				await reassignLocked(tx);
				return loadItems(tx, sql`i.id IN (${idList(ids)})`);
			});
			await core.audit.logFromContext(ctx, 'material.item.created', {
				target: ids[0],
				metadata: { count: ids.length }
			});
			return items;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/items/move',
		summary: 'Mehrere Artikel umlagern',
		tags,
		permission: PERMISSIONS.manage,
		body: moveItemsInput,
		handler: async ({ ctx, body }) => {
			const moved = await mdb().transaction(async (tx) => {
				await assertRefs(tx, { locationId: body.locationId });
				const res = await rows(
					tx,
					sql`UPDATE items SET location_id = ${body.locationId}, updated_at = now()
						WHERE id IN (${idList(body.itemIds)}) RETURNING id`
				);
				if (res.length !== new Set(body.itemIds).size)
					throw errors.notFound('Artikel nicht gefunden');
				return res.length;
			});
			await core.audit.logFromContext(ctx, 'material.item.moved', {
				metadata: { count: moved, locationId: body.locationId }
			});
			return { moved };
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/items/:id',
		summary: 'Lagerartikel bearbeiten oder archivieren',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		body: itemUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Item> => {
			const item = await mdb().transaction(async (tx) => {
				const current = await requireItem(tx, params.id);
				await assertRefs(tx, body);
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.typeId !== undefined) sets.push(sql`type_id = ${body.typeId}`);
				const typeId = body.typeId !== undefined ? body.typeId : current.typeId;
				if (typeId) sets.push(sql`category_id = NULL`);
				else if (body.categoryId !== undefined) sets.push(sql`category_id = ${body.categoryId}`);
				if (body.quantity !== undefined) sets.push(sql`quantity = ${body.quantity}`);
				if (body.locationId !== undefined) sets.push(sql`location_id = ${body.locationId}`);
				if (body.setId !== undefined) sets.push(sql`set_id = ${body.setId}`);
				if (body.code !== undefined && body.code !== current.code) {
					sets.push(sql`code = ${await claimCode(tx, body.code, params.id)}`);
				}
				if (body.condition !== undefined && body.condition !== current.condition) {
					sets.push(sql`condition = ${body.condition}`);
					sets.push(sql`condition_reported_by = ${ctx.userId ?? null}`);
					sets.push(sql`condition_reported_at = now()`);
				}
				if (body.conditionNote !== undefined)
					sets.push(sql`condition_note = ${body.conditionNote}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.archived !== undefined)
					sets.push(
						body.archived
							? sql`archived_at = coalesce(archived_at, now())`
							: sql`archived_at = NULL`
					);
				await tx.execute(sql`UPDATE items SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`);
				// Typ, Anzahl, Zustand, Archiv oder Set ändern die Zuteilung
				if (
					body.typeId !== undefined ||
					body.quantity !== undefined ||
					body.condition !== undefined ||
					body.archived !== undefined ||
					body.setId !== undefined
				) {
					await reassignLocked(tx);
				}
				return requireItem(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.item.updated', { target: params.id });
			return item;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/items/:id/condition',
		summary: 'Zustand melden (Schaden, Verlust, wieder in Ordnung)',
		description:
			'Mit Bestands- oder Reservierungsrecht. Schäden gehen an das Amt „Materialwart*in“.',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: conditionInput,
		handler: async ({ ctx, params, body }): Promise<Item> => {
			if (!canReport(ctx))
				throw errors.forbidden('Zustand melden nur mit Reservierungs- oder Bestandsrecht');
			const item = await mdb().transaction(async (tx) => {
				await requireItem(tx, params.id);
				await tx.execute(
					sql`UPDATE items SET condition = ${body.condition}, condition_note = ${body.note},
						condition_reported_by = ${ctx.userId ?? null}, condition_reported_at = now(), updated_at = now()
						WHERE id = ${params.id}`
				);
				await reassignLocked(tx);
				return requireItem(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'material.item.condition-reported', {
				target: params.id,
				metadata: { condition: body.condition }
			});
			if (body.condition !== 'ok' && body.condition !== 'worn') {
				await notifyDamage(ctx, item, body.note);
			}
			return item;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/items/:id',
		summary: 'Lagerartikel löschen (nur ohne Reservierungen; sonst archivieren)',
		tags,
		permission: PERMISSIONS.manage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				await requireItem(tx, params.id);
				const [used] = await rows(
					tx,
					sql`SELECT (SELECT count(*) FROM reservation_lines WHERE item_id = ${params.id})
						+ (SELECT count(*) FROM tent_parts WHERE item_id = ${params.id})
						+ (SELECT count(*) FROM reservation_assignments a
							JOIN reservations r ON r.id = a.reservation_id
							WHERE a.item_id = ${params.id}
								AND (a.pinned OR r.handed_out_at IS NOT NULL OR r.starts_on <= ${today()}::date)) AS n`
				);
				if (num(used?.n) > 0) {
					throw errors.conflict(
						'Der Artikel steht in Reservierungen oder einem Zelt – stattdessen archivieren'
					);
				}
			});
			await removeImagesOf('items', params.id);
			await mdb().transaction(async (tx) => {
				// Automatische Zuteilungen kommender Reservierungen gehen an andere Artikel
				await tx.execute(sql`DELETE FROM reservation_assignments WHERE item_id = ${params.id}`);
				await tx.execute(sql`DELETE FROM items WHERE id = ${params.id}`);
				await reassignLocked(tx);
			});
			await core.audit.logFromContext(ctx, 'material.item.deleted', { target: params.id });
			return { deleted: true };
		}
	})
];
