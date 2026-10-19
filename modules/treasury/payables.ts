/**
 * Ausstehende Überweisungen (Verbindlichkeiten des Stammes): manuelle Eingangsrechnungen sowie
 * automatisch aus Auslagen der Aktions-Abrechnungen, gebuchten Rückzahlungen und Guthaben.
 * Bezahlt wird über eine Ausgabe-Buchung (`payable_payments`); Auslagen werden danach in der
 * Abrechnung als ausgezahlt markiert (Rückkanal über `ActionsService.markReimbursed`).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import type { MemberContact } from '$lib/modules/members/contract';
import { decryptIban, storeIban } from './bank';
import {
	actionsService,
	idList,
	isoOrNull,
	loadPayerNames,
	mdb,
	num,
	requireAccount,
	rows,
	str,
	today
} from './db';
import { formatIban, maskIban } from './iban';
import { notifyKasse, payableNotification, type CreatedPayableInfo } from './office-notify';
import { loadSummaries } from './invoices.endpoints';
import {
	centsToCsv,
	csvDocument,
	formatDateDe,
	matchMember,
	parseReimbursementRef,
	planPayables,
	reimbursementDescription,
	reimbursementRef,
	sanitizeName,
	type PayableDesired,
	type PayableExisting
} from './logic';
import {
	MAX_RECEIPT_BYTES,
	MODULE_ID,
	PAYABLE_SOURCE_LABELS,
	RECEIPT_CONTENT_TYPES,
	idParams,
	payableInput,
	payableListQuery,
	payablePayInput,
	type Payable,
	type PayableInput,
	type PayableList,
	type PayablePayInput,
	type PayableSource
} from './schemas';
import { syncIfStale } from './sync';

const TAGS = ['Modul: treasury'];
const EDIT = 'treasury.payable.edit';
const REFUND_CATEGORY = 'cat-rueckzahlung';

// --- Abgleich ------------------------------------------------------------------

/** Erzeugt/aktualisiert automatische Auszahlungen. Dienste vor der Transaktion, Änderungen in einer. */
export async function syncPayables(members: MemberContact[]): Promise<{
	created: number;
	updated: number;
	cancelled: number;
	/** Neu angelegte Auszahlungen (für die Benachrichtigung des Amts „Kasse“, ohne Bankdaten) */
	createdItems: CreatedPayableInfo[];
}> {
	const svc = await actionsService();
	const reimbursements = await svc.listReimbursements();
	const refunds = await svc.listRefundItems();
	const clubExpenses = await svc.listClubExpenses();
	const actionIds = [
		...new Set([...reimbursements, ...refunds, ...clubExpenses].map((r) => r.actionId))
	];
	const actionNames = new Map(
		(actionIds.length ? await svc.listActionRefs({ ids: actionIds }) : []).map((a) => [
			a.id,
			a.name
		])
	);
	const { summaries } = await loadSummaries();

	return mdb().transaction(async (tx) => {
		const payerByMember = new Map(
			(await rows(tx, sql`SELECT payer_id, member_id FROM payer_members`)).map((r) => [
				String(r.member_id),
				String(r.payer_id)
			])
		);
		const payerBank = new Map(
			(await rows(tx, sql`SELECT id, iban_last4, bic FROM payers`)).map((r) => [
				String(r.id),
				{ last4: str(r.iban_last4), bic: str(r.bic) }
			])
		);
		const existingRows = await rows(
			tx,
			sql`SELECT p.id, p.source_ref, p.amount_cents, p.description, p.recipient_name, p.payer_id, p.iban_last4,
				p.cancelled_at, p.auto_cancelled,
				coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid
			FROM payables p WHERE p.source <> 'manual'`
		);
		const paidByRef = new Map(existingRows.map((r) => [String(r.source_ref), num(r.paid)]));
		// Herkunftskonto: IBAN der (letzten) Zahlung, die einem Beitrag bzw. einer Rechnung zugeordnet ist
		const originRows = await rows(
			tx,
			sql`SELECT DISTINCT ON (l.id) l.source_ref, l.invoice_id, t.counterparty_iban_enc, t.counterparty_iban_last4
			FROM invoice_lines l JOIN allocations a ON a.line_id = l.id JOIN transactions t ON t.id = a.transaction_id
			WHERE t.counterparty_iban_enc IS NOT NULL
			ORDER BY l.id, t.booked_on DESC, t.created_at DESC`
		);
		const originByRef = new Map(
			originRows
				.filter((r) => r.source_ref)
				.map((r) => [
					String(r.source_ref),
					{ enc: str(r.counterparty_iban_enc), last4: str(r.counterparty_iban_last4) }
				])
		);
		const originByInvoice = new Map(
			originRows.map((r) => [
				String(r.invoice_id),
				{ enc: str(r.counterparty_iban_enc), last4: str(r.counterparty_iban_last4) }
			])
		);
		const actionLabel = (id: string) => actionNames.get(id) ?? 'Aktion';

		const desired: PayableDesired[] = [
			...reimbursements.map((r) => {
				// Eine Auszahlung je (Aktion, Person) – egal ob aus Zwischenabrechnung oder Abschluss.
				// Alte ZA-Schlüssel (`reimb:<a>:<p>:<za>`) fehlen hier und werden, solange unbezahlt, storniert.
				const ref = reimbursementRef(r.actionId, r.payeeId);
				return {
					sourceRef: ref,
					source: 'reimbursement' as const,
					actionId: r.actionId,
					recipientName: r.name,
					description: reimbursementDescription(r.name, actionLabel(r.actionId)),
					// In der Kasse bereits Gezahltes + in der Abrechnung noch offen
					amountCents: (paidByRef.get(ref) ?? 0) + r.openCents,
					payerId: null,
					memberId: null,
					ibanLast4: r.ibanLast ? r.ibanLast.slice(-4) : null,
					bic: r.bic
				};
			}),
			...refunds.map((r) => {
				const memberId = matchMember(
					{ memberId: r.memberId, name: r.name, birthDate: r.birthDate },
					members
				);
				const payerId = memberId ? (payerByMember.get(memberId) ?? null) : null;
				const origin = r.participantId
					? originByRef.get(`action:${r.actionId}:${r.participantId}`)
					: undefined;
				return {
					sourceRef: `refund:${r.actionId}:${r.id}`,
					source: 'refund' as const,
					actionId: r.actionId,
					recipientName: r.name,
					description: `Rückzahlung Überschuss ${actionLabel(r.actionId)}`.slice(0, 200),
					amountCents: r.amountCents,
					payerId,
					memberId,
					ibanLast4: origin?.last4 ?? (payerId ? (payerBank.get(payerId)?.last4 ?? null) : null),
					bic: origin ? null : payerId ? (payerBank.get(payerId)?.bic ?? null) : null,
					ibanEnc: origin?.enc ?? null
				};
			}),
			// Stamm-Ausgaben: offen oder von der Kasse überwiesen (manuell bezahlte entfallen)
			...clubExpenses
				.filter((e) => e.paidVia !== 'manual')
				.map((e) => ({
					sourceRef: `expense:${e.actionId}:${e.entryId}`,
					source: 'expense' as const,
					actionId: e.actionId,
					recipientName: e.recipientName ?? e.description,
					description: (e.purpose ?? `${e.description} (${actionLabel(e.actionId)})`).slice(0, 200),
					amountCents: e.amountCents,
					payerId: null,
					memberId: null,
					ibanLast4: e.ibanLast ? e.ibanLast.slice(-4) : null,
					bic: e.bic
				})),
			...summaries
				.filter((s) => s.creditCents > 0)
				.map((s) => ({
					sourceRef: `credit:${s.id}`,
					source: 'credit' as const,
					actionId: s.action?.id ?? null,
					recipientName: s.recipientName,
					description: `Guthaben aus ${s.number}${s.status === 'cancelled' ? ' (storniert)' : ''}`,
					amountCents: s.creditCents,
					payerId: s.payer?.id ?? null,
					memberId: null,
					ibanLast4:
						originByInvoice.get(s.id)?.last4 ??
						(s.payer ? (payerBank.get(s.payer.id)?.last4 ?? null) : null),
					bic: originByInvoice.has(s.id)
						? null
						: s.payer
							? (payerBank.get(s.payer.id)?.bic ?? null)
							: null,
					ibanEnc: originByInvoice.get(s.id)?.enc ?? null
				}))
		];
		const existing: PayableExisting[] = existingRows.map((r) => ({
			id: String(r.id),
			sourceRef: String(r.source_ref),
			amountCents: num(r.amount_cents),
			paidCents: num(r.paid),
			description: String(r.description),
			recipientName: String(r.recipient_name),
			payerId: str(r.payer_id),
			ibanLast4: str(r.iban_last4),
			cancelled: r.cancelled_at != null,
			autoCancelled: Boolean(r.auto_cancelled)
		}));
		const plan = planPayables(desired, existing);
		const due = today();
		for (const d of plan.create) {
			await tx.execute(
				sql`INSERT INTO payables (id, source, source_ref, action_id, payer_id, member_id, recipient_name,
					iban_last4, bic, iban_enc, description, amount_cents, due_on)
				VALUES (${crypto.randomUUID()}, ${d.source}, ${d.sourceRef}, ${d.actionId}, ${d.payerId}, ${d.memberId},
					${d.recipientName.slice(0, 150)}, ${d.ibanLast4}, ${d.bic}, ${d.ibanEnc ?? null}, ${d.description},
					${d.amountCents}, ${due})`
			);
		}
		for (const u of plan.update) {
			await tx.execute(
				sql`UPDATE payables SET amount_cents = ${u.amountCents}, description = ${u.want.description},
					recipient_name = ${u.want.recipientName.slice(0, 150)}, payer_id = ${u.want.payerId},
					iban_last4 = ${u.want.ibanLast4}, bic = ${u.want.bic}, iban_enc = ${u.want.ibanEnc ?? null},
					updated_at = now()
				WHERE id = ${u.id}`
			);
		}
		if (plan.reactivate.length) {
			await tx.execute(
				sql`UPDATE payables SET cancelled_at = NULL, auto_cancelled = false, updated_at = now()
				WHERE id IN (${idList(plan.reactivate)})`
			);
		}
		if (plan.cancel.length) {
			await tx.execute(
				sql`UPDATE payables SET cancelled_at = now(), auto_cancelled = true, updated_at = now()
				WHERE id IN (${idList(plan.cancel)})`
			);
		}
		return {
			created: plan.create.length,
			updated: plan.update.length,
			cancelled: plan.cancel.length,
			createdItems: plan.create.map((d) => ({
				source: d.source,
				recipientName: d.recipientName,
				amountCents: d.amountCents,
				description: d.description,
				actionName: d.actionId ? (actionNames.get(d.actionId) ?? null) : null
			}))
		};
	});
}

