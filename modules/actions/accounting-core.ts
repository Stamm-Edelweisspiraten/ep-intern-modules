/** Gemeinsame Datenbank-Hilfen der Abrechnung (Buchungen, Abschlussstatus). */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import type {
	AccountingClosedEvent,
	ActionContributions,
	TreasuryService
} from '$lib/modules/treasury/contract';
import { rowsOf } from './access';
import { payeeTotals, summarize, toSummaryEntry } from './accounting';
import { computeAutoIncome } from './auto-income';
import { calculate } from './calculation';
import { maskFromLast } from './iban';
import { computeSubsidy } from './subsidy';
import type { EligibilityParticipant } from './subsidy-eligibility';
import type {
	AccountingCategory,
	AccountingEntry,
	AccountingInterim,
	AccountingPlan,
	AccountingSummary,
	AutoIncome,
	CalcBasis,
	CalcCategory,
	CalcItem,
	ClubPaidVia,
	EntryType,
	FreizeitType,
	InterimSnapshot,
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

/** Soll-Werte aus der gespeicherten Kalkulation; `null`, wenn keine gespeichert ist. */
export async function loadPlan(tx: Tx, actionId: string): Promise<AccountingPlan | null> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT * FROM action_calculations WHERE action_id = ${actionId}`
	);
	if (!row) return null;
	const itemRows = await rowsOf(
		tx,
		sql`SELECT id, category, label, amount_cents, basis FROM calc_items
			WHERE action_id = ${actionId} ORDER BY position`
	);
	const items: CalcItem[] = itemRows.map((r) => ({
		id: String(r.id),
		category: String(r.category) as CalcCategory,
		label: String(r.label),
		amountCents: Number(r.amount_cents),
		basis: String(r.basis) as CalcBasis
	}));
	const includeSubsidy = Boolean(row.include_subsidy);
	const subsidy = includeSubsidy
		? computeSubsidy({
				nights: Number(row.nights),
				lodgingType: String(row.lodging_type) as LodgingType,
				konfi: Boolean(row.konfi),
				freizeitType: String(row.freizeit_type) as FreizeitType,
				children: Number(row.bremen_children),
				youth: Number(row.bremen_youth),
				teamWithJuleica: Number(row.team_with_juleica),
				teamWithoutJuleica: Number(row.team_without_juleica),
				teamYouth: Number(row.team_youth)
			})
		: null;
	const participants = Number(row.participants);
	const team = Number(row.team);
	const result = calculate({
		participants,
		team,
		teamPercent: Number(row.team_percent),
		nights: Number(row.nights),
		items,
		bufferPercent: Number(row.buffer_percent),
		subsidyCents: subsidy?.subsidyCents ?? 0
	});
	const [fee] = await rowsOf(
		tx,
		sql`SELECT fee_cents, team_fee_cents FROM actions WHERE id = ${actionId}`
	);
	const hasFee = !!fee && fee.fee_cents != null;
	const perPerson = hasFee ? Number(fee!.fee_cents) : result.recommendedPerPersonCents;
	const perTeam = hasFee ? Number(fee!.team_fee_cents ?? 0) : result.recommendedTeamPerPersonCents;
	const expenseByCategory: Partial<Record<CalcCategory, number>> = {};
	for (const line of result.lines) {
		expenseByCategory[line.category] = (expenseByCategory[line.category] ?? 0) + line.totalCents;
	}
	if (expenseByCategory.program != null || result.programTotalCents > 0) {
		expenseByCategory.program = result.programTotalCents;
	}
	return {
		contributionsCents: perPerson * participants + perTeam * team,
		subsidyCents: includeSubsidy ? (subsidy?.subsidyCents ?? 0) : 0,
		expenseByCategory,
		totalExpenseCents: result.totalCents
	};
}

/**
 * Abbild einer Zwischenabrechnung aus einem Abrechnungsstand. `payees` = Personen der Aktion
 * (nur `id`/`name` werden gelesen); übernommen werden nur Personen mit Auslagen. Keine Bankdaten.
 */
export function buildInterimSnapshot(input: {
	takenAt: string;
	entries: AccountingEntry[];
	summary: AccountingSummary;
	plan: AccountingPlan | null;
	autoIncome: AutoIncome;
	payees: { id: string; name: string }[];
}): InterimSnapshot {
	const totals = payeeTotals(input.entries.map(toSummaryEntry));
	return {
		takenAt: input.takenAt,
		entries: input.entries,
		summary: input.summary,
		plan: input.plan,
		autoIncome: input.autoIncome,
		payees: input.payees
			.filter((p) => totals.has(p.id))
			.map((p) => ({
				id: p.id,
				name: p.name,
				openCents: totals.get(p.id)!.openCents,
				reimbursedCents: totals.get(p.id)!.reimbursedCents
			})),
		receiptEntryIds: input.entries.filter((e) => e.receipt !== null).map((e) => e.id)
	};
}

/**
 * Altdaten (Spalte `snapshot` leer): Abbild live aus den enthaltenen Buchungen
 * (`accounting_interim_entries`) bauen; automatische Einnahmen ohne Kasse.
 */
async function legacySnapshot(
	tx: Tx,
	actionId: string,
	interimId: string,
	takenAt: string
): Promise<InterimSnapshot> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${ENTRY_COLUMNS}
			FROM accounting_entries e
			JOIN accounting_interim_entries x ON x.entry_id = e.id AND x.interim_id = ${interimId}
			LEFT JOIN accounting_payees p ON p.id = e.payee_id
			WHERE e.action_id = ${actionId}
			ORDER BY e.entry_date DESC, e.created_at DESC`
	);
	const entries = rows.map(mapEntry);
	const se = entries.map(toSummaryEntry);
	const plan = await loadPlan(tx, actionId);
	const autoIncome = await loadAutoIncome(tx, actionId, se, null);
	const payees = await rowsOf(
		tx,
		sql`SELECT id, name FROM accounting_payees WHERE action_id = ${actionId} ORDER BY name, created_at`
	);
	return buildInterimSnapshot({
		takenAt,
		entries,
		summary: summarize(se, plan, autoIncome),
		plan,
		autoIncome,
		payees: payees.map((p) => ({ id: String(p.id), name: String(p.name) }))
	});
}

