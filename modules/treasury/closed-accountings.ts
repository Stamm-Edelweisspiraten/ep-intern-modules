/**
 * Abgeschlossene Abrechnungen der Aktionen im Kassenbericht: Liste mit Ergebnis, PDF-Bericht
 * (inkl. Belege) und Markierung „abgelegt“ für die Ablage der Kasse. Aktionen, die nur
 * Zwischenabrechnungen haben, erscheinen als „zwischenabgerechnet“ (Liste + PDF je Zwischenabrechnung).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { core, errors, type ApiEndpoint } from '$lib/sdk/server';
import { actionsService, mdb, rows, str } from './db';
import { sanitizeName } from './logic';
import { listPayables } from './payables';
import type {
	ClosedAccounting,
	ClosedAccountingDetail,
	InterimRef
} from '$lib/modules/actions/contract';
import type { Payable } from './schemas';

const TAGS = ['Modul: treasury'];
const PERM = 'treasury.report.view';
const params = z.object({ id: z.uuid() });
const interimParams = z.object({ id: z.uuid(), interimId: z.uuid() });

/** Zwischenabrechnung in der Liste/im Detail (PDF über `/closed-accountings/:id/interims/:interimId/pdf`) */
export type AccountingInterimItem = Omit<InterimRef, 'actionId'>;

export interface ClosedAccountingItem extends Omit<ClosedAccounting, 'closedAt'> {
	/** `closed` = Schlussabrechnung abgeschlossen; `interim` = nur Zwischenabrechnungen, Aktion offen */
	status: 'closed' | 'interim';
	/** `null` bei `interim` */
	closedAt: string | null;
	/** aufsteigend nach Nummer */
	interims: AccountingInterimItem[];
	filedAt: string | null;
	filedBy: string | null;
}

export interface ClosedAccountingDetailItem extends ClosedAccountingDetail {
	interims: AccountingInterimItem[];
	filedAt: string | null;
	filedBy: string | null;
	/** Auszahlungen der Kasse zu dieser Aktion (Auslagen, Stamm-Ausgaben, Rückzahlungen) */
	payables: Payable[];
}

