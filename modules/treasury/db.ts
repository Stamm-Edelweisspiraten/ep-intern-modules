/**
 * Datenbank-Hilfen und Loader der Kasse. Alles mit `tx` läuft INNERHALB einer Modul-Transaktion;
 * Namensauflösung (`resolveNames`) nutzt die Dienste von `members`/`actions` und läuft DANACH.
 */
import { sql } from 'drizzle-orm';
import { core, errors, type Tx } from '$lib/sdk/server';
import type { ActionsService } from '$lib/modules/actions/contract';
import type { MembersService } from '$lib/modules/members/contract';
import { invoiceTotals, lineOpen, overdueDays } from './logic';
import {
	CONTRIBUTIONS_CATEGORY_ID,
	MODULE_ID,
	type Account,
	type AccountKind,
	type InvoiceDetail,
	type InvoiceDocument,
	type InvoiceLine,
	type InvoiceSource,
	type InvoiceSummary,
	type Transaction
} from './schemas';

export type Row = Record<string, unknown>;

export const mdb = () => core.database.forModule(MODULE_ID);

export async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	return ((await tx.execute(query)) as unknown as { rows: Row[] }).rows;
}

/** pg liefert Date, PGlite Strings */
export const iso = (v: unknown): string => {
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
export const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
export const num = (v: unknown): number => Number(v ?? 0);
export const str = (v: unknown): string | null => (v == null ? null : String(v));

export const idList = (ids: string[]) =>
	sql.join(
		ids.map((v) => sql`${v}`),
		sql`, `
	);

let todayOverride: string | null = null;
/** Nur für Tests: festes „heute“ (`YYYY-MM-DD`) */
export function setTreasuryTodayForTests(d: string | null): void {
	todayOverride = d;
}
/** Heutiges Datum in Deutschland */
export function today(): string {
	return (
		todayOverride ??
		new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
	);
}

export const membersService = () => core.modules.use<MembersService>('members', MODULE_ID);
export const actionsService = () => core.modules.use<ActionsService>('actions', MODULE_ID);

// --- Konten ----------------------------------------------------------------------

export async function loadAccounts(tx: Tx, upTo?: string): Promise<Account[]> {
	const limit = upTo ? sql`AND t.booked_on <= ${upTo}` : sql``;
	const found = await rows(
		tx,
		sql`SELECT a.id, a.name, a.kind, a.iban, a.opening_balance_cents,
			to_char(a.opening_date, 'YYYY-MM-DD') AS opening_date, a.archived_at, a.is_default,
			coalesce((SELECT sum(t.amount_cents) FROM transactions t WHERE t.account_id = a.id ${limit}), 0) AS sum_cents,
			(SELECT count(*)::int FROM transactions t WHERE t.account_id = a.id) AS tx_count,
			(SELECT to_char(max(t.booked_on), 'YYYY-MM-DD') FROM transactions t WHERE t.account_id = a.id) AS last_on
		FROM accounts a ORDER BY a.archived_at NULLS FIRST, a.is_default DESC, a.name, a.id`
	);
	return found.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		kind: r.kind as AccountKind,
		iban: str(r.iban),
		openingBalanceCents: num(r.opening_balance_cents),
		openingDate: String(r.opening_date),
		archived: r.archived_at != null,
		balanceCents: num(r.opening_balance_cents) + num(r.sum_cents),
		transactionCount: num(r.tx_count),
		lastBookedOn: str(r.last_on),
		isDefault: Boolean(r.is_default)
	}));
}

export async function requireAccount(tx: Tx, id: string, forWrite = true): Promise<Row> {
	const [a] = await rows(tx, sql`SELECT * FROM accounts WHERE id = ${id}`);
	if (!a) throw errors.notFound('Konto nicht gefunden');
	if (forWrite && a.archived_at != null) throw errors.conflict('Konto ist archiviert');
	return a;
}

// --- Buchungen -----------------------------------------------------------------

export interface RawTransaction {
	row: Row;
	allocations: Row[];
}

/**
 * Einnahmen, die einer Rechnung zugeordnet werden sollten: ohne Kategorie oder als
 * Teilnehmerbeitrag gebucht, keine Umbuchung, noch nicht vollständig verteilt (Alias `t`).
 */
export const NEEDS_ALLOCATION_SQL = sql`(t.amount_cents > 0 AND t.transfer_id IS NULL
	AND (t.category_id IS NULL OR t.category_id = ${CONTRIBUTIONS_CATEGORY_ID})
	AND t.amount_cents > coalesce((SELECT sum(al.amount_cents) FROM allocations al WHERE al.transaction_id = t.id), 0))`;

