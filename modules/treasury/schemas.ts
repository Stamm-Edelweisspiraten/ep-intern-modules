import { z } from 'zod';
import { isValidIban, normalizeIban } from './iban';

export const MODULE_ID = 'treasury';

// --- Konstanten ---------------------------------------------------------------

export const ACCOUNT_KINDS = ['giro', 'cash', 'other'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
	giro: 'Girokonto',
	cash: 'Barkasse',
	other: 'Sonstiges'
};

export const CATEGORY_KINDS = ['income', 'expense', 'both'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
	income: 'Einnahme',
	expense: 'Ausgabe',
	both: 'Beides'
};

export const INVOICE_SOURCES = ['manual', 'action'] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

export const INVOICE_STATUSES = ['open', 'partial', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
	open: 'Offen',
	partial: 'Teilweise bezahlt',
	paid: 'Bezahlt',
	cancelled: 'Storniert'
};

export const MAX_AMOUNT_CENTS = 100_000_000; // 1 Mio. €
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_CONTENT_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp'
] as const;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_INVOICE_LINES = 50;
export const MAX_ALLOCATIONS = 100;
/** Rechnungsnummern `R-JJJJ-NNNN` */
export const INVOICE_NUMBER_RE = /\bR-(\d{4})-(\d{4,6})\b/gi;

/** Standardkategorien (feste IDs, beim Aktivieren angelegt, umbenennbar) */
export const DEFAULT_CATEGORIES: { id: string; name: string; kind: CategoryKind }[] = [
	{ id: 'cat-beitraege', name: 'Teilnehmerbeiträge', kind: 'income' },
	{ id: 'cat-mitgliedsbeitraege', name: 'Mitgliedsbeiträge', kind: 'income' },
	{ id: 'cat-zuschuesse', name: 'Zuschüsse', kind: 'income' },
	{ id: 'cat-spenden', name: 'Spenden', kind: 'income' },
	{ id: 'cat-material', name: 'Material', kind: 'expense' },
	{ id: 'cat-fahrt', name: 'Fahrtkosten', kind: 'expense' },
	{ id: 'cat-unterkunft', name: 'Unterkunft', kind: 'expense' },
	{ id: 'cat-verpflegung', name: 'Verpflegung', kind: 'expense' },
	{ id: 'cat-gebuehren', name: 'Bankgebühren', kind: 'expense' },
	{ id: 'cat-rueckzahlung', name: 'Rückzahlungen', kind: 'expense' },
	{ id: 'cat-sonstiges', name: 'Sonstiges', kind: 'both' }
];
export const CONTRIBUTIONS_CATEGORY_ID = 'cat-beitraege';

// --- Hilfs-Schemas ------------------------------------------------------------

const id = z.uuid('Ungültige ID');
/** Kategorien haben feste Standard-IDs (`cat-…`) oder UUIDs */
const categoryId = z.string().regex(/^(cat-[a-z0-9-]{1,40}|[0-9a-f-]{36})$/, 'Ungültige Kategorie');

function isRealDate(v: string): boolean {
	const d = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export const dateString = z
	.string('Bitte ein Datum angeben')
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Format JJJJ-MM-TT')
	.refine(isRealDate, 'Kein gültiges Datum');

const text = (max: number) =>
	z
		.string('Pflichtfeld')
		.trim()
		.min(1, 'Pflichtfeld')
		.max(max, `Höchstens ${max} Zeichen`)
		// eslint-disable-next-line no-control-regex
		.refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), 'Ungültige Zeichen');

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

const optionalEmail = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.nullish()
	.transform((v) => (v ? v : null))
	.refine((v) => v === null || z.email().safeParse(v).success, 'Ungültige E-Mail-Adresse');

const cents = (min: number, message = 'Ungültiger Betrag') =>
	z.number(message).int(message).min(min, message).max(MAX_AMOUNT_CENTS, 'Betrag zu groß');

export const idParams = z.object({ id });
export const lineParams = z.object({ id, lineId: id });
export const categoryParams = z.object({ id: categoryId });

