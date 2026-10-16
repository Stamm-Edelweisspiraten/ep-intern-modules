import { sql } from 'drizzle-orm';
import { core, type Tx } from '$lib/sdk/server';
import type { ActionRef, ActionsService, ReceivableSource } from './contract';

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
					to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, a.fee_cents, a.team_fee_cents
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
				sql`SELECT e.action_id, e.payee_id, p.name, p.iban_last4, p.bic, (p.iban_enc IS NOT NULL) AS has_iban,
					sum(e.amount_cents) AS total_cents,
					coalesce(sum(e.amount_cents) FILTER (WHERE e.reimbursed_at IS NULL), 0) AS open_cents
				FROM accounting_entries e JOIN accounting_payees p ON p.id = e.payee_id
				WHERE e.paid_by = 'person' AND e.type = 'expense'
				GROUP BY e.action_id, e.payee_id, p.name, p.iban_last4, p.bic, p.iban_enc
				ORDER BY e.action_id, p.name`
			);
			return found.map((r) => ({
				actionId: String(r.action_id),
				payeeId: String(r.payee_id),
				name: String(r.name),
				ibanLast: (r.iban_last4 as string | null) ?? null,
				hasIban: Boolean(r.has_iban),
				bic: (r.bic as string | null) ?? null,
				totalCents: Number(r.total_cents),
				openCents: Number(r.open_cents)
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

	async markReimbursed(actionId, payeeId, reimbursed) {
		const changed = await core.database.forModule(MODULE_ID).transaction(async (tx) =>
			rows(
				tx,
				reimbursed
					? sql`UPDATE accounting_entries SET reimbursed_at = now(), updated_at = now()
						WHERE action_id = ${actionId} AND payee_id = ${payeeId} AND paid_by = 'person'
							AND type = 'expense' AND reimbursed_at IS NULL RETURNING amount_cents`
					: sql`UPDATE accounting_entries SET reimbursed_at = NULL, updated_at = now()
						WHERE action_id = ${actionId} AND payee_id = ${payeeId} AND paid_by = 'person'
							AND reimbursed_at IS NOT NULL RETURNING amount_cents`
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
	}
};
