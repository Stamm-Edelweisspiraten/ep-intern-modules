/**
 * Globale Suche (Befehlspalette) der Kasse.
 * - Mit `treasury.cash.view`: Rechnungen nach Nummer, Empfänger*in oder Mitgliedsname (Posten bzw.
 *   Jahresbeitrags-Anteile) und Zahler nach Name. Keine E-Mail-Adressen, keine IBAN.
 * - Nur mit `treasury.own.view`: eigene offene Rechnungen der verknüpften Mitglieder (wie `/my/invoices`).
 * Dienste (`members`) und Namensauflösung laufen außerhalb der Modul-Transaktion.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ModuleSearchProvider, RequestContext } from '$lib/sdk/server';
import type { SearchHit } from '$lib/sdk/types/search';
import { formatEuro } from '$lib/components/layout/money';
import { idList, mdb, membersService, num, rows } from './db';
import { loadSummaries } from './invoices.endpoints';
import { loadMyInvoices } from './my.endpoints';
import { INVOICE_STATUS_LABELS, type InvoiceSummary } from './schemas';

const BASE = '/modules/treasury';

function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function formatDate(isoDate: string): string {
	const [y, m, d] = isoDate.slice(0, 10).split('-');
	return `${d}.${m}.${y}`;
}

/** Offene/teilbezahlte zuerst, dann neueste Nummer */
function rank(s: InvoiceSummary): number {
	return s.status === 'open' || s.status === 'partial' ? 0 : 1;
}

function invoiceSubtitle(s: InvoiceSummary): string {
	const parts = [s.recipientName, INVOICE_STATUS_LABELS[s.status]];
	if (s.status === 'open' || s.status === 'partial') {
		parts.push(`offen ${formatEuro(s.openCents)}`);
		parts.push(
			s.overdue ? `überfällig seit ${formatDate(s.dueOn)}` : `fällig ${formatDate(s.dueOn)}`
		);
	} else {
		parts.push(formatEuro(s.totalCents));
	}
	return parts.join(' · ');
}

async function searchCash(query: string, limit: number): Promise<SearchHit[]> {
	const pattern = likePattern(query);
	// Mitglieder per Name über den Dienst `members` (vor der Transaktion)
	const memberIds = await membersService()
		.then((m) => m.searchMembers({ search: query, limit: 30 }))
		.then((found) => found.map((m) => m.id))
		.catch(() => [] as string[]);
	const memberCond: SQL = memberIds.length
		? sql`OR EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.member_id IN (${idList(memberIds)}))
			OR EXISTS (SELECT 1 FROM annual_fee_items x WHERE x.invoice_id = i.id AND x.member_id IN (${idList(memberIds)}))`
		: sql``;
	const where = sql`(i.number ILIKE ${pattern} ESCAPE '\\' OR i.recipient_name ILIKE ${pattern} ESCAPE '\\' ${memberCond})`;

	const { summaries } = await loadSummaries(where);
	const invoices = [...summaries]
		.sort((a, b) => rank(a) - rank(b) || b.number.localeCompare(a.number))
		.slice(0, limit);

	const payers = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT p.id, p.name, (SELECT count(*) FROM payer_members pm WHERE pm.payer_id = p.id) AS members
				FROM payers p
				WHERE p.name ILIKE ${pattern} ESCAPE '\\'
				ORDER BY p.name, p.id
				LIMIT ${limit}`
		)
	);

	const hits: SearchHit[] = invoices.map((s) => ({
		id: `invoice:${s.id}`,
		title: s.number,
		subtitle: invoiceSubtitle(s),
		href: `${BASE}/invoices/${encodeURIComponent(s.id)}`,
		icon: 'wallet',
		type: 'Rechnung'
	}));
	const payerHits: SearchHit[] = payers.map((p) => {
		const n = num(p.members);
		return {
			id: `payer:${String(p.id)}`,
			title: String(p.name),
			subtitle: n === 1 ? '1 Mitglied' : `${n} Mitglieder`,
			href: `${BASE}?tab=income&view=families&payer=${encodeURIComponent(String(p.id))}`,
			icon: 'users',
			type: 'Zahler'
		};
	});
	// Nach einer Rechnungsnummer gesucht → Rechnungen zuerst; sonst bis zur Hälfte Platz für Zahler
	const reserved = /^r-/i.test(query) ? 0 : Math.floor(limit / 2);
	const payerSlots = Math.min(payerHits.length, Math.max(limit - hits.length, reserved));
	return [...hits.slice(0, limit - payerSlots), ...payerHits.slice(0, payerSlots)];
}

async function searchOwn(ctx: RequestContext, query: string, limit: number): Promise<SearchHit[]> {
	const q = query.toLowerCase();
	const { invoices } = await loadMyInvoices(ctx);
	return invoices
		.filter((i) => i.number.toLowerCase().includes(q))
		.slice(0, limit)
		.map((i) => ({
			id: `invoice:${i.id}`,
			title: i.number,
			subtitle: [
				i.members.join(', ') || null,
				`offen ${formatEuro(i.openCents)}`,
				i.overdue ? `überfällig seit ${formatDate(i.dueDate)}` : `fällig ${formatDate(i.dueDate)}`
			]
				.filter(Boolean)
				.join(' · '),
			href: '/dashboard',
			icon: 'wallet',
			type: 'Rechnung'
		}));
}

export const treasurySearch: ModuleSearchProvider = {
	anyPermission: ['treasury.cash.view', 'treasury.own.view'],
	run: (ctx, query, limit) =>
		ctx.permissions.has('treasury.cash.view')
			? searchCash(query, limit)
			: searchOwn(ctx, query, limit)
};
