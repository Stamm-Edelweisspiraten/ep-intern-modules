import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import type { ActionContributions } from '$lib/modules/treasury/contract';
import { requireAccess, rowsOf } from './access';
import {
	ENTRY_COLUMNS,
	assertOpen,
	closedInfo,
	loadAutoIncome,
	loadEntries,
	loadInterims,
	loadPlan,
	loadTreasuryContributions,
	mapEntry,
	resolveInterimUsers
} from './accounting-core';
import { payeeTotals, summarize } from './accounting';
import { detectReceiptType, sanitizeName } from './action-archive';
import { ibanLast, maskFromLast } from './iban';
import {
	MAX_RECEIPT_BYTES,
	MODULE_ID,
	RECEIPT_CONTENT_TYPES,
	entryInput,
	entryParams,
	idParams,
	needsTransfer,
	type AccountingEntry,
	type AccountingPayee,
	type AccountingState,
	type EntryInput,
	type SummaryEntry
} from './schemas';

const mdb = () => core.database.forModule(MODULE_ID);
const TAGS = ['Modul: actions'];

function toSummaryEntries(rows: Record<string, unknown>[]): SummaryEntry[] {
	return rows.map((r) => ({
		type: String(r.type) as SummaryEntry['type'],
		category: String(r.category) as SummaryEntry['category'],
		amountCents: Number(r.amount_cents),
		paidBy: String(r.paid_by) as SummaryEntry['paidBy'],
		payeeId: r.payee_id == null ? null : String(r.payee_id),
		hasReceipt: r.receipt_path != null,
		reimbursed: r.reimbursed_at != null,
		clubOpen: r.type === 'expense' && r.paid_by === 'club' && r.club_paid_at == null
	}));
}

export interface LoadedState {
	state: AccountingState;
	closedBy: string | null;
}

/**
 * Abrechnung lesen (ohne Objektrechte); Empfänger nur mit `canViewPayouts`.
 * `canManageInterims` = Eigentümer*in oder `edit-all` (Zwischenabrechnungen zurücknehmen).
 */
export async function loadState(
	tx: Tx,
	actionId: string,
	treasury: ActionContributions | null,
	canViewPayouts: boolean,
	canManageInterims = false
): Promise<LoadedState> {
	const closed = await closedInfo(tx, actionId);
	const entries = await loadEntries(tx, actionId);
	const plan = await loadPlan(tx, actionId);
	const raw = await rowsOf(
		tx,
		sql`SELECT type, category, amount_cents, paid_by, payee_id, receipt_path, reimbursed_at, club_paid_at
			FROM accounting_entries WHERE action_id = ${actionId}`
	);
	const summaryEntries = toSummaryEntries(raw);
	const autoIncome = await loadAutoIncome(tx, actionId, summaryEntries, treasury);
	let payees: AccountingPayee[] | null = null;
	if (canViewPayouts) {
		const totals = payeeTotals(summaryEntries);
		const rows = await rowsOf(
			tx,
			sql`SELECT id, name, iban_last4, bic, note FROM accounting_payees
				WHERE action_id = ${actionId} ORDER BY name, created_at`
		);
		payees = rows.map((r) => {
			const t = totals.get(String(r.id));
			return {
				id: String(r.id),
				name: String(r.name),
				ibanMasked: maskFromLast(r.iban_last4 == null ? null : String(r.iban_last4)),
				bic: r.bic == null ? null : String(r.bic),
				note: r.note == null ? null : String(r.note),
				openCents: t?.openCents ?? 0,
				reimbursedCents: t?.reimbursedCents ?? 0,
				openEntries: t?.openEntries ?? 0
			};
		});
	}
	const interims = await loadInterims(tx, actionId, canManageInterims);
	return {
		state: {
			closed: closed ? { at: closed.at, by: null } : null,
			entries,
			summary: summarize(summaryEntries, plan, autoIncome),
			plan,
			autoIncome,
			payees,
			canViewPayouts,
			interims
		},
		closedBy: closed?.by ?? null
	};
}

async function loadOne(tx: Tx, actionId: string, entryId: string): Promise<AccountingEntry> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT ${ENTRY_COLUMNS}
			FROM accounting_entries e LEFT JOIN accounting_payees p ON p.id = e.payee_id
			WHERE e.id = ${entryId} AND e.action_id = ${actionId}`
	);
	if (!r) throw errors.notFound('Buchung nicht gefunden');
	return mapEntry(r);
}

/** Sperrt die Buchung der Aktion (FOR UPDATE) oder wirft 404. */
async function lockEntry(
	tx: Tx,
	actionId: string,
	entryId: string
): Promise<Record<string, unknown>> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT * FROM accounting_entries WHERE id = ${entryId} AND action_id = ${actionId} FOR UPDATE`
	);
	if (!r) throw errors.notFound('Buchung nicht gefunden');
	return r;
}

