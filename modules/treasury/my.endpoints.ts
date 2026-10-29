/**
 * „Meine“ Kassen-Daten für das Dashboard: offene Rechnungen der mit dem Konto verknüpften Mitglieder.
 * Nur lesend, ohne Audit. Der members-Dienst läuft AUSSERHALB der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { defineEndpoint, type ApiEndpoint, type RequestContext } from '$lib/sdk/server';
import { idList, mdb, membersService, rows } from './db';
import { invoicePurpose } from './documents';
import { loadSummaries } from './invoices.endpoints';
import { loadBankData } from './notify';
import type { InvoiceSummary, MyInvoice, MyInvoices } from './schemas';

const TAGS = ['Modul: treasury'];

/** Rechnungen mit einem Posten (oder Jahresbeitrags-Anteil) eines der Mitglieder */
const membersInvoicesWhere = (memberIds: string[]) =>
	sql`(EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.member_id IN (${idList(memberIds)}))
		OR EXISTS (SELECT 1 FROM annual_fee_items x WHERE x.invoice_id = i.id AND x.member_id IN (${idList(memberIds)})))`;

/** Anlass einer Rechnung für Titel wie „Rechnung Herbstfahrt 2026 bezahlen“ */
export function invoiceOccasion(s: InvoiceSummary): string | null {
	if (s.source === 'action') return s.action?.name ?? 'Aktion';
	if (s.source === 'annual') return `Jahresbeitrag ${s.issuedOn.slice(0, 4)}`;
	if (s.source === 'order') return 'Bestellung';
	return null;
}

/** Nach Fälligkeit (älteste zuerst), dann Nummer */
const byDue = (a: MyInvoice, b: MyInvoice) =>
	a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number);

export async function loadMyInvoices(ctx: RequestContext): Promise<MyInvoices> {
	const empty: MyInvoices = { invoices: [], totals: { openCents: 0, overdueCents: 0 }, bank: null };
	if (!ctx.userId) return empty;

	const linked = await (await membersService()).listLinkedMembers(ctx);
	if (linked.length === 0) return empty;
	const memberIds = linked.map((m) => m.id);
	const nameOf = new Map(linked.map((m) => [m.id, `${m.firstName} ${m.lastName}`]));

	const { summaries } = await loadSummaries(membersInvoicesWhere(memberIds));
	const open = summaries.filter(
		(s) => (s.status === 'open' || s.status === 'partial') && s.openCents > 0
	);

	// Welche EIGENEN Mitglieder stehen auf welcher Rechnung? (Namen fremder Mitglieder nie ausgeben)
	const membersByInvoice = new Map<string, Set<string>>();
	if (open.length > 0) {
		const found = await mdb().transaction((tx) =>
			rows(
				tx,
				sql`SELECT l.invoice_id, l.member_id FROM invoice_lines l
					WHERE l.invoice_id IN (${idList(open.map((s) => s.id))}) AND l.member_id IN (${idList(memberIds)})
				UNION
				SELECT x.invoice_id, x.member_id FROM annual_fee_items x
					WHERE x.invoice_id IN (${idList(open.map((s) => s.id))}) AND x.member_id IN (${idList(memberIds)})`
			)
		);
		for (const r of found) {
			const inv = String(r.invoice_id);
			const set = membersByInvoice.get(inv) ?? new Set<string>();
			set.add(String(r.member_id));
			membersByInvoice.set(inv, set);
		}
	}

	const invoices: MyInvoice[] = open
		.map((s) => ({
			id: s.id,
			number: s.number,
			members: [...(membersByInvoice.get(s.id) ?? [])]
				.map((id) => nameOf.get(id) ?? '')
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b, 'de')),
			totalCents: s.totalCents,
			openCents: s.openCents,
			dueDate: s.dueOn,
			overdue: s.overdue,
			purpose: invoicePurpose({ number: s.number, recipientName: s.recipientName }),
			occasion: invoiceOccasion(s)
		}))
		.sort(byDue);

	const bank = await loadBankData();
	return {
		invoices,
		totals: {
			openCents: invoices.reduce((sum, i) => sum + i.openCents, 0),
			overdueCents: invoices.reduce((sum, i) => sum + (i.overdue ? i.openCents : 0), 0)
		},
		bank: bank.holder && bank.iban ? { holder: bank.holder, iban: bank.iban, bic: bank.bic } : null
	};
}

export const myEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/my/invoices',
		summary:
			'Eigene offene Rechnungen (der mit dem Konto verknüpften Mitglieder) mit Zahlungsdaten',
		tags: TAGS,
		permission: 'treasury.own.view',
		handler: ({ ctx }): Promise<MyInvoices> => loadMyInvoices(ctx)
	})
] as ApiEndpoint[];
