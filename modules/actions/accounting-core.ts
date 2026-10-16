/** Gemeinsame Datenbank-Hilfen der Abrechnung (Buchungen, Abschlussstatus). */
import { sql } from 'drizzle-orm';
import { core, errors, type Tx } from '$lib/sdk/server';
import type { ActionContributions, TreasuryService } from '$lib/modules/treasury/contract';
import { rowsOf } from './access';
import { computeAutoIncome } from './auto-income';
import { maskFromLast } from './iban';
import type { EligibilityParticipant } from './subsidy-eligibility';
import type {
	AccountingCategory,
	AccountingEntry,
	AutoIncome,
	ClubPaidVia,
	EntryType,
	FreizeitType,
	LodgingType,
	ParticipantRole,
	PaidBy
} from './schemas';

const iso = (v: unknown): string => new Date(String(v)).toISOString();

/** Abschlussstatus; `null`, wenn die Abrechnung offen ist. */
export async function closedInfo(
	tx: Tx,
	actionId: string
): Promise<{ at: string; by: string | null } | null> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT closed_at, closed_by FROM action_accounting WHERE action_id = ${actionId}`
	);
	if (!r || r.closed_at == null) return null;
	return { at: iso(r.closed_at), by: r.closed_by == null ? null : String(r.closed_by) };
}

/** Wirft 409, wenn die Abrechnung abgeschlossen ist (alle ändernden Endpoints rufen das auf). */
export async function assertOpen(tx: Tx, actionId: string): Promise<void> {
	if (await closedInfo(tx, actionId)) {
		throw errors.conflict(
			'Die Abrechnung ist abgeschlossen. Zum Ändern bitte zuerst wieder öffnen.'
		);
	}
}

/** SELECT-Spalten fuer Buchungen (Alias `e`, Empfaenger `p` per LEFT JOIN). */
export const ENTRY_COLUMNS = sql`e.id, e.type, e.category, e.description, e.amount_cents,
	to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.paid_by, e.payee_id, p.name AS payee_name,
	e.receipt_path, e.receipt_name, e.receipt_content_type, e.reimbursed_at, e.created_at, e.updated_at,
	e.recipient_name, e.recipient_iban_last4, e.recipient_bic, e.purpose, e.club_paid_at, e.club_paid_via`;

export function mapEntry(r: Record<string, unknown>): AccountingEntry {
	return {
		id: String(r.id),
		type: String(r.type) as EntryType,
		category: String(r.category) as AccountingCategory,
		description: String(r.description),
		amountCents: Number(r.amount_cents),
		entryDate: String(r.entry_date),
		paidBy: String(r.paid_by) as PaidBy,
		payee: r.payee_id == null ? null : { id: String(r.payee_id), name: String(r.payee_name) },
		receipt:
			r.receipt_path == null
				? null
				: {
						name: String(r.receipt_name ?? 'Beleg'),
						contentType: String(r.receipt_content_type ?? 'application/octet-stream')
					},
		reimbursedAt: r.reimbursed_at == null ? null : iso(r.reimbursed_at),
		recipient:
			r.recipient_name == null
				? null
				: {
						name: String(r.recipient_name),
						ibanMasked:
							r.recipient_iban_last4 == null ? null : maskFromLast(String(r.recipient_iban_last4)),
						bic: r.recipient_bic == null ? null : String(r.recipient_bic)
					},
		purpose: r.purpose == null ? null : String(r.purpose),
		clubPaidAt: r.club_paid_at == null ? null : iso(r.club_paid_at),
		clubPaidVia: r.club_paid_via == null ? null : (String(r.club_paid_via) as ClubPaidVia),
		createdAt: iso(r.created_at),
		updatedAt: iso(r.updated_at)
	};
}

export async function loadEntries(tx: Tx, actionId: string): Promise<AccountingEntry[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${ENTRY_COLUMNS}
			FROM accounting_entries e LEFT JOIN accounting_payees p ON p.id = e.payee_id
			WHERE e.action_id = ${actionId}
			ORDER BY e.entry_date DESC, e.created_at DESC`
	);
	return rows.map(mapEntry);
}

export interface RefundSnapshot {
	bookedAt: string;
	entryId: string;
	surplusCents: number;
	perHeadCents: number;
	payingCount: number;
	mode: 'auto' | 'manual';
	totalCents: number;
	remainderCents: number;
	items: { participantId: string | null; name: string; amountCents: number }[];
}