// --- Laden ---------------------------------------------------------------------

async function loadPayableRows(tx: Tx, where = sql`TRUE`) {
	const list = await rows(
		tx,
		sql`SELECT p.*, to_char(p.due_on, 'YYYY-MM-DD') AS due,
			coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid,
			(SELECT py.iban_last4 FROM payers py WHERE py.id = p.payer_id) AS payer_last4
		FROM payables p WHERE ${where}
		ORDER BY p.cancelled_at NULLS FIRST, p.due_on NULLS LAST, p.created_at, p.id`
	);
	const payments = list.length
		? await rows(
				tx,
				sql`SELECT pp.payable_id, pp.transaction_id, pp.amount_cents, to_char(t.booked_on, 'YYYY-MM-DD') AS booked_on,
					a.name AS account_name
				FROM payable_payments pp JOIN transactions t ON t.id = pp.transaction_id
				JOIN accounts a ON a.id = t.account_id
				WHERE pp.payable_id IN (${idList(list.map((r) => String(r.id)))}) ORDER BY t.booked_on`
			)
		: [];
	return { list, payments };
}

async function toPayables(
	data: Awaited<ReturnType<typeof loadPayableRows>>,
	payers: Map<string, { name: string }>
): Promise<Payable[]> {
	const actionIds = [
		...new Set(data.list.map((r) => str(r.action_id)).filter(Boolean) as string[])
	];
	const names = new Map(
		(actionIds.length ? await (await actionsService()).listActionRefs({ ids: actionIds }) : []).map(
			(a) => [a.id, a.name]
		)
	);
	const t = today();
	return data.list.map((r) => {
		const paid = num(r.paid);
		const amount = num(r.amount_cents);
		const open = r.cancelled_at ? 0 : Math.max(0, amount - paid);
		const last4 = str(r.iban_last4) ?? str(r.payer_last4);
		const actionId = str(r.action_id);
		const payerId = str(r.payer_id);
		return {
			id: String(r.id),
			source: r.source as PayableSource,
			recipientName: String(r.recipient_name),
			description: String(r.description),
			amountCents: amount,
			paidCents: paid,
			openCents: open,
			dueOn: str(r.due),
			overdue: open > 0 && !!r.due && String(r.due) < t,
			action: actionId ? { id: actionId, name: names.get(actionId) ?? 'Aktion' } : null,
			payer: payerId ? { id: payerId, name: payers.get(payerId)?.name ?? 'Zahler' } : null,
			ibanMasked: maskIban(last4),
			hasIban: !!last4,
			bic: str(r.bic),
			note: str(r.note),
			receipt: r.receipt_name
				? { name: String(r.receipt_name), contentType: String(r.receipt_content_type) }
				: null,
			cancelledAt: isoOrNull(r.cancelled_at),
			payments: data.payments
				.filter((p) => p.payable_id === r.id)
				.map((p) => ({
					transactionId: String(p.transaction_id),
					bookedOn: String(p.booked_on),
					accountName: String(p.account_name),
					amountCents: num(p.amount_cents)
				})),
			automatic: r.source !== 'manual'
		};
	});
}

