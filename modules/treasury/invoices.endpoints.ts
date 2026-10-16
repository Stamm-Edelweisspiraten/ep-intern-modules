import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { core, errors, type ApiEndpoint, type RequestContext, type Tx } from '$lib/sdk/server';
import { replaceAllocations } from './allocation';
import { decryptIban, storeIban } from './bank';
import {
	invoicePdfResponse,
	listDocuments,
	refreshSentDocuments,
	sendDocuments
} from './documents';
import { formatIban, maskIban } from './iban';
import {
	collectIds,
	idList,
	loadInvoiceDetailRaw,
	loadPayerNames,
	loadRawInvoices,
	mdb,
	membersService,
	nextInvoiceNumber,
	num,
	requireAccount,
	resolveNames,
	rows,
	str,
	toDetail,
	toSummary,
	today,
	actionsService,
	type NameMaps,
	type RawInvoice
} from './db';
import {
	centsToCsv,
	csvDocument,
	distribute,
	formatDateDe,
	normalizeName as normalizeKey,
	suggestPayers
} from './logic';
import { notifyPaid, runReminderJob, sendManualReminders } from './notify';
import {
	CONTRIBUTIONS_CATEGORY_ID,
	INVOICE_STATUS_LABELS,
	actionSettingsInput,
	cancelInput,
	idParams,
	invoiceInput,
	invoiceListQuery,
	invoicePatchInput,
	lineParams,
	lineWaiveInput,
	markPaidInput,
	openItemsQuery,
	payerInput,
	type ActionReceivables,
	type ActionSettingsInput,
	type AllocationResult,
	type InvoiceInput,
	type InvoiceList,
	type InvoiceListQuery,
	type InvoicePatchInput,
	type InvoiceSummary,
	type LineWaiveInput,
	type MarkPaidInput,
	type OpenItems,
	type OpenItemsGroup,
	type Payer,
	type PayerInput,
	type PayerSuggestion
} from './schemas';
import { syncActions, syncIfStale } from './sync';

const TAGS = ['Modul: treasury'];
const VIEW = 'treasury.cash.view';
const EDIT = 'treasury.invoice.edit';

export interface LoadedInvoices {
	raw: RawInvoice[];
	names: NameMaps;
	summaries: InvoiceSummary[];
}

/** Rechnungen laden + Namen aufloesen + Summen berechnen */
export async function loadSummaries(where = sql`TRUE`): Promise<LoadedInvoices> {
	const { raw, payers } = await mdb().transaction(async (tx) => ({
		raw: await loadRawInvoices(tx, where),
		payers: await loadPayerNames(tx)
	}));
	const names = await resolveNames({ ...collectIds(raw), payers });
	const t = today();
	return { raw, names, summaries: raw.map((r) => toSummary(r, names, t)) };
}

function filterSummaries(list: InvoiceSummary[], q: InvoiceListQuery): InvoiceSummary[] {
	const search = q.search ? normalizeKey(q.search) : '';
	return list.filter((i) => {
		if (q.status === 'unpaid' && !(i.status === 'open' || i.status === 'partial')) return false;
		if (q.status === 'overdue' && !i.overdue) return false;
		if (!['all', 'unpaid', 'overdue'].includes(q.status) && i.status !== q.status) return false;
		if (q.source !== 'all' && i.source !== q.source) return false;
		if (q.payerId && i.payer?.id !== q.payerId) return false;
		if (search) {
			const hay = normalizeKey(
				[i.number, i.recipientName, ...i.people, i.action?.name ?? ''].join(' ')
			);
			if (!hay.includes(search)) return false;
		}
		return true;
	});
}

function invoiceWhere(q: InvoiceListQuery) {
	const conds = [sql`TRUE`];
	if (q.actionId) {
		conds.push(sql`(i.action_id = ${q.actionId} OR EXISTS (SELECT 1 FROM invoice_lines l
			WHERE l.invoice_id = i.id AND l.action_id = ${q.actionId}))`);
	}
	if (q.memberId) {
		conds.push(
			sql`EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.member_id = ${q.memberId})`
		);
	}
	return sql.join(conds, sql` AND `);
}

const canSeeRecipients = (ctx: RequestContext) =>
	ctx.actor.type === 'system' ||
	ctx.permissions.has('treasury.invoice.edit') ||
	ctx.permissions.has('treasury.invoice.send');

async function detail(ctx: RequestContext, id: string) {
	const { d, payers } = await mdb().transaction(async (tx) => ({
		d: await loadInvoiceDetailRaw(tx, id),
		payers: await loadPayerNames(tx)
	}));
	const names = await resolveNames({ ...collectIds([d.inv]), payers });
	return toDetail(d, names, today(), canSeeRecipients(ctx), await listDocuments(id));
}

