/**
 * Globale Suche (Befehlspalette): Stücke/Kisten (Code, Bezeichnung), Sets, Artikel und offene
 * Reservierungen. Alles mit `material.inventory.view` sichtbar (wie in der Oberfläche).
 */
import { sql } from 'drizzle-orm';
import type { ModuleSearchProvider, RequestContext } from '$lib/sdk/server';
import type { SearchHit } from '$lib/sdk/types/search';
import { formatDateDe } from '$lib/sdk/dates';
import { dateStr, mdb, rows, str } from './db';
import { BASE_PATH, PERMISSIONS, normalizeCode } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function run(_ctx: RequestContext, query: string, limit: number): Promise<SearchHit[]> {
	const p = like(query);
	const code = normalizeCode(query);
	return mdb().transaction(async (tx) => {
		const hits: SearchHit[] = [];
		const units = await rows(
			tx,
			sql`SELECT u.id, u.code, u.label, u.is_container, a.name FROM units u
				JOIN articles a ON a.id = u.article_id
				WHERE u.retired_at IS NULL AND (u.code = ${code} OR u.label ILIKE ${p})
				ORDER BY (u.code = ${code}) DESC, lower(u.label) LIMIT ${limit}`
		);
		for (const u of units) {
			hits.push({
				id: `unit:${String(u.id)}`,
				type: u.is_container === true || u.is_container === 't' ? 'Kiste' : 'Material',
				title: str(u.label) || String(u.name),
				subtitle: `${String(u.code)} · ${String(u.name)}`,
				href: `${BASE_PATH}?open=${String(u.id)}`,
				icon: 'boxes'
			});
		}
		const sets = await rows(
			tx,
			sql`SELECT s.id, s.code, s.name, t.name AS template FROM sets s
				JOIN set_templates t ON t.id = s.template_id
				WHERE s.code = ${code} OR s.name ILIKE ${p} ORDER BY lower(s.name) LIMIT ${limit}`
		);
		for (const s of sets) {
			hits.push({
				id: `set:${String(s.id)}`,
				type: 'Set',
				title: String(s.name),
				subtitle: `${String(s.code)} · ${String(s.template)}`,
				href: `${BASE_PATH}?tab=sets&open=${String(s.id)}`,
				icon: 'boxes'
			});
		}
		const articles = await rows(
			tx,
			sql`SELECT id, name, kind FROM articles WHERE archived_at IS NULL AND name ILIKE ${p}
				ORDER BY lower(name) LIMIT ${limit}`
		);
		for (const a of articles) {
			hits.push({
				id: `article:${String(a.id)}`,
				type: 'Artikel',
				title: String(a.name),
				subtitle: String(a.kind) === 'bulk' ? 'Menge' : 'Einzelstücke',
				href: `${BASE_PATH}?article=${String(a.id)}`,
				icon: 'boxes'
			});
		}
		const res = await rows(
			tx,
			sql`SELECT id, title, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM reservations
				WHERE status IN ('reserved', 'issued') AND title ILIKE ${p}
				ORDER BY starts_on LIMIT ${limit}`
		);
		for (const r of res) {
			hits.push({
				id: `reservation:${String(r.id)}`,
				type: 'Reservierung',
				title: String(r.title),
				subtitle: `ab ${formatDateDe(dateStr(r.starts_on))}`,
				href: `${BASE_PATH}?tab=reservations&open=${String(r.id)}`,
				icon: 'boxes'
			});
		}
		return hits.slice(0, limit);
	});
}

export const materialSearch: ModuleSearchProvider = { permission: PERMISSIONS.view, run };