export const TX_COLUMNS = sql`t.id, t.account_id, a.name AS account_name, to_char(t.booked_on, 'YYYY-MM-DD') AS booked_on,
	t.amount_cents, t.counterparty, t.purpose, t.category_id, c.name AS category_name, t.action_id, t.note,
	t.receipt_name, t.receipt_content_type, t.transfer_id, t.import_hash, t.created_at, t.counterparty_iban_last4, t.counterparty_iban_hash, t.payer_id,
	(SELECT py.name FROM payers py WHERE py.id = t.payer_id) AS payer_name,
	(SELECT p.id || '|' || p.recipient_name FROM payable_payments pp JOIN payables p ON p.id = pp.payable_id
		WHERE pp.transaction_id = t.id LIMIT 1) AS payable_ref,
	(SELECT a2.name FROM transactions t2 JOIN accounts a2 ON a2.id = t2.account_id
		WHERE t.transfer_id IS NOT NULL AND t2.transfer_id = t.transfer_id AND t2.id <> t.id LIMIT 1) AS transfer_account,
	coalesce((SELECT sum(al.amount_cents) FROM allocations al WHERE al.transaction_id = t.id), 0) AS allocated_cents`;

export async function loadTransactionsWhere(
	tx: Tx,
	where: ReturnType<typeof sql>,
	page?: { limit: number; offset: number }
): Promise<RawTransaction[]> {
	const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
	const list = await rows(
		tx,
		sql`SELECT ${TX_COLUMNS} FROM transactions t JOIN accounts a ON a.id = t.account_id
			LEFT JOIN categories c ON c.id = t.category_id
			WHERE ${where} ORDER BY t.booked_on DESC, t.created_at DESC, t.id ${paging}`
	);
	if (!list.length) return [];
	const allocs = await rows(
		tx,
		sql`SELECT al.id, al.transaction_id, al.line_id, al.amount_cents, l.invoice_id, l.description, i.number
			FROM allocations al JOIN invoice_lines l ON l.id = al.line_id JOIN invoices i ON i.id = l.invoice_id
			WHERE al.transaction_id IN (${idList(list.map((r) => String(r.id)))})
			ORDER BY i.number, l.position`
	);
	return list.map((row) => ({
		row,
		allocations: allocs.filter((x) => x.transaction_id === row.id)
	}));
}

export function toTransaction(t: RawTransaction, actionNames: Map<string, string>): Transaction {
	const r = t.row;
	const amount = num(r.amount_cents);
	const allocated = num(r.allocated_cents);
	const actionId = str(r.action_id);
	return {
		id: String(r.id),
		accountId: String(r.account_id),
		accountName: String(r.account_name),
		bookedOn: String(r.booked_on),
		amountCents: amount,
		counterparty: str(r.counterparty),
		purpose: str(r.purpose),
		category: r.category_id ? { id: String(r.category_id), name: String(r.category_name) } : null,
		action: actionId
			? { id: actionId, name: actionNames.get(actionId) ?? 'Unbekannte Aktion' }
			: null,
		note: str(r.note),
		receipt: r.receipt_name
			? { name: String(r.receipt_name), contentType: String(r.receipt_content_type) }
			: null,
		transferId: str(r.transfer_id),
		transferAccountName: str(r.transfer_account),
		counterpartyIbanLast4: str(r.counterparty_iban_last4),
		payer: r.payer_id ? { id: String(r.payer_id), name: String(r.payer_name ?? 'Zahler') } : null,
		payable: r.payable_ref
			? {
					id: String(r.payable_ref).split('|')[0]!,
					recipientName: String(r.payable_ref).split('|').slice(1).join('|')
				}
			: null,
		imported: r.import_hash != null,
		allocatedCents: allocated,
		unallocatedCents: amount > 0 && !r.transfer_id ? Math.max(0, amount - allocated) : 0,
		needsAllocation:
			amount > allocated &&
			!r.transfer_id &&
			(r.category_id == null || r.category_id === CONTRIBUTIONS_CATEGORY_ID),
		allocations: t.allocations.map((a) => ({
			id: String(a.id),
			lineId: String(a.line_id),
			invoiceId: String(a.invoice_id),
			invoiceNumber: String(a.number),
			description: String(a.description),
			amountCents: num(a.amount_cents)
		})),
		createdAt: iso(r.created_at)
	};
}

// --- Rechnungen ----------------------------------------------------------------

