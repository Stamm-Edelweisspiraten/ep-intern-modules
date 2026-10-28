/**
 * Globale Suche (Befehlspalette): Lagerartikel (Code, Name), Typen, Lagerorte und offene Reservierungen.
 * Alles mit `material.inventory.view` sichtbar (wie in der Oberfläche).
 */
import { sql } from 'drizzle-orm';
import type { ModuleSearchProvider, RequestContext } from '$lib/sdk/server';
import type { SearchHit } from '$lib/sdk/types/search';
import { formatDateDe } from '$lib/sdk/dates';
import { dateStr, likePattern, mdb, rows, str, today } from './db';
import { itemLink, reservationLink } from './notify';
import { BASE_PATH, PERMISSIONS, normalizeCode } from './schemas';

async function run(_ctx: RequestContext, query: string, limit: number): Promise<SearchHit[]> {
	const p = likePattern(query);
	const code = normalizeCode(query);
	return mdb().transaction(async (tx) => {
		const hits: SearchHit[] = [];
		for (const i of await rows(
			tx,
			sql`SELECT i.id, i.code, i.name, t.name AS type_name FROM items i
				LEFT JOIN types t ON t.id = i.type_id
				WHERE i.archived_at IS NULL AND (i.code = ${code} OR i.name ILIKE ${p})
				ORDER BY (i.code = ${code}) DESC, lower(i.name) LIMIT ${limit}`
		)) {
			hits.push({
				id: `item:${String(i.id)}`,
				type: 'Material',
				title: String(i.name),
				subtitle: [String(i.code), str(i.type_name)].filter(Boolean).join(' · '),
				href: itemLink(String(i.id)),
				icon: 'boxes'
			});
		}
		for (const t of await rows(
			tx,
			sql`SELECT id, name FROM types WHERE archived_at IS NULL AND name ILIKE ${p}
				ORDER BY lower(name) LIMIT ${limit}`
		)) {
			hits.push({
				id: `type:${String(t.id)}`,
				type: 'Materialtyp',
				title: String(t.name),
				subtitle: 'Typ',
				href: `${BASE_PATH}?tab=lager&type=${String(t.id)}`,
				icon: 'boxes'
			});
		}
		for (const l of await rows(
			tx,
			sql`SELECT id, name, code FROM locations WHERE code = ${code} OR name ILIKE ${p}
				ORDER BY lower(name) LIMIT ${limit}`
		)) {
			hits.push({
				id: `location:${String(l.id)}`,
				type: 'Lagerort',
				title: String(l.name),
				subtitle: String(l.code),
				href: `${BASE_PATH}?tab=lager&location=${String(l.id)}`,
				icon: 'boxes'
			});
		}
		for (const r of await rows(
			tx,
			sql`SELECT id, title, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM reservations
				WHERE status = 'reserved' AND ends_on >= ${today()}::date AND title ILIKE ${p}
				ORDER BY starts_on LIMIT ${limit}`
		)) {
			hits.push({
				id: `reservation:${String(r.id)}`,
				type: 'Reservierung',
				title: String(r.title),
				subtitle: `ab ${formatDateDe(dateStr(r.starts_on))}`,
				href: reservationLink(String(r.id)),
				icon: 'boxes'
			});
		}
		return hits.slice(0, limit);
	});
}

export const materialSearch: ModuleSearchProvider = { permission: PERMISSIONS.view, run };
