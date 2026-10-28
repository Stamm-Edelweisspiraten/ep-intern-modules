/**
 * Lesen des Bestands: Kategorien, Orte, Typen, Lagerartikel (mit Bildern) und die Grundlage der
 * Verfügbarkeit. Nur Datenbankzugriffe – innerhalb einer Modul-Transaktion aufrufen.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '$lib/sdk/server';
import type { Booking, StockItem } from './availability';
import { dateStr, idList, iso, isoOrNull, num, rows, str, type Row } from './db';
import {
	UNUSABLE_CONDITIONS,
	imageUrl,
	type Category,
	type CategoryRef,
	type Condition,
	type ImageOwner,
	type ImageRef,
	type Item,
	type Location,
	type MaterialType
} from './schemas';

export function categoryRef(r: Row, prefix = 'c_'): CategoryRef | null {
	const id = r[`${prefix}id`];
	if (!id) return null;
	return {
		id: String(id),
		name: String(r[`${prefix}name`]),
		icon: str(r[`${prefix}icon`]) || null,
		color: str(r[`${prefix}color`]) || null
	};
}

/** Bilder je Besitzer (Reihenfolge = Position) */
export async function imagesFor(
	tx: Tx,
	owner: ImageOwner,
	ids: string[]
): Promise<Map<string, ImageRef[]>> {
	const map = new Map<string, ImageRef[]>();
	if (!ids.length) return map;
	const column = owner === 'types' ? sql`type_id` : sql`item_id`;
	const list = await rows(
		tx,
		sql`SELECT id, ${column} AS owner_id, width, height FROM images
			WHERE ${column} IN (${idList(ids)}) ORDER BY position, created_at, id`
	);
	for (const r of list) {
		const ownerId = String(r.owner_id);
		const id = String(r.id);
		const arr = map.get(ownerId) ?? [];
		arr.push({
			id,
			width: num(r.width),
			height: num(r.height),
			thumbUrl: imageUrl(owner, ownerId, id, 'thumb'),
			webUrl: imageUrl(owner, ownerId, id, 'web')
		});
		map.set(ownerId, arr);
	}
	return map;
}

export async function loadCategories(tx: Tx): Promise<Category[]> {
	return (
		await rows(
			tx,
			sql`SELECT c.id, c.name, c.icon, c.color, c.position,
					(SELECT count(*) FROM types t WHERE t.category_id = c.id AND t.archived_at IS NULL)
					+ (SELECT count(*) FROM items i
						WHERE i.type_id IS NULL AND i.category_id = c.id AND i.archived_at IS NULL) AS n
				FROM categories c ORDER BY c.position, lower(c.name)`
		)
	).map((r) => ({
		id: String(r.id),
		name: String(r.name),
		icon: str(r.icon) || null,
		color: str(r.color) || null,
		position: num(r.position),
		count: num(r.n)
	}));
}

export async function loadLocations(tx: Tx): Promise<Location[]> {
	return (
		await rows(
			tx,
			sql`SELECT l.id, l.name, l.description, l.code, l.position,
					(SELECT count(*) FROM items i WHERE i.location_id = l.id AND i.archived_at IS NULL) AS n
				FROM locations l ORDER BY l.position, lower(l.name)`
		)
	).map((r) => ({
		id: String(r.id),
		name: String(r.name),
		description: str(r.description),
		code: String(r.code),
		position: num(r.position),
		itemCount: num(r.n)
	}));
}

const ITEM_SELECT = sql`SELECT i.id, i.name, i.code, i.type_id, t.name AS type_name, i.quantity,
		i.location_id, l.name AS location_name, i.condition, i.condition_note, i.condition_reported_at,
		i.condition_reported_by, i.notes, i.archived_at, i.created_at,
		c.id AS c_id, c.name AS c_name, c.icon AS c_icon, c.color AS c_color
	FROM items i
	LEFT JOIN types t ON t.id = i.type_id
	LEFT JOIN categories c ON c.id = COALESCE(t.category_id, i.category_id)
	LEFT JOIN locations l ON l.id = i.location_id`;

