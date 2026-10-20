/**
 * Vertrag der Dienste, die die Kasse anderen Modulen anbietet (`ModuleDefinition.provides`).
 * `actions` nutzt ihn als optionale Abhängigkeit: `core.modules.useOptional<TreasuryService>('treasury', 'actions')`.
 */
import type { RequestContext } from '$lib/sdk/types';

export interface ActionContributions {
	/** Rechnungen (nicht storniert) mit Posten dieser Aktion */
	invoiceCount: number;
	/** Soll nach Ermäßigungen */
	dueCents: number;
	/** Tatsächlich eingegangene, zugeordnete Zahlungen */
	paidCents: number;
	openCents: number;
}

/** Zahlstand des Beitrags einer/eines Teilnehmenden (Posten der Rechnung aus der Aktion). */
export interface ParticipantPayment {
	participantId: string;
	invoiceId: string;
	invoiceNumber: string;
	/** Soll nach Ermäßigung */
	dueCents: number;
	paidCents: number;
	openCents: number;
	/** `waived` = vollständig erlassen */
	status: 'paid' | 'partial' | 'open' | 'waived';
	/** JJJJ-MM-TT */
	dueOn: string | null;
	overdue: boolean;
}

export interface TreasuryService {
	/** `null`, wenn die Kasse für diese Aktion keine Rechnungen führt */
	contributionsForAction(actionId: string): Promise<ActionContributions | null>;
	/** Zahlstand je Teilnehmende*r (nur nicht stornierte Rechnungen aus der Aktion) */
	participantPayments(actionId: string): Promise<ParticipantPayment[]>;
	/**
	 * Nach einer Anmeldung: Rechnung der Person sofort anlegen (Abgleich) und als PDF liefern
	 * (Fassung 1, wird an der Rechnung gespeichert). `null` ohne Beitrag bzw. Rechnung.
	 * AUSSERHALB von Modul-Transaktionen aufrufen.
	 */
	invoiceForRegistration(
		actionId: string,
		participantId: string
	): Promise<RegistrationInvoice | null>;
	/** Bankdaten aus den Kassen-Einstellungen (leere Felder = nicht gepflegt) */
	bankData(): Promise<{ holder: string; iban: string; bic: string; name: string }>;
	/**
	 * Meldet dem Amt „Kasse“ (Modul `offices`, optional) eine abgeschlossene Abrechnung bzw. eine neue
	 * Zwischenabrechnung. Nach der Transaktion aufrufen; wirft nie (Fehler werden geloggt).
	 */
	accountingClosed(ctx: RequestContext, info: AccountingClosedEvent): Promise<void>;

	// --- Bestellungen (Modul `orders`, Push in die Kasse; alle AUSSERHALB von Modul-Transaktionen) ---

	/**
	 * Legt die Rechnung einer Bestellung an bzw. gleicht sie an (`invoices.source = 'order'`).
	 * Schlüssel der Rechnung: `sourceKey` (`order:<orderId>`), Posten über `lines[].ref`
	 * (`order:<orderId>:<itemId>`). Neue Rechnung → Nummer `R-JJJJ-NNNN`, bei `send` Versand mit PDF.
	 * Geänderte Posten einer versendeten Rechnung → „Geänderte Rechnung“; keine Posten mehr → Storno
	 * (Bezahltes wird Guthaben). Wirft 422 bei unbekanntem Mitglied.
	 */
	upsertOrderInvoice(ctx: RequestContext, input: OrderInvoiceInput): Promise<OrderInvoiceResult>;
	/**
	 * Legt eine Auszahlung (Lieferantenrechnung) an bzw. aktualisiert sie (`payables.source = 'order'`,
	 * Schlüssel `ref` = `order-supplier:<id>`). Betrag nie unter bereits Gezahltes (409). Meldet neue
	 * Auszahlungen dem Amt „Kasse“.
	 */
	upsertOrderPayable(ctx: RequestContext, input: OrderPayableInput): Promise<{ payableId: string }>;
	/** Storniert eine Auszahlung aus `upsertOrderPayable`; bereits (teilweise) bezahlt → 409 */
	cancelOrderPayable(ctx: RequestContext, ref: string): Promise<void>;
	/** Zahlstand je Rechnung (fehlende IDs fehlen im Ergebnis) */
	invoiceStatus(invoiceIds: string[]): Promise<Record<string, ExternalInvoiceStatus>>;
	/** Zahlstand je Auszahlung über `ref` (fehlende fehlen im Ergebnis) */
	payableStatus(refs: string[]): Promise<Record<string, ExternalPayableStatus>>;
}

export interface OrderInvoiceLine {
	/** Eindeutiger Schlüssel des Postens (`order:<orderId>:<itemId>`) */
	ref: string;
	/** z. B. „Halstuch (Gr. M) × 2“ */
	description: string;
	/** Gesamtbetrag des Postens (Integer-Cent, ≥ 0) */
	amountCents: number;
}

export interface OrderInvoiceInput {
	/** `order:<orderId>` – identifiziert die Rechnung */
	sourceKey: string;
	memberId: string;
	/** Anzeige-/Rechnungsnummer der Bestellung, z. B. `B-2026-0001` (für Notiz/Mail) */
	orderNumber: string;
	/** Fehlt = Name des Mitglieds */
	recipientName?: string | null;
	note?: string | null;
	/** Leere Liste = Rechnung stornieren (falls vorhanden) */
	lines: OrderInvoiceLine[];
	/** Neue Rechnung sofort per Mail mit PDF verschicken */
	send: boolean;
}

export interface OrderInvoiceResult {
	/** `null`, wenn keine Rechnung existiert (leere Bestellung ohne bisherige Rechnung) */
	invoiceId: string | null;
	number: string | null;
	totalCents: number;
	cancelled: boolean;
	/** Mail mit PDF verschickt (neu oder geändert) */
	mailed: boolean;
}

export interface OrderPayableInput {
	/** `order-supplier:<supplierOrderId>` */
	ref: string;
	recipientName: string;
	description: string;
	amountCents: number;
	/** JJJJ-MM-TT, fehlt = heute */
	dueOn?: string | null;
	/** Klartext-IBAN; fehlt = unverändert, '' = entfernen */
	iban?: string;
	bic?: string | null;
	note?: string | null;
	/** Beleg (Lieferantenrechnung, PDF/Bild ≤ 10 MB) – wird in der Kasse abgelegt */
	receipt?: { bytes: Uint8Array; contentType: string; name: string } | null;
}

export type ExternalPaymentStatus = 'paid' | 'partial' | 'open' | 'cancelled';

export interface ExternalInvoiceStatus {
	invoiceId: string;
	number: string;
	status: ExternalPaymentStatus;
	dueCents: number;
	paidCents: number;
	openCents: number;
	dueOn: string | null;
	overdue: boolean;
}

export interface ExternalPayableStatus {
	payableId: string;
	status: ExternalPaymentStatus;
	amountCents: number;
	paidCents: number;
}

export interface AccountingClosedEvent {
	actionId: string;
	actionName: string;
	/** `final` = Abschluss der Abrechnung, `interim` = Zwischenabrechnung angelegt */
	kind: 'final' | 'interim';
	/** Nummer der Zwischenabrechnung */
	number?: number;
}

export interface RegistrationInvoice {
	filename: string;
	contentType: 'application/pdf';
	data: Uint8Array;
	number: string;
	totalCents: number;
	/** Zahlungsangaben für die Bestätigungsmail (Text bzw. HTML-Block) */
	paymentText: string;
	paymentHtml: string;
}
