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

export const INVOICE_SOURCES = ['manual', 'action', 'annual', 'order'] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];
export const INVOICE_SOURCE_LABELS: Record<InvoiceSource, string> = {
	manual: 'Manuell',
	action: 'Aktion',
	annual: 'Jahresbeitrag',
	order: 'Bestellung'
};

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
/** Mitgliedsbeiträge (Jahresbeitrag) */
export const MEMBERSHIP_CATEGORY_ID = 'cat-mitgliedsbeitraege';

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

const optionalIbanEarly = z
	.string()
	.trim()
	.max(50, 'IBAN zu lang')
	.transform((v) => normalizeIban(v))
	.refine((v) => v === '' || isValidIban(v), 'Ungültige IBAN');

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
	note: optionalText(1000),
	/** IBAN der Gegenpartei (fehlt = unverändert, '' = entfernen) */
	counterpartyIban: optionalIbanEarly.optional(),
	/** Zahler (z. B. per Autovervollständigung gewählt) */
	payerId: id.nullish().transform((v) => v ?? null)
});
export type TransactionInput = z.infer<typeof transactionInput>;
export type TransactionFormInput = z.input<typeof transactionInput>;

/** Neue Buchung, optional gleich zugeordnet (Einnahme → Rechnungsposten, Ausgabe → Auszahlung) */
export const transactionCreateInput = transactionInput.extend({
	allocations: z
		.array(z.object({ lineId: id, amountCents: cents(1, 'Betrag muss größer als 0 sein') }))
		.max(MAX_ALLOCATIONS)
		.default([]),
	payableId: id.nullish().transform((v) => v ?? null),
	notify: z.boolean().default(true)
});
export type TransactionCreateInput = z.infer<typeof transactionCreateInput>;

/** Vorschau für die Zuordnung einer noch nicht gespeicherten Buchung */
export const matchPreviewInput = z.object({
	amountCents: z.number().int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS),
	counterparty: z.string().max(140).nullish(),
	purpose: z.string().max(300).nullish(),
	/** ungeprüft: nur für den Abgleich, wird nicht gespeichert */
	counterpartyIban: z.string().max(50).nullish(),
	payerId: id.nullish()
});
export type MatchPreviewInput = z.infer<typeof matchPreviewInput>;

export interface MatchPreview {
	/** Einnahme: offene Posten + Vorschlag */
	lines: OpenLine[];
	suggestion: Omit<MatchSuggestion, 'transactionId'> | null;
	/** Ausgabe: offene Auszahlungen + Vorschlag */
	payables: Payable[];
	payableSuggestion: {
		payableId: string;
		confidence: 'high' | 'medium' | 'low';
		reason: string;
	} | null;
}

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
	/** Zahler (Familie), der diese Einnahme überwiesen hat */
	payer: { id: string; name: string } | null;
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

export const DOCUMENT_REASONS = [
	'registration',
	'changed',
	'cancelled',
	'manual',
	'annual',
	'order'
] as const;
export type DocumentReason = (typeof DOCUMENT_REASONS)[number];
export const DOCUMENT_REASON_LABELS: Record<DocumentReason, string> = {
	registration: 'Anmeldung',
	changed: 'Geänderte Rechnung',
	cancelled: 'Stornierung',
	manual: 'Manuell versendet',
	annual: 'Jahresbeitrag',
	order: 'Bestellung'
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
	/** IBAN der Zahler*in (optional; daraus lernt die Kasse den Zahler) */
	counterpartyIban: optionalIbanEarly.optional(),
	payerId: id.nullish().transform((v) => v ?? null),
	notify: z.boolean().default(true)
});
export type MarkPaidInput = z.infer<typeof markPaidInput>;

export interface AllocationResult {
	transactionId: string;
	/** Zahler, der aus der Buchung angelegt bzw. ergänzt wurde */
	payer?: { id: string; name: string; created: boolean } | null;
	allocatedCents: number;
	unallocatedCents: number;
	paidInvoices: number;
	mailsSent: number;
	mailErrors: number;
}

/** Antwort auf `POST /transactions`: Buchung plus Ergebnis der direkten Zuordnung */
export type TransactionCreated = Transaction & {
	allocation: AllocationResult | null;
	payableLinked: boolean;
};

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