/** Pruefen, dass referenzierte Mitglieder/Aktionen existieren (vor der Transaktion) */
async function validateRefs(lines: { memberId: string | null; actionId: string | null }[]) {
	const memberIds = [...new Set(lines.map((l) => l.memberId).filter(Boolean) as string[])];
	const actionIds = [...new Set(lines.map((l) => l.actionId).filter(Boolean) as string[])];
	if (memberIds.length) {
		const found = await (await membersService()).listMemberContacts({ ids: memberIds });
		if (found.length !== memberIds.length) {
			throw errors.validation([{ path: ['lines'], message: 'Mitglied nicht gefunden' }]);
		}
	}
	if (actionIds.length) {
		const found = await (await actionsService()).listActionRefs({ ids: actionIds });
		if (found.length !== actionIds.length) {
			throw errors.validation([{ path: ['lines'], message: 'Aktion nicht gefunden' }]);
		}
	}
}

async function requirePayer(tx: Tx, id: string | null) {
	if (!id) return;
	const [p] = await rows(tx, sql`SELECT id FROM payers WHERE id = ${id}`);
	if (!p) throw errors.validation([{ path: ['payerId'], message: 'Zahler nicht gefunden' }]);
}

async function lockInvoice(tx: Tx, id: string) {
	const [i] = await rows(tx, sql`SELECT * FROM invoices WHERE id = ${id} FOR UPDATE`);
	if (!i) throw errors.notFound('Rechnung nicht gefunden');
	return i;
}

async function paidOf(tx: Tx, invoiceId: string): Promise<number> {
	const [r] = await rows(
		tx,
		sql`SELECT coalesce(sum(a.amount_cents), 0) AS s FROM allocations a JOIN invoice_lines l ON l.id = a.line_id
			WHERE l.invoice_id = ${invoiceId}`
	);
	return num(r?.s);
}

async function insertLines(tx: Tx, invoiceId: string, lines: InvoiceInput['lines']) {
	let position = 0;
	for (const l of lines) {
		await tx.execute(
			sql`INSERT INTO invoice_lines (id, invoice_id, position, description, amount_cents, member_id, action_id)
			VALUES (${crypto.randomUUID()}, ${invoiceId}, ${position++}, ${l.description}, ${l.amountCents},
				${l.memberId}, ${l.actionId})`
		);
	}
}

function groupOpenItems(
	summaries: InvoiceSummary[],
	raw: RawInvoice[],
	names: NameMaps,
	groupBy: 'payer' | 'action'
): OpenItemsGroup[] {
	const groups = new Map<string, OpenItemsGroup>();
	const rawById = new Map(raw.map((r) => [String(r.row.id), r]));
	for (const s of summaries) {
		if (s.openCents <= 0 && s.creditCents <= 0) continue;
		let key: string;
		let kind: OpenItemsGroup['kind'];
		let label: string;
		let payerId: string | null = null;
		if (groupBy === 'action') {
			if (s.action) {
				key = `action:${s.action.id}`;
				kind = 'action';
				label = s.action.name;
			} else {
				key = 'manual';
				kind = 'manual';
				label = 'Ohne Aktion';
			}
		} else if (s.payer) {
			key = `payer:${s.payer.id}`;
			kind = 'payer';
			label = s.payer.name;
			payerId = s.payer.id;
		} else {
			const memberId = rawById.get(s.id)?.lines.find((l) => l.member_id)?.member_id;
			if (memberId) {
				key = `member:${String(memberId)}`;
				kind = 'member';
				label = names.members.get(String(memberId)) ?? s.recipientName;
			} else {
				key = `person:${normalizeKey(s.recipientName)}`;
				kind = 'person';
				label = s.recipientName;
			}
		}
		const g = groups.get(key) ?? {
			key,
			kind,
			label,
			payerId,
			openCents: 0,
			overdueCents: 0,
			creditCents: 0,
			invoices: []
		};
		g.openCents += s.openCents;
		g.overdueCents += s.overdue ? s.openCents : 0;
		g.creditCents += s.creditCents;
		g.invoices.push(s);
		groups.set(key, g);
	}
	return [...groups.values()].sort(
		(a, b) =>
			b.overdueCents - a.overdueCents ||
			b.openCents - a.openCents ||
			a.label.localeCompare(b.label, 'de')
	);
}