// --- Konten -------------------------------------------------------------------

export const accountInput = z.object({
	name: text(100),
	kind: z.enum(ACCOUNT_KINDS, 'Bitte eine Kontoart wählen'),
	iban: z
		.string()
		.trim()
		.toUpperCase()
		.max(40)
		.nullish()
		.transform((v) => (v ? v.replace(/\s+/g, '') : null)),
	openingBalanceCents: z
		.number('Ungültiger Betrag')
		.int('Ungültiger Betrag')
		.min(-MAX_AMOUNT_CENTS, 'Betrag zu klein')
		.max(MAX_AMOUNT_CENTS, 'Betrag zu groß')
		.default(0),
	openingDate: dateString,
	archived: z.boolean().default(false)
});
export type AccountInput = z.infer<typeof accountInput>;
export type AccountFormInput = z.input<typeof accountInput>;

export interface Account {
	id: string;
	name: string;
	kind: AccountKind;
	iban: string | null;
	openingBalanceCents: number;
	openingDate: string;
	archived: boolean;
	balanceCents: number;
	transactionCount: number;
	lastBookedOn: string | null;
	/** Vorbelegung in allen Dialogen (genau ein Konto) */
	isDefault: boolean;
}

export const categoryInput = z.object({
	name: text(60),
	kind: z.enum(CATEGORY_KINDS),
	archived: z.boolean().default(false)
});
export type CategoryInput = z.infer<typeof categoryInput>;

export interface Category {
	id: string;
	name: string;
	kind: CategoryKind;
	archived: boolean;
	builtIn: boolean;
}

// --- Buchungen ----------------------------------------------------------------

export const transactionInput = z.object({
	accountId: id,
	bookedOn: dateString,
	/** Einnahme positiv, Ausgabe negativ, nie 0 */
	amountCents: z
		.number('Bitte einen Betrag angeben')
		.int('Bitte einen Betrag angeben')
		.min(-MAX_AMOUNT_CENTS, 'Betrag zu groß')
		.max(MAX_AMOUNT_CENTS, 'Betrag zu groß')
		.refine((v) => v !== 0, 'Der Betrag darf nicht 0 sein'),
	counterparty: optionalText(140),
	purpose: optionalText(300),
	categoryId: categoryId.nullish().transform((v) => v ?? null),
	actionId: id.nullish().transform((v) => v ?? null),
	note: optionalText(1000)
});
export type TransactionInput = z.infer<typeof transactionInput>;
export type TransactionFormInput = z.input<typeof transactionInput>;

export const transferInput = z
	.object({
		fromAccountId: id,
		toAccountId: id,
		bookedOn: dateString,
		amountCents: cents(1, 'Der Betrag muss größer als 0 sein'),
		purpose: optionalText(300)
	})
	.refine((t) => t.fromAccountId !== t.toAccountId, {
		path: ['toAccountId'],
		message: 'Bitte zwei verschiedene Konten wählen'
	});
export type TransferInput = z.infer<typeof transferInput>;

export const transactionListQuery = z.object({
	accountId: id.optional(),
	categoryId: categoryId.optional(),
	actionId: id.optional(),
	from: dateString.optional(),
	to: dateString.optional(),
	search: z.string().trim().max(100).optional(),
	/** `unassigned`: Einnahmen mit noch nicht zugeordnetem Betrag */
	filter: z.enum(['all', 'income', 'expense', 'unassigned']).default('all'),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});
export type TransactionListQuery = z.infer<typeof transactionListQuery>;

export interface AllocationRef {
	id: string;
	lineId: string;
	invoiceId: string;
	invoiceNumber: string;
	description: string;
	amountCents: number;
}