export const OVERVIEW_TASK_KINDS = [
	'bank-missing',
	'unallocated',
	'overdue',
	'payables-overdue',
	'payables-no-iban',
	'annual-draft',
	'annual-scheduled',
	'annual-missing'
] as const;
export type OverviewTaskKind = (typeof OVERVIEW_TASK_KINDS)[number];

/** Offene Aufgabe der Kasse (Texte baut die Oberfläche aus `kind` und den Zahlen) */
export interface OverviewTask {
	kind: OverviewTaskKind;
	severity: 'info' | 'warning' | 'critical';
	/** Anzahl betroffener Einträge (Buchungen, Rechnungen, Überweisungen); 0 = nicht zählbar */
	count: number;
	cents: number | null;
	/** Beitragsjahr (Jahresbeitrag) */
	year: number | null;
	/** Frist bzw. geplanter Versand (`YYYY-MM-DD`) */
	date: string | null;
	/** Ziel-Tab der Kasse; null = Einstellungen */
	tab: 'transactions' | 'open' | 'payables' | 'annual' | null;
}

export interface Overview {
	/** Aufgaben, wichtigste zuerst (leer = alles erledigt) */
	tasks: OverviewTask[];
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
	/** Kontodaten in den Kassen-Einstellungen fehlen (Rechnungen ohne IBAN) */
	bankMissing: boolean;
}

// --- Ausstehende Überweisungen -------------------------------------------------