export async function listPayables(where = sql`TRUE`): Promise<Payable[]> {
	const { data, payers } = await mdb().transaction(async (tx) => ({
		data: await loadPayableRows(tx, where),
		payers: await loadPayerNames(tx)
	}));
	return toPayables(data, payers);
}

async function onePayable(id: string): Promise<Payable> {
	const [p] = await listPayables(sql`p.id = ${id}`);
	if (!p) throw errors.notFound('Auszahlung nicht gefunden');
	return p;
}

/** Klartext-IBAN je Quelle: eigene (manuell), Abrechnung (Auslagen) oder Zahler (Rückzahlung/Guthaben) */
async function payableIban(id: string): Promise<string | null> {
	const r = await mdb().transaction(async (tx) => {
		const [p] = await rows(
			tx,
			sql`SELECT p.source, p.source_ref, p.iban_enc, (SELECT iban_enc FROM payers py WHERE py.id = p.payer_id) AS payer_enc
			FROM payables p WHERE p.id = ${id}`
		);
		if (!p) throw errors.notFound('Auszahlung nicht gefunden');
		return p;
	});
	if (r.source === 'reimbursement') {
		const [, actionId, payeeId] = String(r.source_ref).split(':');
		return (await actionsService()).getPayeeIban(actionId!, payeeId!);
	}
	if (r.source === 'expense') {
		const [, actionId, entryId] = String(r.source_ref).split(':');
		return (await actionsService()).getClubExpenseIban(actionId!, entryId!);
	}
	return decryptIban(r.iban_enc) ?? decryptIban(r.payer_enc);
}

