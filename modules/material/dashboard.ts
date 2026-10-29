/**
 * Übersicht (`/dashboard`):
 * - „Zu erledigen“ (nur `material.inventory.manage`, wie die Kachel „Material“): gemeldete Schäden und
 *   Reservierungen, die in den nächsten 7 Tagen beginnen und noch nicht ausgegeben sind – je eine Zeile,
 *   nur wenn es etwas gibt.
 * - „Diese Woche“: eigene Reservierungen, für Verwaltende (Lager oder Reservierungen) alle, deren
 *   Zeitraum die Woche berührt.
 */
import { sql } from 'drizzle-orm';
import { addDays } from '$lib/sdk/dates';
import type { ModuleDashboardSources, RequestContext } from '$lib/sdk/server';
import type { DashboardAgendaItem, DashboardTodo } from '$lib/sdk/types/dashboard';
import { canManage, canManageReservations, dateStr, mdb, num, rows } from './db';
import { BASE_PATH, PERMISSIONS } from './schemas';

/** So viele Tage im Voraus erscheinen anstehende Reservierungen in „Zu erledigen“ */
export const MATERIAL_PREPARE_DAYS = 7;

/** Link wie in der Oberfläche (`MaterialPage`): eigene unter „Meine“, sonst „Alle“ (nur mit Recht) */
function reservationHref(ctx: RequestContext, id: string, mine: boolean): string {
	const tab = mine || !canManageReservations(ctx) ? 'meine' : 'alle';
	return `${BASE_PATH}?tab=${tab}&open=${encodeURIComponent(id)}`;
}

const DAMAGED = sql`condition IN ('damaged', 'defect', 'lost')`;

async function managerTodos(
	ctx: RequestContext,
	today: string,
	limit: number
): Promise<DashboardTodo[]> {
	const until = addDays(today, MATERIAL_PREPARE_DAYS);
	const { damaged, firstDamaged, upcoming } = await mdb().transaction(async (tx) => {
		const [d] = await rows(
			tx,
			sql`SELECT count(*) AS n FROM items WHERE archived_at IS NULL AND ${DAMAGED}`
		);
		const [first] = await rows(
			tx,
			sql`SELECT id, name FROM items WHERE archived_at IS NULL AND ${DAMAGED}
				ORDER BY condition_reported_at DESC NULLS LAST, lower(name), id LIMIT 1`
		);
		const upcoming = await rows(
			tx,
			sql`SELECT id, title, created_by, to_char(starts_on, 'YYYY-MM-DD') AS starts_on
				FROM reservations
				WHERE status = 'reserved' AND handed_out_at IS NULL
					AND starts_on >= ${today}::date AND starts_on <= ${until}::date
				ORDER BY starts_on, lower(title), id`
		);
		return { damaged: num(d?.n), firstDamaged: first, upcoming };
	});

	const out: DashboardTodo[] = [];
	if (upcoming.length) {
		const first = upcoming[0]!;
		const names = upcoming.slice(0, 3).map((r) => String(r.title));
		const more = upcoming.length - names.length;
		out.push({
			id: 'prepare',
			title:
				upcoming.length === 1
					? `Reservierung ${String(first.title)} vorbereiten`
					: `${upcoming.length} Reservierungen vorbereiten`,
			detail: `Beginnt in den nächsten ${MATERIAL_PREPARE_DAYS} Tagen · ${names.join(', ')}${more > 0 ? ` und ${more} weitere` : ''}`,
			due: dateStr(first.starts_on),
			severity: 'due',
			action:
				upcoming.length === 1
					? {
							label: 'Öffnen',
							href: reservationHref(ctx, String(first.id), first.created_by === ctx.userId)
						}
					: {
							label: 'Ansehen',
							href: `${BASE_PATH}?tab=${canManageReservations(ctx) ? 'alle' : 'meine'}`
						}
		});
	}
	if (damaged > 0 && firstDamaged) {
		out.push({
			id: 'damages',
			title: damaged === 1 ? '1 Schaden gemeldet' : `${damaged} Schäden gemeldet`,
			detail:
				damaged === 1
					? `${String(firstDamaged.name)} · beschädigt, defekt oder verloren`
					: 'Artikel beschädigt, defekt oder verloren',
			severity: 'due',
			action:
				damaged === 1
					? {
							label: 'Prüfen',
							href: `${BASE_PATH}?tab=lager&open=${encodeURIComponent(String(firstDamaged.id))}`
						}
					: { label: 'Prüfen', href: `${BASE_PATH}?tab=lager` }
		});
	}
	return out.slice(0, limit);
}

async function agendaItems(
	ctx: RequestContext,
	from: string,
	to: string
): Promise<DashboardAgendaItem[]> {
	const all = canManage(ctx) || canManageReservations(ctx);
	if (!all && !ctx.userId) return [];
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT r.id, r.title, r.created_by,
					to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on,
					(SELECT coalesce(sum(l.quantity), 0) FROM reservation_lines l
						WHERE l.reservation_id = r.id AND l.parent_line_id IS NULL) AS pieces
				FROM reservations r
				WHERE r.status = 'reserved' AND r.starts_on <= ${to}::date AND r.ends_on >= ${from}::date
					${all ? sql`` : sql`AND r.created_by = ${ctx.userId ?? ''}`}
				ORDER BY r.starts_on, lower(r.title), r.id
				LIMIT 100`
		)
	);
	return found.map((r) => {
		const n = num(r.pieces);
		const startsOn = dateStr(r.starts_on);
		const endsOn = dateStr(r.ends_on);
		return {
			id: `reservation:${String(r.id)}`,
			kind: 'material',
			title: `Material: ${String(r.title)}`,
			date: startsOn,
			endDate: endsOn !== startsOn ? endsOn : null,
			detail: `${n} Artikel`,
			href: reservationHref(ctx, String(r.id), !!ctx.userId && r.created_by === ctx.userId)
		};
	});
}

export const materialDashboard: ModuleDashboardSources = {
	todos: {
		permission: PERMISSIONS.manage,
		run: (ctx, { today, limit }) => managerTodos(ctx, today, limit)
	},
	agenda: {
		permission: PERMISSIONS.view,
		run: (ctx, { from, to }) => agendaItems(ctx, from, to)
	}
};
