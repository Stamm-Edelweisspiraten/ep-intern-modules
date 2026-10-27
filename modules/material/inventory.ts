/**
 * Bestand lesen: Index der Orte/Kisten (Pfade, effektiver Ort) und Zusammenfassungen von Stücken.
 * Der Index lädt alle Orte und alle Stücke mit wenigen Spalten – für den Bestand eines Stammes
 * (einige tausend Stücke) unkritisch und erspart rekursive Abfragen.
 */
import { sql } from 'drizzle-orm';
import { errors, type Tx } from '$lib/sdk/server';
import { bool, idList, iso, isoOrNull, rows, str, type Row } from './db';
import { PATH_SEPARATOR, effectivePlace, locationPaths, type Placed } from './places';
import { UNUSABLE_CONDITIONS, type Condition, type UnitSummary } from './schemas';

export interface PlaceIndex {
	locationPaths: Map<string, string>;
	locationParents: Map<string, string | null>;
	units: Map<string, Placed & { name: string; isContainer: boolean; articleId: string }>;
}

export async function loadPlaceIndex(tx: Tx): Promise<PlaceIndex> {
	const locs = await rows(tx, sql`SELECT id, parent_id, name FROM locations`);
	const nodes = locs.map((r) => ({
		id: String(r.id),
		parentId: r.parent_id ? String(r.parent_id) : null,
		name: String(r.name)
	}));
	const unitRows = await rows(
		tx,
		sql`SELECT u.id, u.article_id, u.container_id, u.location_id, u.label, u.is_container, a.name AS article_name
			FROM units u JOIN articles a ON a.id = u.article_id`
	);
	return {
		locationPaths: locationPaths(nodes),
		locationParents: new Map(nodes.map((n) => [n.id, n.parentId])),
		units: new Map(
			unitRows.map((r) => [
				String(r.id),
				{
					id: String(r.id),
					containerId: r.container_id ? String(r.container_id) : null,
					locationId: r.location_id ? String(r.location_id) : null,
					name: str(r.label) || String(r.article_name),
					isContainer: bool(r.is_container),
					articleId: String(r.article_id)
				}
			])
		)
	};
}

/** Ort eines Stücks als Text: „Materialraum › Regal A › Kochkiste 2“ (Kisten innen zuletzt) */
export function placeText(index: PlaceIndex, unitId: string): string {
	const { locationId, chain } = effectivePlace(index.units, unitId);
	const parts: string[] = [];
	if (locationId) parts.push(index.locationPaths.get(locationId) ?? '');
	for (const id of [...chain].reverse()) parts.push(index.units.get(id)?.name ?? '');
	return parts.filter(Boolean).join(PATH_SEPARATOR) || 'Ohne Ort';
}

/** Ort einer Kiste/eines Lagerorts als Text (für Bestand/Halter) */
export function holderText(
	index: PlaceIndex,
	holder: { locationId: string | null; containerId: string | null }
): string {
	if (holder.locationId) return index.locationPaths.get(holder.locationId) ?? 'Unbekannter Ort';
	if (holder.containerId) {
		const base = placeText(index, holder.containerId);
		const name = index.units.get(holder.containerId)?.name ?? 'Kiste';
		return base === 'Ohne Ort' ? name : `${base}${PATH_SEPARATOR}${name}`;
	}
	return 'Ohne Ort';
}

/** Alle Stücke in einer Kiste (rekursiv, ohne die Kiste selbst) */
export function containedUnits(index: PlaceIndex, containerId: string): string[] {
	const children = new Map<string, string[]>();
	for (const u of index.units.values()) {
		if (!u.containerId) continue;
		const list = children.get(u.containerId);
		if (list) list.push(u.id);
		else children.set(u.containerId, [u.id]);
	}
	const out: string[] = [];
	const seen = new Set<string>([containerId]);
	const stack = [...(children.get(containerId) ?? [])];
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		stack.push(...(children.get(id) ?? []));
	}
	return out;
}

export const UNIT_SELECT = sql`SELECT u.id, u.code, u.label, u.article_id, a.name AS article_name,
		c.name AS category_name, c.color AS category_color, u.is_container, u.container_id,
		u.location_id, u.condition, u.retired_at, su.set_id, s.name AS set_name,
		u.issued_reservation_id, r.title AS issued_title,
		u.condition_note, u.purchased_on, u.value_cents, u.notes, u.created_at
	FROM units u
	JOIN articles a ON a.id = u.article_id
	LEFT JOIN categories c ON c.id = a.category_id
	LEFT JOIN set_units su ON su.unit_id = u.id
	LEFT JOIN sets s ON s.id = su.set_id
	LEFT JOIN reservations r ON r.id = u.issued_reservation_id`;

export function toUnitSummary(index: PlaceIndex, r: Row): UnitSummary {
	const id = String(r.id);
	const containerId = r.container_id ? String(r.container_id) : null;
	return {
		id,
		code: String(r.code),
		name: str(r.label) || String(r.article_name),
		label: str(r.label),
		articleId: String(r.article_id),
		articleName: String(r.article_name),
		categoryName: r.category_name ? String(r.category_name) : null,
		categoryColor: r.category_color ? String(r.category_color) : null,
		isContainer: bool(r.is_container),
		containerId,
		containerName: containerId ? (index.units.get(containerId)?.name ?? null) : null,
		locationId: r.location_id ? String(r.location_id) : null,
		locationPath: placeText(index, id),
		condition: String(r.condition) as Condition,
		retired: r.retired_at != null,
		setId: r.set_id ? String(r.set_id) : null,
		setName: r.set_name ? String(r.set_name) : null,
		issued: r.issued_reservation_id
			? { reservationId: String(r.issued_reservation_id), title: str(r.issued_title) }
			: null
	};
}

/** Zusammenfassungen zu IDs (Reihenfolge der IDs bleibt erhalten, Unbekannte fehlen) */
export async function unitSummaries(
	tx: Tx,
	ids: readonly string[],
	index?: PlaceIndex
): Promise<UnitSummary[]> {
	if (!ids.length) return [];
	const idx = index ?? (await loadPlaceIndex(tx));
	const list = await rows(tx, sql`${UNIT_SELECT} WHERE u.id IN (${idList([...ids])})`);
	const byId = new Map(list.map((r) => [String(r.id), toUnitSummary(idx, r)]));
	return ids.map((id) => byId.get(id)).filter((u): u is UnitSummary => !!u);
}

/** Ein Stück laden (404, wenn unbekannt) */
export async function requireUnitRow(tx: Tx, id: string): Promise<Row> {
	const [r] = await rows(tx, sql`${UNIT_SELECT} WHERE u.id = ${id}`);
	if (!r) throw errors.notFound('Stück nicht gefunden');
	return r;
}

/** Ist ein Stück nutzbar (nicht ausgemustert, nicht defekt/verloren)? */
export function isUsable(r: Row): boolean {
	return r.retired_at == null && !UNUSABLE_CONDITIONS.includes(String(r.condition) as Condition);
}

export { iso, isoOrNull };
