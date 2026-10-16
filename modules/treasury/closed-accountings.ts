/**
 * Abgeschlossene Abrechnungen der Aktionen im Kassenbericht: Liste mit Ergebnis, PDF-Bericht
 * (inkl. Belege) und Markierung „abgelegt“ fuer die Ablage der Kasse.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { core, errors, type ApiEndpoint } from '$lib/sdk/server';
import { actionsService, mdb, rows, str } from './db';
import type { ClosedAccounting } from '$lib/modules/actions/contract';

const TAGS = ['Modul: treasury'];
const PERM = 'treasury.report.view';
const params = z.object({ id: z.uuid() });

export interface ClosedAccountingItem extends ClosedAccounting {
	filedAt: string | null;
	filedBy: string | null;
}

export const closedAccountingEndpoints = [
	{
		method: 'GET',
		path: '/closed-accountings',
		summary: 'Abgeschlossene Abrechnungen der Aktionen mit Ablage-Status',
		tags: TAGS,
		permission: PERM,
		handler: async ({ ctx }) => {
			const list = await (await actionsService()).listClosedAccountings();
			const filed = await mdb().transaction((tx) =>
				rows(tx, sql`SELECT action_id, filed_at, filed_by FROM filed_accountings`)
			);
			const userIds = [...new Set(filed.map((f) => str(f.filed_by)).filter(Boolean) as string[])];
			const users = userIds.length
				? await core.users.directory(ctx, { ids: userIds, limit: 30 }).catch(() => [])
				: [];
			return list.map((a): ClosedAccountingItem => {
				const f = filed.find((x) => x.action_id === a.actionId);
				const by = f ? str(f.filed_by) : null;
				return {
					...a,
					filedAt: f ? new Date(String(f.filed_at)).toISOString() : null,
					filedBy: by ? (users.find((u) => u.id === by)?.name ?? 'Unbekannt') : null
				};
			});
		}
	},
	{
		method: 'GET',
		path: '/closed-accountings/:id/pdf',
		summary: 'Abrechnungsbericht einer abgeschlossenen Aktion (PDF mit Belegen)',
		tags: TAGS,
		permission: PERM,
		params,
		handler: async ({ ctx, params: p }) => {
			const { id } = p as { id: string };
			const svc = await actionsService();
			if (!(await svc.listClosedAccountings()).some((a) => a.actionId === id)) {
				throw errors.notFound('Abgeschlossene Abrechnung nicht gefunden');
			}
			const pdf = await svc.accountingReportPdf(
				id,
				core.permissions.has(ctx, 'treasury.bank.view'),
				ctx
			);
			return new Response(Buffer.from(pdf.data), {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `inline; filename="${pdf.fileName}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	},
	{
		method: 'PUT',
		path: '/closed-accountings/:id/filed',
		summary: 'Abrechnung als abgelegt markieren bzw. zuruecknehmen',
		tags: TAGS,
		permission: PERM,
		params,
		body: z.object({ filed: z.boolean() }),
		handler: async ({ ctx, params: p, body }) => {
			const { id } = p as { id: string };
			const { filed } = body as { filed: boolean };
			await mdb().transaction((tx) =>
				filed
					? tx.execute(
							sql`INSERT INTO filed_accountings (action_id, filed_by) VALUES (${id}, ${ctx.userId})
							ON CONFLICT (action_id) DO UPDATE SET filed_at = now(), filed_by = excluded.filed_by`
						)
					: tx.execute(sql`DELETE FROM filed_accountings WHERE action_id = ${id}`)
			);
			await core.audit.logFromContext(ctx, 'treasury.accounting.filed', {
				target: id,
				metadata: { filed }
			});
			return { actionId: id, filed };
		}
	}
] as ApiEndpoint[];
