import { sql } from 'drizzle-orm';
import type { RequestContext } from '$lib/sdk/server';
import type {
	AccountingClosedEvent,
	ActionContributions,
	ParticipantPayment,
	TreasuryService
} from './contract';
import { actionsService, mdb, num, rows, today } from './db';
import { registrationDocument } from './documents';
import {
	cancelOrderPayable,
	invoiceStatus,
	payableStatus,
	upsertOrderInvoice,
	upsertOrderPayable
} from './external';
import { lineOpen, sourceRef } from './logic';
import { loadBankData } from './notify';
import { accountingClosedNotification, notifyKasse } from './office-notify';
import { syncActions } from './sync';

export const treasuryService: TreasuryService = {
	async contributionsForAction(actionId: string): Promise<ActionContributions | null> {
		const lines = await mdb().transaction((tx) =>
			rows(
				tx,
				sql`SELECT l.invoice_id, l.amount_cents, l.waived_cents,
					coalesce((SELECT sum(a.amount_cents) FROM allocations a WHERE a.line_id = l.id), 0) AS paid_cents
				FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
				WHERE i.cancelled_at IS NULL AND coalesce(l.action_id, i.action_id) = ${actionId}`
			)
		);
		if (!lines.length) return null;
		let dueCents = 0;
		let paidCents = 0;
		let openCents = 0;
		for (const l of lines) {
			const a = {
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_cents)
			};
			dueCents += Math.max(0, a.amountCents - a.waivedCents);
			paidCents += a.paidCents;
			openCents += lineOpen(a);
		}
		return {
			invoiceCount: new Set(lines.map((l) => String(l.invoice_id))).size,
			dueCents,
			paidCents,
			openCents
		};
	},

	async participantPayments(actionId: string): Promise<ParticipantPayment[]> {
		const lines = await mdb().transaction((tx) =>
			rows(
				tx,
				sql`SELECT l.participant_id, l.invoice_id, i.number, l.amount_cents, l.waived_cents,
					to_char(i.due_on, 'YYYY-MM-DD') AS due_on,
					coalesce((SELECT sum(a.amount_cents) FROM allocations a WHERE a.line_id = l.id), 0) AS paid_cents
				FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
				WHERE i.cancelled_at IS NULL AND l.participant_id IS NOT NULL
					AND coalesce(l.action_id, i.action_id) = ${actionId}
				ORDER BY i.created_at`
			)
		);
		const t = today();
		return lines.map((l) => {
			const a = {
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_cents)
			};
			const dueCents = Math.max(0, a.amountCents - a.waivedCents);
			const openCents = lineOpen(a);
			const dueOn = l.due_on == null ? null : String(l.due_on);
			return {
				participantId: String(l.participant_id),
				invoiceId: String(l.invoice_id),
				invoiceNumber: String(l.number),
				dueCents,
				paidCents: a.paidCents,
				openCents,
				status:
					dueCents === 0
						? 'waived'
						: openCents === 0
							? 'paid'
							: a.paidCents > 0
								? 'partial'
								: 'open',
				dueOn,
				overdue: openCents > 0 && !!dueOn && dueOn < t
			};
		});
	},

	async invoiceForRegistration(actionId: string, participantId: string) {
		// Vergangene Aktionen: keine Rechnung (Anmeldebestätigung ohne Zahlungsblock)
		const [source] = await (
			await actionsService()
		).listReceivableSources({ actionIds: [actionId] });
		if (source?.isPast) return null;
		await syncActions(null);
		const [line] = await mdb().transaction((tx) =>
			rows(
				tx,
				sql`SELECT l.invoice_id FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
				WHERE l.source_ref = ${sourceRef(actionId, participantId)} AND i.cancelled_at IS NULL`
			)
		);
		if (!line) return null;
		const doc = await registrationDocument(String(line.invoice_id));
		return doc ? { ...doc, contentType: 'application/pdf' as const } : null;
	},

	bankData() {
		return loadBankData();
	},

	accountingClosed(ctx: RequestContext, info: AccountingClosedEvent): Promise<void> {
		return notifyKasse(ctx, [accountingClosedNotification(info)]);
	},

	// Bestellungen (Modul `orders`), Implementierung in `external.ts`
	upsertOrderInvoice,
	upsertOrderPayable,
	cancelOrderPayable,
	invoiceStatus,
	payableStatus
};
