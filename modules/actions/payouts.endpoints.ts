import { randomUUID } from 'node:crypto';
import { notifyAccounting } from './notify';
import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	core,
	errors,
	moduleDb,
	type RequestContext,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { requireAccess } from './access';
import {
	assertOpen,
	closedInfo,
	loadAutoIncome,
	loadTreasuryContributions,
	loadEntries,
	loadInterimSnapshot,
	loadRefundSnapshot,
	notifyTreasuryAccountingClosed
} from './accounting-core';
import {
	buildReportBlocks,
	numberExpenses,
	payeeTotals,
	summarize,
	toPayoutCsv,
	toSummaryEntry
} from './accounting';
import { formatEuro } from '$lib/components/layout/money';
import { safeFilename } from './form-support';
import { ibanLast, maskFromLast } from './iban';
import type { PdfAttachment } from '$lib/sdk/types';
import {
	MODULE_ID,
	closeInput,
	idParams,
	payeeInput,
	payeeParams,
	payeeUpdateInput,
	type AccountingPayee,
	type PayeeInput,
	type PayoutRow,
	type ReportInput,
	type SummaryEntry
} from './schemas';

const TAGS = ['Modul: actions'];
const PAYOUT_PERMISSION = 'actions.payout.view';
const crypt = () => core.crypto.forModule(MODULE_ID);
const ATTACHABLE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_ATTACHMENTS = 80;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const euroText = formatEuro;

const str = (v: unknown): string | null => (v == null ? null : String(v));

async function actionName(tx: Tx, id: string): Promise<string> {
	const [a] = await rowsOf(tx, sql`SELECT name FROM actions WHERE id = ${id}`);
	if (!a) throw errors.notFound('Aktion nicht gefunden');
	return String(a.name);
}

