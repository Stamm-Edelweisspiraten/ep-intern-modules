import { sql } from 'drizzle-orm';
import { core, type ApiEndpoint, type RequestContext } from '$lib/sdk/server';
import type { PdfBlock } from '$lib/sdk/types';
import {
	NEEDS_ALLOCATION_SQL,
	actionsService,
	loadAccounts,
	loadTransactionsWhere,
	mdb,
	num,
	rows
} from './db';
import { loadSummaries } from './invoices.endpoints';
import { loadBankData } from './notify';
import { listPayables } from './payables';
import { centsToCsv, csvDocument, formatDateDe } from './logic';
import {
	reportQuery,
	type Overview,
	type PeriodReport,
	type ReportQuery,
	type ReportRow
} from './schemas';
import { decorateTransactions } from './transactions.endpoints';
import { syncIfStale } from './sync';

const TAGS = ['Modul: treasury'];

async function openStats() {
	const { summaries } = await loadSummaries();
	return {
		openCents: summaries.reduce((s, i) => s + i.openCents, 0),
		overdueCents: summaries.reduce((s, i) => s + (i.overdue ? i.openCents : 0), 0),
		overdueCount: summaries.filter((i) => i.overdue).length,
		creditCents: summaries.reduce((s, i) => s + i.creditCents, 0),
		invoiceCount: summaries.filter((i) => i.openCents > 0).length
	};
}

async function overview(ctx: RequestContext): Promise<Overview> {
	await syncIfStale(ctx);
	const data = await mdb().transaction(async (tx) => {
		const accounts = await loadAccounts(tx);
		const [u] = await rows(
			tx,
			sql`SELECT count(*)::int AS n, coalesce(sum(t.amount_cents - coalesce(
					(SELECT sum(al.amount_cents) FROM allocations al WHERE al.transaction_id = t.id), 0)), 0) AS s
				FROM transactions t WHERE ${NEEDS_ALLOCATION_SQL}`
		);
		const [st] = await rows(tx, sql`SELECT last_sync_at FROM sync_state WHERE id = 1`);
		return {
			accounts,
			unallocatedCount: num(u?.n),
			unallocatedCents: num(u?.s),
			recent: await loadTransactionsWhere(tx, sql`TRUE`, { limit: 8, offset: 0 }),
			lastSyncAt: st?.last_sync_at ? new Date(String(st.last_sync_at)).toISOString() : null
		};
	});
	const stats = await openStats();
	const payables = (await listPayables()).filter((p) => p.openCents > 0);
	const bank = await loadBankData();
	return {
		accounts: data.accounts.filter((a) => !a.archived || a.balanceCents !== 0),
		balanceCents: data.accounts.reduce((s, a) => s + a.balanceCents, 0),
		openCents: stats.openCents,
		overdueCents: stats.overdueCents,
		overdueCount: stats.overdueCount,
		creditCents: stats.creditCents,
		unallocatedCount: data.unallocatedCount,
		unallocatedCents: data.unallocatedCents,
		recent: await decorateTransactions(data.recent),
		lastSyncAt: data.lastSyncAt,
		payableCents: payables.reduce((s, p) => s + p.openCents, 0),
		payableCount: payables.length,
		bankMissing: !bank.iban || !bank.holder
	};
}

