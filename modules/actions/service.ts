import { sql } from 'drizzle-orm';
import { core, type Tx } from '$lib/sdk/server';
import type { ActionRef, ActionsService, InterimRef, ReceivableSource } from './contract';
import { summarize, toSummaryEntry } from './accounting';
import { loadState } from './accounting.endpoints';
import {
	interimTotals,
	loadAutoIncome,
	loadEntries,
	loadInterimSnapshot,
	loadRefundSnapshot,
	loadTreasuryContributions
} from './accounting-core';
import { buildAccountingReport } from './payouts.endpoints';

type Row = Record<string, unknown>;
const MODULE_ID = 'actions';

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	return ((await tx.execute(query)) as unknown as { rows: Row[] }).rows;
}

const idList = (ids: string[]) =>
	sql.join(
		ids.slice(0, 1000).map((v) => sql`${v}`),
		sql`, `
	);

/**
 * Auslage zur Auszahlung freigegeben (Alias `e`): Abrechnung abgeschlossen oder Buchung in
 * mindestens einer Zwischenabrechnung enthalten.
 */
const RELEASED = sql`(EXISTS (SELECT 1 FROM action_accounting c
		WHERE c.action_id = e.action_id AND c.closed_at IS NOT NULL)
	OR EXISTS (SELECT 1 FROM accounting_interim_entries x WHERE x.entry_id = e.id))`;

/**
 * Seit Migration 0016 gibt es je (Aktion, Person) nur noch eine Auszahlung. `null` (Kasse) = alle
 * freigegebenen Auslagen; fehlt = alle Auslagen der Person (Altverhalten); ein konkreter
 * (Alt-)Schlüssel einer Zwischenabrechnung trifft nichts.
 */
const isLegacyInterimKey = (interimId: string | null | undefined): boolean =>
	interimId !== undefined && interimId !== null;
const releasedFilter = (interimId: string | null | undefined) =>
	interimId === null ? sql`AND ${RELEASED}` : sql``;

const ref = (r: Row): ActionRef => ({
	id: r.id as string,
	name: r.name as string,
	startsOn: r.starts_on as string,
	endsOn: (r.ends_on as string | null) ?? null
});