/** Empfänger mit Summen (ohne IBAN im Klartext). */
async function loadPayee(tx: Tx, actionId: string, payeeId: string): Promise<AccountingPayee> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT p.id, p.name, p.iban_last4, p.bic, p.note,
				COALESCE(SUM(e.amount_cents) FILTER (WHERE e.reimbursed_at IS NULL), 0) AS open_cents,
				COALESCE(SUM(e.amount_cents) FILTER (WHERE e.reimbursed_at IS NOT NULL), 0) AS done_cents,
				COUNT(e.id) FILTER (WHERE e.reimbursed_at IS NULL) AS open_entries
			FROM accounting_payees p
			LEFT JOIN accounting_entries e ON e.payee_id = p.id AND e.paid_by = 'person'
			WHERE p.id = ${payeeId} AND p.action_id = ${actionId}
			GROUP BY p.id`
	);
	if (!r) throw errors.notFound('Person nicht gefunden');
	return {
		id: String(r.id),
		name: String(r.name),
		ibanMasked: maskFromLast(str(r.iban_last4)),
		bic: str(r.bic),
		note: str(r.note),
		openCents: Number(r.open_cents),
		reimbursedCents: Number(r.done_cents),
		openEntries: Number(r.open_entries)
	};
}

async function payeeExists(tx: Tx, actionId: string, payeeId: string): Promise<void> {
	const rows = await rowsOf(
		tx,
		sql`SELECT 1 AS x FROM accounting_payees WHERE id = ${payeeId} AND action_id = ${actionId}`
	);
	if (!rows.length) throw errors.notFound('Person nicht gefunden');
}

const noStore = { 'cache-control': 'no-store' };

function reimburseEndpoint(method: 'POST' | 'DELETE'): ApiEndpoint {
	const apply = method === 'POST';
	return {
		method,
		path: '/actions/:id/accounting/payees/:payeeId/reimburse',
		summary: apply
			? 'Offene Auslagen einer Person als ausgezahlt markieren'
			: 'Auszahlung zurücknehmen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: payeeParams,
		handler: async ({ ctx, params }: { ctx: RequestContext; params: unknown }) => {
			await core.permissions.require(ctx, PAYOUT_PERMISSION);
			const { id, payeeId } = params as { id: string; payeeId: string };
			const res = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await payeeExists(tx, id, payeeId);
				const rows = await rowsOf(
					tx,
					apply
						? sql`UPDATE accounting_entries SET reimbursed_at = now(), updated_at = now()
							WHERE action_id = ${id} AND payee_id = ${payeeId} AND paid_by = 'person'
								AND type = 'expense' AND reimbursed_at IS NULL
							RETURNING amount_cents`
						: sql`UPDATE accounting_entries SET reimbursed_at = NULL, reimbursed_upfront = false,
									updated_at = now()
							WHERE action_id = ${id} AND payee_id = ${payeeId} AND paid_by = 'person'
								AND reimbursed_at IS NOT NULL
							RETURNING amount_cents`
				);
				return {
					payeeId,
					count: rows.length,
					amountCents: rows.reduce((s, r) => s + Number(r.amount_cents), 0)
				};
			});
			await core.audit.logFromContext(
				ctx,
				apply ? 'actions.accounting.reimbursed' : 'actions.accounting.reimbursement_reverted',
				{
					target: id,
					metadata: { actionId: id, payeeId, count: res.count, amountCents: res.amountCents }
				}
			);
			return res;
		}
	} as ApiEndpoint;
}

/**
 * Abrechnungsbericht (PDF inkl. Beleg-Anhängen). `checkAccess=false` nur für vertrauenswürdige
 * Aufrufer (Dienst für die Kasse); dann läuft der Abruf mit dem übergebenen (System-)Kontext.
 * Mit `interimId` entsteht der Bericht einer Zwischenabrechnung: ein eingefrorenes Abbild des
 * gesamten Abrechnungsstands zum Stichtag (Snapshot); Bankdaten und Belegdateien werden live
 * nachgeladen, eine Rückzahlung gibt es dort nicht.
 */
export async function buildAccountingReport(
	ctx: RequestContext,
	id: string,
	opts: {
		withBank: boolean;
		canAttach: boolean;
		checkAccess: boolean;
		auditCtx?: RequestContext;
		interimId?: string;
	}
): Promise<{ buffer: Uint8Array; fileName: string }> {
	const withBank = opts.withBank;
	const interimId = opts.interimId ?? null;
	const treasury = interimId ? null : await loadTreasuryContributions(id);
	const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
		if (opts.checkAccess) await requireAccess(tx, ctx, id, 'read');
		const [a] = await rowsOf(
			tx,
			sql`SELECT name, location, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM actions WHERE id = ${id}`
		);
		if (!a) throw errors.notFound('Aktion nicht gefunden');
		const payees = await rowsOf(
			tx,
			sql`SELECT id, name, bic, iban_enc, iban_last4 FROM accounting_payees
				WHERE action_id = ${id} ORDER BY name, id`
		);
		const receipts = await rowsOf(
			tx,
			sql`SELECT id, receipt_path FROM accounting_entries
				WHERE action_id = ${id} AND receipt_path IS NOT NULL`
		);
		if (interimId) {
			const { interim, snapshot } = await loadInterimSnapshot(tx, id, interimId);
			return {
				a,
				payees,
				receipts,
				interim: { id: interim.id, number: interim.number, takenAt: snapshot.takenAt },
				snapshot,
				entries: snapshot.entries,
				closed: null,
				refund: null,
				autoIncome: snapshot.autoIncome
			};
		}
		const entries = await loadEntries(tx, id);
		return {
			a,
			payees,
			receipts,
			interim: null,
			snapshot: null,
			entries,
			closed: await closedInfo(tx, id),
			refund: await loadRefundSnapshot(tx, id),
			autoIncome: await loadAutoIncome(tx, id, entries, treasury)
		};
	});
	const { interim, snapshot } = data;

	// Core-Services erst nach der Transaktion: IBAN entschlüsseln, Belege laden.
	const ibanOf = (p: Record<string, unknown>): string | null => {
		if (!p.iban_enc) return null;
		if (withBank) {
			try {
				return crypt().decrypt(String(p.iban_enc));
			} catch {
				return null;
			}
		}
		return maskFromLast(str(p.iban_last4));
	};
	const livePayees = new Map(data.payees.map((p) => [String(p.id), p]));
	let payees: ReportInput['payees'];
	let summary: ReportInput['summary'];
	if (snapshot) {
		summary = snapshot.summary;
		// Beträge aus dem Stichtag, Bankdaten live (gelöschte Personen ohne Bankdaten)
		payees = snapshot.payees.map((p) => {
			const live = livePayees.get(p.id);
			return {
				name: p.name,
				openCents: p.openCents,
				reimbursedCents: p.reimbursedCents,
				iban: live ? ibanOf(live) : null,
				bic: live ? str(live.bic) : null
			};
		});
	} else {
		const se: SummaryEntry[] = data.entries.map(toSummaryEntry);
		const totals = payeeTotals(se);
		summary = summarize(se, null, data.autoIncome);
		payees = data.payees.map((n) => {
			const t = totals.get(String(n.id));
			return {
				name: String(n.name),
				openCents: t?.openCents ?? 0,
				reimbursedCents: t?.reimbursedCents ?? 0,
				iban: ibanOf(n),
				bic: str(n.bic)
			};
		});
	}

	const numbering = numberExpenses(data.entries);
	const paths = new Map(data.receipts.map((r) => [String(r.id), String(r.receipt_path)]));
	// ZA: nur Belege, die zum Stichtag vorhanden waren (Pfade live; gelöscht → fehlend)
	const receiptIds = snapshot ? new Set(snapshot.receiptEntryIds) : null;
	const attachments: PdfAttachment[] = [];
	const attachedEntryIds: string[] = [];
	let missingAttachments = 0;
	const canAttach = opts.canAttach;
	const withReceipt = data.entries
		.filter(
			(e) =>
				e.type === 'expense' &&
				e.category !== 'refund' &&
				e.receipt &&
				(!receiptIds || receiptIds.has(e.id))
		)
		.sort((x, y) => (numbering.get(x.id) ?? 0) - (numbering.get(y.id) ?? 0));
	let totalBytes = 0;
	let storageDown = false;
	for (const e of withReceipt) {
		const path = paths.get(e.id);
		if (!canAttach || storageDown || !path || attachments.length >= MAX_ATTACHMENTS) {
			missingAttachments += 1;
			continue;
		}
		try {
			const { buffer, file } = await core.storage.download(ctx, { module: MODULE_ID, path });
			const contentType = (file.contentType || e.receipt!.contentType || '').toLowerCase();
			if (
				!ATTACHABLE_TYPES.includes(contentType) ||
				totalBytes + buffer.byteLength > MAX_ATTACHMENT_BYTES
			) {
				missingAttachments += 1;
				continue;
			}
			totalBytes += buffer.byteLength;
			attachments.push({
				label: `Beleg Nr. ${numbering.get(e.id)}`,
				caption: `${e.description} – ${euroText(e.amountCents)}`,
				contentType,
				data: new Uint8Array(buffer)
			});
			attachedEntryIds.push(e.id);
		} catch (err) {
			missingAttachments += 1;
			if ((err as { code?: string })?.code === 'unavailable') storageDown = true;
		}
	}

	const input: ReportInput = {
		actionName: String(data.a.name),
		location: str(data.a.location),
		startsOn: String(data.a.starts_on),
		endsOn: str(data.a.ends_on),
		closedAt: data.closed?.at ?? null,
		entries: data.entries,
		summary,
		autoIncome: data.autoIncome,
		interim: interim ? { number: interim.number, takenAt: interim.takenAt } : null,
		payees,
		refund: data.refund
			? {
					items: data.refund.items.map((i) => ({
						name: i.name,
						amountCents: i.amountCents,
						donatedCents: i.donatedCents
					})),
					totalCents: data.refund.totalCents,
					remainderCents: data.refund.remainderCents,
					bookedAt: data.refund.bookedAt
				}
			: null,
		missingAttachments,
		attachedEntryIds
	};
	const hasLetterhead = core.pdf.listTemplates().some((t) => t.id === 'stamm-briefkopf');
	const pdf = await core.pdf.generate(ctx, {
		template: hasLetterhead ? 'stamm-briefkopf' : 'default',
		title: interim
			? `Zwischenabrechnung Nr. ${interim.number} – ${input.actionName}`
			: `Abrechnung – ${input.actionName}`,
		content: buildReportBlocks(input),
		attachments
	});
	await core.audit.logFromContext(opts.auditCtx ?? ctx, 'actions.accounting.report', {
		target: id,
		metadata: {
			actionId: id,
			withBank,
			attachments: attachments.length,
			missingAttachments,
			...(interim ? { interimId: interim.id, interimNumber: interim.number } : {})
		}
	});
	// Wie der Schlussbericht (core sanitizeFileName): Umlaute ohne Akzent, sonst nur [A-Za-z0-9._-]
	const safeName =
		input.actionName
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[^a-zA-Z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'Aktion';
	const fileName = interim
		? `Zwischenabrechnung-${safeName}-ZA${interim.number}.pdf`
		: pdf.fileName;
	return { buffer: pdf.buffer, fileName };
}

export const payoutEndpoints: ApiEndpoint[] = [
	{
		method: 'POST',
		path: '/actions/:id/accounting/payees',
		summary: 'Person mit Bankdaten für Auslagen anlegen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: payeeInput,
		handler: async ({ ctx, params, body }) => {
			await core.permissions.require(ctx, PAYOUT_PERMISSION);
			const id = (params as { id: string }).id;
			const input = body as PayeeInput;
			const payeeId = randomUUID();
			const enc = crypt().encrypt(input.iban);
			const payee = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await tx.execute(
					sql`INSERT INTO accounting_payees (id, action_id, name, iban_enc, iban_last4, bic, note)
						VALUES (${payeeId}, ${id}, ${input.name}, ${enc}, ${ibanLast(input.iban)},
							${input.bic}, ${input.note ?? null})`
				);
				return loadPayee(tx, id, payeeId);
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.payee_created', {
				target: id,
				metadata: { actionId: id, payeeId }
			});
			return payee;
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/accounting/payees/:payeeId',
		summary: 'Person bearbeiten',
		tags: TAGS,
		permission: 'actions.action.view',
		params: payeeParams,
		body: payeeUpdateInput,
		handler: async ({ ctx, params, body }) => {
			await core.permissions.require(ctx, PAYOUT_PERMISSION);
			const { id, payeeId } = params as { id: string; payeeId: string };
			const input = body as Omit<PayeeInput, 'iban'> & { iban?: string };
			const enc = input.iban ? crypt().encrypt(input.iban) : null;
			const last = input.iban ? ibanLast(input.iban) : null;
			const payee = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await payeeExists(tx, id, payeeId);
				await tx.execute(
					sql`UPDATE accounting_payees SET name = ${input.name}, bic = ${input.bic},
							note = ${input.note ?? null},
							iban_enc = COALESCE(${enc}::text, iban_enc),
							iban_last4 = COALESCE(${last}::text, iban_last4)
						WHERE id = ${payeeId} AND action_id = ${id}`
				);
				return loadPayee(tx, id, payeeId);
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.payee_updated', {
				target: id,
				metadata: { actionId: id, payeeId, ibanChanged: !!input.iban }
			});
			return payee;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/accounting/payees/:payeeId',
		summary: 'Person löschen (nur ohne Buchungen)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: payeeParams,
		handler: async ({ ctx, params }) => {
			await core.permissions.require(ctx, PAYOUT_PERMISSION);
			const { id, payeeId } = params as { id: string; payeeId: string };
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await payeeExists(tx, id, payeeId);
				const used = await rowsOf(
					tx,
					sql`SELECT 1 AS x FROM accounting_entries WHERE payee_id = ${payeeId} LIMIT 1`
				);
				if (used.length) throw errors.conflict('Es gibt noch Buchungen zu dieser Person');
				await tx.execute(
					sql`DELETE FROM accounting_payees WHERE id = ${payeeId} AND action_id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.payee_deleted', {
				target: id,
				metadata: { actionId: id, payeeId }
			});
			return { id: payeeId };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/accounting/payees/:payeeId/iban',
		summary: 'IBAN einer Person entschlüsselt lesen (nur Bearbeiten-Dialog)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: payeeParams,
		handler: async ({ ctx, params }) => {
			await core.permissions.require(ctx, PAYOUT_PERMISSION);
			const { id, payeeId } = params as { id: string; payeeId: string };
			const enc = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const [r] = await rowsOf(
					tx,
					sql`SELECT iban_enc FROM accounting_payees WHERE id = ${payeeId} AND action_id = ${id}`
				);
				if (!r) throw errors.notFound('Person nicht gefunden');
				return str(r.iban_enc);
			});
			const iban = enc ? crypt().decrypt(enc) : '';
			await core.audit.logFromContext(ctx, 'actions.accounting.iban_viewed', {
				target: id,
				metadata: { actionId: id, payeeId }
			});
			return new Response(JSON.stringify({ data: { iban } }), {
				status: 200,
				headers: { 'content-type': 'application/json; charset=utf-8', ...noStore }
			});
		}
	} as ApiEndpoint,
	reimburseEndpoint('POST'),
	reimburseEndpoint('DELETE'),
	{
		method: 'GET',
		path: '/actions/:id/accounting/payouts.csv',
		summary: 'Auszahlungsliste als CSV (mit IBAN)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			await core.permissions.require(ctx, PAYOUT_PERMISSION);
			const id = (params as { id: string }).id;
			const { name, list } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				const name = await actionName(tx, id);
				const list = await rowsOf(
					tx,
					sql`SELECT p.id, p.name, p.iban_enc, p.bic,
							SUM(e.amount_cents) AS amount, COUNT(e.id) AS cnt
						FROM accounting_payees p
						JOIN accounting_entries e ON e.payee_id = p.id AND e.paid_by = 'person'
							AND e.type = 'expense' AND e.reimbursed_at IS NULL
						WHERE p.action_id = ${id}
						GROUP BY p.id
						HAVING SUM(e.amount_cents) > 0
						ORDER BY p.name, p.id`
				);
				return { name, list };
			});
			const purpose = `${name} Auslagenerstattung`.slice(0, 140);
			const rows: PayoutRow[] = list.map((r) => ({
				payeeId: String(r.id),
				name: String(r.name),
				iban: r.iban_enc ? crypt().decrypt(String(r.iban_enc)) : '',
				bic: str(r.bic),
				amountCents: Number(r.amount),
				purpose,
				entryCount: Number(r.cnt)
			}));
			const csv = toPayoutCsv(rows);
			await core.audit.logFromContext(ctx, 'actions.accounting.exported', {
				target: id,
				metadata: { actionId: id, rows: rows.length }
			});
			return new Response(csv, {
				status: 200,
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="${safeFilename(name, '-auszahlung.csv')}"`,
					...noStore
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/close',
		summary: 'Abrechnung abschließen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: closeInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const { acceptMissingReceipts } = body as { acceptMissingReceipts: boolean };
			const res = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				const [c] = await rowsOf(
					tx,
					sql`SELECT COUNT(*) AS n FROM accounting_entries
						WHERE action_id = ${id} AND type = 'expense' AND category <> 'refund' AND receipt_path IS NULL`
				);
				const missing = Number(c?.n ?? 0);
				if (missing > 0 && !acceptMissingReceipts) {
					throw errors.conflict(
						`${missing} ${missing === 1 ? 'Ausgabe hat' : 'Ausgaben haben'} keinen Beleg`
					);
				}
				const [r] = await rowsOf(
					tx,
					sql`INSERT INTO action_accounting (action_id, closed_at, closed_by)
						VALUES (${id}, now(), ${ctx.userId})
						ON CONFLICT (action_id) DO UPDATE SET closed_at = now(), closed_by = ${ctx.userId}
						RETURNING closed_at`
				);
				const [a] = await rowsOf(tx, sql`SELECT name FROM actions WHERE id = ${id}`);
				return { closedAt: toIso(r!.closed_at), missing, name: String(a?.name ?? 'Aktion') };
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.closed', {
				target: id,
				metadata: { actionId: id, missingReceipts: res.missing }
			});
			await notifyTreasuryAccountingClosed(ctx, {
				actionId: id,
				actionName: res.name,
				kind: 'final'
			});
			await notifyAccounting(ctx, { actionId: id, actionName: res.name, kind: 'final' });
			return { closedAt: res.closedAt };
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/reopen',
		summary: 'Abrechnung wieder öffnen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const actionName = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'edit');
				if (!access.isOwner && !core.permissions.has(ctx, 'actions.action.edit-all')) {
					throw errors.forbidden('Nur Eigentümer*in darf die Abrechnung wieder öffnen');
				}
				await tx.execute(
					sql`UPDATE action_accounting SET closed_at = NULL, closed_by = NULL WHERE action_id = ${id}`
				);
				const [a] = await rowsOf(tx, sql`SELECT name FROM actions WHERE id = ${id}`);
				return String(a?.name ?? 'Aktion');
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.reopened', {
				target: id,
				metadata: { actionId: id }
			});
			await notifyAccounting(ctx, { actionId: id, actionName, kind: 'reopened' });
			return { closedAt: null };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/accounting/report.pdf',
		summary: 'Abrechnungsbericht als PDF (IBAN nur mit Auszahlungsrecht, Belege als Anhang)',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const pdf = await buildAccountingReport(ctx, id, {
				withBank: core.permissions.has(ctx, PAYOUT_PERMISSION),
				canAttach: core.permissions.has(ctx, 'actions.storage.read'),
				checkAccess: true
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
];