function oneYearAhead(): string {
	const d = new Date();
	d.setUTCFullYear(d.getUTCFullYear() + 1);
	return d.toISOString().slice(0, 10);
}

async function validateEntry(tx: Tx, actionId: string, input: EntryInput): Promise<void> {
	if (input.entryDate > oneYearAhead()) {
		throw errors.validation({ entryDate: 'Das Datum liegt zu weit in der Zukunft' });
	}
	if (input.paidBy === 'person') {
		const [p] = await rowsOf(
			tx,
			sql`SELECT 1 AS ok FROM accounting_payees WHERE id = ${input.payeeId} AND action_id = ${actionId}`
		);
		if (!p) throw errors.validation({ payeeId: 'Die Person gehört nicht zu dieser Aktion' });
	}
}

const REIMBURSED_MSG = 'Ausgezahlte Auslagen können nicht geändert werden';
const TRANSFERRED_MSG =
	'Die Ausgabe wurde bereits von der Kasse überwiesen. Zum Ändern zuerst die Zahlung in der Kasse löschen.';
const crypt = () => core.crypto.forModule(MODULE_ID);

/** Empfängerdaten einer Stamm-Ausgabe für INSERT/UPDATE (alles `null` bei anderen Buchungen). */
function recipientValues(
	input: EntryInput,
	encrypted: string | null,
	current: Record<string, unknown> | null
) {
	const club = input.type === 'expense' && input.paidBy === 'club';
	if (!club) {
		return { name: null, enc: null, last: null, bic: null, purpose: null, paid: false };
	}
	const enc = encrypted ?? (current?.recipient_iban_enc as string | null | undefined) ?? null;
	const last = input.iban
		? ibanLast(input.iban)
		: ((current?.recipient_iban_last4 as string | null | undefined) ?? null);
	if (needsTransfer(input) && !enc) throw errors.validation({ iban: 'IBAN fehlt' });
	return {
		name: input.recipientName,
		enc,
		last,
		bic: input.bic,
		purpose: input.purpose,
		paid: input.clubPaid
	};
}
const REFUND_MSG = 'Bitte die Rückzahlung über die Rückzahlungsfunktion zurücknehmen';

