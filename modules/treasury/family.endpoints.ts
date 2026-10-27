/**
 * Familienkonto: alles zu einem Zahler (Familie) bzw. zu einem Mitglied ohne Zahler –
 * Rechnungen, eingegangene Zahlungen, Auszahlungen und Summen. Nur lesend, daher ohne Audit.
 * Dienste von `members`/`actions` laufen immer AUSSERHALB der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { errors, type ApiEndpoint, type RequestContext } from '$lib/sdk/server';
import { idList, loadTransactionsWhere, mdb, membersService, rows } from './db';
import { loadPayers, loadSummaries } from './invoices.endpoints';
import { listPayables } from './payables';
import {
	familyAccountQuery,
	type FamilyAccount,
	type FamilyAccountQuery,
	type InvoiceSummary,
	type Payer,
	type PayerMember
} from './schemas';
import { decorateTransactions } from './transactions.endpoints';

const TAGS = ['Modul: treasury'];
const VIEW = 'treasury.cash.view';

/** Zahler-ID zum Mitglied (oder null); unbekannte Zahler-ID → 404 */
async function resolveTarget(
	q: FamilyAccountQuery
): Promise<{ payerId: string } | { memberId: string }> {
	return mdb().transaction(async (tx) => {
		if (q.payerId) {
			const [p] = await rows(tx, sql`SELECT id FROM payers WHERE id = ${q.payerId}`);
			if (!p) throw errors.notFound('Zahler nicht gefunden');
			return { payerId: q.payerId };
		}
		const memberId = q.memberId!;
		const [link] = await rows(
			tx,
			sql`SELECT payer_id FROM payer_members WHERE member_id = ${memberId}`
		);
		return link ? { payerId: String(link.payer_id) } : { memberId };
	});
}

/** Rechnungen eines Zahlers: eigener Zahler oder (ohne Zahler) Zahler des ersten Postens – wie `toSummary` */
const payerInvoicesWhere = (payerId: string) =>
	sql`coalesce(i.payer_id, (SELECT pm.payer_id FROM invoice_lines l JOIN payer_members pm ON pm.member_id = l.member_id
		WHERE l.invoice_id = i.id ORDER BY l.position LIMIT 1)) = ${payerId}`;

/** Rechnungen mit einem Posten (oder Jahresbeitrags-Anteil) dieses Mitglieds */
const memberInvoicesWhere = (memberId: string) =>
	sql`(EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.member_id = ${memberId})
		OR EXISTS (SELECT 1 FROM annual_fee_items x WHERE x.invoice_id = i.id AND x.member_id = ${memberId}))`;

/** Neueste zuerst (Ausstellungsdatum, dann Nummer) */
const byNewest = (a: InvoiceSummary, b: InvoiceSummary) =>
	b.issuedOn.localeCompare(a.issuedOn) || b.number.localeCompare(a.number);

export async function loadFamilyAccount(
	ctx: RequestContext,
	q: FamilyAccountQuery
): Promise<FamilyAccount> {
	const target = await resolveTarget(q);

	let payer: Payer | null = null;
	let members: PayerMember[];
	let name: string;
	let invoices: InvoiceSummary[];

	if ('payerId' in target) {
		payer = (await loadPayers([target.payerId]))[0] ?? null;
		if (!payer) throw errors.notFound('Zahler nicht gefunden');
		name = payer.name;
		members = payer.members;
		invoices = (await loadSummaries(payerInvoicesWhere(payer.id))).summaries.filter(
			(s) => s.payer?.id === target.payerId
		);
	} else {
		const [m] = await (
			await membersService()
		).listMemberContacts({ ids: [target.memberId], limit: 1 });
		if (!m) throw errors.notFound('Mitglied nicht gefunden');
		name = `${m.firstName} ${m.lastName}`;
		members = [{ id: m.id, name, emails: m.emails }];
		invoices = (await loadSummaries(memberInvoicesWhere(m.id))).summaries;
	}
	invoices.sort(byNewest);

	const invoiceIds = invoices.map((i) => i.id);
	const memberIds = members.map((m) => m.id);
	const payerId = payer?.id ?? null;

	const byInvoice = invoiceIds.length
		? sql`t.id IN (SELECT al.transaction_id FROM allocations al JOIN invoice_lines l ON l.id = al.line_id
			WHERE l.invoice_id IN (${idList(invoiceIds)}))`
		: sql`FALSE`;
	const byPayer = payerId ? sql`t.payer_id = ${payerId}` : sql`FALSE`;
	const rawPayments = await mdb().transaction((tx) =>
		loadTransactionsWhere(tx, sql`t.amount_cents > 0 AND (${byPayer} OR ${byInvoice})`)
	);
	const payments = await decorateTransactions(rawPayments);

	const payableByPayer = payerId ? sql`p.payer_id = ${payerId}` : sql`FALSE`;
	const payableByMember = memberIds.length
		? sql`(p.payer_id IS NULL AND p.member_id IN (${idList(memberIds)}))`
		: sql`FALSE`;
	const payables = await listPayables(sql`(${payableByPayer} OR ${payableByMember})`);

	const live = invoices.filter((i) => i.status !== 'cancelled');
	return {
		payer,
		name,
		members,
		invoices,
		payments,
		payables,
		totals: {
			openCents: live.reduce((s, i) => s + i.openCents, 0),
			overdueCents: live.reduce((s, i) => s + (i.overdue ? i.openCents : 0), 0),
			paidCents: invoices.reduce((s, i) => s + i.paidCents, 0),
			creditCents: invoices.reduce((s, i) => s + i.creditCents, 0),
			payableOpenCents: payables.reduce((s, p) => s + p.openCents, 0)
		}
	};
}

export const familyEndpoints = [
	{
		method: 'GET',
		path: '/family-account',
		summary: 'Familienkonto: Rechnungen, Zahlungen und Auszahlungen eines Zahlers bzw. Mitglieds',
		tags: TAGS,
		permission: VIEW,
		query: familyAccountQuery,
		handler: ({ ctx, query }) => loadFamilyAccount(ctx, query as FamilyAccountQuery)
	}
] as ApiEndpoint[];
