import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { core, errors, type ApiEndpoint, type RequestContext, type Tx } from '$lib/sdk/server';
import { loadMatchLines, replaceAllocations } from './allocation';
import {
	actionsService,
	loadTransactionsWhere,
	NEEDS_ALLOCATION_SQL,
	mdb,
	payerByIbanHash,
	num,
	requireAccount,
	rows,
	str,
	toTransaction,
	type RawTransaction
} from './db';
import { sanitizeName, suggestMatch, suggestPayable } from './logic';
import { ibanHash } from './bank';
import { applyCounterparty } from './counterparty';
import { notifyPaid } from './notify';
import { learnPayerFromTransaction } from './payer-learning';
import { linkTransactionToPayable, listPayables, syncActionPayableStatus } from './payables';
import {
	MAX_RECEIPT_BYTES,
	MODULE_ID,
	RECEIPT_CONTENT_TYPES,
	allocateInput,
	idParams,
	matchPreviewInput,
	transactionCreateInput,
	transactionInput,
	transactionListQuery,
	transferInput,
	type AllocateInput,
	type AllocationResult,
	type MatchPreview,
	type MatchPreviewInput,
	type MatchSuggestion,
	type Transaction,
	type TransactionCreated,
	type TransactionCreateInput,
	type TransactionInput,
	type TransactionList,
	type TransactionListQuery,
	type TransferInput
} from './schemas';
import { syncIfStale } from './sync';

const TAGS = ['Modul: treasury'];
const VIEW = 'treasury.cash.view';
const EDIT = 'treasury.transaction.edit';

export async function decorateTransactions(raw: RawTransaction[]): Promise<Transaction[]> {
	const actionIds = [
		...new Set(
			raw
				.map((t) => t.row.action_id)
				.filter(Boolean)
				.map(String)
		)
	];
	const names = new Map<string, string>();
	if (actionIds.length) {
		for (const a of await (await actionsService()).listActionRefs({ ids: actionIds })) {
			names.set(a.id, a.name);
		}
	}
	return raw.map((t) => toTransaction(t, names));
}

function listWhere(q: TransactionListQuery): ReturnType<typeof sql> {
	const conds = [sql`TRUE`];
	if (q.accountId) conds.push(sql`t.account_id = ${q.accountId}`);
	if (q.categoryId) conds.push(sql`t.category_id = ${q.categoryId}`);
	if (q.actionId) conds.push(sql`t.action_id = ${q.actionId}`);
	if (q.from) conds.push(sql`t.booked_on >= ${q.from}`);
	if (q.to) conds.push(sql`t.booked_on <= ${q.to}`);
	if (q.search) {
		const p = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
		conds.push(sql`(t.counterparty ILIKE ${p} OR t.purpose ILIKE ${p} OR t.note ILIKE ${p})`);
	}
	if (q.filter === 'income') conds.push(sql`t.amount_cents > 0`);
	if (q.filter === 'expense') conds.push(sql`t.amount_cents < 0`);
	if (q.filter === 'unassigned') conds.push(NEEDS_ALLOCATION_SQL);
	return sql.join(conds, sql` AND `);
}

async function loadOne(tx: Tx, id: string): Promise<RawTransaction> {
	const [t] = await loadTransactionsWhere(tx, sql`t.id = ${id}`);
	if (!t) throw errors.notFound('Buchung nicht gefunden');
	return t;
}

async function requireCategory(tx: Tx, id: string | null): Promise<void> {
	if (!id) return;
	const [c] = await rows(tx, sql`SELECT id FROM categories WHERE id = ${id}`);
	if (!c) throw errors.validation([{ path: ['categoryId'], message: 'Kategorie nicht gefunden' }]);
}

async function requireActionRef(actionId: string | null): Promise<void> {
	if (!actionId) return;
	const found = await (await actionsService()).listActionRefs({ ids: [actionId] });
	if (!found.length) {
		throw errors.validation([{ path: ['actionId'], message: 'Aktion nicht gefunden' }]);
	}
}

async function lockTransaction(tx: Tx, id: string) {
	const [t] = await rows(tx, sql`SELECT * FROM transactions WHERE id = ${id} FOR UPDATE`);
	if (!t) throw errors.notFound('Buchung nicht gefunden');
	return t;
}

