import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import { type ApiEndpoint, core, errors, moduleDb, rowsOf, type Tx } from '$lib/sdk/server';
import { requireAccess } from './access';
import { appliedAutoIncome } from './auto-income';
import type { ActionContributions } from '$modules/treasury/contract';
import {
	assertOpen,
	closedInfo,
	loadAutoIncome,
	loadRefundSnapshot,
	loadTreasuryContributions
} from './accounting-core';
import {
	deadlineRunning,
	MIN_REFUND_PER_HEAD_CENTS,
	computeManualRefund,
	computeRefund,
	refundThresholdOk,
	type RefundPayer
} from './refund';
import { refundEntryText, treasuryPaidByItem } from './refund-donation';
import { MODULE_ID, idParams, refundBodySchema, refundQuerySchema } from './schemas';

const TAGS = ['Modul: actions'];

interface RefundItemDto {
	/** Posten-ID (nur gebucht; Vorschau `null`) */
	id: string | null;
	participantId: string | null;
	name: string;
	amountCents: number;
	/** An den Stamm gespendet */
	donatedCents: number;
	/** Auszuzahlen = Anteil − Spende */
	payoutCents: number;
	decidedVia: 'internal' | 'link' | null;
	decidedAt: string | null;
	hasLink: boolean;
	/** Von der Kasse bereits überwiesen (> 0 = Wahl gesperrt) */
	paidCents: number;
}

const previewItem = (i: {
	participantId: string | null;
	name: string;
	amountCents: number;
}): RefundItemDto => ({
	id: null,
	participantId: i.participantId,
	name: i.name,
	amountCents: i.amountCents,
	donatedCents: 0,
	payoutCents: i.amountCents,
	decidedVia: null,
	decidedAt: null,
	hasLink: false,
	paidCents: 0
});

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
		entryId: string | null;
		surplusCents: number;
		totalCents: number;
		remainderCents: number;
		donatedCents: number;
		payoutCents: number;
		/** Rückmeldung bis einschließlich JJJJ-MM-TT (`null` = keine Frist) */
		deadline: string | null;
		/** Frist läuft noch: Link offen, Kasse zahlt noch nicht aus */
		deadlineRunning: boolean;
		items: RefundItemDto[];
	};
	canBook: boolean;
	blockers: string[];
	feeCents: number | null;
	teamFeeCents: number | null;
}

/** Berechnung für GET/POST; `canEdit` fließt nur in `canBook` ein. */
async function loadRefund(
	tx: Tx,
	actionId: string,
	canEdit: boolean,
	manual?: { count: number; names?: string[] },
	treasury: ActionContributions | null = null
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
			})),
			treasury
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
					? manualNames.map((name) =>
							previewItem({
								participantId: crypto.randomUUID(),
								name,
								amountCents: manualCalc.perHeadCents
							})
						)
					: []) as RefundItemDto[],
				totalCents: manualCalc.totalCents,
				remainderCents: manualCalc.remainderCents,
				perHeadCents: manualCalc.perHeadCents,
				payingCount: manualCalc.perHeadCents > 0 ? manualCalc.count : 0
			}
		: { ...autoCalc, items: autoCalc.items.map(previewItem) };
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

	const bookedItems: RefundItemDto[] = (snapshot?.items ?? []).map((i) => ({
		id: i.id,
		participantId: i.participantId,
		name: i.name,
		amountCents: i.amountCents,
		donatedCents: i.donatedCents,
		payoutCents: Math.max(0, i.amountCents - i.donatedCents),
		decidedVia: i.decidedVia,
		decidedAt: i.decidedAt,
		hasLink: i.hasLink,
		paidCents: 0
	}));

	return {
		mode,
		count: snapshot ? snapshot.payingCount : manualCalc ? manualCalc.count : autoCalc.payingCount,
		autoCount: payers.length,
		minPerHeadCents: MIN_REFUND_PER_HEAD_CENTS,
		thresholdOk: snapshot ? snapshot.perHeadCents > MIN_REFUND_PER_HEAD_CENTS : thresholdOk,
		surplusCents,
		payingCount: snapshot ? snapshot.payingCount : calc.payingCount,
		perHeadCents: snapshot ? snapshot.perHeadCents : calc.perHeadCents,
		items: snapshot ? bookedItems : calc.items,
		totalCents: snapshot ? snapshot.totalCents : calc.totalCents,
		remainderCents: snapshot ? snapshot.remainderCents : calc.remainderCents,
		booked: snapshot
			? {
					bookedAt: snapshot.bookedAt,
					entryId: snapshot.entryId,
					surplusCents: snapshot.surplusCents,
					totalCents: snapshot.totalCents,
					remainderCents: snapshot.remainderCents,
					donatedCents: snapshot.donatedCents,
					payoutCents: snapshot.payoutCents,
					deadline: snapshot.deadline,
					deadlineRunning: deadlineRunning(snapshot.deadline, todayBerlin()),
					items: bookedItems
				}
			: null,
		canBook: canEdit && blockers.length === 0,
		blockers,
		feeCents,
		teamFeeCents
	};
}