export interface RawInvoice {
	row: Row;
	lines: Row[];
	/** Jahresbeitrag: Aufschlüsselung je Mitglied und Ebene (`annual_fee_items`), sonst leer */
	annualItems: Row[];
	reminderLevel: number;
	lastReminderAt: string | null;
	/** Fachliches Datum der letzten Erinnerung */
	lastReminderOn: string | null;
}

/** Lädt Rechnungen inkl. Posten (mit bezahltem Betrag) und Erinnerungsstand. */
export async function loadRawInvoices(
	tx: Tx,
	where: ReturnType<typeof sql> = sql`TRUE`
): Promise<RawInvoice[]> {
	const list = await rows(
		tx,
		sql`SELECT i.id, i.number, i.source, i.action_id, i.recipient_name, i.recipient_email, i.note,
			to_char(i.issued_on, 'YYYY-MM-DD') AS issued_on, to_char(i.due_on, 'YYYY-MM-DD') AS due_on,
			i.reminders_paused, i.cancelled_at, i.cancel_reason, i.auto_cancelled, i.paid_notified_at,
			i.created_at, i.updated_at, i.annual_run_id,
			(SELECT r.year FROM annual_fee_runs r WHERE r.id = i.annual_run_id) AS annual_year,
			(SELECT r.pdf_text FROM annual_fee_runs r WHERE r.id = i.annual_run_id) AS annual_pdf_text,
			coalesce(i.payer_id, (SELECT pm.payer_id FROM invoice_lines l JOIN payer_members pm ON pm.member_id = l.member_id
				WHERE l.invoice_id = i.id ORDER BY l.position LIMIT 1)) AS payer_id,
			(SELECT max(r.level) FROM reminders r WHERE r.invoice_id = i.id) AS reminder_level,
			(SELECT count(*)::int FROM invoice_documents d WHERE d.invoice_id = i.id) AS document_count,
			(SELECT max(r.sent_at) FROM reminders r WHERE r.invoice_id = i.id) AS last_reminder_at,
			(SELECT to_char(max(r.sent_on), 'YYYY-MM-DD') FROM reminders r WHERE r.invoice_id = i.id) AS last_reminder_on
		FROM invoices i WHERE ${where}
		ORDER BY i.due_on, i.number`
	);
	if (!list.length) return [];
	const ids = idList(list.map((r) => String(r.id)));
	const lines = await rows(
		tx,
		sql`SELECT l.id, l.invoice_id, l.position, l.description, l.amount_cents, l.waived_cents, l.waive_reason,
			l.member_id, l.participant_id, l.action_id, l.source_ref, l.fee_level,
			coalesce((SELECT sum(a.amount_cents) FROM allocations a WHERE a.line_id = l.id), 0) AS paid_cents
		FROM invoice_lines l WHERE l.invoice_id IN (${ids}) ORDER BY l.position, l.id`
	);
	const items = await rows(
		tx,
		sql`SELECT invoice_id, member_id, level, amount_cents FROM annual_fee_items
		WHERE invoice_id IN (${ids}) ORDER BY position, id`
	);
	return list.map((row) => ({
		row,
		lines: lines.filter((l) => l.invoice_id === row.id),
		annualItems: items.filter((i) => i.invoice_id === row.id),
		reminderLevel: num(row.reminder_level),
		lastReminderAt: isoOrNull(row.last_reminder_at),
		lastReminderOn: str(row.last_reminder_on)
	}));
}

export interface NameMaps {
	members: Map<string, string>;
	memberEmails: Map<string, string[]>;
	/** Abgewählte, abschaltbare Mail-Kategorien je Mitglied (fehlt = alle an) */
	memberMailOptOut: Map<string, string[]>;
	actions: Map<string, string>;
	payers: Map<string, { name: string; email: string | null }>;
}

/** Namen von Mitgliedern/Aktionen auflösen (AUSSERHALB der Transaktion). */
export async function resolveNames(p: {
	memberIds?: Iterable<string>;
	actionIds?: Iterable<string>;
	payers?: Map<string, { name: string; email: string | null }>;
}): Promise<NameMaps> {
	const memberIds = [...new Set(p.memberIds ?? [])];
	const actionIds = [...new Set(p.actionIds ?? [])];
	const members = new Map<string, string>();
	const memberEmails = new Map<string, string[]>();
	const memberMailOptOut = new Map<string, string[]>();
	const actions = new Map<string, string>();
	if (memberIds.length) {
		for (const m of await (await membersService()).listMemberContacts({ ids: memberIds })) {
			members.set(m.id, `${m.firstName} ${m.lastName}`);
			memberEmails.set(m.id, m.emails);
			if (m.mailOptOut?.length) memberMailOptOut.set(m.id, m.mailOptOut);
		}
	}
	if (actionIds.length) {
		for (const a of await (await actionsService()).listActionRefs({ ids: actionIds })) {
			actions.set(a.id, a.name);
		}
	}
	return { members, memberEmails, memberMailOptOut, actions, payers: p.payers ?? new Map() };
}