/** Gebuchte Rueckzahlung (Snapshot) oder `null`. */
export async function loadRefundSnapshot(tx: Tx, actionId: string): Promise<RefundSnapshot | null> {
	const [b] = await rowsOf(
		tx,
		sql`SELECT entry_id, surplus_cents, per_head_cents, paying_count, remainder_cents, booked_at, mode
			FROM action_refund_booking WHERE action_id = ${actionId}`
	);
	if (!b) return null;
	const rows = await rowsOf(
		tx,
		sql`SELECT participant_id, name, amount_cents FROM accounting_refunds
			WHERE action_id = ${actionId} ORDER BY position, name, created_at, id`
	);
	const items = rows.map((r) => ({
		participantId: r.participant_id == null ? null : String(r.participant_id),
		name: String(r.name),
		amountCents: Number(r.amount_cents)
	}));
	const mode = String(b.mode) === 'manual' ? 'manual' : 'auto';
	return {
		bookedAt: iso(b.booked_at),
		entryId: String(b.entry_id),
		surplusCents: Number(b.surplus_cents),
		perHeadCents: Number(b.per_head_cents),
		payingCount: Number(b.paying_count),
		mode,
		totalCents:
			mode === 'manual'
				? Number(b.surplus_cents) - Number(b.remainder_cents)
				: items.reduce((a, i) => a + i.amountCents, 0),
		remainderCents: Number(b.remainder_cents),
		items
	};
}

/** Teilnehmerliste fuer die Zuschuss-Klassifikation (nur Spalten, die dafuer noetig sind). */
export async function loadEligibilityParticipants(
	tx: Tx,
	actionId: string
): Promise<EligibilityParticipant[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT id, name, role, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
				bremen_resident, juleica, subsidy_eligible
			FROM action_participants WHERE action_id = ${actionId} ORDER BY created_at, name`
	);
	return rows.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		role: String(r.role) as ParticipantRole,
		birthDate: r.birth_date == null ? null : String(r.birth_date),
		bremenResident: r.bremen_resident == null ? null : Boolean(r.bremen_resident),
		juleica: Boolean(r.juleica),
		subsidyEligible: r.subsidy_eligible == null ? null : Boolean(r.subsidy_eligible)
	}));
}

/**
 * Automatische Einnahmen (Beitraege aus der Teilnehmerliste, Zuschuss laut Kalkulation).
 * `entries` = Typ/Kategorie der manuellen Buchungen (ueberschreiben die Automatik).
 */
export async function loadAutoIncome(
	tx: Tx,
	actionId: string,
	entries: { type: EntryType; category: string }[],
	treasury: ActionContributions | null = null
): Promise<AutoIncome> {
	const [act] = await rowsOf(
		tx,
		sql`SELECT fee_cents, team_fee_cents, to_char(starts_on, 'YYYY-MM-DD') AS starts_on
			FROM actions WHERE id = ${actionId}`
	);
	const participants = await loadEligibilityParticipants(tx, actionId);
	const [calc] = await rowsOf(
		tx,
		sql`SELECT nights, lodging_type, konfi, freizeit_type, include_subsidy
			FROM action_calculations WHERE action_id = ${actionId}`
	);
	return computeAutoIncome({
		feeCents: act?.fee_cents == null ? null : Number(act.fee_cents),
		teamFeeCents: act?.team_fee_cents == null ? null : Number(act.team_fee_cents),
		payingCount: participants.filter((p) => p.role !== 'team').length,
		teamCount: participants.filter((p) => p.role === 'team').length,
		subsidy:
			calc && Boolean(calc.include_subsidy)
				? {
						nights: Number(calc.nights),
						lodgingType: String(calc.lodging_type) as LodgingType,
						konfi: Boolean(calc.konfi),
						freizeitType: String(calc.freizeit_type) as FreizeitType,
						startsOn: String(act?.starts_on ?? ''),
						participants
					}
				: null,
		entries,
		treasury
	});
}

/**
 * Tatsaechlich eingegangene Beitraege aus der Kasse (optional, nur wenn das Modul aktiv ist).
 * AUSSERHALB der Modul-Transaktion aufrufen und an `loadAutoIncome` uebergeben.
 */
export async function loadTreasuryContributions(
	actionId: string
): Promise<ActionContributions | null> {
	const svc = await core.modules.useOptional<TreasuryService>('treasury', 'actions');
	if (!svc) return null;
	try {
		return await svc.contributionsForAction(actionId);
	} catch (e) {
		console.error('[actions] Kasse nicht erreichbar:', e);
		return null;
	}
}
