import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { requireAccess, rowsOf } from './access';
import { appliedAutoIncome } from './auto-income';
import { assertOpen, closedInfo, loadAutoIncome, loadRefundSnapshot } from './accounting-core';
import {
	MIN_REFUND_PER_HEAD_CENTS,
	computeManualRefund,
	computeRefund,
	refundThresholdOk,
	type RefundPayer
} from './refund';
import { MODULE_ID, idParams, refundBodySchema, refundQuerySchema } from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

interface RefundItemDto {
	participantId: string | null;
	name: string;
	amountCents: number;
}

interface RefundState {
	mode: 'auto' | 'manual';
	/** Verwendete Personenzahl */
	count: number;
	/** Anzahl zahlender Teilnehmender laut Teilnehmerliste */
	autoCount: number;
	minPerHeadCents: number;
	thresholdOk: boolean;
	surplusCents: number;
	payingCount: number;
	perHeadCents: number;
	items: RefundItemDto[];
	totalCents: number;
	remainderCents: number;
	booked: null | {
		bookedAt: string;
		entryId: string;
		surplusCents: number;
		totalCents: number;
		remainderCents: number;
		items: RefundItemDto[];
	};
	canBook: boolean;
	blockers: string[];
	feeCents: number | null;
	teamFeeCents: number | null;
}

const euros = (cents: number): string => `${Math.floor(cents / 100)}`;

/** Berechnung fuer GET/POST; `canEdit` fliesst nur in `canBook` ein. */
async function loadRefund(
	tx: Tx,
	actionId: string,
	canEdit: boolean,
	manual?: { count: number; names?: string[] }
): Promise<RefundState> {
	const closed = await closedInfo(tx, actionId);
	const [act] = await rowsOf(
		tx,
		sql`SELECT fee_cents, team_fee_cents FROM actions WHERE id = ${actionId}`
	);
	const feeCents = act?.fee_cents == null ? null : Number(act.fee_cents);
	const teamFeeCents = act?.team_fee_cents == null ? null : Number(act.team_fee_cents);
	const [sums] = await rowsOf(
		tx,
		sql`SELECT
				COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income'), 0) AS income,
				COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense' AND category <> 'refund'), 0) AS expense
			FROM accounting_entries WHERE action_id = ${actionId}`
	);
	const manualEntries = await rowsOf(
		tx,
		sql`SELECT DISTINCT type, category FROM accounting_entries WHERE action_id = ${actionId}`
	);
	const auto = appliedAutoIncome(
		await loadAutoIncome(
			tx,
			actionId,
			manualEntries.map((r) => ({
				type: String(r.type) as 'income' | 'expense',
				category: String(r.category)
			}))
		)
	);
	const surplusCents =
		Number(sums?.income ?? 0) +
		auto.contributionsCents +
		auto.subsidyCents -
		Number(sums?.expense ?? 0);

	const people = await rowsOf(
		tx,
		sql`SELECT id, name, role FROM action_participants WHERE action_id = ${actionId}
			ORDER BY name, id`
	);
	const payers: RefundPayer[] = [];
	for (const p of people) {
		const fee = String(p.role) === 'team' ? teamFeeCents : feeCents;
		if (fee != null && fee > 0) {
			payers.push({ id: String(p.id), name: String(p.name), feeCents: fee });
		}
	}
	const snapshot = await loadRefundSnapshot(tx, actionId);
	const autoCalc = computeRefund({ surplusCents, payers });
	const manualCalc =
		!snapshot && manual != null ? computeManualRefund({ surplusCents, count: manual.count }) : null;
	const manualNames = manual?.names;
	const minItem = autoCalc.items.reduce((m, i) => Math.min(m, i.amountCents), Infinity);
	const calc = manualCalc
		? {
				items: (manualNames && manualCalc.perHeadCents > 0
					? manualNames.map((name) => ({
							participantId: crypto.randomUUID(),
							name,
							amountCents: manualCalc.perHeadCents
						}))
					: []) as RefundItemDto[],
				totalCents: manualCalc.totalCents,
				remainderCents: manualCalc.remainderCents,
				perHeadCents: manualCalc.perHeadCents,
				payingCount: manualCalc.perHeadCents > 0 ? manualCalc.count : 0
			}
		: autoCalc;
	// Schwelle: Betrag je Person (manuell) bzw. kleinster Einzelbetrag (Standard)
	const checkCents = manualCalc ? manualCalc.perHeadCents : Number.isFinite(minItem) ? minItem : 0;
	const thresholdOk = refundThresholdOk(checkCents);
	const mode: 'auto' | 'manual' = snapshot ? snapshot.mode : manualCalc ? 'manual' : 'auto';

	const blockers: string[] = [];
	if (snapshot) blockers.push('Die Rückzahlung ist bereits gebucht.');
	if (closed) blockers.push('Die Abrechnung ist abgeschlossen.');
	if (!snapshot) {
		if (surplusCents <= 0) blockers.push('Es gibt keinen Überschuss.');
		if (feeCents == null) blockers.push('Der Beitrag der Aktion ist nicht festgelegt.');
		if (mode === 'auto' && payers.length === 0) {
			blockers.push('Es gibt keine zahlenden Teilnehmenden.');
		} else if (surplusCents > 0 && !thresholdOk) {
			blockers.push('Pro Person bleiben höchstens 5 € – eine Rückzahlung lohnt sich nicht.');
		}
	}

	return {
		mode,
		count: snapshot ? snapshot.payingCount : manualCalc ? manualCalc.count : autoCalc.payingCount,
		autoCount: payers.length,
		minPerHeadCents: MIN_REFUND_PER_HEAD_CENTS,
		thresholdOk: snapshot ? snapshot.perHeadCents > MIN_REFUND_PER_HEAD_CENTS : thresholdOk,
		surplusCents,
		payingCount: snapshot ? snapshot.payingCount : calc.payingCount,
		perHeadCents: snapshot ? snapshot.perHeadCents : calc.perHeadCents,
		items: snapshot ? snapshot.items : calc.items,
		totalCents: snapshot ? snapshot.totalCents : calc.totalCents,
		remainderCents: snapshot ? snapshot.remainderCents : calc.remainderCents,
		booked: snapshot
			? {
					bookedAt: snapshot.bookedAt,
					entryId: snapshot.entryId,
					surplusCents: snapshot.surplusCents,
					totalCents: snapshot.totalCents,
					remainderCents: snapshot.remainderCents,
					items: snapshot.items
				}
			: null,
		canBook: canEdit && blockers.length === 0,
		blockers,
		feeCents,
		teamFeeCents
	};
}

