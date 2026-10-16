import { sql } from 'drizzle-orm';
import type { ActionContributions, TreasuryService } from './contract';
import { mdb, num, rows } from './db';
import { registrationDocument } from './documents';
import { lineOpen, sourceRef } from './logic';
import { loadBankData } from './notify';
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

	async invoiceForRegistration(actionId: string, participantId: string) {
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
	}
};
