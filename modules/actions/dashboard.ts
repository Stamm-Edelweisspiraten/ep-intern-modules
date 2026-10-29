/**
 * Übersicht (`/dashboard`):
 * - „Zu erledigen“: vergangene Aktionen mit Bearbeiten-Zugriff und offener Abrechnung (wie die Kachel
 *   „Offene Abrechnungen“) sowie offene Rückmeldungen „Rückzahlung spenden oder auszahlen“ zu eigenen
 *   Anmeldungen (Konto oder verknüpfte Mitglieder), solange die Frist läuft und ein Link existiert.
 * - „Diese Woche“: sichtbare Aktionen und eigene Anmeldungen im Zeitraum (wie das Kalender-Abo).
 * Principal-Schlüssel und der members-Dienst laufen VOR der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { formatEuro } from '$lib/components/layout/money';
import {
	core,
	inList,
	type ModuleDashboardSources,
	moduleDb,
	type RequestContext,
	rowsOf,
	str
} from '$lib/sdk/server';
import type { DashboardAgendaItem, DashboardTodo } from '$lib/sdk/types/dashboard';
import type { MembersService } from '$lib/modules/members/contract';
import { loadActionKeys } from './access';
import { listCalendarActions } from './calendar';
import { storedToken } from './link-tokens';
import { loadOpenAccountings } from './my.endpoints';
import { deadlineRunning } from './refund';
import { treasuryPaidByItem } from './refund-donation';
import { MODULE_ID, REFUND_PUBLIC_PREFIX } from './schemas';

const VIEW = 'actions.action.view';
const OWN = 'actions.own.view';

const actionHref = (id: string) => `/modules/actions/${encodeURIComponent(id)}`;

/** `2026-10-05` → `5.10.` */
export function shortDate(iso: string): string {
	const [, m, d] = iso.split('-');
	return `${Number(d)}.${Number(m)}.`;
}

async function openAccountingTodos(
	ctx: RequestContext,
	today: string,
	limit: number
): Promise<DashboardTodo[]> {
	if (!ctx.permissions.has(VIEW)) return [];
	await loadActionKeys(ctx);
	const open = await loadOpenAccountings(ctx, today);
	return open.slice(0, limit).map((a) => {
		const extra =
			a.missingReceipts > 0
				? ` · ${a.missingReceipts === 1 ? '1 Beleg fehlt' : `${a.missingReceipts} Belege fehlen`}`
				: '';
		return {
			id: `accounting:${a.actionId}`,
			title: `Abrechnung ${a.name} abschließen`,
			detail: `Aktion endete am ${shortDate(a.endsOn)}${extra}`,
			severity: 'due',
			action: { label: 'Abrechnen', href: `${actionHref(a.actionId)}?tab=accounting` }
		};
	});
}

/**
 * Offene Wahl „spenden oder auszahlen“ zu eigenen Anmeldungen: gebuchte Rückzahlung mit laufender Frist,
 * noch nicht entschieden, Abrechnung offen, Link vorhanden (sonst gibt es keinen Ort für die Wahl),
 * von der Kasse noch nicht überwiesen.
 */
async function refundChoiceTodos(
	ctx: RequestContext,
	today: string,
	limit: number
): Promise<DashboardTodo[]> {
	if (!ctx.userId || !ctx.permissions.has(OWN)) return [];
	const userId = ctx.userId;
	const linked = await (
		await core.modules.use<MembersService>('members', MODULE_ID)
	).listLinkedMembers(ctx);
	const memberIds = linked.map((m) => m.id);
	const byMember = memberIds.length ? sql`p.member_id IN (${inList(memberIds)})` : sql`FALSE`;
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT r.id, r.action_id, r.name, r.amount_cents, r.token_enc, a.name AS action_name,
					to_char(b.choice_deadline, 'YYYY-MM-DD') AS deadline
				FROM accounting_refunds r
					JOIN action_participants p ON p.id = r.participant_id
					JOIN actions a ON a.id = r.action_id
					JOIN action_refund_booking b ON b.action_id = r.action_id
				WHERE r.decided_at IS NULL AND r.token_enc IS NOT NULL
					AND b.choice_deadline IS NOT NULL AND b.choice_deadline >= ${today}::date
					AND NOT EXISTS (SELECT 1 FROM action_accounting c
						WHERE c.action_id = r.action_id AND c.closed_at IS NOT NULL)
					AND (p.user_id = ${userId} OR ${byMember})
				ORDER BY b.choice_deadline, a.name, r.name, r.id
				LIMIT ${limit}`
		)
	);
	const out: DashboardTodo[] = [];
	const byAction = new Map<string, string[]>();
	for (const r of found) {
		const list = byAction.get(String(r.action_id)) ?? [];
		list.push(String(r.id));
		byAction.set(String(r.action_id), list);
	}
	const paid = new Set<string>();
	for (const [actionId, ids] of byAction) {
		for (const id of (await treasuryPaidByItem(actionId, ids)).keys()) paid.add(id);
	}
	for (const r of found) {
		const deadline = str(r.deadline);
		const token = storedToken(r);
		if (!token || paid.has(String(r.id)) || !deadlineRunning(deadline, today)) continue;
		const amount = Number(r.amount_cents);
		out.push({
			id: `refund:${String(r.id)}`,
			title: `Rückzahlung ${String(r.action_name)}: spenden oder auszahlen?`,
			detail: `${String(r.name)} · ${formatEuro(amount)} · ohne Rückmeldung wird ausgezahlt`,
			due: deadline,
			severity: 'info',
			amountCents: amount,
			action: { label: 'Auswählen', href: `${REFUND_PUBLIC_PREFIX}/${token}` }
		});
	}
	return out;
}

async function agendaItems(
	ctx: RequestContext,
	from: string,
	to: string
): Promise<DashboardAgendaItem[]> {
	const list = await listCalendarActions(ctx, { from, to });
	return list.map((a) => {
		const parts: string[] = [];
		if (a.location) parts.push(a.location);
		if (a.registered.length) parts.push(`Angemeldet: ${a.registered.join(', ')}`);
		return {
			id: `action:${a.id}`,
			kind: 'action',
			title: a.name,
			date: a.startsOn,
			endDate: a.endsOn,
			startTime: a.startsTime,
			endTime: a.endsTime,
			detail: parts.join(' · ') || undefined,
			// Nur Angemeldete ohne Zugriff auf die Aktion: keine Aktionsseite (wäre 404)
			href: a.canOpen ? actionHref(a.id) : '/dashboard'
		};
	});
}

export const actionsDashboard: ModuleDashboardSources = {
	todos: {
		anyPermission: [VIEW, OWN],
		async run(ctx, { today, limit }) {
			const accounting = await openAccountingTodos(ctx, today, limit);
			const refunds = await refundChoiceTodos(ctx, today, limit);
			return [...accounting, ...refunds].slice(0, limit);
		}
	},
	agenda: {
		anyPermission: [VIEW, OWN],
		run: (ctx, { from, to }) => agendaItems(ctx, from, to)
	}
};
