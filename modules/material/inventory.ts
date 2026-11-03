/**
 * Lesen des Bestands: Kategorien, Orte, Typen, Lagerartikel (mit Bildern) und die Grundlage der
 * Verfügbarkeit. Nur Datenbankzugriffe – innerhalb einer Modul-Transaktion aufrufen.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '$lib/sdk/server';
import { todayBerlin } from '$lib/sdk/dates';
import { setCompleteness } from './allocation';
import type { PlanItem } from './assignment';
import type { Booking, StockItem } from './availability';
import { bool, dateStr, idList, iso, isoOrNull, num, rows, str, type Row } from './db';
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
	type MaterialSet,
	type MaterialType,
	type ReservationStatus,
	type SetMember,
	type Tent
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
		i.consumable, i.unit, i.location_id, l.name AS location_name, i.condition, i.condition_note, i.condition_reported_at,
		i.condition_reported_by, i.notes, i.archived_at, i.created_at, i.set_id, s.name AS set_name,
		c.id AS c_id, c.name AS c_name, c.icon AS c_icon, c.color AS c_color
	FROM items i
	LEFT JOIN types t ON t.id = i.type_id
	LEFT JOIN sets s ON s.id = i.set_id
	LEFT JOIN categories c ON c.id = COALESCE(t.category_id, i.category_id)
	LEFT JOIN locations l ON l.id = i.location_id`;

/** Lagerartikel nach Bedingung (Alias `i` = items, `t` = types, `c` = categories, `l` = locations, `s` = sets) */
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
			consumable: bool(r.consumable),
			unit: str(r.unit),
			locationId: str(r.location_id) || null,
			locationName: str(r.location_name) || null,
			setId: str(r.set_id) || null,
			setName: str(r.set_name) || null,
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
		sql`SELECT t.id, t.name, t.description, t.notes, t.category_id, t.archived_at, t.consumable, t.unit,
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
		consumable: bool(r.consumable),
		unit: str(r.unit),
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

/** Offene Ausgabe: ausgegeben, noch nicht zurückgenommen (Alias `r` = reservations) */
const OPEN_HAND_OUT = sql`r.handed_out_at IS NOT NULL AND r.returned_at IS NULL`;
const OPEN_END = sql`DATE '9999-12-31'`;

/**
 * Wirksames Ende einer Reservierungszeile (Alias `l`, `r`): Verbrauchsmaterial einer offenen Ausgabe belegt
 * bis zur Rücknahme, auch über das Ende hinaus
 */
export const lineEndSql = sql`CASE WHEN ${OPEN_HAND_OUT} AND (
		EXISTS (SELECT 1 FROM items ci WHERE ci.id = l.item_id AND ci.consumable)
		OR EXISTS (SELECT 1 FROM types ct WHERE ct.id = l.type_id AND ct.consumable)
	) THEN ${OPEN_END} ELSE r.ends_on END`;

/** Wie `lineEndSql` für Zuteilungen (Alias `a`, `r`) */
export const assignmentEndSql = sql`CASE WHEN ${OPEN_HAND_OUT}
		AND EXISTS (SELECT 1 FROM items ci WHERE ci.id = a.item_id AND ci.consumable)
	THEN ${OPEN_END} ELSE r.ends_on END`;

/**
 * Zeilen anderer, nicht stornierter Reservierungen, die den Zeitraum berühren (ohne Zelt-Zeilen; deren Teile
 * sind eigene Zeilen), dazu feste Zuteilungen (angeheftet oder bei ausgegebenen/laufenden Reservierungen)
 */
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
					to_char(${lineEndSql}, 'YYYY-MM-DD') AS ends_on, l.type_id, l.item_id, l.quantity
				FROM reservation_lines l JOIN reservations r ON r.id = l.reservation_id
				WHERE r.status = 'reserved' AND l.tent_id IS NULL AND r.starts_on <= ${to}::date
					AND ${lineEndSql} >= ${from}::date
					AND r.id::text <> ${excludeReservationId ?? ''}`
		)
	)
		.map((r) => ({
			startsOn: dateStr(r.starts_on),
			endsOn: dateStr(r.ends_on),
			typeId: str(r.type_id) || null,
			itemId: str(r.item_id) || null,
			quantity: num(r.quantity)
		}))
		.concat(
			(
				await rows(
					tx,
					sql`SELECT to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
							to_char(${assignmentEndSql}, 'YYYY-MM-DD') AS ends_on, a.item_id, a.quantity
						FROM reservation_assignments a JOIN reservations r ON r.id = a.reservation_id
						WHERE r.status = 'reserved' AND r.starts_on <= ${to}::date
							AND ${assignmentEndSql} >= ${from}::date
							AND r.id::text <> ${excludeReservationId ?? ''}
							AND (a.pinned OR r.handed_out_at IS NOT NULL OR r.starts_on <= ${todayBerlin()}::date)`
				)
			).map((r) => ({
				startsOn: dateStr(r.starts_on),
				endsOn: dateStr(r.ends_on),
				typeId: null,
				itemId: String(r.item_id),
				quantity: num(r.quantity),
				assigned: true
			}))
		);
}

// --- Sets, Zelte, Zuteilung ------------------------------------------------------