export interface Transaction {
	id: string;
	accountId: string;
	accountName: string;
	bookedOn: string;
	amountCents: number;
	counterparty: string | null;
	purpose: string | null;
	category: { id: string; name: string } | null;
	action: { id: string; name: string } | null;
	note: string | null;
	receipt: { name: string; contentType: string } | null;
	transferId: string | null;
	/** Gegenkonto bei Umbuchungen */
	transferAccountName: string | null;
	/** Letzte vier Stellen der IBAN der Gegenpartei (aus dem Import) */
	counterpartyIbanLast4: string | null;
	/** Verknüpfte Auszahlung (bei Ausgaben) */
	payable: { id: string; recipientName: string } | null;
	imported: boolean;
	allocatedCents: number;
	/** Noch nicht auf Rechnungen verteilter Betrag (nur Einnahmen) */
	unallocatedCents: number;
	/** Einnahme ohne Kategorie bzw. Teilnehmerbeitrag mit offenem Rest – sollte zugeordnet werden */
	needsAllocation: boolean;
	allocations: AllocationRef[];
	createdAt: string;
}

export interface TransactionList {
	items: Transaction[];
	total: number;
	/** Summe der gefilterten Buchungen */
	sumCents: number;
}

// --- Zahler (Familien) ----------------------------------------------------------

/** Optionale IBAN: leer = keine; `undefined` beim Bearbeiten = unverändert */
const optionalIban = z
	.string()
	.trim()
	.max(50, 'IBAN zu lang')
	.transform((v) => normalizeIban(v))
	.refine((v) => v === '' || isValidIban(v), 'Ungültige IBAN');
const optionalBic = z
	.string()
	.trim()
	.toUpperCase()
	.max(11)
	.nullish()
	.transform((v) => (v ? v : null))
	.refine(
		(v) => v === null || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v),
		'Ungültige BIC (8 oder 11 Zeichen)'
	);

export const payerInput = z.object({
	name: text(120),
	email: optionalEmail,
	note: optionalText(500),
	memberIds: z.array(id).max(30, 'Höchstens 30 Mitglieder').default([]),
	accountHolder: optionalText(100),
	/** fehlt = unverändert, '' = entfernen */
	iban: optionalIban.optional(),
	bic: optionalBic
});
export type PayerInput = z.infer<typeof payerInput>;
export type PayerFormInput = z.input<typeof payerInput>;

export interface PayerMember {
	id: string;
	name: string;
	emails: string[];
}

export interface Payer {
	id: string;
	name: string;
	email: string | null;
	note: string | null;
	members: PayerMember[];
	openCents: number;
	overdueCents: number;
	creditCents: number;
	accountHolder: string | null;
	/** `•••• 1234` – Klartext nur über `/payers/:id/iban` mit `treasury.bank.view` */
	ibanMasked: string | null;
	bic: string | null;
}

export interface PayerSuggestion {
	name: string;
	reason: string;
	members: PayerMember[];
}

// --- Rechnungen ---------------------------------------------------------------