/**
 * Nach Zahlung/Löschung: Auslagen bzw. Stamm-Ausgaben in der Abrechnung als (nicht) bezahlt markieren.
 */
export async function syncActionPayableStatus(payableIds: string[]): Promise<void> {
	if (!payableIds.length) return;
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT p.source, p.source_ref, p.amount_cents, p.cancelled_at,
				coalesce((SELECT sum(pp.amount_cents) FROM payable_payments pp WHERE pp.payable_id = p.id), 0) AS paid
			FROM payables p WHERE p.id IN (${idList(payableIds)}) AND p.source IN ('reimbursement', 'expense')`
		)
	);
	if (!found.length) return;
	const svc = await actionsService();
	for (const r of found) {
		const settled = num(r.paid) > 0 && num(r.paid) >= num(r.amount_cents);
		if (r.source === 'expense') {
			const [, actionId, entryId] = String(r.source_ref).split(':');
			if (actionId && entryId) await svc.markClubExpensePaid(actionId, entryId, settled);
			continue;
		}
		// Auslagen: eine Auszahlung je (Aktion, Person), `interimId: null` = alle freigegebenen Auslagen.
		// Alt-Schlüssel mit ZA liefern die interimId weiter (Backend: No-op).
		const ref = parseReimbursementRef(String(r.source_ref));
		if (!ref) continue;
		// Die Auszahlung wächst mit neuen Auslagen (z. B. aus einer weiteren Zwischenabrechnung). Ist sie
		// nur teilweise bezahlt, bleiben bereits erstattete Auslagen erstattet – sonst würden sie im
		// nächsten Abgleich erneut offen und doppelt ausgezahlt. Zurückgenommen wird erst, wenn nichts
		// mehr bezahlt ist.
		if (settled) {
			await svc.markReimbursed(ref.actionId, ref.payeeId, true, ref.interimId);
		} else if (num(r.paid) <= 0) {
			await svc.markReimbursed(ref.actionId, ref.payeeId, false, ref.interimId);
		}
	}
}

// --- Endpoints -----------------------------------------------------------------

/**
 * Ausgabe einer Auszahlung zuordnen (bzw. mit `null` lösen). Liefert die betroffenen Auszahlungen,
 * damit danach `syncActionPayableStatus` laufen kann (außerhalb der Transaktion).
 */
export async function linkTransactionToPayable(
	tx: Tx,
	transactionId: string,
	payableId: string | null,
	userId: string | null
): Promise<string[]> {
	const [t] = await rows(
		tx,
		sql`SELECT amount_cents, transfer_id FROM transactions WHERE id = ${transactionId} FOR UPDATE`
	);
	if (!t) throw errors.notFound('Buchung nicht gefunden');
	const before = await rows(
		tx,
		sql`SELECT payable_id FROM payable_payments WHERE transaction_id = ${transactionId}`
	);
	await tx.execute(sql`DELETE FROM payable_payments WHERE transaction_id = ${transactionId}`);
	if (payableId) {
		if (num(t.amount_cents) >= 0 || t.transfer_id) {
			throw errors.conflict('Nur Ausgaben können einer Auszahlung zugeordnet werden');
		}
		const p = await lockPayable(tx, payableId);
		if (p.cancelled_at) throw errors.conflict('Auszahlung ist storniert');
		const [paid] = await rows(
			tx,
			sql`SELECT coalesce(sum(amount_cents), 0) AS s FROM payable_payments WHERE payable_id = ${payableId}`
		);
		const amount = Math.min(-num(t.amount_cents), num(p.amount_cents) - num(paid?.s));
		if (amount <= 0) throw errors.conflict('Die Auszahlung ist bereits vollständig bezahlt');
		await tx.execute(
			sql`INSERT INTO payable_payments (id, payable_id, transaction_id, amount_cents, created_by)
			VALUES (${crypto.randomUUID()}, ${payableId}, ${transactionId}, ${amount}, ${userId})`
		);
	}
	return [...before.map((r) => String(r.payable_id)), ...(payableId ? [payableId] : [])];
}

async function lockPayable(tx: Tx, id: string) {
	const [p] = await rows(tx, sql`SELECT * FROM payables WHERE id = ${id} FOR UPDATE`);
	if (!p) throw errors.notFound('Auszahlung nicht gefunden');
	return p;
}

/** Prüft die Aktion (422) und liefert ihren Namen (`null` ohne Aktion). */
async function requireActionRef(actionId: string | null): Promise<string | null> {
	if (!actionId) return null;
	const found = await (await actionsService()).listActionRefs({ ids: [actionId] });
	if (!found[0])
		throw errors.validation([{ path: ['actionId'], message: 'Aktion nicht gefunden' }]);
	return found[0].name;
}

export const payableEndpoints = [
	{
		method: 'GET',
		path: '/payables',
		summary: 'Ausstehende Überweisungen (Auslagen, Rückzahlungen, Guthaben, Eingangsrechnungen)',
		tags: TAGS,
		permission: 'treasury.cash.view',
		query: payableListQuery,
		handler: async ({ ctx, query }) => {
			const q = query as z.infer<typeof payableListQuery>;
			await syncIfStale(ctx);
			const all = await listPayables(q.source === 'all' ? sql`TRUE` : sql`p.source = ${q.source}`);
			const items = all.filter((p) =>
				q.status === 'all'
					? true
					: q.status === 'cancelled'
						? !!p.cancelledAt
						: q.status === 'paid'
							? !p.cancelledAt && p.openCents === 0
							: p.openCents > 0
			);
			return {
				items,
				totals: {
					openCents: items.reduce((s, p) => s + p.openCents, 0),
					count: items.filter((p) => p.openCents > 0).length
				}
			} satisfies PayableList;
		}
	},
	{
		method: 'POST',
		path: '/payables',
		summary: 'Eingangsrechnung / manuelle Auszahlung anlegen',
		tags: TAGS,
		permission: EDIT,
		body: payableInput,
		handler: async ({ ctx, body }) => {
			const input = body as PayableInput;
			const actionName = await requireActionRef(input.actionId);
			const id = crypto.randomUUID();
			const bank = storeIban(input.iban);
			await mdb().transaction((tx) =>
				tx.execute(
					sql`INSERT INTO payables (id, source, action_id, payer_id, recipient_name, iban_enc, iban_last4, bic,
						description, amount_cents, due_on, note, created_by)
					VALUES (${id}, 'manual', ${input.actionId}, ${input.payerId}, ${input.recipientName},
						${bank?.enc ?? null}, ${bank?.last4 ?? null}, ${input.bic}, ${input.description}, ${input.amountCents},
						${input.dueOn}, ${input.note}, ${ctx.userId})`
				)
			);
			await core.audit.logFromContext(ctx, 'treasury.payable.created', {
				target: id,
				metadata: { amountCents: input.amountCents }
			});
			await notifyKasse(ctx, [
				payableNotification({
					source: 'manual',
					recipientName: input.recipientName,
					amountCents: input.amountCents,
					description: input.description,
					actionName
				})
			]);
			return onePayable(id);
		}
	},
	{
		method: 'PUT',
		path: '/payables/:id',
		summary: 'Auszahlung ändern (automatische: nur Fälligkeit und Notiz)',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: payableInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as PayableInput;
			await requireActionRef(input.actionId);
			const bank = storeIban(input.iban);
			await mdb().transaction(async (tx) => {
				const cur = await lockPayable(tx, id);
				if (cur.source !== 'manual') {
					await tx.execute(
						sql`UPDATE payables SET due_on = ${input.dueOn}, note = ${input.note}, updated_at = now() WHERE id = ${id}`
					);
					return;
				}
				const [paid] = await rows(
					tx,
					sql`SELECT coalesce(sum(amount_cents), 0) AS s FROM payable_payments WHERE payable_id = ${id}`
				);
				if (input.amountCents < num(paid?.s)) {
					throw errors.conflict('Der Betrag ist kleiner als bereits gezahlt');
				}
				await tx.execute(
					sql`UPDATE payables SET recipient_name = ${input.recipientName}, description = ${input.description},
						amount_cents = ${input.amountCents}, due_on = ${input.dueOn}, note = ${input.note},
						action_id = ${input.actionId}, payer_id = ${input.payerId}, bic = ${input.bic}, updated_at = now()
					WHERE id = ${id}`
				);
				if (bank) {
					await tx.execute(
						sql`UPDATE payables SET iban_enc = ${bank.enc}, iban_last4 = ${bank.last4} WHERE id = ${id}`
					);
				}
			});
			await core.audit.logFromContext(ctx, 'treasury.payable.updated', { target: id });
			return onePayable(id);
		}
	},
	{
		method: 'POST',
		path: '/payables/:id/cancel',
		summary: 'Auszahlung stornieren bzw. wieder aufnehmen',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: z.object({ cancelled: z.boolean() }),
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const { cancelled } = body as { cancelled: boolean };
			await mdb().transaction(async (tx) => {
				await lockPayable(tx, id);
				await tx.execute(
					sql`UPDATE payables SET cancelled_at = ${cancelled ? new Date().toISOString() : null},
						auto_cancelled = false, updated_at = now() WHERE id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'treasury.payable.cancelled', {
				target: id,
				metadata: { cancelled }
			});
			return onePayable(id);
		}
	},
	{
		method: 'DELETE',
		path: '/payables/:id',
		summary: 'Manuelle Auszahlung ohne Zahlung löschen',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const path = await mdb().transaction(async (tx) => {
				const cur = await lockPayable(tx, id);
				if (cur.source !== 'manual')
					throw errors.conflict('Automatische Auszahlungen werden storniert');
				const [paid] = await rows(
					tx,
					sql`SELECT count(*)::int AS n FROM payable_payments WHERE payable_id = ${id}`
				);
				if (num(paid?.n) > 0)
					throw errors.conflict('Bereits bezahlte Auszahlungen können nicht gelöscht werden');
				await tx.execute(sql`DELETE FROM payables WHERE id = ${id}`);
				return str(cur.receipt_path);
			});
			if (path) await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
			await core.audit.logFromContext(ctx, 'treasury.payable.deleted', { target: id });
			return null;
		}
	},
	{
		method: 'POST',
		path: '/payables/:id/pay',
		summary: 'Überweisung buchen (Ausgabe) und der Auszahlung zuordnen',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: payablePayInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as PayablePayInput;
			const txId = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await requireAccount(tx, input.accountId);
				const p = await lockPayable(tx, id);
				if (p.cancelled_at) throw errors.conflict('Auszahlung ist storniert');
				const [paid] = await rows(
					tx,
					sql`SELECT coalesce(sum(amount_cents), 0) AS s FROM payable_payments WHERE payable_id = ${id}`
				);
				const open = num(p.amount_cents) - num(paid?.s);
				if (input.amountCents > open) {
					throw errors.validation([
						{ path: ['amountCents'], message: 'Höher als der offene Betrag' }
					]);
				}
				const category =
					input.categoryId ??
					(p.source === 'refund' || p.source === 'credit' ? REFUND_CATEGORY : null);
				await tx.execute(
					sql`INSERT INTO transactions (id, account_id, booked_on, amount_cents, counterparty, purpose,
						category_id, action_id, created_by)
					VALUES (${txId}, ${input.accountId}, ${input.bookedOn}, ${-input.amountCents}, ${String(p.recipient_name)},
						${String(p.description)}, ${category}, ${str(p.action_id)}, ${ctx.userId})`
				);
				await tx.execute(
					sql`INSERT INTO payable_payments (id, payable_id, transaction_id, amount_cents, created_by)
					VALUES (${crypto.randomUUID()}, ${id}, ${txId}, ${input.amountCents}, ${ctx.userId})`
				);
			});
			await syncActionPayableStatus([id]);
			await core.audit.logFromContext(ctx, 'treasury.payable.paid', {
				target: id,
				metadata: { transactionId: txId, amountCents: input.amountCents }
			});
			return onePayable(id);
		}
	},
	{
		method: 'PUT',
		path: '/transactions/:id/payable',
		summary: 'Ausgabe (z. B. aus dem Import) einer Auszahlung zuordnen bzw. lösen',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: z.object({ payableId: z.uuid().nullable() }),
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const { payableId } = body as { payableId: string | null };
			const touched = await mdb().transaction((tx) =>
				linkTransactionToPayable(tx, id, payableId, ctx.userId)
			);
			await syncActionPayableStatus(touched);
			await core.audit.logFromContext(ctx, 'treasury.payable.linked', {
				target: id,
				metadata: { payableId }
			});
			return null;
		}
	},
	{
		method: 'GET',
		path: '/payables/:id/iban',
		summary: 'IBAN der Empfänger*in im Klartext (auditiert)',
		tags: TAGS,
		permission: 'treasury.bank.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const iban = await payableIban(id);
			if (!iban) throw errors.notFound('Keine IBAN hinterlegt');
			await core.audit.logFromContext(ctx, 'treasury.payable.iban_viewed', { target: id });
			return new Response(JSON.stringify({ data: { iban: formatIban(iban) } }), {
				status: 200,
				headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' }
			});
		}
	},
	{
		method: 'GET',
		path: '/payables.csv',
		summary: 'Offene Auszahlungen als Überweisungsliste (IBAN nur mit treasury.bank.view)',
		tags: TAGS,
		permission: 'treasury.cash.view',
		handler: async ({ ctx }) => {
			const withBank = core.permissions.has(ctx, 'treasury.bank.view');
			const open = (await listPayables()).filter((p) => p.openCents > 0);
			const csvRows: (string | number | null)[][] = [];
			for (const p of open) {
				const iban = withBank && p.hasIban ? await payableIban(p.id).catch(() => null) : null;
				csvRows.push([
					p.recipientName,
					iban ? formatIban(iban) : (p.ibanMasked ?? ''),
					p.bic ?? '',
					centsToCsv(p.openCents),
					p.description.slice(0, 140),
					PAYABLE_SOURCE_LABELS[p.source],
					p.dueOn ? formatDateDe(p.dueOn) : ''
				]);
			}
			await core.audit.logFromContext(ctx, 'treasury.payables.exported', {
				metadata: { count: open.length, withBank }
			});
			return new Response(
				csvDocument(
					['Empfänger', 'IBAN', 'BIC', 'Betrag', 'Verwendungszweck', 'Art', 'Fällig'],
					csvRows
				),
				{
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': `attachment; filename="ueberweisungen-${today()}.csv"`,
						'cache-control': 'private, no-store'
					}
				}
			);
		}
	},
	{
		method: 'POST',
		path: '/payables/:id/receipt',
		summary: 'Beleg (Eingangsrechnung) hochladen (multipart, Feld "file")',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params, request }) => {
			const { id } = params as { id: string };
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) throw errors.badRequest('Feld "file" fehlt');
			const contentType = (file.type || '').split(';')[0]!.trim().toLowerCase();
			if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
				throw errors.badRequest('Dateityp nicht erlaubt (PDF, JPEG, PNG oder WebP)');
			}
			if (file.size === 0) throw errors.badRequest('Datei ist leer');
			if (file.size > MAX_RECEIPT_BYTES) throw errors.tooLarge('Datei überschreitet 10 MB');
			const old = await mdb().transaction(async (tx) =>
				str((await lockPayable(tx, id)).receipt_path)
			);
			const name = file.name?.trim() || 'beleg';
			const path = `payables/${id}/receipt-${crypto.randomUUID()}-${sanitizeName(name)}`;
			await core.storage.upload(ctx, {
				module: MODULE_ID,
				path,
				file: new Uint8Array(await file.arrayBuffer()),
				contentType,
				name
			});
			try {
				await mdb().transaction((tx) =>
					tx.execute(
						sql`UPDATE payables SET receipt_path = ${path}, receipt_name = ${name},
							receipt_content_type = ${contentType}, updated_at = now() WHERE id = ${id}`
					)
				);
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
				throw e;
			}
			if (old)
				await core.storage.remove(ctx, { module: MODULE_ID, path: old }).catch(() => undefined);
			await core.audit.logFromContext(ctx, 'treasury.payable.receipt_uploaded', { target: id });
			return { name, contentType };
		}
	},
	{
		method: 'GET',
		path: '/payables/:id/receipt',
		summary: 'Beleg einer Auszahlung herunterladen',
		tags: TAGS,
		permission: 'treasury.cash.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const ref = await mdb().transaction(async (tx) => {
				const [r] = await rows(
					tx,
					sql`SELECT receipt_path, receipt_name FROM payables WHERE id = ${id}`
				);
				if (!r) throw errors.notFound('Auszahlung nicht gefunden');
				return { path: str(r.receipt_path), name: String(r.receipt_name ?? 'beleg') };
			});
			if (!ref.path) throw errors.notFound('Kein Beleg vorhanden');
			const { buffer, file } = await core.storage.download(ctx, {
				module: MODULE_ID,
				path: ref.path
			});
			return new Response(buffer as BodyInit, {
				status: 200,
				headers: {
					'content-type': file.contentType,
					'content-disposition': `inline; filename="${sanitizeName(ref.name)}"`,
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	}
] as ApiEndpoint[];

// --- Belege zu Auszahlungen ------------------------------------------------------

export interface PayableReceipt {
	id: string;
	label: string;
	date: string | null;
	amountCents: number | null;
	name: string;
	contentType: string;
}

async function payableSource(id: string) {
	const [p] = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT source, source_ref, receipt_name, receipt_content_type, amount_cents, description,
				to_char(due_on, 'YYYY-MM-DD') AS due FROM payables WHERE id = ${id}`
		)
	);
	if (!p) throw errors.notFound('Auszahlung nicht gefunden');
	return p;
}

export const payableReceiptEndpoints = [
	{
		method: 'GET',
		path: '/payables/:id/receipts',
		summary:
			'Belege einer Auszahlung (Eingangsrechnung bzw. Belege der Auslagen aus der Abrechnung)',
		tags: TAGS,
		permission: 'treasury.storage.read',
		params: idParams,
		handler: async ({ params }) => {
			const { id } = params as { id: string };
			const p = await payableSource(id);
			const out: PayableReceipt[] = [];
			if (p.receipt_name) {
				out.push({
					id: 'own',
					label: String(p.description),
					date: str(p.due),
					amountCents: num(p.amount_cents),
					name: String(p.receipt_name),
					contentType: String(p.receipt_content_type)
				});
			}
			if (p.source === 'expense') {
				const [, actionId, entryId] = String(p.source_ref).split(':');
				const exp = (await (await actionsService()).listClubExpenses()).find(
					(e) => e.actionId === actionId && e.entryId === entryId
				);
				if (exp?.receipt) {
					out.push({
						id: exp.entryId,
						label: exp.description,
						date: exp.entryDate,
						amountCents: exp.amountCents,
						name: exp.receipt.name,
						contentType: exp.receipt.contentType
					});
				}
			}
			if (p.source === 'reimbursement') {
				const ref = parseReimbursementRef(String(p.source_ref));
				if (!ref) return out;
				for (const r of await (
					await actionsService()
				).listReimbursementReceipts(ref.actionId, ref.payeeId, ref.interimId)) {
					out.push({
						id: r.entryId,
						label: r.description,
						date: r.entryDate,
						amountCents: r.amountCents,
						name: r.name,
						contentType: r.contentType
					});
				}
			}
			return out;
		}
	},
	{
		method: 'GET',
		path: '/payables/:id/receipts/:entryId',
		summary: 'Einzelnen Beleg einer Auszahlung anzeigen',
		tags: TAGS,
		permission: 'treasury.storage.read',
		params: z.object({ id: z.uuid(), entryId: z.string().regex(/^(own|[0-9a-f-]{36})$/) }),
		handler: async ({ ctx, params }) => {
			const { id, entryId } = params as { id: string; entryId: string };
			const p = await payableSource(id);
			let file: { data: Uint8Array; name: string; contentType: string } | null = null;
			if (entryId === 'own') {
				const path = await mdb().transaction(async (tx) =>
					str(
						(await rows(tx, sql`SELECT receipt_path FROM payables WHERE id = ${id}`))[0]
							?.receipt_path
					)
				);
				if (path) {
					const dl = await core.storage.download(ctx, { module: MODULE_ID, path });
					file = {
						data: new Uint8Array(dl.buffer),
						name: String(p.receipt_name ?? 'beleg'),
						contentType: dl.file.contentType
					};
				}
			} else if (p.source === 'reimbursement') {
				const [, actionId] = String(p.source_ref).split(':');
				file = await (await actionsService()).downloadReceipt(actionId!, entryId);
			} else if (p.source === 'expense') {
				const [, actionId, ownEntry] = String(p.source_ref).split(':');
				if (ownEntry === entryId) {
					file = await (await actionsService()).downloadReceipt(actionId!, entryId);
				}
			}
			if (!file) throw errors.notFound('Beleg nicht gefunden');
			await core.audit.logFromContext(ctx, 'treasury.payable.receipt_viewed', {
				target: id,
				metadata: { entryId }
			});
			return new Response(file.data as BodyInit, {
				status: 200,
				headers: {
					'content-type': file.contentType,
					'content-disposition': `inline; filename="${sanitizeName(file.name)}"`,
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	}
] as ApiEndpoint[];