function parseSnapshot(v: unknown): InterimSnapshot | null {
	if (v == null) return null;
	return (typeof v === 'string' ? JSON.parse(v) : v) as InterimSnapshot;
}

/** Abbild aus der Zeile oder (Altdaten) live gebaut. */
async function snapshotOf(
	tx: Tx,
	actionId: string,
	r: Record<string, unknown>
): Promise<InterimSnapshot> {
	return parseSnapshot(r.snapshot) ?? legacySnapshot(tx, actionId, String(r.id), iso(r.created_at));
}

/** Summen einer Zwischenabrechnung aus ihrem Abbild. */
export function interimTotals(s: InterimSnapshot): {
	entryCount: number;
	incomeCents: number;
	expenseCents: number;
	reimbursementCents: number;
} {
	return {
		entryCount: s.entries.length,
		incomeCents: s.summary.incomeCents,
		expenseCents: s.summary.expenseCents,
		reimbursementCents: s.entries
			.filter((e) => e.type === 'expense' && e.paidBy === 'person')
			.reduce((a, e) => a + e.amountCents, 0)
	};
}

/**
 * Eingefrorenes Abbild einer Zwischenabrechnung (404, wenn sie nicht zur Aktion gehört).
 * `createdBy` ist die Benutzer-ID (Namen löst der Aufrufer nach der Transaktion auf).
 */
