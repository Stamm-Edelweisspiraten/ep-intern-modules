/**
 * Dashboard-Endpunkte von `actions`: eigene Anmeldungen (Aufrufer + verknüpfte Mitglieder) und
 * vergangene Aktionen mit offener Abrechnung. Nur lesend, ohne Audit. Der members-Dienst läuft
 * AUSSERHALB der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import {
	type ApiEndpoint,
	core,
	defineEndpoint,
	inList,
	moduleDb,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import { editableActionsFilter } from './access';
import {
	DASHBOARD_LIST_LIMIT,
	MODULE_ID,
	type MyRegistration,
	type OpenAccounting
} from './schemas';

const TAGS = ['Modul: actions'];

/** Heutiges Datum in Deutschland (zentral, Test-Override über `setTodayForTests` aus `$lib/sdk/dates`) */
const today = (): string => todayBerlin();

const text = (v: unknown): string | null => (v == null ? null : String(v));
export async function loadMyRegistrations(ctx: RequestContext): Promise<MyRegistration[]> {
	if (!ctx.userId) return [];
	const userId = ctx.userId;
	const linked = await (
		await core.modules.use<MembersService>('members', MODULE_ID)
	).listLinkedMembers(ctx);
	const memberIds = linked.map((m) => m.id);
	const byMember = memberIds.length ? sql`p.member_id IN (${inList(memberIds)})` : sql`FALSE`;
	const day = today();

	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT a.id, a.name, a.location, a.starts_time, a.ends_time, a.fee_cents, a.team_fee_cents,
					to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
					p.name AS person, p.role
				FROM actions a JOIN action_participants p ON p.action_id = a.id
				WHERE a.is_past = false AND coalesce(a.ends_on, a.starts_on) >= ${day}::date
					AND (p.user_id = ${userId} OR ${byMember})
				ORDER BY a.starts_on, coalesce(a.starts_time, ''), a.name, a.id, p.name`
		)
	);

	const map = new Map<string, MyRegistration & { anyFee: boolean }>();
	for (const r of found) {
		const id = String(r.id);
		let reg = map.get(id);
		if (!reg) {
			if (map.size >= DASHBOARD_LIST_LIMIT) continue;
			reg = {
				actionId: id,
				name: String(r.name),
				startsOn: String(r.starts_on),
				endsOn: text(r.ends_on),
				startsTime: text(r.starts_time),
				endsTime: text(r.ends_time),
				location: text(r.location),
				people: [],
				feeCents: null,
				anyFee: false
			};
			map.set(id, reg);
		}
		reg.people.push(String(r.person));
		// Team zahlt den Team-Beitrag (wie Kasse/Abrechnung); ohne übernommenen Beitrag `null`
		const fee = r.role === 'team' ? r.team_fee_cents : r.fee_cents;
		if (r.fee_cents != null) {
			reg.anyFee = true;
			reg.feeCents = (reg.feeCents ?? 0) + Number(fee ?? 0);
		}
	}
	return [...map.values()].map(({ anyFee, ...reg }) => ({
		...reg,
		feeCents: anyFee ? reg.feeCents : null
	}));
}

export async function loadOpenAccountings(ctx: RequestContext): Promise<OpenAccounting[]> {
	const day = today();
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT a.id, a.name, to_char(coalesce(a.ends_on, a.starts_on), 'YYYY-MM-DD') AS ends_on,
					(SELECT count(*) FROM accounting_entries e WHERE e.action_id = a.id) AS entry_count,
					(SELECT count(*) FROM accounting_entries e WHERE e.action_id = a.id AND e.type = 'expense'
						AND e.category <> 'refund' AND e.receipt_path IS NULL) AS missing_receipts,
					(SELECT count(*) FROM accounting_entries e WHERE e.action_id = a.id AND e.type = 'expense'
						AND e.paid_by = 'person' AND e.reimbursed_at IS NULL) AS open_reimbursements
				FROM actions a
				WHERE coalesce(a.ends_on, a.starts_on) <= ${day}::date
					AND NOT EXISTS (SELECT 1 FROM action_accounting c WHERE c.action_id = a.id AND c.closed_at IS NOT NULL)
					AND ${editableActionsFilter(ctx)}
				ORDER BY coalesce(a.ends_on, a.starts_on), a.name, a.id
				LIMIT ${DASHBOARD_LIST_LIMIT}`
		)
	);
	return found.map((r) => ({
		actionId: String(r.id),
		name: String(r.name),
		endsOn: String(r.ends_on),
		entryCount: Number(r.entry_count ?? 0),
		missingReceipts: Number(r.missing_receipts ?? 0),
		openReimbursements: Number(r.open_reimbursements ?? 0)
	}));
}

export const myEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/my/registrations',
		summary: 'Eigene kommende Anmeldungen (eigenes Konto und verknüpfte Mitglieder)',
		tags: TAGS,
		permission: 'actions.own.view',
		handler: ({ ctx }): Promise<MyRegistration[]> => loadMyRegistrations(ctx)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/accounting/open',
		summary: 'Vergangene Aktionen mit Bearbeiten-Zugriff und noch offener Abrechnung',
		tags: TAGS,
		permission: 'actions.action.view',
		handler: ({ ctx }): Promise<OpenAccounting[]> => loadOpenAccountings(ctx)
	})
] as ApiEndpoint[];