export const accountingEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/accounting',
		summary: 'Abrechnung einer Aktion lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const treasury = await loadTreasuryContributions(id);
			const loaded = await mdb().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, id, 'read');
				return loadState(
					tx,
					id,
					treasury,
					core.permissions.has(ctx, 'actions.payout.view'),
					access.isOwner || core.permissions.has(ctx, 'actions.action.edit-all')
				);
			});
			const { state, closedBy } = loaded;
			state.payoutsViaTreasury = await core.modules.isEnabled('treasury');
			await resolveInterimUsers(ctx, state.interims);
			if (state.closed && closedBy) {
				const found = await core.users.directory(ctx, { ids: [closedBy], limit: 30 });
				const u = found.find((x) => x.id === closedBy);
				state.closed.by = u
					? { userId: u.id, name: u.name, email: u.email }
					: { userId: closedBy, name: 'Unbekannt', email: null };
			}
			return state;
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/entries',
		summary: 'Buchung anlegen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		body: entryInput,
		handler: async ({ ctx, params, body }) => {
			const id = (params as { id: string }).id;
			const input = body as EntryInput;
			const encrypted = input.iban ? crypt().encrypt(input.iban) : null;
			const entry = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				await validateEntry(tx, id, input);
				const r = recipientValues(input, encrypted, null);
				const entryId = crypto.randomUUID();
				await tx.execute(
					sql`INSERT INTO accounting_entries (id, action_id, type, category, description,
							amount_cents, entry_date, paid_by, payee_id, created_by, recipient_name,
							recipient_iban_enc, recipient_iban_last4, recipient_bic, purpose, club_paid_at, club_paid_via, reimbursed_at, reimbursed_upfront)
						VALUES (${entryId}, ${id}, ${input.type}, ${input.category}, ${input.description},
							${input.amountCents}, ${input.entryDate}, ${input.paidBy}, ${input.payeeId},
							${ctx.userId ?? null}, ${r.name}, ${r.enc}, ${r.last}, ${r.bic}, ${r.purpose},
							${r.paid ? sql`now()` : sql`NULL`}, ${r.paid ? 'manual' : null},
							${input.reimbursed ? sql`now()` : sql`NULL`}, ${input.reimbursed})`
				);
				return loadOne(tx, id, entryId);
			});
			await core.audit.logFromContext(ctx, 'actions.accounting.entry_created', {
				target: id,
				metadata: {
					entryId: entry.id,
					type: input.type,
					category: input.category,
					amountCents: input.amountCents,
					reimbursed: input.reimbursed
				}
			});
			return entry;
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/actions/:id/accounting/entries/:entryId',
		summary: 'Buchung ändern',
		tags: TAGS,
		permission: 'actions.action.view',
		params: entryParams,
		body: entryInput,
		handler: async ({ ctx, params, body }) => {
			const { id, entryId } = params as { id: string; entryId: string };
			const input = body as EntryInput;
			const encrypted = input.iban ? crypt().encrypt(input.iban) : null;
			const { entry, removedReceipt } = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				const cur = await lockEntry(tx, id, entryId);
				if (cur.category === 'refund') throw errors.conflict(REFUND_MSG);
				if (cur.reimbursed_at != null) throw errors.conflict(REIMBURSED_MSG);
				if (cur.club_paid_via === 'treasury') throw errors.conflict(TRANSFERRED_MSG);
				await validateEntry(tx, id, input);
				if (input.reimbursed) {
					throw errors.validation({
						reimbursed: 'Die Erstattung kann nur beim Anlegen gesetzt werden'
					});
				}
				const r = recipientValues(input, encrypted, cur);
				// Einnahmen haben keine Belege
				const dropReceipt = input.type === 'income' && cur.receipt_path != null;
				await tx.execute(
					sql`UPDATE accounting_entries SET type = ${input.type}, category = ${input.category},
							description = ${input.description}, amount_cents = ${input.amountCents},
							entry_date = ${input.entryDate}, paid_by = ${input.paidBy}, payee_id = ${input.payeeId},
							reimbursed_at = NULL, recipient_name = ${r.name}, recipient_iban_enc = ${r.enc},
							recipient_iban_last4 = ${r.last}, recipient_bic = ${r.bic}, purpose = ${r.purpose},
							club_paid_at = ${r.paid ? sql`COALESCE(club_paid_at, now())` : sql`NULL`},
							club_paid_via = ${r.paid ? 'manual' : null},
							receipt_path = ${dropReceipt ? null : (cur.receipt_path ?? null)},
							receipt_name = ${dropReceipt ? null : (cur.receipt_name ?? null)},
							receipt_content_type = ${dropReceipt ? null : (cur.receipt_content_type ?? null)},
							updated_at = now()
						WHERE id = ${entryId}`
				);
				return {
					entry: await loadOne(tx, id, entryId),
					removedReceipt: dropReceipt ? String(cur.receipt_path) : null
				};
			});
			if (removedReceipt) {
				await core.storage
					.remove(ctx, { module: MODULE_ID, path: removedReceipt })
					.catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'actions.accounting.entry_updated', {
				target: id,
				metadata: {
					entryId,
					type: input.type,
					category: input.category,
					amountCents: input.amountCents
				}
			});
			return entry;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/accounting/entries/:entryId',
		summary: 'Buchung löschen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: entryParams,
		handler: async ({ ctx, params }) => {
			const { id, entryId } = params as { id: string; entryId: string };
			const info = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				const cur = await lockEntry(tx, id, entryId);
				if (cur.category === 'refund') throw errors.conflict(REFUND_MSG);
				if (cur.reimbursed_at != null) throw errors.conflict(REIMBURSED_MSG);
				if (cur.club_paid_via === 'treasury') throw errors.conflict(TRANSFERRED_MSG);
				await tx.execute(sql`DELETE FROM accounting_entries WHERE id = ${entryId}`);
				return {
					path: cur.receipt_path == null ? null : String(cur.receipt_path),
					type: String(cur.type),
					category: String(cur.category),
					amountCents: Number(cur.amount_cents)
				};
			});
			if (info.path) {
				await core.storage
					.remove(ctx, { module: MODULE_ID, path: info.path })
					.catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'actions.accounting.entry_deleted', {
				target: id,
				metadata: {
					entryId,
					type: info.type,
					category: info.category,
					amountCents: info.amountCents
				}
			});
			return { id: entryId };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/accounting/entries/:entryId/iban',
		summary: 'IBAN des Empfängers einer Stamm-Ausgabe entschlüsselt lesen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: entryParams,
		handler: async ({ ctx, params }) => {
			await core.permissions.require(ctx, 'actions.payout.view');
			const { id, entryId } = params as { id: string; entryId: string };
			const enc = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				const [r] = await rowsOf(
					tx,
					sql`SELECT recipient_iban_enc FROM accounting_entries WHERE id = ${entryId} AND action_id = ${id}`
				);
				if (!r) throw errors.notFound('Buchung nicht gefunden');
				return r.recipient_iban_enc == null ? null : String(r.recipient_iban_enc);
			});
			const iban = enc ? crypt().decrypt(enc) : '';
			await core.audit.logFromContext(ctx, 'actions.accounting.iban_viewed', {
				target: id,
				metadata: { actionId: id, entryId }
			});
			return new Response(JSON.stringify({ data: { iban } }), {
				status: 200,
				headers: {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'private, no-store'
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/:id/accounting/entries/:entryId/receipt',
		summary: 'Beleg hochladen (multipart, Feld "file")',
		description:
			'Ersetzt einen vorhandenen Beleg. Erlaubt: PDF, JPEG, PNG, WebP bis 10 MB. Nur für Ausgaben.',
		tags: TAGS,
		permission: 'actions.action.view',
		params: entryParams,
		handler: async ({ ctx, params, request }) => {
			const { id, entryId } = params as { id: string; entryId: string };
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) throw errors.badRequest('Feld "file" fehlt');
			const contentType = (file.type || '').split(';')[0]!.trim().toLowerCase();
			if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
				throw errors.badRequest('Dateityp nicht erlaubt (PDF, JPEG, PNG oder WebP)');
			}
			if (file.size === 0) throw errors.badRequest('Datei ist leer');
			if (file.size > MAX_RECEIPT_BYTES) {
				throw errors.tooLarge('Datei überschreitet das Limit von 10 MB');
			}

			const old = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				const cur = await lockEntry(tx, id, entryId);
				if (String(cur.type) !== 'expense') {
					throw errors.badRequest('Belege sind nur bei Ausgaben möglich');
				}
				return cur.receipt_path == null ? null : String(cur.receipt_path);
			});

			const bytes = new Uint8Array(await file.arrayBuffer());
			// Inhalt muss zum angegebenen Typ passen (Magic Bytes)
			if (detectReceiptType(bytes) !== contentType) {
				throw errors.validation({ file: 'Dateiinhalt passt nicht zum Dateityp' });
			}
			const displayName = file.name?.trim() || 'beleg';
			const path = `${id}/${entryId}-${crypto.randomUUID()}-${sanitizeName(displayName)}`;
			await core.storage.upload(ctx, {
				module: MODULE_ID,
				path,
				file: bytes,
				contentType,
				name: displayName
			});
			try {
				await mdb().transaction(async (tx) => {
					await assertOpen(tx, id);
					await lockEntry(tx, id, entryId);
					await tx.execute(
						sql`UPDATE accounting_entries SET receipt_path = ${path}, receipt_name = ${displayName},
								receipt_content_type = ${contentType}, updated_at = now()
							WHERE id = ${entryId}`
					);
				});
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
				throw e;
			}
			if (old) {
				await core.storage.remove(ctx, { module: MODULE_ID, path: old }).catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'actions.accounting.receipt_uploaded', {
				target: id,
				metadata: { entryId, contentType, size: file.size }
			});
			return { name: displayName, contentType };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/actions/:id/accounting/entries/:entryId/receipt',
		summary: 'Beleg herunterladen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: entryParams,
		handler: async ({ ctx, params }) => {
			const { id, entryId } = params as { id: string; entryId: string };
			const ref = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'read');
				const [r] = await rowsOf(
					tx,
					sql`SELECT receipt_path, receipt_name FROM accounting_entries
						WHERE id = ${entryId} AND action_id = ${id}`
				);
				if (!r) throw errors.notFound('Buchung nicht gefunden');
				return {
					path: r.receipt_path == null ? null : String(r.receipt_path),
					name: r.receipt_name == null ? null : String(r.receipt_name)
				};
			});
			if (!ref.path) throw errors.notFound('Kein Beleg vorhanden');
			const { buffer, file } = await core.storage.download(ctx, {
				module: MODULE_ID,
				path: ref.path
			});
			const name = ref.name || file.name || 'beleg';
			return new Response(buffer as BodyInit, {
				status: 200,
				headers: {
					'content-type': file.contentType,
					'content-length': String(buffer.byteLength),
					'content-disposition': `inline; filename="${sanitizeName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/actions/:id/accounting/entries/:entryId/receipt',
		summary: 'Beleg entfernen',
		tags: TAGS,
		permission: 'actions.action.view',
		params: entryParams,
		handler: async ({ ctx, params }) => {
			const { id, entryId } = params as { id: string; entryId: string };
			const path = await mdb().transaction(async (tx) => {
				await requireAccess(tx, ctx, id, 'edit');
				await assertOpen(tx, id);
				const cur = await lockEntry(tx, id, entryId);
				if (cur.receipt_path == null) throw errors.notFound('Kein Beleg vorhanden');
				await tx.execute(
					sql`UPDATE accounting_entries SET receipt_path = NULL, receipt_name = NULL,
							receipt_content_type = NULL, updated_at = now()
						WHERE id = ${entryId}`
				);
				return String(cur.receipt_path);
			});
			await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
			await core.audit.logFromContext(ctx, 'actions.accounting.receipt_deleted', {
				target: id,
				metadata: { entryId }
			});
			return { id: entryId };
		}
	} as ApiEndpoint
] as ApiEndpoint[];