export const actionsService: ActionsService = {
	async listReceivableSources(query = {}) {
		if (query.actionIds && !query.actionIds.length) return [];
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const filter = query.actionIds ? sql`AND a.id IN (${idList(query.actionIds)})` : sql``;
			const actions = await rows(
				tx,
				sql`SELECT a.id, a.name, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, a.fee_cents, a.team_fee_cents, a.is_past
				FROM actions a WHERE a.fee_applied_at IS NOT NULL AND a.fee_cents IS NOT NULL ${filter}
				ORDER BY a.starts_on, a.id`
			);
			if (!actions.length) return [];
			const people = await rows(
				tx,
				sql`SELECT p.id, p.action_id, p.name, p.role, to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
					p.member_id, p.contact_email, p.group_label
				FROM action_participants p
				WHERE p.action_id IN (${idList(actions.map((a) => a.id as string))})
				ORDER BY p.created_at, p.id`
			);
			return actions.map((a): ReceivableSource => ({
				...ref(a),
				isPast: a.is_past === true || a.is_past === 't',
				feeCents: Number(a.fee_cents),
				teamFeeCents: a.team_fee_cents == null ? null : Number(a.team_fee_cents),
				participants: people
					.filter((p) => p.action_id === a.id)
					.map((p) => ({
						id: p.id as string,
						name: p.name as string,
						role: p.role === 'team' ? 'team' : 'participant',
						birthDate: (p.birth_date as string | null) ?? null,
						memberId: (p.member_id as string | null) ?? null,
						contactEmail: (p.contact_email as string | null) ?? null,
						groupLabel: (p.group_label as string | null) ?? null
					}))
			}));
		});
	},

	async listActionRefs(query = {}) {
		if (query.ids && !query.ids.length) return [];
		const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 200)), 200);
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const search = query.search?.trim();
			const where = query.ids
				? sql`id IN (${idList(query.ids)})`
				: search
					? sql`name ILIKE ${`%${search.replace(/[\\%_]/g, '\\$&')}%`}`
					: sql`TRUE`;
			const found = await rows(
				tx,
				sql`SELECT id, name, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(ends_on, 'YYYY-MM-DD') AS ends_on
				FROM actions WHERE ${where} ORDER BY starts_on DESC, id LIMIT ${limit}`
			);
			return found.map(ref);
		});
	},

	async listReimbursements() {
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const found = await rows(
				tx,
				// Freigegeben: Auslage in einer Zwischenabrechnung oder Abrechnung abgeschlossen
				sql`SELECT e.action_id, e.payee_id, p.name, p.iban_last4, p.bic,
					(p.iban_enc IS NOT NULL) AS has_iban,
					sum(e.amount_cents) AS total_cents,
					coalesce(sum(e.amount_cents) FILTER (WHERE e.reimbursed_at IS NULL), 0) AS open_cents
				FROM accounting_entries e JOIN accounting_payees p ON p.id = e.payee_id
				WHERE e.paid_by = 'person' AND e.type = 'expense' AND ${RELEASED}
				GROUP BY e.action_id, e.payee_id, p.name, p.iban_last4, p.bic, p.iban_enc
				ORDER BY e.action_id, p.name, e.payee_id`
			);
			return found.map((r) => ({
				actionId: String(r.action_id),
				payeeId: String(r.payee_id),
				name: String(r.name),
				ibanLast: (r.iban_last4 as string | null) ?? null,
				hasIban: Boolean(r.has_iban),
				bic: (r.bic as string | null) ?? null,
				totalCents: Number(r.total_cents),
				openCents: Number(r.open_cents),
				interimId: null,
				interimNumber: null
			}));
		});
	},

	async getPayeeIban(actionId, payeeId) {
		const enc = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const [r] = await rows(
				tx,
				sql`SELECT iban_enc FROM accounting_payees WHERE id = ${payeeId} AND action_id = ${actionId}`
			);
			return (r?.iban_enc as string | null) ?? null;
		});
		return enc ? core.crypto.forModule(MODULE_ID).decrypt(enc) : null;
	},

	async markReimbursed(actionId, payeeId, reimbursed, interimId) {
		if (isLegacyInterimKey(interimId)) return 0;
		const changed = await core.database.forModule(MODULE_ID).transaction(async (tx) =>
			rows(
				tx,
				reimbursed
					? sql`UPDATE accounting_entries e SET reimbursed_at = now(), updated_at = now()
						WHERE e.action_id = ${actionId} AND e.payee_id = ${payeeId} AND e.paid_by = 'person'
							AND e.type = 'expense' AND e.reimbursed_at IS NULL ${releasedFilter(interimId)}
						RETURNING e.amount_cents`
					: sql`UPDATE accounting_entries e SET reimbursed_at = NULL, updated_at = now()
						WHERE e.action_id = ${actionId} AND e.payee_id = ${payeeId} AND e.paid_by = 'person'
							AND e.reimbursed_at IS NOT NULL AND e.reimbursed_upfront = false
						RETURNING e.amount_cents`
			)
		);
		if (changed.length) {
			await core.audit.logFromContext(
				core.auth.systemContext('treasury'),
				reimbursed ? 'actions.accounting.reimbursed' : 'actions.accounting.reimbursement_reverted',
				{
					target: actionId,
					metadata: {
						actionId,
						payeeId,
						count: changed.length,
						amountCents: changed.reduce((s, r) => s + Number(r.amount_cents), 0),
						via: 'treasury'
					}
				}
			);
		}
		return changed.length;
	},

	async listRefundItems() {
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const found = await rows(
				tx,
				sql`SELECT r.id, r.action_id, r.participant_id, r.name, r.amount_cents, p.member_id,
					to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date
				FROM accounting_refunds r LEFT JOIN action_participants p ON p.id = r.participant_id
				ORDER BY r.action_id, r.position, r.id`
			);
			return found.map((r) => ({
				id: String(r.id),
				actionId: String(r.action_id),
				participantId: (r.participant_id as string | null) ?? null,
				name: String(r.name),
				amountCents: Number(r.amount_cents),
				memberId: (r.member_id as string | null) ?? null,
				birthDate: (r.birth_date as string | null) ?? null
			}));
		});
	},

	async listReimbursementReceipts(actionId, payeeId, interimId) {
		if (isLegacyInterimKey(interimId)) return [];
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const found = await rows(
				tx,
				sql`SELECT e.id, e.description, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
					e.amount_cents, e.receipt_name, e.receipt_content_type
				FROM accounting_entries e
				WHERE e.action_id = ${actionId} AND e.payee_id = ${payeeId} AND e.receipt_path IS NOT NULL
					AND e.paid_by = 'person' AND e.type = 'expense' ${releasedFilter(interimId)}
				ORDER BY e.entry_date, e.created_at, e.id`
			);
			return found.map((r) => ({
				entryId: String(r.id),
				description: String(r.description),
				entryDate: String(r.entry_date),
				amountCents: Number(r.amount_cents),
				name: String(r.receipt_name ?? 'beleg'),
				contentType: String(r.receipt_content_type ?? 'application/octet-stream')
			}));
		});
	},

	async downloadReceipt(actionId, entryId) {
		const ref = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const [r] = await rows(
				tx,
				sql`SELECT receipt_path, receipt_name FROM accounting_entries WHERE id = ${entryId} AND action_id = ${actionId}`
			);
			return r?.receipt_path
				? { path: String(r.receipt_path), name: String(r.receipt_name ?? 'beleg') }
				: null;
		});
		if (!ref) return null;
		const { buffer, file } = await core.storage.download(core.auth.systemContext('treasury'), {
			module: MODULE_ID,
			path: ref.path
		});
		return { data: new Uint8Array(buffer), name: ref.name, contentType: file.contentType };
	},

	async listClosedAccountings() {
		const closed = await core.database.forModule(MODULE_ID).transaction((tx) =>
			rows(
				tx,
				sql`SELECT a.id, a.name, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, c.closed_at
				FROM action_accounting c JOIN actions a ON a.id = c.action_id
				WHERE c.closed_at IS NOT NULL ORDER BY c.closed_at DESC`
			)
		);
		const out = [];
		for (const r of closed) {
			const id = String(r.id);
			const treasury = await loadTreasuryContributions(id);
			const summary = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
				const entries = await loadEntries(tx, id);
				const se = entries.map(toSummaryEntry);
				return summarize(se, null, await loadAutoIncome(tx, id, entries, treasury));
			});
			out.push({
				actionId: id,
				name: String(r.name),
				startsOn: String(r.starts_on),
				endsOn: (r.ends_on as string | null) ?? null,
				closedAt: new Date(String(r.closed_at)).toISOString(),
				incomeCents: summary.incomeCents,
				expenseCents: summary.expenseCents,
				balanceCents: summary.balanceCents
			});
		}
		return out;
	},

	async getClosedAccounting(actionId) {
		const treasury = await loadTreasuryContributions(actionId);
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const [a] = await rows(
				tx,
				sql`SELECT a.id, a.name, a.location, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, c.closed_at
				FROM actions a JOIN action_accounting c ON c.action_id = a.id
				WHERE a.id = ${actionId} AND c.closed_at IS NOT NULL`
			);
			if (!a) return null;
			const { state } = await loadState(tx, actionId, treasury, true);
			const refund = await loadRefundSnapshot(tx, actionId);
			return {
				actionId,
				name: String(a.name),
				location: (a.location as string | null) ?? null,
				startsOn: String(a.starts_on),
				endsOn: (a.ends_on as string | null) ?? null,
				closedAt: new Date(String(a.closed_at)).toISOString(),
				incomeCents: state.summary.incomeCents,
				expenseCents: state.summary.expenseCents,
				balanceCents: state.summary.balanceCents,
				summary: state.summary,
				plan: state.plan,
				autoIncome: state.autoIncome,
				entries: state.entries,
				payees: state.payees ?? [],
				refund: refund
					? {
							totalCents: refund.totalCents,
							count: refund.items.length,
							remainderCents: refund.remainderCents,
							bookedAt: refund.bookedAt
						}
					: null
			};
		});
	},

	async listClubExpenses() {
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const found = await rows(
				tx,
				sql`SELECT id, action_id, description, recipient_name, recipient_iban_last4, recipient_bic,
					(recipient_iban_enc IS NOT NULL) AS has_iban, purpose, amount_cents,
					to_char(entry_date, 'YYYY-MM-DD') AS entry_date, club_paid_at, club_paid_via,
					(receipt_path IS NOT NULL) AS has_receipt, receipt_name, receipt_content_type
				FROM accounting_entries
				WHERE type = 'expense' AND paid_by = 'club' AND category <> 'refund'
				ORDER BY action_id, entry_date, created_at, id`
			);
			return found.map((r) => ({
				actionId: String(r.action_id),
				entryId: String(r.id),
				description: String(r.description),
				recipientName: (r.recipient_name as string | null) ?? null,
				ibanLast: (r.recipient_iban_last4 as string | null) ?? null,
				hasIban: Boolean(r.has_iban),
				bic: (r.recipient_bic as string | null) ?? null,
				purpose: (r.purpose as string | null) ?? null,
				amountCents: Number(r.amount_cents),
				entryDate: String(r.entry_date),
				paidAt: r.club_paid_at == null ? null : new Date(String(r.club_paid_at)).toISOString(),
				paidVia: (r.club_paid_via as 'manual' | 'treasury' | null) ?? null,
				receipt: r.has_receipt
					? {
							name: String(r.receipt_name ?? 'beleg'),
							contentType: String(r.receipt_content_type ?? 'application/octet-stream')
						}
					: null
			}));
		});
	},

	async getClubExpenseIban(actionId, entryId) {
		const enc = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const [r] = await rows(
				tx,
				sql`SELECT recipient_iban_enc FROM accounting_entries
				WHERE id = ${entryId} AND action_id = ${actionId} AND paid_by = 'club'`
			);
			return (r?.recipient_iban_enc as string | null) ?? null;
		});
		return enc ? core.crypto.forModule(MODULE_ID).decrypt(enc) : null;
	},

	async markClubExpensePaid(actionId, entryId, paid) {
		const changed = await core.database.forModule(MODULE_ID).transaction(async (tx) =>
			rows(
				tx,
				paid
					? sql`UPDATE accounting_entries SET club_paid_at = now(), club_paid_via = 'treasury',
							updated_at = now()
						WHERE id = ${entryId} AND action_id = ${actionId} AND type = 'expense'
							AND paid_by = 'club' AND club_paid_at IS NULL RETURNING amount_cents`
					: sql`UPDATE accounting_entries SET club_paid_at = NULL, club_paid_via = NULL, updated_at = now()
						WHERE id = ${entryId} AND action_id = ${actionId} AND club_paid_via = 'treasury'
						RETURNING amount_cents`
			)
		);
		if (changed.length) {
			await core.audit.logFromContext(
				core.auth.systemContext('treasury'),
				paid ? 'actions.accounting.club_paid' : 'actions.accounting.club_paid_reverted',
				{
					target: actionId,
					metadata: {
						actionId,
						entryId,
						amountCents: Number(changed[0]!.amount_cents),
						via: 'treasury'
					}
				}
			);
		}
		return changed.length > 0;
	},

	async accountingReportPdf(actionId, withBank, auditCtx) {
		const pdf = await buildAccountingReport(core.auth.systemContext('treasury'), actionId, {
			withBank,
			canAttach: true,
			checkAccess: false,
			auditCtx
		});
		return { data: pdf.buffer, fileName: pdf.fileName };
	},

	async listInterims(query = {}) {
		if (query.actionIds && !query.actionIds.length) return [];
		return core.database.forModule(MODULE_ID).transaction(async (tx) => {
			const filter = query.actionIds ? sql`WHERE action_id IN (${idList(query.actionIds)})` : sql``;
			const found = await rows(
				tx,
				sql`SELECT id, action_id FROM accounting_interims ${filter} ORDER BY action_id, number`
			);
			const out: InterimRef[] = [];
			for (const r of found) {
				const { interim, snapshot } = await loadInterimSnapshot(
					tx,
					String(r.action_id),
					String(r.id)
				);
				const totals = interimTotals(snapshot);
				out.push({
					id: interim.id,
					actionId: String(r.action_id),
					number: interim.number,
					createdAt: interim.createdAt,
					incomeCents: totals.incomeCents,
					expenseCents: totals.expenseCents,
					reimbursementCents: totals.reimbursementCents
				});
			}
			return out;
		});
	},

	async interimReportPdf(actionId, interimId, withBank, auditCtx) {
		const pdf = await buildAccountingReport(core.auth.systemContext('treasury'), actionId, {
			withBank,
			canAttach: true,
			checkAccess: false,
			auditCtx,
			interimId
		});
		return { data: pdf.buffer, fileName: pdf.fileName };
	}
};