/** Zahler je hinterlegter IBAN (HMAC) – für Zuordnungsvorschläge beim Import */
export async function payerByIbanHash(): Promise<Map<string, string>> {
	const found = await mdb().transaction((tx) =>
		rows(tx, sql`SELECT id, iban_hash FROM payers WHERE iban_hash IS NOT NULL`)
	);
	return new Map(found.map((r) => [String(r.iban_hash), String(r.id)]));
}

export async function loadPayerNames(
	tx: Tx
): Promise<Map<string, { name: string; email: string | null }>> {
	const found = await rows(tx, sql`SELECT id, name, email FROM payers`);
	return new Map(found.map((r) => [String(r.id), { name: String(r.name), email: str(r.email) }]));
}

export function collectIds(invoices: RawInvoice[]): { memberIds: string[]; actionIds: string[] } {
	const memberIds = new Set<string>();
	const actionIds = new Set<string>();
	for (const inv of invoices) {
		if (inv.row.action_id) actionIds.add(String(inv.row.action_id));
		for (const i of inv.annualItems) memberIds.add(String(i.member_id));
		for (const l of inv.lines) {
			if (l.member_id) memberIds.add(String(l.member_id));
			if (l.action_id) actionIds.add(String(l.action_id));
		}
	}
	return { memberIds: [...memberIds], actionIds: [...actionIds] };
}

function toLine(l: Row, names: NameMaps): InvoiceLine {
	const memberId = str(l.member_id);
	const actionId = str(l.action_id);
	const amounts = {
		amountCents: num(l.amount_cents),
		waivedCents: num(l.waived_cents),
		paidCents: num(l.paid_cents)
	};
	return {
		id: String(l.id),
		position: num(l.position),
		description: String(l.description),
		...amounts,
		waiveReason: str(l.waive_reason),
		openCents: lineOpen(amounts),
		member: memberId
			? { id: memberId, name: names.members.get(memberId) ?? 'Unbekanntes Mitglied' }
			: null,
		action: actionId
			? { id: actionId, name: names.actions.get(actionId) ?? 'Unbekannte Aktion' }
			: null,
		participantId: str(l.participant_id)
	};
}

export function toSummary(inv: RawInvoice, names: NameMaps, todayIso: string): InvoiceSummary {
	const r = inv.row;
	const cancelled = r.cancelled_at != null;
	const lines = inv.lines.map((l) => toLine(l, names));
	const totals = invoiceTotals(lines, cancelled);
	const payerId = str(r.payer_id);
	const actionId = str(r.action_id);
	const people = [
		...new Set([
			String(r.recipient_name),
			...lines.flatMap((l) => (l.member ? [l.member.name] : []))
		])
	];
	const days = overdueDays(String(r.due_on), todayIso, totals.openCents);
	return {
		id: String(r.id),
		number: String(r.number),
		source: r.source as InvoiceSource,
		status: totals.status,
		overdue: days > 0,
		daysOverdue: days,
		recipientName: String(r.recipient_name),
		recipientEmail: str(r.recipient_email),
		payer: payerId
			? { id: payerId, name: names.payers.get(payerId)?.name ?? 'Unbekannter Zahler' }
			: null,
		action: actionId
			? { id: actionId, name: names.actions.get(actionId) ?? 'Unbekannte Aktion' }
			: null,
		issuedOn: String(r.issued_on),
		dueOn: String(r.due_on),
		totalCents: totals.totalCents,
		paidCents: totals.paidCents,
		openCents: totals.openCents,
		creditCents: totals.creditCents,
		reminderLevel: inv.reminderLevel,
		lastReminderAt: inv.lastReminderAt,
		remindersPaused: Boolean(r.reminders_paused),
		cancelledAt: isoOrNull(r.cancelled_at),
		cancelReason: str(r.cancel_reason),
		paidNotifiedAt: isoOrNull(r.paid_notified_at),
		documentCount: num(r.document_count),
		people
	};
}