export async function allocateAndNotify(
	ctx: RequestContext,
	input: AllocateInput
): Promise<AllocationResult> {
	const r = await mdb().transaction((tx) =>
		replaceAllocations(tx, input.transactionId, input.allocations, ctx.userId)
	);
	return finishAllocation(ctx, input, r);
}

/** Nach der Zuordnung (außerhalb der Transaktion): Zahler lernen, Bestätigungen senden, Audit */
export async function finishAllocation(
	ctx: RequestContext,
	input: AllocateInput,
	r: { invoiceIds: string[]; allocatedCents: number; amountCents: number }
): Promise<AllocationResult> {
	// Zahler aus der Buchung lernen (IBAN + Mitglieder der bezahlten Posten)
	let payer: AllocationResult['payer'] = null;
	if (input.allocations.length) {
		try {
			payer = await learnPayerFromTransaction(ctx, input.transactionId);
		} catch (e) {
			console.error('[treasury] Zahler konnte nicht angelegt werden:', e);
		}
	}
	const mail = await notifyPaid(r.invoiceIds, input.notify);
	await core.audit.logFromContext(ctx, 'treasury.transaction.allocated', {
		target: input.transactionId,
		metadata: {
			lines: input.allocations.length,
			allocatedCents: r.allocatedCents,
			paidInvoices: mail.paidInvoices,
			mailsSent: mail.mailsSent
		}
	});
	return {
		transactionId: input.transactionId,
		allocatedCents: r.allocatedCents,
		unallocatedCents: Math.max(0, r.amountCents - r.allocatedCents),
		payer,
		...mail
	};
}