export const closedAccountingEndpoints = [
	{
		method: 'GET',
		path: '/closed-accountings',
		summary: 'Abgeschlossene Abrechnungen der Aktionen mit Ablage-Status',
		tags: TAGS,
		permission: PERM,
		handler: async ({ ctx }) => {
			const svc = await actionsService();
			const list = await svc.listClosedAccountings();
			const interims = await svc.listInterims();
			const byAction = groupInterims(interims);
			const closedIds = new Set(list.map((a) => a.actionId));
			const openIds = [...byAction.keys()].filter((id) => !closedIds.has(id));
			const refs = openIds.length ? await svc.listActionRefs({ ids: openIds }) : [];
			const filed = await mdb().transaction((tx) =>
				rows(tx, sql`SELECT action_id, filed_at, filed_by FROM filed_accountings`)
			);
			const userIds = [...new Set(filed.map((f) => str(f.filed_by)).filter(Boolean) as string[])];
			const users = userIds.length
				? await core.users.directory(ctx, { ids: userIds, limit: 30 }).catch(() => [])
				: [];
			const filedOf = (actionId: string) => {
				const f = filed.find((x) => x.action_id === actionId);
				const by = f ? str(f.filed_by) : null;
				return {
					filedAt: f ? new Date(String(f.filed_at)).toISOString() : null,
					filedBy: by ? (users.find((u) => u.id === by)?.name ?? 'Unbekannt') : null
				};
			};
			const closedItems = list.map((a): ClosedAccountingItem => ({
				...a,
				status: 'closed',
				interims: byAction.get(a.actionId) ?? [],
				...filedOf(a.actionId)
			}));
			// Nur zwischenabgerechnet: Summen = Summe der Zwischenabrechnungen
			const interimItems = refs.map((r): ClosedAccountingItem => {
				const its = byAction.get(r.id) ?? [];
				const incomeCents = its.reduce((s, i) => s + i.incomeCents, 0);
				const expenseCents = its.reduce((s, i) => s + i.expenseCents, 0);
				return {
					actionId: r.id,
					name: r.name,
					startsOn: r.startsOn,
					endsOn: r.endsOn,
					closedAt: null,
					incomeCents,
					expenseCents,
					balanceCents: incomeCents - expenseCents,
					status: 'interim',
					interims: its,
					...filedOf(r.id)
				};
			});
			return [...closedItems, ...interimItems];
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
		method: 'GET',
		path: '/closed-accountings/:id/interims/:interimId/pdf',
		summary: 'Bericht einer Zwischenabrechnung (PDF mit Belegen)',
		tags: TAGS,
		permission: PERM,
		params: interimParams,
		handler: async ({ ctx, params: p }) => {
			const { id, interimId } = p as { id: string; interimId: string };
			const svc = await actionsService();
			if (!(await svc.listInterims({ actionIds: [id] })).some((i) => i.id === interimId)) {
				throw errors.notFound('Zwischenabrechnung nicht gefunden');
			}
			const pdf = await svc.interimReportPdf(
				id,
				interimId,
				core.permissions.has(ctx, 'treasury.bank.view'),
				ctx
			);
			return new Response(Buffer.from(pdf.data), {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `inline; filename="${sanitizeName(pdf.fileName)}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	},
	{
		method: 'GET',
		path: '/closed-accountings/:id',
		summary: 'Abgeschlossene Abrechnung einer Aktion lesen (Buchungen, Soll/Ist, Auszahlungen)',
		tags: TAGS,
		permission: PERM,
		params,
		handler: async ({ ctx, params: p }) => {
			const { id } = p as { id: string };
			const detail = await (await actionsService()).getClosedAccounting(id);
			if (!detail) throw errors.notFound('Abgeschlossene Abrechnung nicht gefunden');
			const payables = await listPayables(sql`p.action_id = ${id} AND p.source <> 'manual'`);
			const interims =
				groupInterims(await (await actionsService()).listInterims({ actionIds: [id] })).get(id) ??
				[];
			const [filed] = await mdb().transaction((tx) =>
				rows(tx, sql`SELECT filed_at, filed_by FROM filed_accountings WHERE action_id = ${id}`)
			);
			const by = filed ? str(filed.filed_by) : null;
			const users = by
				? await core.users.directory(ctx, { ids: [by], limit: 30 }).catch(() => [])
				: [];
			const out: ClosedAccountingDetailItem = {
				...detail,
				interims,
				filedAt: filed ? new Date(String(filed.filed_at)).toISOString() : null,
				filedBy: by ? (users.find((u) => u.id === by)?.name ?? 'Unbekannt') : null,
				payables
			};
			return out;
		}
	},
	{
		method: 'GET',
		path: '/closed-accountings/:id/receipts/:entryId',
		summary: 'Beleg einer Buchung aus einer abgeschlossenen Abrechnung anzeigen',
		tags: TAGS,
		permission: PERM,
		params: z.object({ id: z.uuid(), entryId: z.uuid() }),
		handler: async ({ ctx, params: p }) => {
			await core.permissions.require(ctx, 'treasury.storage.read');
			const { id, entryId } = p as { id: string; entryId: string };
			const svc = await actionsService();
			if (!(await svc.getClosedAccounting(id))) {
				throw errors.notFound('Abgeschlossene Abrechnung nicht gefunden');
			}
			const file = await svc.downloadReceipt(id, entryId);
			if (!file) throw errors.notFound('Beleg nicht gefunden');
			await core.audit.logFromContext(ctx, 'treasury.accounting.receipt_viewed', {
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
	},
	{
		method: 'PUT',
		path: '/closed-accountings/:id/filed',
		summary: 'Abrechnung als abgelegt markieren bzw. zurücknehmen',
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

function groupInterims(list: InterimRef[]): Map<string, AccountingInterimItem[]> {
	const out = new Map<string, AccountingInterimItem[]>();
	for (const { actionId, ...rest } of [...list].sort((a, b) => a.number - b.number)) {
		const arr = out.get(actionId) ?? [];
		arr.push(rest);
		out.set(actionId, arr);
	}
	return out;
}