/** Sets mit ihren (nicht archivierten) Artikeln */
export async function loadSets(tx: Tx, where: SQL = sql`TRUE`): Promise<MaterialSet[]> {
	const sets = await rows(
		tx,
		sql`SELECT s.id, s.name, s.notes, s.position FROM sets s WHERE ${where}
			ORDER BY s.position, lower(s.name)`
	);
	if (!sets.length) return [];
	const members = await rows(
		tx,
		sql`SELECT i.id, i.name, i.code, i.type_id, t.name AS type_name, i.quantity, i.condition, i.set_id,
				l.name AS location_name
			FROM items i LEFT JOIN types t ON t.id = i.type_id LEFT JOIN locations l ON l.id = i.location_id
			WHERE i.archived_at IS NULL AND i.set_id IN (${idList(sets.map((r) => String(r.id)))})
			ORDER BY lower(i.name), i.code`
	);
	const next = await rows(
		tx,
		sql`SELECT DISTINCT ON (i.set_id) i.set_id, r.id, r.title, r.status,
				to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on
			FROM reservation_assignments a
			JOIN items i ON i.id = a.item_id
			JOIN reservations r ON r.id = a.reservation_id
			WHERE i.set_id IS NOT NULL AND r.status = 'reserved' AND r.ends_on >= ${todayBerlin()}::date
			ORDER BY i.set_id, r.starts_on, r.id`
	);
	const nextBySet = new Map(
		next.map((r) => [
			String(r.set_id),
			{
				id: String(r.id),
				title: String(r.title),
				status: String(r.status) as ReservationStatus,
				startsOn: dateStr(r.starts_on),
				endsOn: dateStr(r.ends_on)
			}
		])
	);
	return sets.map((r) => {
		const id = String(r.id);
		const items: SetMember[] = members
			.filter((m) => String(m.set_id) === id)
			.map((m) => {
				const condition = String(m.condition) as Condition;
				return {
					id: String(m.id),
					name: String(m.name),
					code: String(m.code),
					typeId: str(m.type_id) || null,
					typeName: str(m.type_name) || null,
					quantity: num(m.quantity),
					condition,
					usable: !UNUSABLE_CONDITIONS.includes(condition),
					locationName: str(m.location_name) || null
				};
			});
		const c = setCompleteness(
			items.map((m) => ({
				itemId: m.id,
				typeId: m.typeId,
				quantity: m.quantity,
				usable: m.usable
			}))
		);
		return {
			id,
			name: String(r.name),
			notes: str(r.notes),
			position: num(r.position),
			items,
			total: c.total,
			usable: c.usable,
			complete: c.complete,
			nextUse: nextBySet.get(id) ?? null
		};
	});
}

/** Zelte (Bauplan) mit Teilen (Alias `z` = tents, `c` = categories) */
export async function loadTents(tx: Tx, where: SQL = sql`TRUE`): Promise<Tent[]> {
	const list = await rows(
		tx,
		sql`SELECT z.id, z.name, z.description, z.category_id, z.archived_at,
				c.id AS c_id, c.name AS c_name, c.icon AS c_icon, c.color AS c_color,
				EXISTS (SELECT 1 FROM reservation_lines rl WHERE rl.tent_id = z.id) AS used
			FROM tents z LEFT JOIN categories c ON c.id = z.category_id
			WHERE ${where} ORDER BY lower(z.name)`
	);
	if (!list.length) return [];
	const parts = await rows(
		tx,
		sql`SELECT p.id, p.tent_id, p.label, p.type_id, p.item_id, p.quantity, p.from_one_set,
				coalesce(t.name, i.name) AS name, coalesce(p.type_id, i.type_id) AS cover_type
			FROM tent_parts p LEFT JOIN types t ON t.id = p.type_id LEFT JOIN items i ON i.id = p.item_id
			WHERE p.tent_id IN (${idList(list.map((r) => String(r.id)))})
			ORDER BY p.position, p.id`
	);
	const typeImages = await imagesFor(
		tx,
		'types',
		parts.map((p) => str(p.cover_type)).filter(Boolean)
	);
	const itemImages = await imagesFor(tx, 'items', parts.map((p) => str(p.item_id)).filter(Boolean));
	return list.map((r) => {
		const id = String(r.id);
		const own = parts.filter((p) => String(p.tent_id) === id);
		let thumbUrl: string | null = null;
		for (const p of own) {
			const img =
				itemImages.get(str(p.item_id))?.[0] ?? typeImages.get(str(p.cover_type))?.[0] ?? null;
			if (img) {
				thumbUrl = img.thumbUrl;
				break;
			}
		}
		return {
			id,
			name: String(r.name),
			description: str(r.description),
			categoryId: str(r.category_id) || null,
			category: categoryRef(r),
			archived: !!r.archived_at,
			used: bool(r.used),
			thumbUrl,
			parts: own.map((p) => ({
				id: String(p.id),
				kind: p.type_id ? ('type' as const) : ('item' as const),
				typeId: str(p.type_id) || null,
				itemId: str(p.item_id) || null,
				name: str(p.name),
				label: str(p.label),
				quantity: num(p.quantity),
				fromOneSet: bool(p.from_one_set)
			}))
		};
	});
}

/** Bestand für die Zuteilung: alle Artikel mit Set und nutzbarer Anzahl */
export async function loadPlanItems(tx: Tx): Promise<PlanItem[]> {
	return (
		await rows(
			tx,
			sql`SELECT i.id, i.type_id, i.set_id, s.name AS set_name, i.quantity, i.condition, i.archived_at,
					i.name, i.code
				FROM items i LEFT JOIN sets s ON s.id = i.set_id`
		)
	).map((r) => {
		const usable =
			!r.archived_at && !UNUSABLE_CONDITIONS.includes(String(r.condition) as Condition);
		return {
			id: String(r.id),
			typeId: str(r.type_id) || null,
			setId: str(r.set_id) || null,
			setName: str(r.set_name) || null,
			capacity: usable ? num(r.quantity) : 0,
			sortKey: `${String(r.name)} ${String(r.code)}`
		};
	});
}