export async function periodReport(q: ReportQuery): Promise<PeriodReport> {
	const data = await mdb().transaction(async (tx) => {
		const accounts = await rows(
			tx,
			sql`SELECT a.id, a.name, a.opening_balance_cents,
				coalesce((SELECT sum(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.booked_on < ${q.from}), 0) AS before_cents,
				coalesce((SELECT sum(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.booked_on BETWEEN ${q.from} AND ${q.to}
					AND t.transfer_id IS NULL AND t.amount_cents > 0), 0) AS income_cents,
				coalesce((SELECT sum(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.booked_on BETWEEN ${q.from} AND ${q.to}
					AND t.transfer_id IS NULL AND t.amount_cents < 0), 0) AS expense_cents,
				coalesce((SELECT sum(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.booked_on BETWEEN ${q.from} AND ${q.to}
					AND t.transfer_id IS NOT NULL), 0) AS transfer_cents
			FROM accounts a ORDER BY a.name, a.id`
		);
		const byCategory = await rows(
			tx,
			sql`SELECT coalesce(t.category_id, '') AS key, coalesce(c.name, 'Ohne Kategorie') AS label,
				coalesce(sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS income,
				coalesce(sum(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS expense
			FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
			WHERE t.booked_on BETWEEN ${q.from} AND ${q.to} AND t.transfer_id IS NULL
			GROUP BY 1, 2 ORDER BY 2`
		);
		const byAction = await rows(
			tx,
			sql`SELECT t.action_id AS key,
				coalesce(sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS income,
				coalesce(sum(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS expense
			FROM transactions t
			WHERE t.booked_on BETWEEN ${q.from} AND ${q.to} AND t.transfer_id IS NULL AND t.action_id IS NOT NULL
			GROUP BY 1`
		);
		const [un] = await rows(
			tx,
			sql`SELECT count(*)::int AS n FROM transactions t
			WHERE t.booked_on BETWEEN ${q.from} AND ${q.to} AND t.transfer_id IS NULL AND t.category_id IS NULL
				AND t.action_id IS NULL AND NOT EXISTS (SELECT 1 FROM allocations al WHERE al.transaction_id = t.id)`
		);
		return { accounts, byCategory, byAction, unassigned: num(un?.n) };
	});
	const actionIds = data.byAction.map((r) => String(r.key));
	const names = new Map<string, string>();
	if (actionIds.length) {
		for (const a of await (await actionsService()).listActionRefs({ ids: actionIds }))
			names.set(a.id, a.name);
	}
	const accounts = data.accounts.map((a) => {
		const opening = num(a.opening_balance_cents) + num(a.before_cents);
		const income = num(a.income_cents);
		const expense = -num(a.expense_cents);
		const transfers = num(a.transfer_cents);
		return {
			id: String(a.id),
			name: String(a.name),
			openingCents: opening,
			incomeCents: income,
			expenseCents: expense,
			transfersCents: transfers,
			closingCents: opening + income - expense + transfers
		};
	});
	const row = (r: Record<string, unknown>, label: string): ReportRow => ({
		key: String(r.key),
		label,
		incomeCents: num(r.income),
		expenseCents: num(r.expense)
	});
	const incomeCents = accounts.reduce((s, a) => s + a.incomeCents, 0);
	const expenseCents = accounts.reduce((s, a) => s + a.expenseCents, 0);
	const open = await openStats();
	return {
		from: q.from,
		to: q.to,
		accounts,
		byCategory: data.byCategory.map((r) => row(r, String(r.label))),
		byAction: data.byAction
			.map((r) => row(r, names.get(String(r.key)) ?? 'Unbekannte Aktion'))
			.sort((a, b) => a.label.localeCompare(b.label, 'de')),
		totals: { incomeCents, expenseCents, resultCents: incomeCents - expenseCents },
		unassignedCount: data.unassigned,
		open: {
			openCents: open.openCents,
			overdueCents: open.overdueCents,
			creditCents: open.creditCents,
			invoiceCount: open.invoiceCount
		}
	};
}

const eur = (c: number) => `${centsToCsv(c)} €`;

export function reportBlocks(r: PeriodReport): PdfBlock[] {
	const sum = (rows: ReportRow[], k: 'incomeCents' | 'expenseCents') =>
		rows.reduce((s, x) => s + x[k], 0);
	return [
		{ type: 'heading', text: 'Kassenbericht', level: 1 },
		{ type: 'paragraph', text: `Zeitraum: ${formatDateDe(r.from)} bis ${formatDateDe(r.to)}` },
		{
			type: 'table',
			variant: 'grid',
			caption: { left: 'Konten' },
			columns: ['Konto', 'Anfangsbestand', 'Einnahmen', 'Ausgaben', 'Umbuchungen', 'Endbestand'],
			align: ['left', 'right', 'right', 'right', 'right', 'right'],
			widths: [3, 2, 2, 2, 2, 2],
			rows: r.accounts.map((a) => [
				a.name,
				eur(a.openingCents),
				eur(a.incomeCents),
				eur(a.expenseCents),
				eur(a.transfersCents),
				eur(a.closingCents)
			]),
			totalRow: [
				'Summe',
				eur(r.accounts.reduce((s, a) => s + a.openingCents, 0)),
				eur(r.totals.incomeCents),
				eur(r.totals.expenseCents),
				eur(r.accounts.reduce((s, a) => s + a.transfersCents, 0)),
				eur(r.accounts.reduce((s, a) => s + a.closingCents, 0))
			]
		},
		{
			type: 'table',
			variant: 'grid',
			caption: { left: 'Nach Kategorie' },
			columns: ['Kategorie', 'Einnahmen', 'Ausgaben'],
			align: ['left', 'right', 'right'],
			widths: [4, 2, 2],
			rows: r.byCategory.map((c) => [c.label, eur(c.incomeCents), eur(c.expenseCents)]),
			totalRow: [
				'Summe',
				eur(sum(r.byCategory, 'incomeCents')),
				eur(sum(r.byCategory, 'expenseCents'))
			]
		},
		...(r.byAction.length
			? [
					{
						type: 'table' as const,
						variant: 'grid' as const,
						caption: { left: 'Nach Aktion' },
						columns: ['Aktion', 'Einnahmen', 'Ausgaben', 'Ergebnis'],
						align: ['left', 'right', 'right', 'right'] as ('left' | 'right')[],
						widths: [4, 2, 2, 2],
						rows: r.byAction.map((a) => [
							a.label,
							eur(a.incomeCents),
							eur(a.expenseCents),
							eur(a.incomeCents - a.expenseCents)
						])
					}
				]
			: []),
		{
			type: 'paragraph',
			text: `Ergebnis des Zeitraums: ${eur(r.totals.resultCents)}${
				r.unassignedCount
					? ` · ${r.unassignedCount} Buchung(en) ohne Kategorie, Aktion oder Rechnung`
					: ''
			}`
		},
		{ type: 'heading', text: 'Offene Forderungen (Stand heute)', level: 2 },
		{
			type: 'list',
			items: [
				`Offen: ${eur(r.open.openCents)} (${r.open.invoiceCount} Rechnungen)`,
				`Davon überfällig: ${eur(r.open.overdueCents)}`,
				`Guthaben/Überzahlungen: ${eur(r.open.creditCents)}`
			]
		}
	];
}

