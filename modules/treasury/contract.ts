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