/** Überwiesene Beträge der Kasse an die gebuchten Posten hängen (nach der Transaktion) */
async function withTreasuryPaid(actionId: string, state: RefundState): Promise<RefundState> {
	if (!state.booked) return state;
	const ids = state.booked.items.map((i) => i.id).filter((i): i is string => !!i);
	const paid = await treasuryPaidByItem(actionId, ids);
	if (!paid.size) return state;
	const mark = (i: RefundItemDto): RefundItemDto => ({
		...i,
		paidCents: paid.get(i.id ?? '') ?? 0
	});
	return {
		...state,
		items: state.items.map(mark),
		booked: { ...state.booked, items: state.booked.items.map(mark) }
	};
}

async function lockAction(tx: Tx, actionId: string): Promise<void> {
	await tx.execute(sql`SELECT id FROM actions WHERE id = ${actionId} FOR UPDATE`);
}

export const refundEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/accounting/refund',
		summary: 'Rückzahlung des Überschusses an Teilnehmende berechnen / Stand lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		query: refundQuerySchema,
		handler: async ({ ctx, params, query }) => {
			const id = (params as { id: string }).id;
			const treasury = await loadTreasuryContributions(id);
			const count = (query as { count?: number } | undefined)?.count;
			const state = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'read');
				return loadRefund(
					tx,
					id,
					access.level === 'edit',
					count == null ? undefined : { count },
					treasury
				);
			});
			return withTreasuryPaid(id, state);
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/refund',
		summary: 'Rückzahlung an Teilnehmende buchen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: refundBodySchema,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const treasury = await loadTreasuryContributions(id);
			const names = (body as { names?: string[] } | undefined)?.names;
			const by = ctx.userId ?? null;
			const state = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await lockAction(tx, id);
				await assertOpen(tx, id);
				const cur = await loadRefund(
					tx,
					id,
					true,
					names ? { count: names.length, names } : undefined,
					treasury
				);
				if (cur.booked) throw errors.conflict('Die Rückzahlung ist bereits gebucht.');
				if (cur.surplusCents <= 0) throw errors.conflict('Es gibt keinen Überschuss.');
				if (cur.feeCents == null) {
					throw errors.conflict('Der Beitrag der Aktion ist nicht festgelegt.');
				}
				if (cur.mode === 'auto' && cur.items.length === 0) {
					throw errors.conflict('Es gibt keine zahlenden Teilnehmenden mit Rückzahlung.');
				}
				if (!cur.thresholdOk) {
					throw errors.conflict(
						'Pro Person bleiben höchstens 5 EUR - eine Rückzahlung lohnt sich nicht.'
					);
				}
				const description = refundEntryText({
					mode: cur.mode,
					payingCount: cur.count,
					perHeadCents: cur.perHeadCents,
					items: cur.items
				});
				const entryId = crypto.randomUUID();
				const today = todayBerlin();
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
				return loadRefund(tx, id, true, undefined, treasury);
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
		summary: 'Rückzahlungsbuchung zurücknehmen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const treasury = await loadTreasuryContributions(id);
			const result = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await lockAction(tx, id);
				await assertOpen(tx, id);
				const snap = await loadRefundSnapshot(tx, id);
				if (!snap) throw errors.notFound('Es ist keine Rückzahlung gebucht');
				if (snap.entryId) {
					await tx.execute(sql`DELETE FROM accounting_entries WHERE id = ${snap.entryId}`);
				}
				await tx.execute(sql`DELETE FROM accounting_refunds WHERE action_id = ${id}`);
				await tx.execute(sql`DELETE FROM action_refund_booking WHERE action_id = ${id}`);
				return {
					state: await loadRefund(tx, id, true, undefined, treasury),
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