async function lockAction(tx: Tx, actionId: string): Promise<void> {
	await tx.execute(sql`SELECT id FROM actions WHERE id = ${actionId} FOR UPDATE`);
}

export const refundEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/accounting/refund',
		summary: 'Rueckzahlung des Ueberschusses an Teilnehmende berechnen / Stand lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		query: refundQuerySchema,
		handler: async ({ ctx, params, query }) => {
			const id = (params as { id: string }).id;
			const count = (query as { count?: number } | undefined)?.count;
			return mdb().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'read');
				return loadRefund(tx, id, access.level === 'edit', count == null ? undefined : { count });
			});
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/refund',
		summary: 'Rueckzahlung an Teilnehmende buchen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: refundBodySchema,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const names = (body as { names?: string[] } | undefined)?.names;
			const by = ctx.userId ?? null;
			const state = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await lockAction(tx, id);
				await assertOpen(tx, id);
				const cur = await loadRefund(
					tx,
					id,
					true,
					names ? { count: names.length, names } : undefined
				);
				if (cur.booked) throw errors.conflict('Die Rueckzahlung ist bereits gebucht.');
				if (cur.surplusCents <= 0) throw errors.conflict('Es gibt keinen Ueberschuss.');
				if (cur.feeCents == null) {
					throw errors.conflict('Der Beitrag der Aktion ist nicht festgelegt.');
				}
				if (cur.mode === 'auto' && cur.items.length === 0) {
					throw errors.conflict('Es gibt keine zahlenden Teilnehmenden mit Rueckzahlung.');
				}
				if (!cur.thresholdOk) {
					throw errors.conflict(
						'Pro Person bleiben hoechstens 5 EUR - eine Rueckzahlung lohnt sich nicht.'
					);
				}
				const same = new Set(cur.items.map((i) => i.amountCents)).size === 1;
				const head =
					cur.mode === 'manual'
						? `${cur.count} × ${euros(cur.perHeadCents)} €`
						: `${cur.items.length} × ${same ? '' : 'bis zu '}${euros(cur.perHeadCents)} €`;
				const description = `Rückzahlung an Teilnehmende (${head})`;
				const entryId = crypto.randomUUID();
				const today = new Date().toISOString().slice(0, 10);
				await tx.execute(
					sql`INSERT INTO accounting_entries (id, action_id, type, category, description,
							amount_cents, entry_date, paid_by, payee_id, created_by)
						VALUES (${entryId}, ${id}, 'expense', 'refund', ${description}, ${cur.totalCents},
							${today}, 'club', NULL, ${by})`
				);
				for (const [position, item] of cur.items.entries()) {
					await tx.execute(
						sql`INSERT INTO accounting_refunds
								(id, action_id, entry_id, participant_id, name, amount_cents, position)
							VALUES (${crypto.randomUUID()}, ${id}, ${entryId}, ${item.participantId},
								${item.name}, ${item.amountCents}, ${position})`
					);
				}
				await tx.execute(
					sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents,
							paying_count, remainder_cents, booked_at, booked_by, mode)
						VALUES (${id}, ${entryId}, ${cur.surplusCents}, ${cur.perHeadCents},
							${cur.mode === 'manual' ? cur.count : cur.items.length},
							${cur.remainderCents}, now(), ${by}, ${cur.mode})`
				);
				return loadRefund(tx, id, true);
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.refund_booked', {
				target: id,
				metadata: {
					actionId: id,
					mode: state.mode,
					count: state.count,
					totalCents: state.totalCents
				}
			});
			return state;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/accounting/refund',
		summary: 'Rueckzahlungsbuchung zuruecknehmen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const result = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await lockAction(tx, id);
				await assertOpen(tx, id);
				const snap = await loadRefundSnapshot(tx, id);
				if (!snap) throw errors.notFound('Es ist keine Rueckzahlung gebucht');
				await tx.execute(sql`DELETE FROM accounting_entries WHERE id = ${snap.entryId}`);
				await tx.execute(sql`DELETE FROM accounting_refunds WHERE action_id = ${id}`);
				await tx.execute(sql`DELETE FROM action_refund_booking WHERE action_id = ${id}`);
				return {
					state: await loadRefund(tx, id, true),
					count: snap.payingCount,
					total: snap.totalCents
				};
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.refund_reverted', {
				target: id,
				metadata: { actionId: id, count: result.count, totalCents: result.total }
			});
			return result.state;
		}
	} as ApiEndpoint
];