/** Alle Empfängeradressen einer Rechnung: Mitglieder der Posten, Rechnungs- und Zahler-Adresse */
export function invoiceAddresses(
	inv: RawInvoice,
	names: NameMaps,
	/**
	 * Abschaltbare Mail-Kategorie (z. B. `payment-confirmation`): Mitglieder, die sie abgewählt haben,
	 * liefern keine Adresse. Haben ALLE Mitglieder der Posten abgewählt, entfallen auch Rechnungs- und
	 * Zahleradresse. Eine gemeinsame Elternadresse (Geschwister) bleibt, solange mindestens ein Kind
	 * nicht abgewählt hat. Ohne Kategorie (verbindliche Mails) wird nichts gefiltert.
	 */
	category?: string
): string[] {
	const optedOut = (memberId: string) =>
		category !== undefined && (names.memberMailOptOut.get(memberId) ?? []).includes(category);
	const out = new Set<string>();
	const memberIds = new Set<string>();
	for (const l of inv.lines) {
		if (l.member_id) memberIds.add(String(l.member_id));
		if (optedOut(String(l.member_id))) continue;
		for (const e of names.memberEmails.get(String(l.member_id)) ?? []) out.add(e.toLowerCase());
	}
	const allOptedOut = memberIds.size > 0 && [...memberIds].every(optedOut);
	if (!allOptedOut) {
		if (inv.row.recipient_email) out.add(String(inv.row.recipient_email).toLowerCase());
		const payer = inv.row.payer_id ? names.payers.get(String(inv.row.payer_id)) : undefined;
		if (payer?.email) out.add(payer.email.toLowerCase());
	}
	return [...out];
}

export async function loadInvoiceDetailRaw(
	tx: Tx,
	id: string
): Promise<{ inv: RawInvoice; payments: Row[]; reminders: Row[] }> {
	const [inv] = await loadRawInvoices(tx, sql`i.id = ${id}`);
	if (!inv) throw errors.notFound('Rechnung nicht gefunden');
	const payments = await rows(
		tx,
		sql`SELECT al.id, al.transaction_id, al.line_id, al.amount_cents, to_char(t.booked_on, 'YYYY-MM-DD') AS booked_on,
			t.counterparty, a.name AS account_name
		FROM allocations al JOIN invoice_lines l ON l.id = al.line_id
		JOIN transactions t ON t.id = al.transaction_id JOIN accounts a ON a.id = t.account_id
		WHERE l.invoice_id = ${id} ORDER BY t.booked_on, al.created_at`
	);
	const reminders = await rows(
		tx,
		sql`SELECT id, level, sent_at, recipients, manual FROM reminders WHERE invoice_id = ${id} ORDER BY sent_at`
	);
	return { inv, payments, reminders };
}

export function toDetail(
	d: { inv: RawInvoice; payments: Row[]; reminders: Row[] },
	names: NameMaps,
	todayIso: string,
	showRecipients: boolean,
	documents: InvoiceDocument[] = []
): InvoiceDetail {
	return {
		...toSummary(d.inv, names, todayIso),
		note: str(d.inv.row.note),
		lines: d.inv.lines.map((l) => toLine(l, names)),
		payments: d.payments.map((p) => ({
			allocationId: String(p.id),
			transactionId: String(p.transaction_id),
			bookedOn: String(p.booked_on),
			accountName: String(p.account_name),
			counterparty: str(p.counterparty),
			lineId: String(p.line_id),
			amountCents: num(p.amount_cents)
		})),
		reminders: d.reminders.map((r) => ({
			id: String(r.id),
			level: num(r.level),
			sentAt: iso(r.sent_at),
			recipients: num(r.recipients),
			manual: Boolean(r.manual)
		})),
		recipients: showRecipients ? invoiceAddresses(d.inv, names) : [],
		documents,
		createdAt: iso(d.inv.row.created_at),
		updatedAt: iso(d.inv.row.updated_at)
	};
}

/** Nächste Rechnungsnummer `R-JJJJ-NNNN` (innerhalb der Transaktion; UNIQUE schützt) */
export async function nextInvoiceNumber(
	tx: Tx,
	issuedOn: string
): Promise<{ number: string; year: number; seq: number }> {
	const year = Number(issuedOn.slice(0, 4));
	// Serialisiert parallele Vergaben bis zum Transaktionsende
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('treasury.invoice-number'))`);
	const [r] = await rows(
		tx,
		sql`SELECT coalesce(max(seq), 0) + 1 AS next FROM invoices WHERE year = ${year}`
	);
	const seq = num(r?.next) || 1;
	return { number: `R-${year}-${String(seq).padStart(4, '0')}`, year, seq };
}