export const transactionEndpoints = [
	{
		method: 'GET',
		path: '/transactions',
		summary: 'Buchungen auflisten (Filter, Seiten)',
		tags: TAGS,
		permission: VIEW,
		query: transactionListQuery,
		handler: async ({ query }) => {
			const q = query as TransactionListQuery;
			const where = listWhere(q);
			const data = await mdb().transaction(async (tx) => {
				const [c] = await rows(
					tx,
					sql`SELECT count(*)::int AS n, coalesce(sum(t.amount_cents), 0) AS s FROM transactions t WHERE ${where}`
				);
				return {
					raw: await loadTransactionsWhere(tx, where, q),
					total: num(c?.n),
					sum: num(c?.s)
				};
			});
			return {
				items: await decorateTransactions(data.raw),
				total: data.total,
				sumCents: data.sum
			} satisfies TransactionList;
		}
	},
	{
		method: 'GET',
		path: '/transactions/:id',
		summary: 'Buchung lesen',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		handler: async ({ params }) => {
			const { id } = params as { id: string };
			const raw = await mdb().transaction((tx) => loadOne(tx, id));
			return (await decorateTransactions([raw]))[0]!;
		}
	},
	{
		method: 'POST',
		path: '/transactions',
		summary: 'Buchung anlegen',
		tags: TAGS,
		permission: EDIT,
		description:
			'Optional gleich zuordnen: Einnahme mit `allocations` (Rechnungsposten), Ausgabe mit `payableId` (Auszahlung).',
		body: transactionCreateInput,
		handler: async ({ ctx, body }): Promise<TransactionCreated> => {
			const input = body as TransactionCreateInput;
			await requireActionRef(input.actionId);
			if (input.allocations.length && input.amountCents < 0) {
				throw errors.validation([
					{ path: ['allocations'], message: 'Nur Einnahmen können Rechnungen zugeordnet werden' }
				]);
			}
			if (input.payableId && input.amountCents > 0) {
				throw errors.validation([
					{ path: ['payableId'], message: 'Nur Ausgaben können Auszahlungen zugeordnet werden' }
				]);
			}
			const id = crypto.randomUUID();
			const { raw, allocated, payables } = await mdb().transaction(async (tx) => {
				await requireAccount(tx, input.accountId);
				await requireCategory(tx, input.categoryId);
				await tx.execute(
					sql`INSERT INTO transactions (id, account_id, booked_on, amount_cents, counterparty, purpose,
						category_id, action_id, note, created_by)
					VALUES (${id}, ${input.accountId}, ${input.bookedOn}, ${input.amountCents}, ${input.counterparty},
						${input.purpose}, ${input.categoryId}, ${input.actionId}, ${input.note}, ${ctx.userId})`
				);
				await applyCounterparty(tx, id, input);
				// Zuordnung in derselben Transaktion: schlägt sie fehl, entsteht auch keine Buchung
				const allocated = input.allocations.length
					? await replaceAllocations(tx, id, input.allocations, ctx.userId)
					: null;
				const payables = input.payableId
					? await linkTransactionToPayable(tx, id, input.payableId, ctx.userId)
					: [];
				return { raw: await loadOne(tx, id), allocated, payables };
			});
			await core.audit.logFromContext(ctx, 'treasury.transaction.created', {
				target: id,
				metadata: { accountId: input.accountId, amountCents: input.amountCents }
			});
			let allocation: AllocationResult | null = null;
			if (allocated) {
				allocation = await finishAllocation(
					ctx,
					{ transactionId: id, allocations: input.allocations, notify: input.notify },
					allocated
				);
			}
			if (payables.length) {
				await syncActionPayableStatus(payables);
				await core.audit.logFromContext(ctx, 'treasury.payable.linked', {
					target: id,
					metadata: { payableId: input.payableId }
				});
			}
			// nach dem Lernen neu laden (Zahler/Kategorie können sich geändert haben)
			const fresh = allocated ? await mdb().transaction((tx) => loadOne(tx, id)) : raw;
			const t = (await decorateTransactions([fresh]))[0]!;
			return { ...t, allocation, payableLinked: payables.length > 0 };
		}
	},
	{
		method: 'POST',
		path: '/match-preview',
		summary: 'Zuordnungsvorschlag für eine noch nicht gespeicherte Buchung',
		description:
			'Einnahme: offene Rechnungsposten + Vorschlag. Ausgabe: offene Auszahlungen + Vorschlag. Speichert nichts.',
		tags: TAGS,
		permission: VIEW,
		body: matchPreviewInput,
		handler: async ({ ctx, body }): Promise<MatchPreview> => {
			const input = body as MatchPreviewInput;
			const empty: MatchPreview = {
				lines: [],
				suggestion: null,
				payables: [],
				payableSuggestion: null
			};
			const iban = ibanHash(input.counterpartyIban);
			if (input.amountCents > 0) {
				await syncIfStale(ctx);
				const { open, match } = await loadMatchLines();
				let payerId = input.payerId ?? null;
				if (!payerId && iban) payerId = (await payerByIbanHash()).get(iban.hash) ?? null;
				const m = suggestMatch(
					{
						amountCents: input.amountCents,
						purpose: input.purpose ?? null,
						counterparty: input.counterparty ?? null,
						payerId
					},
					match
				);
				return { ...empty, lines: open, suggestion: m };
			}
			if (input.amountCents < 0) {
				const payables = (await listPayables(sql`p.cancelled_at IS NULL`)).filter(
					(p) => p.openCents > 0
				);
				const s = suggestPayable(
					{
						amountCents: input.amountCents,
						counterparty: input.counterparty ?? null,
						purpose: input.purpose ?? null,
						ibanLast4: iban?.last4 ?? null
					},
					payables.map((p) => ({
						id: p.id,
						recipientName: p.recipientName,
						description: p.description,
						openCents: p.openCents,
						ibanLast4: p.ibanMasked ? p.ibanMasked.slice(-4) : null
					}))
				);
				return { ...empty, payables, payableSuggestion: s };
			}
			return empty;
		}
	},
	{
		method: 'PUT',
		path: '/transactions/:id',
		summary: 'Buchung ändern',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: transactionInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as TransactionInput;
			await requireActionRef(input.actionId);
			const raw = await mdb().transaction(async (tx) => {
				const cur = await lockTransaction(tx, id);
				if (cur.transfer_id) {
					throw errors.conflict('Umbuchungen bitte löschen und neu anlegen');
				}
				await requireAccount(tx, input.accountId);
				await requireCategory(tx, input.categoryId);
				const [a] = await rows(
					tx,
					sql`SELECT coalesce(sum(amount_cents), 0) AS s FROM allocations WHERE transaction_id = ${id}`
				);
				if (num(a?.s) > 0 && input.amountCents < num(a?.s)) {
					throw errors.conflict(
						'Der Betrag ist kleiner als die Zuordnung zu Rechnungen. Bitte zuerst die Zuordnung anpassen.'
					);
				}
				await tx.execute(
					sql`UPDATE transactions SET account_id = ${input.accountId}, booked_on = ${input.bookedOn},
						amount_cents = ${input.amountCents}, counterparty = ${input.counterparty}, purpose = ${input.purpose},
						category_id = ${input.categoryId}, action_id = ${input.actionId}, note = ${input.note},
						updated_at = now()
					WHERE id = ${id}`
				);
				await applyCounterparty(tx, id, input);
				return loadOne(tx, id);
			});
			await core.audit.logFromContext(ctx, 'treasury.transaction.updated', {
				target: id,
				metadata: { accountId: input.accountId, amountCents: input.amountCents }
			});
			return (await decorateTransactions([raw]))[0]!;
		}
	},
	{
		method: 'DELETE',
		path: '/transactions/:id',
		summary: 'Buchung löschen (Umbuchung: beide Seiten; Zuordnungen entfallen)',
		tags: TAGS,
		permission: 'treasury.transaction.delete',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			let linkedPayables: string[] = [];
			const removed = await mdb().transaction(async (tx) => {
				const cur = await lockTransaction(tx, id);
				linkedPayables = (
					await rows(
						tx,
						sql`SELECT DISTINCT pp.payable_id FROM payable_payments pp JOIN transactions t ON t.id = pp.transaction_id
						WHERE t.id = ${id} OR (t.transfer_id IS NOT NULL AND t.transfer_id = ${str(cur.transfer_id)})`
					)
				).map((r) => String(r.payable_id));
				const group = cur.transfer_id
					? await rows(
							tx,
							sql`SELECT id, receipt_path FROM transactions WHERE transfer_id = ${String(cur.transfer_id)}`
						)
					: [cur];
				for (const t of group) {
					await tx.execute(sql`DELETE FROM transactions WHERE id = ${String(t.id)}`);
				}
				return group.map((t) => (t.receipt_path ? String(t.receipt_path) : null)).filter(Boolean);
			});
			await syncActionPayableStatus(linkedPayables);
			for (const path of removed) {
				await core.storage.remove(ctx, { module: MODULE_ID, path: path! }).catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'treasury.transaction.deleted', { target: id });
			return null;
		}
	},
	{
		method: 'POST',
		path: '/transfers',
		summary: 'Umbuchung zwischen zwei Konten',
		tags: TAGS,
		permission: EDIT,
		body: transferInput,
		handler: async ({ ctx, body }) => {
			const input = body as TransferInput;
			const transferId = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				const from = await requireAccount(tx, input.fromAccountId);
				const to = await requireAccount(tx, input.toAccountId);
				const purpose = input.purpose ?? `Umbuchung ${String(from.name)} → ${String(to.name)}`;
				for (const [accountId, amount, other] of [
					[input.fromAccountId, -input.amountCents, String(to.name)],
					[input.toAccountId, input.amountCents, String(from.name)]
				] as const) {
					await tx.execute(
						sql`INSERT INTO transactions (id, account_id, booked_on, amount_cents, counterparty, purpose,
							transfer_id, created_by)
						VALUES (${crypto.randomUUID()}, ${accountId}, ${input.bookedOn}, ${amount}, ${other},
							${purpose}, ${transferId}, ${ctx.userId})`
					);
				}
			});
			await core.audit.logFromContext(ctx, 'treasury.transfer.created', {
				target: transferId,
				metadata: { amountCents: input.amountCents }
			});
			return { transferId };
		}
	},
	{
		method: 'PUT',
		path: '/transactions/:id/allocations',
		summary: 'Zuordnung einer Einnahme zu Rechnungsposten ersetzen (auch Sammelzahlungen)',
		description:
			'Leere Liste entfernt alle Zuordnungen. Vollständig bezahlte Rechnungen erhalten einmalig eine Bestätigungs-Mail (notify).',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: allocateInput.omit({ transactionId: true }),
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as Omit<AllocateInput, 'transactionId'>;
			return allocateAndNotify(ctx, { ...input, transactionId: id });
		}
	},
	{
		method: 'GET',
		path: '/transactions/:id/suggestion',
		summary: 'Zuordnungsvorschlag für eine Einnahme',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			await syncIfStale(ctx);
			const t = await mdb().transaction((tx) => loadOne(tx, id));
			const amount = num(t.row.amount_cents) - num(t.row.allocated_cents);
			if (amount <= 0 || t.row.transfer_id) return null;
			const { match } = await loadMatchLines(id);
			const byIban = await payerByIbanHash();
			const m = suggestMatch(
				{
					amountCents: amount,
					purpose: t.row.purpose ? String(t.row.purpose) : null,
					counterparty: t.row.counterparty ? String(t.row.counterparty) : null,
					payerId: byIban.get(String(t.row.counterparty_iban_hash ?? '')) ?? null
				},
				match
			);
			return m ? ({ transactionId: id, ...m } satisfies MatchSuggestion) : null;
		}
	},
	{
		method: 'GET',
		path: '/open-lines',
		summary: 'Offene Rechnungsposten für die Zuordnung',
		tags: TAGS,
		permission: VIEW,
		query: z.object({ transactionId: z.uuid().optional() }),
		handler: async ({ ctx, query }) => {
			await syncIfStale(ctx);
			const q = query as { transactionId?: string };
			return (await loadMatchLines(q.transactionId)).open;
		}
	},
	{
		method: 'POST',
		path: '/transactions/:id/receipt',
		summary: 'Beleg hochladen (multipart, Feld "file")',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params, request }) => {
			const { id } = params as { id: string };
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
			if (file.size > MAX_RECEIPT_BYTES) throw errors.tooLarge('Datei überschreitet 10 MB');
			const old = await mdb().transaction(async (tx) => {
				const cur = await lockTransaction(tx, id);
				return cur.receipt_path == null ? null : String(cur.receipt_path);
			});
			const displayName = file.name?.trim() || 'beleg';
			const path = `${id}/receipt-${crypto.randomUUID()}-${sanitizeName(displayName)}`;
			await core.storage.upload(ctx, {
				module: MODULE_ID,
				path,
				file: new Uint8Array(await file.arrayBuffer()),
				contentType,
				name: displayName
			});
			try {
				await mdb().transaction(async (tx) => {
					await lockTransaction(tx, id);
					await tx.execute(
						sql`UPDATE transactions SET receipt_path = ${path}, receipt_name = ${displayName},
							receipt_content_type = ${contentType}, updated_at = now() WHERE id = ${id}`
					);
				});
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
				throw e;
			}
			if (old)
				await core.storage.remove(ctx, { module: MODULE_ID, path: old }).catch(() => undefined);
			await core.audit.logFromContext(ctx, 'treasury.transaction.receipt_uploaded', {
				target: id,
				metadata: { contentType, size: file.size }
			});
			return { name: displayName, contentType };
		}
	},
	{
		method: 'GET',
		path: '/transactions/:id/receipt',
		summary: 'Beleg herunterladen',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const ref = await mdb().transaction(async (tx) => {
				const [r] = await rows(
					tx,
					sql`SELECT receipt_path, receipt_name FROM transactions WHERE id = ${id}`
				);
				if (!r) throw errors.notFound('Buchung nicht gefunden');
				return {
					path: r.receipt_path ? String(r.receipt_path) : null,
					name: String(r.receipt_name ?? '')
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
	},
	{
		method: 'DELETE',
		path: '/transactions/:id/receipt',
		summary: 'Beleg entfernen',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const path = await mdb().transaction(async (tx) => {
				const cur = await lockTransaction(tx, id);
				if (cur.receipt_path == null) throw errors.notFound('Kein Beleg vorhanden');
				await tx.execute(
					sql`UPDATE transactions SET receipt_path = NULL, receipt_name = NULL, receipt_content_type = NULL,
						updated_at = now() WHERE id = ${id}`
				);
				return String(cur.receipt_path);
			});
			await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
			await core.audit.logFromContext(ctx, 'treasury.transaction.receipt_deleted', { target: id });
			return null;
		}
	}
] as ApiEndpoint[];