export const reportEndpoints = [
	{
		method: 'GET',
		path: '/overview',
		summary: 'Uebersicht: Kontostaende, offene Betraege, letzte Buchungen',
		tags: TAGS,
		permission: 'treasury.cash.view',
		handler: ({ ctx }) => overview(ctx)
	},
	{
		method: 'GET',
		path: '/report',
		summary: 'Kassenbericht fuer einen Zeitraum',
		tags: TAGS,
		permission: 'treasury.report.view',
		query: reportQuery,
		handler: ({ query }) => periodReport(query as ReportQuery)
	},
	{
		method: 'GET',
		path: '/report.pdf',
		summary: 'Kassenbericht als PDF',
		tags: TAGS,
		permission: 'treasury.report.view',
		query: reportQuery,
		handler: async ({ ctx, query }) => {
			const q = query as ReportQuery;
			const r = await periodReport(q);
			const hasLetterhead = core.pdf.listTemplates().some((t) => t.id === 'stamm-briefkopf');
			const pdf = await core.pdf.generate(ctx, {
				template: hasLetterhead ? 'stamm-briefkopf' : 'default',
				title: `Kassenbericht ${formatDateDe(q.from)} – ${formatDateDe(q.to)}`,
				content: reportBlocks(r)
			});
			await core.audit.logFromContext(ctx, 'treasury.report.generated', {
				metadata: { from: q.from, to: q.to, format: 'pdf' }
			});
			return new Response(Buffer.from(pdf.buffer), {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `inline; filename="kassenbericht-${q.from}-${q.to}.pdf"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	},
	{
		method: 'GET',
		path: '/report.csv',
		summary: 'Alle Buchungen eines Zeitraums als CSV',
		tags: TAGS,
		permission: 'treasury.report.view',
		query: reportQuery,
		handler: async ({ ctx, query }) => {
			const q = query as ReportQuery;
			const raw = await mdb().transaction((tx) =>
				loadTransactionsWhere(tx, sql`t.booked_on BETWEEN ${q.from} AND ${q.to}`)
			);
			const list = (await decorateTransactions(raw)).reverse();
			const csv = csvDocument(
				[
					'Datum',
					'Konto',
					'Betrag',
					'Gegenpartei',
					'Verwendungszweck',
					'Kategorie',
					'Aktion',
					'Rechnungen',
					'Umbuchung',
					'Beleg'
				],
				list.map((t) => [
					formatDateDe(t.bookedOn),
					t.accountName,
					centsToCsv(t.amountCents),
					t.counterparty,
					t.purpose,
					t.category?.name ?? '',
					t.action?.name ?? '',
					[...new Set(t.allocations.map((a) => a.invoiceNumber))].join(', '),
					t.transferId ? (t.transferAccountName ?? 'ja') : '',
					t.receipt ? 'ja' : ''
				])
			);
			await core.audit.logFromContext(ctx, 'treasury.report.generated', {
				metadata: { from: q.from, to: q.to, format: 'csv', rows: list.length }
			});
			return new Response(csv, {
				status: 200,
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="buchungen-${q.from}-${q.to}.csv"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	}
] as ApiEndpoint[];
