/** Verlauf (Historie) einer Rechnung, Buchung oder Auszahlung aus dem Audit-Log (`GET /history`) */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { core, errors, type ApiEndpoint } from '$lib/sdk/server';
import { mdb, rows } from './db';
import {
	HISTORY_ACTIONS,
	HISTORY_ID,
	HISTORY_KINDS,
	historyLabel,
	type HistoryEntry,
	type HistoryKind
} from './history-labels';

const TAGS = ['Modul: treasury'];

const historyQuery = z
	.object({ kind: z.enum(HISTORY_KINDS), id: z.string().regex(HISTORY_ID) })
	.strict();

const TABLE: Record<HistoryKind, string> = {
	invoice: 'invoices',
	transaction: 'transactions',
	payable: 'payables'
};

/** Entität laden und – bei Rechnungen – die aktuell zugeordneten Buchungen (ihre Einträge gehören mit zum Verlauf) */
async function relatedTargets(kind: HistoryKind, id: string): Promise<string[]> {
	return mdb().transaction(async (tx) => {
		const found = await rows(tx, sql`SELECT id FROM ${sql.raw(TABLE[kind])} WHERE id = ${id}`);
		// Gelöschte Objekte behalten ihren Verlauf nicht lesbar: unbekannt → 404
		if (!found.length) throw errors.notFound('Objekt nicht gefunden');
		if (kind !== 'invoice') return [];
		const tx_ = await rows(
			tx,
			sql`SELECT DISTINCT a.transaction_id FROM allocations a
				JOIN invoice_lines l ON l.id = a.line_id WHERE l.invoice_id = ${id}`
		);
		return tx_.map((r) => String(r.transaction_id));
	});
}

export async function loadHistory(kind: HistoryKind, id: string): Promise<HistoryEntry[]> {
	const related = await relatedTargets(kind, id);
	const { rows: audit } = await core.audit.list({ targets: [id, ...related], limit: 200 });
	return audit
		.filter((r) => HISTORY_ACTIONS.has(r.action))
		.map((r) => ({
			id: r.id,
			at: new Date(String(r.createdAt)).toISOString(),
			action: r.action,
			label: historyLabel(r.action, r.metadata as Record<string, unknown> | null),
			actor: r.actorName ?? 'System',
			related: r.target !== id
		}));
}

export const historyEndpoints = [
	{
		method: 'GET',
		path: '/history',
		summary: 'Verlauf einer Rechnung, Buchung oder Auszahlung',
		tags: TAGS,
		permission: 'treasury.report.view',
		query: historyQuery,
		handler: async ({ ctx, query }) => {
			await core.permissions.require(ctx, 'treasury.cash.view');
			const q = query as z.infer<typeof historyQuery>;
			return { items: await loadHistory(q.kind, q.id) };
		}
	}
] as ApiEndpoint[];