async function openItems(
	ctx: RequestContext,
	q: z.infer<typeof openItemsQuery>
): Promise<OpenItems> {
	await syncIfStale(ctx);
	const { raw, names, summaries } = await loadSummaries();
	const search = q.search ? normalizeKey(q.search) : '';
	let groups = groupOpenItems(summaries, raw, names, q.groupBy);
	if (q.overdue === '1') {
		groups = groups
			.map((g) => ({ ...g, invoices: g.invoices.filter((i) => i.overdue) }))
			.filter((g) => g.invoices.length)
			.map((g) => ({
				...g,
				openCents: g.invoices.reduce((s, i) => s + i.openCents, 0),
				creditCents: 0
			}));
	}
	if (search) {
		groups = groups.filter((g) =>
			normalizeKey(
				[g.label, ...g.invoices.flatMap((i) => [i.number, ...i.people])].join(' ')
			).includes(search)
		);
	}
	const all = groups.flatMap((g) => g.invoices);
	return {
		groups,
		totals: {
			openCents: groups.reduce((s, g) => s + g.openCents, 0),
			overdueCents: groups.reduce((s, g) => s + g.overdueCents, 0),
			creditCents: groups.reduce((s, g) => s + g.creditCents, 0),
			invoiceCount: all.length
		}
	};
}

// --- Zahler --------------------------------------------------------------------

async function loadPayers(): Promise<Payer[]> {
	const { payers, links, summaries } = await (async () => {
		const base = await mdb().transaction(async (tx) => ({
			payers: await rows(
				tx,
				sql`SELECT id, name, email, note, account_holder, iban_last4, bic FROM payers ORDER BY name, id`
			),
			links: await rows(tx, sql`SELECT payer_id, member_id FROM payer_members`)
		}));
		return { ...base, summaries: (await loadSummaries()).summaries };
	})();
	const contacts = links.length
		? await (
				await membersService()
			).listMemberContacts({ ids: links.map((l) => String(l.member_id)) })
		: [];
	return payers.map((p) => {
		const own = summaries.filter((s) => s.payer?.id === p.id);
		return {
			id: String(p.id),
			name: String(p.name),
			email: str(p.email),
			note: str(p.note),
			members: links
				.filter((l) => l.payer_id === p.id)
				.map((l) => contacts.find((c) => c.id === l.member_id))
				.filter((c) => !!c)
				.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, emails: c.emails })),
			openCents: own.reduce((s, i) => s + i.openCents, 0),
			overdueCents: own.reduce((s, i) => s + (i.overdue ? i.openCents : 0), 0),
			creditCents: own.reduce((s, i) => s + i.creditCents, 0),
			accountHolder: str(p.account_holder),
			ibanMasked: maskIban(str(p.iban_last4)),
			bic: str(p.bic)
		};
	});
}

async function savePayer(tx: Tx, id: string, input: PayerInput) {
	if (input.memberIds.length) {
		const taken = await rows(
			tx,
			sql`SELECT member_id FROM payer_members WHERE member_id IN (${idList(input.memberIds)}) AND payer_id <> ${id}`
		);
		if (taken.length) {
			throw errors.conflict('Mindestens ein Mitglied gehoert bereits zu einem anderen Zahler');
		}
	}
	const bank = storeIban(input.iban);
	await tx.execute(
		sql`UPDATE payers SET account_holder = ${input.accountHolder}, bic = ${input.bic} WHERE id = ${id}`
	);
	if (bank) {
		await tx.execute(
			sql`UPDATE payers SET iban_enc = ${bank.enc}, iban_last4 = ${bank.last4}, iban_hash = ${bank.hash}
			WHERE id = ${id}`
		);
	}
	await tx.execute(sql`DELETE FROM payer_members WHERE payer_id = ${id}`);
	for (const m of new Set(input.memberIds)) {
		await tx.execute(sql`INSERT INTO payer_members (payer_id, member_id) VALUES (${id}, ${m})`);
	}
}

// --- PDF -----------------------------------------------------------------------

// --- Aktionen ------------------------------------------------------------------

