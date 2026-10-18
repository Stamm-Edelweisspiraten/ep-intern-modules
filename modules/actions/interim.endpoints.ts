/**
 * Zwischenabrechnungen: eingefrorene Abbilder des gesamten Abrechnungsstands (Spalte `snapshot`).
 * Sie bauen nicht aufeinander auf und sperren keine Buchungen. Auslagen (bezahlt von Person), die in
 * einer Zwischenabrechnung enthalten sind (`accounting_interim_entries`), gibt die Kasse sofort zur
 * Auszahlung frei (`ActionsService.listReimbursements`). Rückzahlung des Überschusses nur beim Abschluss.
 */
import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type RequestContext, type Tx } from '$lib/sdk/server';
import { requireAccess, rowsOf, type ActionAccess } from './access';
import { loadState } from './accounting.endpoints';
import {
	assertOpen,
	buildInterimSnapshot,
	loadInterims,
	loadTreasuryContributions,
	resolveInterimUsers
} from './accounting-core';
import { buildAccountingReport } from './payouts.endpoints';
import {
	MODULE_ID,
	idParams,
	interimInput,
	interimParams,
	interimRevertQuery,
	type AccountingInterim,
	type InterimInput,
	type InterimRevertWarning
} from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

/** Sperrt die Aktion (serialisiert Nummernvergabe und Rücknahme). */
async function lockAction(tx: Tx, actionId: string): Promise<void> {
	const [a] = await rowsOf(tx, sql`SELECT id FROM actions WHERE id = ${actionId} FOR UPDATE`);
	if (!a) throw errors.notFound('Aktion nicht gefunden');
}

/** Recht zum Zurücknehmen von Zwischenabrechnungen: Eigentümer*in oder `edit-all`. */
const canManage = (ctx: RequestContext, access: ActionAccess): boolean =>
	access.isOwner || core.permissions.has(ctx, 'actions.action.edit-all');

const WARNING_TEXT: Record<InterimRevertWarning, string> = {
	closed: 'die Abrechnung ist abgeschlossen',
	paid: 'Auslagen daraus wurden bereits erstattet und sind in keiner anderen Zwischenabrechnung enthalten'
};

async function findInterim(
	tx: Tx,
	actionId: string,
	interimId: string,
	manage: boolean
): Promise<AccountingInterim> {
	const found = (await loadInterims(tx, actionId, manage)).find((i) => i.id === interimId);
	if (!found) throw errors.notFound('Zwischenabrechnung nicht gefunden');
	return found;
}