export const invoiceLineInput = z.object({
	description: text(200),
	amountCents: cents(0),
	memberId: id.nullish().transform((v) => v ?? null),
	actionId: id.nullish().transform((v) => v ?? null)
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;

export const invoiceInput = z.object({
	payerId: id.nullish().transform((v) => v ?? null),
	recipientName: text(150),
	recipientEmail: optionalEmail,
	issuedOn: dateString,
	dueOn: dateString,
	note: optionalText(1000),
	remindersPaused: z.boolean().default(false),
	lines: z
		.array(invoiceLineInput)
		.min(1, 'Mindestens ein Posten')
		.max(MAX_INVOICE_LINES, `Höchstens ${MAX_INVOICE_LINES} Posten`)
});
export type InvoiceInput = z.infer<typeof invoiceInput>;
export type InvoiceFormInput = z.input<typeof invoiceInput>;

/** Änderungen an automatisch erzeugten Rechnungen (Aktionen): Empfänger, Frist, Erlass */
export const invoicePatchInput = z.object({
	payerId: id.nullish().transform((v) => v ?? null),
	recipientName: text(150),
	recipientEmail: optionalEmail,
	dueOn: dateString,
	note: optionalText(1000),
	remindersPaused: z.boolean().default(false)
});
export type InvoicePatchInput = z.infer<typeof invoicePatchInput>;

export const lineWaiveInput = z.object({
	/** Ermäßigung/Erlass in Cent (0 = keiner) */
	waivedCents: cents(0),
	reason: optionalText(200),
	/** Mitglied zuordnen (z. B. Teilnehmende*r ohne Verknüpfung) */
	memberId: id.nullish().transform((v) => v ?? null)
});
export type LineWaiveInput = z.infer<typeof lineWaiveInput>;

export const cancelInput = z.object({ reason: optionalText(200) });

export const invoiceListQuery = z.object({
	status: z.enum(['all', 'unpaid', 'overdue', ...INVOICE_STATUSES]).default('all'),
	source: z.enum(['all', ...INVOICE_SOURCES]).default('all'),
	actionId: id.optional(),
	payerId: id.optional(),
	memberId: id.optional(),
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuery>;

export interface InvoiceLine {
	id: string;
	position: number;
	description: string;
	amountCents: number;
	waivedCents: number;
	waiveReason: string | null;
	paidCents: number;
	openCents: number;
	member: { id: string; name: string } | null;
	action: { id: string; name: string } | null;
	participantId: string | null;
}

export interface InvoiceSummary {
	id: string;
	number: string;
	source: InvoiceSource;
	status: InvoiceStatus;
	overdue: boolean;
	daysOverdue: number;
	recipientName: string;
	recipientEmail: string | null;
	payer: { id: string; name: string } | null;
	action: { id: string; name: string } | null;
	issuedOn: string;
	dueOn: string;
	totalCents: number;
	paidCents: number;
	openCents: number;
	/** Bezahlter Betrag auf stornierter Rechnung bzw. Überzahlung */
	creditCents: number;
	reminderLevel: number;
	lastReminderAt: string | null;
	remindersPaused: boolean;
	cancelledAt: string | null;
	cancelReason: string | null;
	paidNotifiedAt: string | null;
	/** Anzahl gespeicherter Rechnungsfassungen (PDF) */
	documentCount: number;
	/** Namen der Personen auf den Posten (Anzeige/Suche) */
	people: string[];
}

export interface InvoiceDetail extends InvoiceSummary {
	note: string | null;
	lines: InvoiceLine[];
	payments: {
		allocationId: string;
		transactionId: string;
		bookedOn: string;
		accountName: string;
		counterparty: string | null;
		lineId: string;
		amountCents: number;
	}[];
	reminders: { id: string; level: number; sentAt: string; recipients: number; manual: boolean }[];
	documents: InvoiceDocument[];
	/** Adressen, an die Bestätigungen/Erinnerungen gehen (nur mit invoice.edit/send sichtbar) */
	recipients: string[];
	createdAt: string;
	updatedAt: string;
}

export const DOCUMENT_REASONS = ['registration', 'changed', 'cancelled', 'manual'] as const;
export type DocumentReason = (typeof DOCUMENT_REASONS)[number];
export const DOCUMENT_REASON_LABELS: Record<DocumentReason, string> = {
	registration: 'Anmeldung',
	changed: 'Geänderte Rechnung',
	cancelled: 'Stornierung',
	manual: 'Manuell versendet'
};

export interface InvoiceDocument {
	version: number;
	reason: DocumentReason;
	createdAt: string;
	sentAt: string | null;
	recipients: number;
	totalCents: number;
}

export interface InvoiceList {
	items: InvoiceSummary[];
	total: number;
	totals: { totalCents: number; paidCents: number; openCents: number };
}

// --- Zuordnung (Zahlung ↔ Posten) ----------------------------------------------

export const allocateInput = z.object({
	transactionId: id,
	allocations: z
		.array(z.object({ lineId: id, amountCents: cents(1, 'Betrag muss größer als 0 sein') }))
		.max(MAX_ALLOCATIONS),
	/** Bestätigungs-Mail für vollständig bezahlte Rechnungen senden */
	notify: z.boolean().default(true)
});
export type AllocateInput = z.infer<typeof allocateInput>;

/** Rechnung direkt als bezahlt markieren: legt eine Buchung an und verteilt sie */
export const markPaidInput = z.object({
	accountId: id,
	bookedOn: dateString,
	amountCents: cents(1, 'Der Betrag muss größer als 0 sein'),
	counterparty: optionalText(140),
	notify: z.boolean().default(true)
});
export type MarkPaidInput = z.infer<typeof markPaidInput>;

export interface AllocationResult {
	transactionId: string;
	allocatedCents: number;
	unallocatedCents: number;
	paidInvoices: number;
	mailsSent: number;
	mailErrors: number;
}

export interface OpenLine {
	lineId: string;
	invoiceId: string;
	invoiceNumber: string;
	description: string;
	recipientName: string;
	dueOn: string;
	openCents: number;
	memberId: string | null;
	payerId: string | null;
}

export interface MatchSuggestion {
	transactionId: string;
	confidence: 'high' | 'medium' | 'low';
	reason: string;
	allocations: { lineId: string; amountCents: number }[];
	invoiceNumbers: string[];
}

// --- Offene Posten / Übersicht ------------------------------------------------

export const openItemsQuery = z.object({
	groupBy: z.enum(['payer', 'action']).default('payer'),
	overdue: z.enum(['0', '1']).default('0'),
	search: z.string().trim().max(100).optional()
});

export interface OpenItemsGroup {
	key: string;
	kind: 'payer' | 'member' | 'person' | 'action' | 'manual';
	label: string;
	payerId: string | null;
	openCents: number;
	overdueCents: number;
	creditCents: number;
	invoices: InvoiceSummary[];
}

export interface OpenItems {
	groups: OpenItemsGroup[];
	totals: { openCents: number; overdueCents: number; creditCents: number; invoiceCount: number };
}

export interface Overview {
	accounts: Account[];
	balanceCents: number;
	openCents: number;
	overdueCents: number;
	overdueCount: number;
	creditCents: number;
	unallocatedCount: number;
	unallocatedCents: number;
	recent: Transaction[];
	lastSyncAt: string | null;
	/** Ausstehende Überweisungen */
	payableCents: number;
	payableCount: number;
}

// --- Ausstehende Überweisungen -------------------------------------------------

export const PAYABLE_SOURCES = ['manual', 'reimbursement', 'refund', 'credit'] as const;
export type PayableSource = (typeof PAYABLE_SOURCES)[number];
export const PAYABLE_SOURCE_LABELS: Record<PayableSource, string> = {
	manual: 'Eingangsrechnung',
	reimbursement: 'Auslagenerstattung',
	refund: 'Rückzahlung Überschuss',
	credit: 'Guthaben'
};

export const payableInput = z.object({
	recipientName: text(150),
	description: text(200),
	amountCents: cents(1, 'Der Betrag muss größer als 0 sein'),
	dueOn: dateString.nullish().transform((v) => v ?? null),
	/** fehlt = unverändert, '' = entfernen */
	iban: optionalIban.optional(),
	bic: optionalBic,
	actionId: id.nullish().transform((v) => v ?? null),
	payerId: id.nullish().transform((v) => v ?? null),
	note: optionalText(1000)
});
export type PayableInput = z.infer<typeof payableInput>;
export type PayableFormInput = z.input<typeof payableInput>;

export const payablePayInput = z.object({
	accountId: id,
	bookedOn: dateString,
	amountCents: cents(1, 'Der Betrag muss größer als 0 sein'),
	categoryId: categoryId.nullish().transform((v) => v ?? null)
});
export type PayablePayInput = z.infer<typeof payablePayInput>;

export const payableListQuery = z.object({
	status: z.enum(['open', 'paid', 'cancelled', 'all']).default('open'),
	source: z.enum(['all', ...PAYABLE_SOURCES]).default('all')
});

export interface Payable {
	id: string;
	source: PayableSource;
	recipientName: string;
	description: string;
	amountCents: number;
	paidCents: number;
	openCents: number;
	dueOn: string | null;
	overdue: boolean;
	action: { id: string; name: string } | null;
	payer: { id: string; name: string } | null;
	ibanMasked: string | null;
	hasIban: boolean;
	bic: string | null;
	note: string | null;
	receipt: { name: string; contentType: string } | null;
	cancelledAt: string | null;
	payments: { transactionId: string; bookedOn: string; accountName: string; amountCents: number }[];
	/** Automatisch erzeugt (Abrechnung, Rückzahlung, Guthaben) – Stammdaten nicht editierbar */
	automatic: boolean;
}

export interface PayableList {
	items: Payable[];
	totals: { openCents: number; count: number };
}

// --- Aktionen ------------------------------------------------------------------

export const actionSettingsInput = z.object({
	excluded: z.boolean().default(false),
	dueOn: dateString.nullish().transform((v) => v ?? null)
});
export type ActionSettingsInput = z.infer<typeof actionSettingsInput>;

export interface ActionReceivables {
	actionId: string;
	name: string;
	startsOn: string;
	feeCents: number;
	teamFeeCents: number | null;
	excluded: boolean;
	dueOn: string | null;
	invoiceCount: number;
	totalCents: number;
	paidCents: number;
	openCents: number;
	overdueCents: number;
}

// --- Import --------------------------------------------------------------------

export const IMPORT_PRESETS = ['sparkasse-camt', 'generic'] as const;
export type ImportPreset = (typeof IMPORT_PRESETS)[number];
export const IMPORT_PRESET_LABELS: Record<ImportPreset, string> = {
	'sparkasse-camt': 'Sparkasse / CSV-CAMT',
	generic: 'Andere Bank (Spalten zuordnen)'
};

export const importMappingSchema = z.object({
	delimiter: z.enum([';', ',', '\t']).default(';'),
	/** Spaltennamen der Kopfzeile */
	date: z.string().min(1).max(80),
	amount: z.string().min(1).max(80),
	counterparty: z.string().max(80).nullish(),
	purpose: z.string().max(80).nullish(),
	/** Spalte mit der IBAN der Gegenpartei (Abgleich mit Zahlern) */
	iban: z.string().max(80).nullish(),
	dateFormat: z.enum(['DD.MM.YYYY', 'DD.MM.YY', 'YYYY-MM-DD']).default('DD.MM.YYYY'),
	decimal: z.enum([',', '.']).default(',')
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export interface ImportPreviewRow {
	line: number;
	bookedOn: string | null;
	amountCents: number | null;
	counterparty: string | null;
	purpose: string | null;
	duplicate: boolean;
	error: string | null;
}

export interface ImportPreview {
	headers: string[];
	mapping: ImportMapping;
	rows: ImportPreviewRow[];
	valid: number;
	duplicates: number;
	errors: number;
}

export interface ImportResult {
	batchId: string;
	imported: number;
	duplicates: number;
	errors: number;
	suggestions: number;
}

// --- Berichte -----------------------------------------------------------------

export const reportQuery = z
	.object({ from: dateString, to: dateString })
	.refine((q) => q.from <= q.to, { path: ['to'], message: 'Ende vor Beginn' });
export type ReportQuery = z.infer<typeof reportQuery>;

export interface ReportRow {
	key: string;
	label: string;
	incomeCents: number;
	expenseCents: number;
}

export interface PeriodReport {
	from: string;
	to: string;
	accounts: {
		id: string;
		name: string;
		openingCents: number;
		incomeCents: number;
		expenseCents: number;
		transfersCents: number;
		closingCents: number;
	}[];
	byCategory: ReportRow[];
	byAction: ReportRow[];
	totals: { incomeCents: number; expenseCents: number; resultCents: number };
	unassignedCount: number;
	open: { openCents: number; overdueCents: number; creditCents: number; invoiceCount: number };
}

// --- Einstellungen --------------------------------------------------------------

export const SETTING_KEYS = {
	bankHolder: 'treasury.bank.holder',
	bankIban: 'treasury.bank.iban',
	bankBic: 'treasury.bank.bic',
	bankName: 'treasury.bank.name',
	daysBeforeStart: 'treasury.due.daysBeforeStart',
	minDays: 'treasury.due.minDays',
	remindersEnabled: 'treasury.reminder.enabled',
	firstDays: 'treasury.reminder.firstDays',
	secondDays: 'treasury.reminder.secondDays',
	paidMailEnabled: 'treasury.mail.paidEnabled',
	paidSubject: 'treasury.mail.paidSubject',
	paidBody: 'treasury.mail.paidBody',
	reminderSubject: 'treasury.mail.reminderSubject',
	reminderBody: 'treasury.mail.reminderBody',
	invoiceSubject: 'treasury.mail.invoiceSubject',
	invoiceBody: 'treasury.mail.invoiceBody'
} as const;

export const DEFAULT_PAID_SUBJECT = 'Zahlungseingang bestätigt';
export const DEFAULT_PAID_BODY = `Hallo,

vielen Dank! Wir haben folgende Zahlung erhalten:

{posten}

Summe: {summe}

Herzliche Grüße
Die Kasse`;
export const DEFAULT_REMINDER_SUBJECT = 'Zahlungserinnerung';
export const DEFAULT_REMINDER_BODY = `Hallo,

bei uns sind folgende Beträge noch offen:

{posten}

Offen insgesamt: {summe}

Bitte überweise den Betrag auf folgendes Konto:
{kontodaten}
Verwendungszweck: {verwendungszweck}

Falls du schon bezahlt hast, betrachte diese Nachricht bitte als gegenstandslos.

Herzliche Grüße
Die Kasse`;

export const DEFAULT_INVOICE_SUBJECT = '{anlass}: {rechnungen}';
export const DEFAULT_INVOICE_BODY = `Hallo,

{aenderung}

{posten}

Summe: {summe} – bitte bis {faellig} überweisen:
{kontodaten}
Verwendungszweck: {verwendungszweck}

Die Rechnung findest du im Anhang.

Herzliche Grüße
Die Kasse`;

export const settingsInput = z.object({
	bankHolder: z.string().trim().max(100),
	bankIban: z.string().trim().max(40),
	bankBic: z.string().trim().max(20),
	bankName: z.string().trim().max(100),
	daysBeforeStart: z.number().int().min(0).max(365),
	minDays: z.number().int().min(0).max(365),
	remindersEnabled: z.boolean(),
	firstDays: z.number().int().min(1).max(365),
	secondDays: z.number().int().min(1).max(365),
	paidMailEnabled: z.boolean(),
	paidSubject: z.string().trim().min(1).max(150),
	paidBody: z.string().trim().min(1).max(5000),
	reminderSubject: z.string().trim().min(1).max(150),
	reminderBody: z.string().trim().min(1).max(5000),
	invoiceSubject: z.string().trim().min(1).max(150),
	invoiceBody: z.string().trim().min(1).max(5000)
});
export type TreasurySettings = z.infer<typeof settingsInput>;

export const MAIL_PLACEHOLDERS = [
	['{name}', 'Name(n) der Empfänger*innen'],
	['{posten}', 'Liste der Posten mit Beträgen'],
	['{summe}', 'Summe der Posten'],
	['{rechnungen}', 'Rechnungsnummern'],
	['{faellig}', 'Fälligkeitsdatum (früheste)'],
	['{kontodaten}', 'Kontoinhaber, IBAN, BIC, Bank'],
	['{verwendungszweck}', 'Rechnungsnummern + Name'],
	['{stufe}', 'Erinnerungsstufe (1 oder 2)'],
	['{anlass}', 'Rechnung / Geänderte Rechnung / Stornierung'],
	['{aenderung}', 'Erklärender Satz zur geänderten oder stornierten Rechnung']
] as const;