async function actionReceivables(ctx: RequestContext): Promise<ActionReceivables[]> {
	await syncIfStale(ctx);
	const sources = await (await actionsService()).listReceivableSources();
	const settings = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT action_id, excluded, to_char(due_on, 'YYYY-MM-DD') AS due_on FROM action_settings`
		)
	);
	const { summaries } = await loadSummaries(sql`i.source = 'action'`);
	return sources.map((s) => {
		const own = summaries.filter((i) => i.action?.id === s.id && i.status !== 'cancelled');
		const st = settings.find((r) => r.action_id === s.id);
		return {
			actionId: s.id,
			name: s.name,
			startsOn: s.startsOn,
			feeCents: s.feeCents,
			teamFeeCents: s.teamFeeCents,
			excluded: Boolean(st?.excluded),
			dueOn: str(st?.due_on),
			invoiceCount: own.length,
			totalCents: own.reduce((a, i) => a + i.totalCents, 0),
			paidCents: own.reduce((a, i) => a + i.paidCents, 0),
			openCents: own.reduce((a, i) => a + i.openCents, 0),
			overdueCents: own.reduce((a, i) => a + (i.overdue ? i.openCents : 0), 0)
		};
	});
}

export const invoiceEndpoints = [
	{
		method: 'GET',
		path: '/invoices',
		summary: 'Rechnungen auflisten',
		tags: TAGS,
		permission: VIEW,
		query: invoiceListQuery,
		handler: async ({ ctx, query }) => {
			const q = query as InvoiceListQuery;
			await syncIfStale(ctx);
			const { summaries } = await loadSummaries(invoiceWhere(q));
			const filtered = filterSummaries(summaries, q).sort(
				(a, b) => b.issuedOn.localeCompare(a.issuedOn) || b.number.localeCompare(a.number)
			);
			return {
				items: filtered.slice(q.offset, q.offset + q.limit),
				total: filtered.length,
				totals: {
					totalCents: filtered.reduce((s, i) => s + i.totalCents, 0),
					paidCents: filtered.reduce((s, i) => s + i.paidCents, 0),
					openCents: filtered.reduce((s, i) => s + i.openCents, 0)
				}
			} satisfies InvoiceList;
		}
	},
	{
		method: 'GET',
		path: '/invoices/:id',
		summary: 'Rechnung mit Posten, Zahlungen und Erinnerungen',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		handler: ({ ctx, params }) => detail(ctx, (params as { id: string }).id)
	},
	{
		method: 'GET',
		path: '/invoices/:id/pdf',
		summary: 'Rechnung als PDF (Briefvorlage)',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		handler: ({ ctx, params }) => invoicePdfResponse(ctx, (params as { id: string }).id)
	},
	{
		method: 'GET',
		path: '/invoices/:id/documents/:version/pdf',
		summary: 'Versendete Fassung einer Rechnung als PDF',
		tags: TAGS,
		permission: VIEW,
		params: z.object({ id: z.uuid(), version: z.coerce.number().int().min(1).max(1000) }),
		handler: ({ ctx, params }) => {
			const p = params as unknown as { id: string; version: number };
			return invoicePdfResponse(ctx, p.id, p.version);
		}
	},
	{
		method: 'POST',
		path: '/invoices/:id/send',
		summary: 'Rechnung (neue Fassung) per Mail mit PDF senden',
		tags: TAGS,
		permission: 'treasury.invoice.send',
		params: idParams,
		handler: ({ ctx, params }) => sendDocuments(ctx, [(params as { id: string }).id], 'manual')
	},
	{
		method: 'POST',
		path: '/invoices',
		summary: 'Rechnung manuell anlegen',
		tags: TAGS,
		permission: EDIT,
		body: invoiceInput,
		handler: async ({ ctx, body }) => {
			const input = body as InvoiceInput;
			await validateRefs(input.lines);
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await requirePayer(tx, input.payerId);
				const n = await nextInvoiceNumber(tx, input.issuedOn);
				await tx.execute(
					sql`INSERT INTO invoices (id, number, year, seq, source, payer_id, recipient_name, recipient_email,
						issued_on, due_on, note, reminders_paused, created_by)
					VALUES (${id}, ${n.number}, ${n.year}, ${n.seq}, 'manual', ${input.payerId}, ${input.recipientName},
						${input.recipientEmail}, ${input.issuedOn}, ${input.dueOn}, ${input.note}, ${input.remindersPaused},
						${ctx.userId})`
				);
				await insertLines(tx, id, input.lines);
			});
			await core.audit.logFromContext(ctx, 'treasury.invoice.created', {
				target: id,
				metadata: { lines: input.lines.length }
			});
			return detail(ctx, id);
		}
	},
	{
		method: 'PUT',
		path: '/invoices/:id',
		summary: 'Rechnung aendern (manuell: inkl. Posten; aus Aktionen: Empfaenger, Frist, Notiz)',
		description:
			'Posten bereits (teil-)bezahlter Rechnungen lassen sich nicht mehr aendern (409); dafuer gibt es die Ermaessigung je Posten.',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params, request }) => {
			const { id } = params as { id: string };
			const raw = await request.json().catch(() => {
				throw errors.badRequest('Ungueltiger JSON-Body');
			});
			const source = await mdb().transaction(async (tx) =>
				String((await lockInvoice(tx, id)).source)
			);
			const parsed = (source === 'manual' ? invoiceInput : invoicePatchInput).safeParse(raw);
			if (!parsed.success) {
				throw errors.validation(
					parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
				);
			}
			const input = parsed.data as InvoiceInput | InvoicePatchInput;
			const lines = 'lines' in input ? input.lines : null;
			if (lines) await validateRefs(lines);
			await mdb().transaction(async (tx) => {
				const cur = await lockInvoice(tx, id);
				await requirePayer(tx, input.payerId);
				if (lines) {
					const existing = await rows(
						tx,
						sql`SELECT description, amount_cents, member_id, action_id FROM invoice_lines
							WHERE invoice_id = ${id} ORDER BY position, id`
					);
					const same =
						existing.length === lines.length &&
						existing.every(
							(e, i) =>
								String(e.description) === lines[i]!.description &&
								num(e.amount_cents) === lines[i]!.amountCents &&
								str(e.member_id) === lines[i]!.memberId &&
								str(e.action_id) === lines[i]!.actionId
						);
					if (!same) {
						if ((await paidOf(tx, id)) > 0) {
							throw errors.conflict(
								'Die Rechnung ist bereits (teilweise) bezahlt. Posten koennen nicht mehr geaendert werden.'
							);
						}
						await tx.execute(sql`DELETE FROM invoice_lines WHERE invoice_id = ${id}`);
						await insertLines(tx, id, lines);
					}
				}
				const issuedOn = 'issuedOn' in input ? input.issuedOn : String(cur.issued_on);
				await tx.execute(
					sql`UPDATE invoices SET payer_id = ${input.payerId}, recipient_name = ${input.recipientName},
						recipient_email = ${input.recipientEmail}, issued_on = ${issuedOn}, due_on = ${input.dueOn},
						note = ${input.note}, reminders_paused = ${input.remindersPaused}, updated_at = now()
					WHERE id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'treasury.invoice.updated', { target: id });
			await refreshSentDocuments(ctx, [id]);
			return detail(ctx, id);
		}
	},
	{
		method: 'DELETE',
		path: '/invoices/:id',
		summary: 'Manuelle Rechnung ohne Zahlungen loeschen',
		tags: TAGS,
		permission: 'treasury.invoice.delete',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			await mdb().transaction(async (tx) => {
				const cur = await lockInvoice(tx, id);
				if (cur.source !== 'manual') {
					throw errors.conflict('Rechnungen aus Aktionen werden storniert, nicht geloescht');
				}
				if ((await paidOf(tx, id)) > 0) {
					throw errors.conflict('Bezahlte Rechnungen koennen nur storniert werden');
				}
				await tx.execute(sql`DELETE FROM invoices WHERE id = ${id}`);
			});
			await core.audit.logFromContext(ctx, 'treasury.invoice.deleted', { target: id });
			return null;
		}
	},
	{
		method: 'POST',
		path: '/invoices/:id/cancel',
		summary: 'Rechnung stornieren (bereits Bezahltes wird Guthaben)',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: cancelInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const { reason } = body as { reason: string | null };
			await mdb().transaction(async (tx) => {
				const cur = await lockInvoice(tx, id);
				if (cur.cancelled_at) throw errors.conflict('Rechnung ist bereits storniert');
				await tx.execute(
					sql`UPDATE invoices SET cancelled_at = now(), cancel_reason = ${reason ?? 'Storniert'},
						auto_cancelled = false, updated_at = now() WHERE id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'treasury.invoice.cancelled', { target: id });
			await refreshSentDocuments(ctx, [id]);
			return detail(ctx, id);
		}
	},
	{
		method: 'POST',
		path: '/invoices/:id/reactivate',
		summary: 'Stornierung zuruecknehmen',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			await mdb().transaction(async (tx) => {
				const cur = await lockInvoice(tx, id);
				if (!cur.cancelled_at) throw errors.conflict('Rechnung ist nicht storniert');
				if (cur.auto_cancelled) {
					throw errors.conflict(
						'Automatisch storniert: Teilnahme oder Beitrag der Aktion ist entfallen'
					);
				}
				await tx.execute(
					sql`UPDATE invoices SET cancelled_at = NULL, cancel_reason = NULL, updated_at = now() WHERE id = ${id}`
				);
			});
			await core.audit.logFromContext(ctx, 'treasury.invoice.reactivated', { target: id });
			await refreshSentDocuments(ctx, [id]);
			return detail(ctx, id);
		}
	},
	{
		method: 'PUT',
		path: '/invoices/:id/lines/:lineId',
		summary: 'Posten: Ermaessigung/Erlass und Mitglied',
		tags: TAGS,
		permission: EDIT,
		params: lineParams,
		body: lineWaiveInput,
		handler: async ({ ctx, params, body }) => {
			const { id, lineId } = params as { id: string; lineId: string };
			const input = body as LineWaiveInput;
			if (input.memberId) await validateRefs([{ memberId: input.memberId, actionId: null }]);
			await mdb().transaction(async (tx) => {
				await lockInvoice(tx, id);
				const [l] = await rows(
					tx,
					sql`SELECT l.amount_cents, coalesce((SELECT sum(a.amount_cents) FROM allocations a WHERE a.line_id = l.id), 0) AS paid
					FROM invoice_lines l WHERE l.id = ${lineId} AND l.invoice_id = ${id} FOR UPDATE`
				);
				if (!l) throw errors.notFound('Posten nicht gefunden');
				if (input.waivedCents > num(l.amount_cents) - num(l.paid)) {
					throw errors.validation([
						{
							path: ['waivedCents'],
							message: 'Die Ermäßigung ist höher als der noch offene Betrag'
						}
					]);
				}
				await tx.execute(
					sql`UPDATE invoice_lines SET waived_cents = ${input.waivedCents},
						waive_reason = ${input.waivedCents > 0 ? input.reason : null}, member_id = ${input.memberId}
					WHERE id = ${lineId}`
				);
				await tx.execute(sql`UPDATE invoices SET updated_at = now() WHERE id = ${id}`);
			});
			await core.audit.logFromContext(ctx, 'treasury.invoice.line_updated', {
				target: id,
				metadata: { lineId, waivedCents: input.waivedCents }
			});
			await refreshSentDocuments(ctx, [id]);
			// Ein Erlass kann die Rechnung vollstaendig begleichen → keine Bestaetigung (nichts gezahlt)
			return detail(ctx, id);
		}
	},
	{
		method: 'POST',
		path: '/invoices/:id/mark-paid',
		summary: 'Zahlung erfassen und dieser Rechnung zuordnen (z. B. Barzahlung)',
		tags: TAGS,
		permission: 'treasury.transaction.edit',
		params: idParams,
		body: markPaidInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as MarkPaidInput;
			const txId = crypto.randomUUID();
			const r = await mdb().transaction(async (tx) => {
				await requireAccount(tx, input.accountId);
				const [inv] = await loadRawInvoices(tx, sql`i.id = ${id}`);
				if (!inv) throw errors.notFound('Rechnung nicht gefunden');
				if (inv.row.cancelled_at) throw errors.conflict('Rechnung ist storniert');
				const slots = inv.lines.map((l) => ({
					lineId: String(l.id),
					openCents: Math.max(0, num(l.amount_cents) - num(l.waived_cents) - num(l.paid_cents)),
					dueOn: String(inv.row.due_on),
					order: String(l.position).padStart(4, '0')
				}));
				const open = slots.reduce((s, l) => s + l.openCents, 0);
				if (input.amountCents > open) {
					throw errors.validation([
						{ path: ['amountCents'], message: 'Der Betrag ist höher als der offene Betrag' }
					]);
				}
				await tx.execute(
					sql`INSERT INTO transactions (id, account_id, booked_on, amount_cents, counterparty, purpose,
						category_id, action_id, created_by)
					VALUES (${txId}, ${input.accountId}, ${input.bookedOn}, ${input.amountCents},
						${input.counterparty ?? String(inv.row.recipient_name)}, ${`${String(inv.row.number)} ${String(inv.row.recipient_name)}`.slice(0, 300)},
						${inv.row.source === 'action' ? CONTRIBUTIONS_CATEGORY_ID : null}, ${str(inv.row.action_id)}, ${ctx.userId})`
				);
				return replaceAllocations(
					tx,
					txId,
					distribute(input.amountCents, slots).allocations,
					ctx.userId
				);
			});
			const mail = await notifyPaid(r.invoiceIds, input.notify);
			await core.audit.logFromContext(ctx, 'treasury.invoice.marked_paid', {
				target: id,
				metadata: { transactionId: txId, amountCents: input.amountCents, mailsSent: mail.mailsSent }
			});
			return {
				transactionId: txId,
				allocatedCents: r.allocatedCents,
				unallocatedCents: 0,
				...mail
			} satisfies AllocationResult;
		}
	},
	{
		method: 'POST',
		path: '/invoices/:id/remind',
		summary: 'Zahlungserinnerung jetzt senden (naechste Stufe)',
		tags: TAGS,
		permission: 'treasury.invoice.send',
		params: idParams,
		handler: async ({ ctx, params }) => sendManualReminders(ctx, [(params as { id: string }).id])
	},
	{
		method: 'POST',
		path: '/reminders/run',
		summary: 'Faellige Erinnerungen jetzt versenden (wie der taegliche Job)',
		tags: TAGS,
		permission: 'treasury.invoice.send',
		handler: ({ ctx }) => runReminderJob(ctx)
	},
	{
		method: 'POST',
		path: '/sync',
		summary: 'Rechnungen mit den Aktionen abgleichen',
		tags: TAGS,
		permission: EDIT,
		handler: ({ ctx }) => syncActions(ctx)
	},
	{
		method: 'GET',
		path: '/open-items',
		summary: 'Offene Posten gruppiert nach Zahler/Person oder Aktion',
		tags: TAGS,
		permission: VIEW,
		query: openItemsQuery,
		handler: ({ ctx, query }) => openItems(ctx, query as z.infer<typeof openItemsQuery>)
	},
	{
		method: 'GET',
		path: '/open-items.csv',
		summary: 'Offene Posten als CSV',
		tags: TAGS,
		permission: VIEW,
		query: openItemsQuery,
		handler: async ({ ctx, query }) => {
			const data = await openItems(ctx, query as z.infer<typeof openItemsQuery>);
			const csv = csvDocument(
				[
					'Gruppe',
					'Rechnung',
					'Empfänger',
					'Aktion',
					'Fällig',
					'Status',
					'Gesamt',
					'Bezahlt',
					'Offen',
					'Guthaben',
					'Tage überfällig'
				],
				data.groups.flatMap((g) =>
					g.invoices.map((i) => [
						g.label,
						i.number,
						i.recipientName,
						i.action?.name ?? '',
						formatDateDe(i.dueOn),
						INVOICE_STATUS_LABELS[i.status],
						centsToCsv(i.totalCents),
						centsToCsv(i.paidCents),
						centsToCsv(i.openCents),
						centsToCsv(i.creditCents),
						i.daysOverdue
					])
				)
			);
			await core.audit.logFromContext(ctx, 'treasury.open_items.exported', {
				metadata: { invoices: data.totals.invoiceCount }
			});
			return new Response(csv, {
				status: 200,
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="offene-posten-${today()}.csv"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	},
	{
		method: 'GET',
		path: '/actions',
		summary: 'Forderungen je Aktion (Beitraege)',
		tags: TAGS,
		permission: VIEW,
		handler: ({ ctx }) => actionReceivables(ctx)
	},
	{
		method: 'PUT',
		path: '/actions/:id/settings',
		summary: 'Aktion ausschliessen bzw. Faelligkeit festlegen',
		description: 'Eine feste Faelligkeit gilt fuer alle offenen Rechnungen der Aktion.',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: actionSettingsInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as ActionSettingsInput;
			const known = await (await actionsService()).listActionRefs({ ids: [id] });
			if (!known.length) throw errors.notFound('Aktion nicht gefunden');
			await mdb().transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO action_settings (action_id, excluded, due_on) VALUES (${id}, ${input.excluded}, ${input.dueOn})
					ON CONFLICT (action_id) DO UPDATE SET excluded = excluded.excluded, due_on = excluded.due_on, updated_at = now()`
				);
				if (input.dueOn) {
					await tx.execute(
						sql`UPDATE invoices SET due_on = ${input.dueOn}, updated_at = now()
						WHERE source = 'action' AND action_id = ${id} AND cancelled_at IS NULL`
					);
				}
			});
			await core.audit.logFromContext(ctx, 'treasury.action.settings_updated', {
				target: id,
				metadata: { excluded: input.excluded, dueOn: input.dueOn }
			});
			await syncActions(ctx);
			return (await actionReceivables(ctx)).find((a) => a.actionId === id) ?? null;
		}
	},
	{
		method: 'GET',
		path: '/payers',
		summary: 'Zahler (Familien) mit Mitgliedern und offenen Betraegen',
		tags: TAGS,
		permission: VIEW,
		handler: () => loadPayers()
	},
	{
		method: 'GET',
		path: '/payers/suggestions',
		summary: 'Vorschlaege fuer Zahler aus Geschwistern (gleiche E-Mail/Anschrift)',
		tags: TAGS,
		permission: VIEW,
		handler: async () => {
			const members = await (await membersService()).listMemberContacts({});
			const assigned = await mdb().transaction((tx) =>
				rows(tx, sql`SELECT member_id FROM payer_members`)
			);
			const byId = new Map(members.map((m) => [m.id, m]));
			return suggestPayers(members, new Set(assigned.map((r) => String(r.member_id)))).map(
				(s): PayerSuggestion => ({
					name: s.name,
					reason: s.reason,
					members: s.memberIds.map((id) => {
						const m = byId.get(id)!;
						return { id, name: `${m.firstName} ${m.lastName}`, emails: m.emails };
					})
				})
			);
		}
	},
	{
		method: 'POST',
		path: '/payers',
		summary: 'Zahler anlegen',
		tags: TAGS,
		permission: EDIT,
		body: payerInput,
		handler: async ({ ctx, body }) => {
			const input = body as PayerInput;
			await validateRefs(input.memberIds.map((memberId) => ({ memberId, actionId: null })));
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO payers (id, name, email, note) VALUES (${id}, ${input.name}, ${input.email}, ${input.note})`
				);
				await savePayer(tx, id, input);
			});
			await core.audit.logFromContext(ctx, 'treasury.payer.created', {
				target: id,
				metadata: { members: input.memberIds.length }
			});
			return (await loadPayers()).find((p) => p.id === id)!;
		}
	},
	{
		method: 'PUT',
		path: '/payers/:id',
		summary: 'Zahler aendern',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		body: payerInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as PayerInput;
			await validateRefs(input.memberIds.map((memberId) => ({ memberId, actionId: null })));
			await mdb().transaction(async (tx) => {
				const [p] = await rows(tx, sql`SELECT id FROM payers WHERE id = ${id} FOR UPDATE`);
				if (!p) throw errors.notFound('Zahler nicht gefunden');
				await tx.execute(
					sql`UPDATE payers SET name = ${input.name}, email = ${input.email}, note = ${input.note},
						updated_at = now() WHERE id = ${id}`
				);
				await savePayer(tx, id, input);
			});
			await core.audit.logFromContext(ctx, 'treasury.payer.updated', {
				target: id,
				metadata: { members: input.memberIds.length }
			});
			return (await loadPayers()).find((p) => p.id === id)!;
		}
	},
	{
		method: 'GET',
		path: '/payers/:id/iban',
		summary: 'IBAN eines Zahlers im Klartext (auditiert)',
		tags: TAGS,
		permission: 'treasury.bank.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const enc = await mdb().transaction(async (tx) => {
				const [p] = await rows(tx, sql`SELECT iban_enc FROM payers WHERE id = ${id}`);
				if (!p) throw errors.notFound('Zahler nicht gefunden');
				return p.iban_enc;
			});
			const iban = decryptIban(enc);
			if (!iban) throw errors.notFound('Keine IBAN hinterlegt');
			await core.audit.logFromContext(ctx, 'treasury.payer.iban_viewed', { target: id });
			return new Response(JSON.stringify({ data: { iban: formatIban(iban) } }), {
				status: 200,
				headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' }
			});
		}
	},
	{
		method: 'DELETE',
		path: '/payers/:id',
		summary: 'Zahler loeschen (Rechnungen bleiben erhalten)',
		tags: TAGS,
		permission: EDIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			await mdb().transaction(async (tx) => {
				const [p] = await rows(tx, sql`DELETE FROM payers WHERE id = ${id} RETURNING id`);
				if (!p) throw errors.notFound('Zahler nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'treasury.payer.deleted', { target: id });
			return null;
		}
	},
	{
		method: 'GET',
		path: '/members',
		summary: 'Mitglieder suchen (Auswahl fuer Rechnungen/Zahler)',
		tags: TAGS,
		permission: VIEW,
		query: z.object({
			search: z.string().trim().max(100).optional(),
			ids: z.string().max(4000).optional()
		}),
		handler: async ({ query }) => {
			const q = query as { search?: string; ids?: string };
			const ids = q.ids ? q.ids.split(',').filter((v) => z.uuid().safeParse(v).success) : undefined;
			const list = await (
				await membersService()
			).listMemberContacts({
				ids,
				search: q.search,
				limit: ids ? 200 : q.search ? 30 : 1000
			});
			return list.map((m) => ({
				id: m.id,
				name: `${m.firstName} ${m.lastName}`,
				emails: m.emails
			}));
		}
	},
	{
		method: 'GET',
		path: '/action-refs',
		summary: 'Aktionen suchen (Auswahl fuer Buchungen/Rechnungen)',
		tags: TAGS,
		permission: VIEW,
		query: z.object({ search: z.string().trim().max(100).optional() }),
		handler: async ({ query }) =>
			(await actionsService()).listActionRefs({
				search: (query as { search?: string }).search,
				limit: 50
			})
	}
] as ApiEndpoint[];