export const PAYABLE_SOURCES = [
	'manual',
	'reimbursement',
	'refund',
	'credit',
	'expense',
	'order'
] as const;
export type PayableSource = (typeof PAYABLE_SOURCES)[number];
export const PAYABLE_SOURCE_LABELS: Record<PayableSource, string> = {
	manual: 'Eingangsrechnung',
	reimbursement: 'Auslagenerstattung',
	refund: 'Rückzahlung Überschuss',
	credit: 'Guthaben',
	expense: 'Ausgabe aus Abrechnung',
	order: 'Bestellung (Lieferant)'
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

// --- Familienkonto (alles zu einem Zahler bzw. Mitglied ohne Zahler) -------------

/** Genau eines von beiden; gehört das Mitglied zu einem Zahler, gilt dessen Familienkonto */
export const familyAccountQuery = z
	.object({ payerId: id.optional(), memberId: id.optional() })
	.refine((q) => !!q.payerId !== !!q.memberId, 'Zahler oder Mitglied angeben');
export type FamilyAccountQuery = z.infer<typeof familyAccountQuery>;

export interface FamilyAccount {
	/** null = Mitglied ohne Zahler */
	payer: Payer | null;
	/** Anzeigename (Zahler oder Mitglied) */
	name: string;
	members: PayerMember[];
	/** Alle Rechnungen (auch bezahlte/stornierte), neueste zuerst */
	invoices: InvoiceSummary[];
	/** Eingegangene Zahlungen: Buchungen des Zahlers oder auf seine Rechnungen, neueste zuerst */
	payments: Transaction[];
	/** Auszahlungen an die Familie (Rückzahlung, Guthaben, …), alle Status */
	payables: Payable[];
	totals: {
		openCents: number;
		overdueCents: number;
		paidCents: number;
		creditCents: number;
		/** Noch offene Auszahlungen an die Familie */
		payableOpenCents: number;
	};
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
	/** Aktion liegt in der Vergangenheit (Posten eingefroren, keine neuen Rechnungen) */
	isPast: boolean;
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
	invoiceBody: 'treasury.mail.invoiceBody',
	annualStamm: 'treasury.annual.stamm',
	annualGau: 'treasury.annual.gau',
	annualLandesmark: 'treasury.annual.landesmark',
	annualBund: 'treasury.annual.bund',
	annualSubject: 'treasury.annual.mailSubject',
	annualBody: 'treasury.annual.mailBody',
	annualPdfText: 'treasury.annual.pdfText'
} as const;

export const DEFAULT_PAID_SUBJECT = 'Zahlungseingang bestätigt';
export const DEFAULT_PAID_BODY = `Hallo,

vielen Dank! Wir haben deine Zahlung erhalten und die folgenden Posten als bezahlt verbucht:

{posten}

Herzliche Grüße und Gut Pfad
Die Kasse`;
export const DEFAULT_REMINDER_SUBJECT = 'Zahlungserinnerung';
export const DEFAULT_REMINDER_BODY = `Hallo,

nach unseren Unterlagen sind die folgenden Beträge noch offen (fällig seit {faellig}):

{posten}

Bitte überweise den offenen Betrag mit diesen Angaben:

{zahlung}

Falls du in den letzten Tagen schon bezahlt hast, betrachte diese Nachricht bitte als gegenstandslos.

Herzliche Grüße und Gut Pfad
Die Kasse`;

export const DEFAULT_INVOICE_SUBJECT = '{anlass}: {rechnungen}';
export const DEFAULT_INVOICE_BODY = `Hallo,

{aenderung}

{posten}

{zahlung}

Die Rechnung findest du auch als PDF im Anhang.

Herzliche Grüße und Gut Pfad
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
	['{posten}', 'Tabelle der Posten mit Beträgen (eigener Absatz)'],
	['{summe}', 'Summe der Posten'],
	['{rechnungen}', 'Rechnungsnummern'],
	['{faellig}', 'Fälligkeitsdatum (früheste)'],
	['{kontodaten}', 'Kontoinhaber, IBAN, BIC, Bank'],
	[
		'{zahlung}',
		'Zahlungskasten: Empfänger, IBAN, Betrag, Frist, Verwendungszweck (eigener Absatz)'
	],
	['{verwendungszweck}', 'Rechnungsnummern + Name'],
	['{stufe}', 'Erinnerungsstufe (1 oder 2)'],
	['{anlass}', 'Rechnung / Geänderte Rechnung / Stornierung'],
	['{aenderung}', 'Erklärender Satz zur geänderten oder stornierten Rechnung']
] as const;

// --- Jahresbeitrag --------------------------------------------------------------

/** Beitragsebenen (gleiche Werte wie `members` `FEE_LEVELS`) */
export const FEE_LEVELS = ['stamm', 'gau', 'landesmark', 'bund'] as const;
export type FeeLevel = (typeof FEE_LEVELS)[number];
export const FEE_LEVEL_LABELS: Record<FeeLevel, string> = {
	stamm: 'Stamm',
	gau: 'Gau',
	landesmark: 'Landesmark',
	bund: 'Bund'
};
/** Cent je Ebene */
export type FeeRates = Record<FeeLevel, number>;
export const DEFAULT_FEE_RATES: FeeRates = { stamm: 1200, gau: 800, landesmark: 200, bund: 2500 };
/** Eintritt nach diesem Tag (MM-TT) im Beitragsjahr → nur Stammesbeitrag */
export const FEE_FULL_UNTIL = '02-28';

export const ANNUAL_RUN_STATUSES = ['draft', 'scheduled', 'sent'] as const;
export type AnnualRunStatus = (typeof ANNUAL_RUN_STATUSES)[number];
export const ANNUAL_RUN_STATUS_LABELS: Record<AnnualRunStatus, string> = {
	draft: 'Entwurf',
	scheduled: 'Versand geplant',
	sent: 'Versendet'
};

export const DEFAULT_ANNUAL_SUBJECT = 'Jahresbeitrag {jahr}: {rechnungen}';
export const DEFAULT_ANNUAL_BODY = `Hallo,

der Jahresbeitrag {jahr} für {mitglieder} ist fällig. Die Aufschlüsselung nach Stamm, Gau, Landesmark und Bund findest du im PDF im Anhang.

{zahlung}

Herzliche Grüße und Gut Pfad
Die Kasse`;
export const DEFAULT_ANNUAL_PDF_TEXT = `wir bitten um Zahlung des Mitgliedsbeitrags für das Jahr {jahr}. Der Beitrag setzt sich aus den Anteilen für Stamm, Gau, Landesmark und Bund zusammen. Bitte überweise den Betrag bis zum {faellig}.`;

export const ANNUAL_PLACEHOLDERS = [
	['{jahr}', 'Beitragsjahr'],
	['{name}', 'Name(n) der Empfänger*innen'],
	['{mitglieder}', 'Vornamen der abgerechneten Mitglieder'],
	['{summe}', 'Rechnungsbetrag'],
	['{rechnungen}', 'Rechnungsnummer'],
	['{faellig}', 'Zahlungsfrist'],
	['{zahlung}', 'Zahlungskasten (nur Mail, eigener Absatz)'],
	['{verwendungszweck}', 'Rechnungsnummer + Name']
] as const;

const feeCents = z.number('Ungültiger Betrag').int('Ungültiger Betrag').min(0).max(100_000);
export const feeRatesInput = z.object({
	stamm: feeCents,
	gau: feeCents,
	landesmark: feeCents,
	bund: feeCents
});

export const annualRunInput = z.object({
	year: z.number().int().min(2000).max(2100)
});
export type AnnualRunInput = z.infer<typeof annualRunInput>;

/** Änderungen nur an Entwürfen/geplanten Läufen */
export const annualRunUpdate = z.object({
	dueOn: dateString.optional(),
	rates: feeRatesInput.optional(),
	mailSubject: z.string().trim().min(1, 'Pflichtfeld').max(150).optional(),
	mailBody: z.string().trim().min(1, 'Pflichtfeld').max(5000).optional(),
	pdfText: z.string().trim().min(1, 'Pflichtfeld').max(3000).optional()
});
export type AnnualRunUpdate = z.infer<typeof annualRunUpdate>;

export const annualScheduleInput = z.object({ sendOn: dateString });

export const annualPreviewQuery = z.object({
	/** `run` = Lauf zum Stichtag, `catch-up` = Nachberechnung; Standard: versendet → `catch-up`, sonst `run` */
	mode: z.enum(['run', 'catch-up']).optional(),
	/** Rechnungsschlüssel aus `AnnualPreview.invoices[].key` (sonst die erste) */
	key: z.string().max(80).optional()
});

export interface AnnualRun {
	id: string;
	year: number;
	/** Stichtag (Erstellung): wer da Mitglied ist, zahlt */
	createdOn: string;
	dueOn: string;
	sendOn: string | null;
	status: AnnualRunStatus;
	sentAt: string | null;
	rates: FeeRates;
	mailSubject: string;
	mailBody: string;
	pdfText: string;
	/** Ergebnis des letzten Versands */
	lastResult: AnnualSendResult | null;
	/** Bereits erzeugte Rechnungen dieses Laufs */
	invoiceCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface AnnualPreviewMember {
	memberId: string;
	name: string;
	levels: FeeLevel[];
	/** Grund für reduzierte Ebenen */
	note: 'secondary' | 'late-entry' | null;
	totalCents: number;
}

export interface AnnualPreviewInvoice {
	/** `payer:<id>` oder `member:<id>` */
	key: string;
	payerId: string | null;
	recipientName: string;
	/** Leer ohne `treasury.invoice.send`/`.edit` (dann nur `emailCount`) */
	emails: string[];
	emailCount: number;
	members: AnnualPreviewMember[];
	totalCents: number;
}

export interface AnnualPreview {
	year: number;
	/** `run` = Lauf zum Stichtag; `catch-up` = noch nicht abgerechnete Mitglieder des Jahres */
	mode: 'run' | 'catch-up';
	invoices: AnnualPreviewInvoice[];
	totalCents: number;
	memberCount: number;
	/** Mitglieder ohne E-Mail (Rechnung entsteht trotzdem, Mail nicht) */
	withoutEmail: { memberId: string; name: string }[];
	/** Mitglieder mit 0 € (z. B. Zweitmitglied ohne Ebenen) */
	skipped: { memberId: string; name: string }[];
	/** Anzahl Mitglieder ohne Zahler mit Geschwister-Vorschlag (Hinweis auf „Zahler & Familien“) */
	payerSuggestions: number;
}

export interface AnnualSendResult {
	invoicesCreated: number;
	mailsSent: number;
	mailErrors: number;
	withoutAddress: number;
}

/** Vorschau der Mail einer geplanten Rechnung (`GET /annual-fees/:id/preview-mail`) */
export interface AnnualMailPreview {
	subject: string;
	html: string;
	text: string;
	to: string[];
}
