/**
 * Globale Suche (Befehlspalette): Aktionen nach Name und Ort. Sichtbar wie in `GET /actions`
 * (`visibleActionsFilter`: eigene + freigegebene, alle mit `view-all`/`edit-all`).
 * Reihenfolge: laufende/kommende zuerst (früheste zuerst), danach vergangene (jüngste zuerst).
 */
import { sql } from 'drizzle-orm';
import { moduleDb, type ModuleSearchProvider, rowsOf, type SearchHit } from '$lib/sdk/server';
import { visibleActionsFilter } from './access';
import { MODULE_ID } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `2026-03-07` → `07.03.2026` */
function de(iso: unknown): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
	return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

export const actionsSearch: ModuleSearchProvider = {
	permission: 'actions.action.view',
	async run(ctx, query, limit) {
		const p = like(query);
		const found = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT a.id, a.name, a.location,
						to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
						to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
						(COALESCE(a.ends_on, a.starts_on) < CURRENT_DATE) AS is_over
					FROM actions a
					WHERE ${visibleActionsFilter(ctx)} AND (a.name ILIKE ${p} OR a.location ILIKE ${p})
					ORDER BY is_over,
						CASE WHEN COALESCE(a.ends_on, a.starts_on) < CURRENT_DATE THEN NULL ELSE a.starts_on END,
						a.starts_on DESC, a.name, a.id
					LIMIT ${limit}`
			)
		);
		return found.map((r): SearchHit => {
			const start = de(r.starts_on);
			const end = de(r.ends_on);
			const date = end && end !== start ? `${start} – ${end}` : start;
			return {
				id: String(r.id),
				title: String(r.name),
				subtitle:
					[date, r.location ? String(r.location) : ''].filter(Boolean).join(' · ') || undefined,
				href: `/modules/actions/${encodeURIComponent(String(r.id))}`,
				icon: 'backpack',
				type: 'Aktion'
			};
		});
	}
};