/** Lagerartikel nach Bedingung (Alias `i` = items, `t` = types, `c` = categories, `l` = locations) */
export async function loadItems(tx: Tx, where: SQL = sql`TRUE`): Promise<Item[]> {
	const list = await rows(tx, sql`${ITEM_SELECT} WHERE ${where} ORDER BY lower(i.name), i.code`);
	const ids = list.map((r) => String(r.id));
	const typeIds = [...new Set(list.map((r) => str(r.type_id)).filter(Boolean))];
	const own = await imagesFor(tx, 'items', ids);
	const typeImages = await imagesFor(tx, 'types', typeIds);
	return list.map((r) => {
		const id = String(r.id);
		const images = own.get(id) ?? [];
		const typeId = str(r.type_id) || null;
		const cover = images[0] ?? (typeId ? typeImages.get(typeId)?.[0] : undefined);
		return {
			id,
			name: String(r.name),
			code: String(r.code),
			typeId,
			typeName: str(r.type_name) || null,
			categoryId: str(r.c_id) || null,
			category: categoryRef(r),
			quantity: num(r.quantity),
			locationId: str(r.location_id) || null,
			locationName: str(r.location_name) || null,
			condition: String(r.condition) as Condition,
			conditionNote: str(r.condition_note),
			conditionReportedAt: isoOrNull(r.condition_reported_at),
			notes: str(r.notes),
			archived: !!r.archived_at,
			images,
			thumbUrl: cover?.thumbUrl ?? null,
			createdAt: iso(r.created_at)
		};
	});
}

export async function loadItem(
	tx: Tx,
	id: string
): Promise<(Item & { reportedBy: string | null }) | null> {
	const [item] = await loadItems(tx, sql`i.id = ${id}`);
	if (!item) return null;
	const [r] = await rows(tx, sql`SELECT condition_reported_by FROM items WHERE id = ${id}`);
	return { ...item, reportedBy: str(r?.condition_reported_by) || null };
}

/** Typen nach Bedingung (Alias `t`, `c`) mit Zählern über die nicht archivierten Artikel */
export async function loadTypes(tx: Tx, where: SQL = sql`TRUE`): Promise<MaterialType[]> {
	const unusable = sql.join(
		UNUSABLE_CONDITIONS.map((c) => sql`${c}`),
		sql`, `
	);
	const list = await rows(
		tx,
		sql`SELECT t.id, t.name, t.description, t.notes, t.category_id, t.archived_at,
				c.id AS c_id, c.name AS c_name, c.icon AS c_icon, c.color AS c_color,
				(SELECT count(*) FROM items i WHERE i.type_id = t.id AND i.archived_at IS NULL) AS item_count,
				(SELECT coalesce(sum(i.quantity), 0) FROM items i
					WHERE i.type_id = t.id AND i.archived_at IS NULL) AS total_qty,
				(SELECT coalesce(sum(i.quantity), 0) FROM items i
					WHERE i.type_id = t.id AND i.archived_at IS NULL AND i.condition NOT IN (${unusable})) AS usable_qty
			FROM types t LEFT JOIN categories c ON c.id = t.category_id
			WHERE ${where} ORDER BY lower(t.name)`
	);
	const images = await imagesFor(
		tx,
		'types',
		list.map((r) => String(r.id))
	);
	return list.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		description: str(r.description),
		notes: str(r.notes),
		categoryId: str(r.category_id) || null,
		category: categoryRef(r),
		images: images.get(String(r.id)) ?? [],
		archived: !!r.archived_at,
		itemCount: num(r.item_count),
		totalQuantity: num(r.total_qty),
		usableQuantity: num(r.usable_qty)
	}));
}

/** Grundlage der Verfügbarkeit: alle nicht archivierten Artikel */
export async function loadStock(tx: Tx): Promise<StockItem[]> {
	return (
		await rows(
			tx,
			sql`SELECT id, type_id, quantity, condition FROM items WHERE archived_at IS NULL`
		)
	).map((r) => ({
		id: String(r.id),
		typeId: str(r.type_id) || null,
		quantity: num(r.quantity),
		usable: !UNUSABLE_CONDITIONS.includes(String(r.condition) as Condition)
	}));
}

/** Zeilen anderer, nicht stornierter Reservierungen, die den Zeitraum berühren */
export async function loadBookings(
	tx: Tx,
	from: string,
	to: string,
	excludeReservationId?: string | null
): Promise<Booking[]> {
	return (
		await rows(
			tx,
			sql`SELECT to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on, l.type_id, l.item_id, l.quantity
				FROM reservation_lines l JOIN reservations r ON r.id = l.reservation_id
				WHERE r.status = 'reserved' AND r.starts_on <= ${to}::date AND r.ends_on >= ${from}::date
					AND r.id::text <> ${excludeReservationId ?? ''}`
		)
	).map((r) => ({
		startsOn: dateStr(r.starts_on),
		endsOn: dateStr(r.ends_on),
		typeId: str(r.type_id) || null,
		itemId: str(r.item_id) || null,
		quantity: num(r.quantity)
	}));
}
