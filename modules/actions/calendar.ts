/**
 * Aktionen für das Kalender-Abo (Modul `events`, Dienst `ActionsService.listCalendarActions`):
 * - mit `actions.action.view` alle Aktionen, die die Person auch in der Liste sieht (`visibleActionsFilter`);
 * - mit `actions.own.view` zusätzlich Aktionen, bei denen sie selbst oder ein verknüpftes Mitglied
 *   angemeldet ist (Namen in `registered`, wie die Dashboard-Kachel „Meine Anmeldungen“).
 * Der members-Dienst läuft AUSSERHALB der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { core, inList, moduleDb, type RequestContext, rowsOf } from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import { visibleActionsFilter } from './access';
import type { CalendarAction } from './contract';
import { MODULE_ID } from './schemas';

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Höchstzahl Aktionen je Abruf */
const CALENDAR_LIMIT = 500;

export async function listCalendarActions(
	ctx: RequestContext,
	window: { from: string; to: string }
): Promise<CalendarAction[]> {
	const canView = core.permissions.has(ctx, 'actions.action.view');
	const canOwn = core.permissions.has(ctx, 'actions.own.view');
	if (!ctx.userId || (!canView && !canOwn)) return [];
	const userId = ctx.userId;
	const memberIds = canOwn
		? (
				await (await core.modules.use<MembersService>('members', MODULE_ID)).listLinkedMembers(ctx)
			).map((m) => m.id)
		: [];
	const mine = canOwn
		? sql`(p.user_id = ${userId} OR ${memberIds.length ? sql`p.member_id IN (${inList(memberIds)})` : sql`FALSE`})`
		: sql`FALSE`;
	const visible = canView ? visibleActionsFilter(ctx) : sql`FALSE`;
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT a.id, a.name, a.description, a.location, a.starts_time, a.ends_time,
					to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
					(${visible}) AS visible,
					(SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM action_participants p
						WHERE p.action_id = a.id AND ${mine}) AS registered
				FROM actions a
				WHERE a.starts_on <= ${window.to}::date
					AND coalesce(a.ends_on, a.starts_on) >= ${window.from}::date
					AND ((${visible}) OR EXISTS (SELECT 1 FROM action_participants p
						WHERE p.action_id = a.id AND ${mine}))
				ORDER BY a.starts_on, a.id
				LIMIT ${CALENDAR_LIMIT}`
		)
	);
	return rows.map((r) => {
		const visibleRow = r.visible === true || r.visible === 't';
		return {
			id: String(r.id),
			name: String(r.name),
			// Beschreibung nur für Personen mit Zugriff auf die Aktion, nicht für reine Anmeldungen
			description: visibleRow ? text(r.description) : null,
			location: text(r.location),
			startsOn: String(r.starts_on),
			endsOn: text(r.ends_on),
			startsTime: text(r.starts_time),
			endsTime: text(r.ends_time),
			registered: text(r.registered)?.split(', ') ?? [],
			canOpen: visibleRow
		};
	});
}