export async function loadInterimSnapshot(
	tx: Tx,
	actionId: string,
	interimId: string
): Promise<{
	interim: {
		id: string;
		number: number;
		note: string | null;
		createdAt: string;
		createdBy: string | null;
	};
	snapshot: InterimSnapshot;
}> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT id, number, note, created_by, created_at, snapshot FROM accounting_interims
			WHERE id = ${interimId} AND action_id = ${actionId}`
	);
	if (!r) throw errors.notFound('Zwischenabrechnung nicht gefunden');
	return {
		interim: {
			id: String(r.id),
			number: Number(r.number),
			note: r.note == null ? null : String(r.note),
			createdAt: iso(r.created_at),
			createdBy: r.created_by == null ? null : String(r.created_by)
		},
		snapshot: await snapshotOf(tx, actionId, r)
	};
}

/** Erstattete Auslage einer ZA, die durch deren Rücknahme nicht mehr freigegeben wäre (Alias `e`, `i`). */
const PAID_EXCLUSIVE = sql`e.type = 'expense' AND e.paid_by = 'person' AND e.reimbursed_at IS NOT NULL
	AND e.reimbursed_upfront = false
	AND NOT EXISTS (SELECT 1 FROM accounting_interim_entries y
		WHERE y.entry_id = e.id AND y.interim_id <> i.id)`;

/**
 * Zwischenabrechnungen einer Aktion (aufsteigend). Summen aus dem Abbild, offene Auslagen live.
 * `createdBy.name` ist ein Platzhalter ('Unbekannt'); Namen löst der Aufrufer NACH der Transaktion
 * auf (`resolveInterimUsers`). `canManage` = Eigentümer*in oder `actions.action.edit-all`.
 * Warnung `paid`: erstattete Auslagen nur in dieser ZA und Abrechnung nicht abgeschlossen.
 */
export async function loadInterims(
	tx: Tx,
	actionId: string,
	canManage = false
): Promise<AccountingInterim[]> {
	const closed = await closedInfo(tx, actionId);
	const rows = await rowsOf(
		tx,
		sql`SELECT i.id, i.number, i.note, i.created_by, i.created_at, i.snapshot, s.*
			FROM accounting_interims i
			CROSS JOIN LATERAL (
				SELECT
					coalesce(sum(e.amount_cents) FILTER (WHERE e.type = 'expense' AND e.paid_by = 'person'
						AND e.reimbursed_at IS NULL), 0) AS open_reimbursement_cents,
					count(e.id) FILTER (WHERE ${PAID_EXCLUSIVE}) AS paid_count,
					coalesce(sum(e.amount_cents) FILTER (WHERE ${PAID_EXCLUSIVE}), 0)
						AS paid_reimbursement_cents
				FROM accounting_interim_entries x JOIN accounting_entries e ON e.id = x.entry_id
				WHERE x.interim_id = i.id
			) s
			WHERE i.action_id = ${actionId}
			ORDER BY i.number`
	);
	const out: AccountingInterim[] = [];
	for (const r of rows) {
		const paid = !closed && Number(r.paid_count) > 0;
		out.push({
			id: String(r.id),
			number: Number(r.number),
			note: r.note == null ? null : String(r.note),
			createdAt: iso(r.created_at),
			createdBy:
				r.created_by == null
					? null
					: { userId: String(r.created_by), name: 'Unbekannt', email: null },
			...interimTotals(await snapshotOf(tx, actionId, r)),
			openReimbursementCents: Number(r.open_reimbursement_cents),
			canRevert: canManage,
			revertWarnings: paid ? ['paid'] : [],
			paidReimbursementCents: Number(r.paid_reimbursement_cents)
		});
	}
	return out;
}

/** Namen der Ersteller*innen auflösen (Core-Dienst, AUSSERHALB der Modul-Transaktion aufrufen). */
export async function resolveInterimUsers(
	ctx: RequestContext,
	interims: AccountingInterim[]
): Promise<void> {
	const ids = [
		...new Set(interims.map((i) => i.createdBy?.userId).filter((v): v is string => !!v))
	];
	if (!ids.length) return;
	const found = await core.users.directory(ctx, { ids: ids.slice(0, 30), limit: 30 });
	for (const i of interims) {
		const u = i.createdBy && found.find((x) => x.id === i.createdBy!.userId);
		if (u) i.createdBy = { userId: u.id, name: u.name, email: u.email };
	}
}

/** SELECT-Spalten für Buchungen (Alias `e`, Empfänger `p` per LEFT JOIN). */
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

/** Gebuchte Rückzahlung (Snapshot) oder `null`. */
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

/** Teilnehmerliste für die Zuschuss-Klassifikation (nur Spalten, die dafür nötig sind). */
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
 * Automatische Einnahmen (Beiträge aus der Teilnehmerliste, Zuschuss laut Kalkulation).
 * `entries` = Typ/Kategorie der manuellen Buchungen (überschreiben die Automatik).
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
 * Tatsächlich eingegangene Beiträge aus der Kasse (optional, nur wenn das Modul aktiv ist).
 * AUSSERHALB der Modul-Transaktion aufrufen und an `loadAutoIncome` übergeben.
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

/**
 * Meldet der Kasse (optional) einen Abrechnungsabschluss bzw. eine neue Zwischenabrechnung, damit
 * das Amt „Kasse“ benachrichtigt wird. NACH der Transaktion aufrufen; wirft nie.
 */
export async function notifyTreasuryAccountingClosed(
	ctx: RequestContext,
	info: AccountingClosedEvent
): Promise<void> {
	try {
		const svc = await core.modules.useOptional<TreasuryService>('treasury', 'actions');
		await svc?.accountingClosed(ctx, info);
	} catch (e) {
		console.error('[actions] Benachrichtigung der Kasse fehlgeschlagen:', e);
	}
}