export const interimEndpoints = [
	{
		method: 'GET',
		path: '/actions/:id/accounting/interims',
		summary: 'Zwischenabrechnungen einer Aktion',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const list = await mdb().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'read');
				return loadInterims(tx, id, canManage(ctx, access));
			});
			await resolveInterimUsers(ctx, list);
			return list;
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/interims',
		summary: 'Zwischenabrechnung erstellen (Abbild des gesamten Abrechnungsstands)',
		description:
			'409 ohne Buchung, bei abgeschlossener Abrechnung oder bei Ausgaben ohne Beleg ' +
			'(außer acceptMissingReceipts). Enthaltene Auslagen gehen sofort als Auszahlung an die Kasse.',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: interimInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as InterimInput;
			// Kasse (Core-Dienst) vor der Transaktion
			const treasury = await loadTreasuryContributions(id);
			const interim = await mdb().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await lockAction(tx, id);
				const [c] = await rowsOf(
					tx,
					sql`SELECT count(*) AS n,
							count(*) FILTER (WHERE type = 'expense' AND category <> 'refund'
								AND receipt_path IS NULL) AS missing
						FROM accounting_entries WHERE action_id = ${id}`
				);
				if (Number(c?.n ?? 0) === 0) {
					throw errors.conflict('Es gibt noch keine Buchungen für eine Zwischenabrechnung');
				}
				const missing = Number(c?.missing ?? 0);
				if (missing > 0 && !input.acceptMissingReceipts) {
					throw errors.conflict(
						`${missing} ${missing === 1 ? 'Ausgabe hat' : 'Ausgaben haben'} keinen Beleg`
					);
				}
				// Gleicher Weg wie GET …/accounting; Empfänger immer (ohne Bankdaten im Abbild)
				const { state } = await loadState(tx, id, treasury, true);
				const snapshot = buildInterimSnapshot({
					takenAt: new Date().toISOString(),
					entries: state.entries,
					summary: state.summary,
					plan: state.plan,
					autoIncome: state.autoIncome,
					payees: state.payees ?? []
				});
				const [m] = await rowsOf(
					tx,
					sql`SELECT coalesce(max(number), 0) AS n FROM accounting_interims WHERE action_id = ${id}`
				);
				const number = Number(m?.n ?? 0) + 1;
				const interimId = crypto.randomUUID();
				await tx.execute(
					sql`INSERT INTO accounting_interims (id, action_id, number, note, created_by, snapshot)
						VALUES (${interimId}, ${id}, ${number}, ${input.note ?? null}, ${ctx.userId ?? null},
							${JSON.stringify(snapshot)}::jsonb)`
				);
				await tx.execute(
					sql`INSERT INTO accounting_interim_entries (interim_id, entry_id)
						SELECT ${interimId}, id FROM accounting_entries WHERE action_id = ${id}`
				);
				return { ...(await findInterim(tx, id, interimId, canManage(ctx, access))), missing };
			});
			const { missing, ...result } = interim;
			await core.audit.logFromContext(ctx, 'actions.accounting.interim_created', {
				target: id,
				metadata: {
					actionId: id,
					interimId: result.id,
					number: result.number,
					entryCount: result.entryCount,
					incomeCents: result.incomeCents,
					expenseCents: result.expenseCents,
					reimbursementCents: result.reimbursementCents,
					missingReceipts: missing
				}
			});
			await resolveInterimUsers(ctx, [result]);
			return result;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/accounting/interims/:interimId',
		summary: 'Zwischenabrechnung zurücknehmen',
		description:
			'Jede Zwischenabrechnung, nur Eigentümer*in oder actions.action.edit-all. Wurden Auslagen daraus ' +
			'bereits erstattet, die weder in einer anderen Zwischenabrechnung enthalten noch durch den Abschluss ' +
			'freigegeben sind (`revertWarnings: paid`), antwortet der Endpoint mit 409, bis `force=true` die ' +
			'Rücknahme bestätigt. Buchungen bleiben unverändert, erstattete Auslagen bleiben erstattet.',
		tags: TAGS,
		permission: 'actions.action.view',
		params: interimParams,
		query: interimRevertQuery,
		handler: async ({ ctx, params, query }) => {
			const { id, interimId } = params as { id: string; interimId: string };
			const { force } = query as { force: boolean };
			const res = await mdb().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'edit');
				if (!canManage(ctx, access)) {
					throw errors.forbidden('Nur Eigentümer*in darf eine Zwischenabrechnung zurücknehmen');
				}
				await lockAction(tx, id);
				const interim = await findInterim(tx, id, interimId, true);
				if (interim.revertWarnings.length && !force) {
					throw errors.conflict(
						`Bestätigung erforderlich: ${interim.revertWarnings.map((w) => WARNING_TEXT[w]).join(' und ')}`
					);
				}
				// Zuordnungen per CASCADE; reimbursed_at bleibt: erstattete Auslagen nicht erneut auszahlen
				await tx.execute(sql`DELETE FROM accounting_interims WHERE id = ${interimId}`);
				return {
					number: interim.number,
					entryCount: interim.entryCount,
					paid: interim.revertWarnings.includes('paid')
				};
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.interim_reverted', {
				target: id,
				metadata: {
					actionId: id,
					interimId,
					number: res.number,
					entryCount: res.entryCount,
					forced: force,
					paid: res.paid
				}
			});
			return { id: interimId, number: res.number };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/accounting/interims/:interimId/report.pdf',
		summary: 'Bericht einer Zwischenabrechnung als PDF (Belege als Anhang)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: interimParams,
		handler: async ({ ctx, params }) => {
			const { id, interimId } = params as { id: string; interimId: string };
			const pdf = await buildAccountingReport(ctx, id, {
				withBank: core.permissions.has(ctx, 'actions.payout.view'),
				canAttach: core.permissions.has(ctx, 'actions.storage.read'),
				checkAccess: true,
				interimId
			});
			return new Response(Buffer.from(pdf.buffer), {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `inline; filename="${pdf.fileName}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	} as ApiEndpoint
] as ApiEndpoint[];
