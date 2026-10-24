/**
 * Vertrag der Dienste, die `actions` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.use<ActionsService>('actions', '<aufrufendes Modul>')`.
 * Die Funktionen prüfen KEINE Objektrechte – der Aufrufer verantwortet den Zugriff (z. B. Kasse).
 */
import type { RequestContext } from '$lib/sdk/types';
import type {
	AccountingEntry,
	AccountingPayee,
	AccountingPlan,
	AccountingSummary,
	AutoIncome
} from './schemas';

export interface ReceivableParticipant {
	id: string;
	name: string;
	role: 'participant' | 'team';
	/** JJJJ-MM-TT */
	birthDate: string | null;
	memberId: string | null;
	contactEmail: string | null;
	groupLabel: string | null;
}

export interface ReceivableSource {
	id: string;
	name: string;
	/** JJJJ-MM-TT */
	startsOn: string;
	endsOn: string | null;
	/** Aktion liegt bereits in der Vergangenheit (nachträgliche Abrechnung) */
	isPast: boolean;
	/** Beitrag je Teilnehmende*r (Cent) */
	feeCents: number;
	/** Beitrag je Teammitglied (Cent, `null` = zahlt nicht) */
	teamFeeCents: number | null;
	participants: ReceivableParticipant[];
}

export interface ActionRef {
	id: string;
	name: string;
	startsOn: string;
	endsOn: string | null;
}

export interface ReimbursementSource {
	actionId: string;
	payeeId: string;
	name: string;
	/** Letzte Stellen der IBAN (Anzeige) */
	ibanLast: string | null;
	hasIban: boolean;
	bic: string | null;
	/** Summe aller Auslagen der Person */
	totalCents: number;
	/** davon noch nicht als ausgezahlt markiert */
	openCents: number;
	/**
	 * Seit Migration 0016 immer `null`: je (Aktion, Empfänger*in) eine Zeile mit allen freigegebenen
	 * Auslagen (in einer Zwischenabrechnung enthalten oder Abrechnung abgeschlossen).
	 */
	interimId?: string | null;
	interimNumber?: number | null;
}

/** Zwischenabrechnung einer Aktion (für die Kasse); Summen aus dem eingefrorenen Abbild. */
export interface InterimRef {
	id: string;
	actionId: string;
	number: number;
	createdAt: string;
	incomeCents: number;
	expenseCents: number;
	reimbursementCents: number;
}

export interface RefundItemSource {
	id: string;
	actionId: string;
	participantId: string | null;
	name: string;
	amountCents: number;
	memberId: string | null;
	birthDate: string | null;
}

export interface ReceiptRef {
	entryId: string;
	description: string;
	/** JJJJ-MM-TT */
	entryDate: string;
	amountCents: number;
	name: string;
	contentType: string;
}

export interface ClosedAccounting {
	actionId: string;
	name: string;
	startsOn: string;
	endsOn: string | null;
	closedAt: string;
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
}

/** Ausgabe „bezahlt vom Stamm“ mit Empfänger für die Überweisung durch die Kasse. */
export interface ClubExpenseSource {
	actionId: string;
	entryId: string;
	description: string;
	recipientName: string | null;
	/** Letzte Stellen der IBAN (Anzeige) */
	ibanLast: string | null;
	hasIban: boolean;
	bic: string | null;
	purpose: string | null;
	amountCents: number;
	/** JJJJ-MM-TT */
	entryDate: string;
	/** `null` = offen */
	paidAt: string | null;
	paidVia: 'manual' | 'treasury' | null;
	receipt: { name: string; contentType: string } | null;
}

/** Abgeschlossene Abrechnung zum Nachvollziehen in der Kasse (nur Lesen, Bankdaten maskiert). */
export interface ClosedAccountingDetail extends ClosedAccounting {
	location: string | null;
	summary: AccountingSummary;
	plan: AccountingPlan | null;
	autoIncome: AutoIncome;
	entries: AccountingEntry[];
	payees: AccountingPayee[];
	refund: { totalCents: number; count: number; remainderCents: number; bookedAt: string } | null;
}

/** Aktion im Kalender-Abo (Modul `events`) */
export interface CalendarAction {
	id: string;
	name: string;
	/** Nur mit Zugriff auf die Aktion, sonst `null` */
	description: string | null;
	location: string | null;
	/** JJJJ-MM-TT */
	startsOn: string;
	endsOn: string | null;
	/** HH:MM */
	startsTime: string | null;
	endsTime: string | null;
	/** Namen der eigenen angemeldeten Personen (Konto oder verknüpfte Mitglieder) */
	registered: string[];
	/** Person darf die Aktion in der App öffnen */
	canOpen: boolean;
}

export interface ActionsService {
	/**
	 * Aktionen im Zeitraum für das Kalender-Abo: sichtbare (`actions.action.view`) und solche mit eigener
	 * Anmeldung (`actions.own.view`). Prüft die Rechte von `ctx` selbst (Ausnahme in diesem Vertrag).
	 */
	listCalendarActions(
		ctx: RequestContext,
		window: { from: string; to: string }
	): Promise<CalendarAction[]>;
	/** Aktionen mit übernommenem Beitrag (`fee_applied_at` gesetzt) inkl. Teilnehmender */
	listReceivableSources(query?: { actionIds?: string[] }): Promise<ReceivableSource[]>;
	/** Kurzdaten von Aktionen (Anzeige, Auswahl); `search` im Namen, max. 200 */
	listActionRefs(query?: { ids?: string[]; search?: string; limit?: number }): Promise<ActionRef[]>;
	/**
	 * Auslagen je Aktion, Empfänger*in und Zwischenabrechnung (bezahlt von Person): aus Zwischenabrechnungen
	 * sofort, die übrigen erst aus abgeschlossenen Abrechnungen.
	 */
	listReimbursements(): Promise<ReimbursementSource[]>;
	/** Klartext-IBAN der Empfänger*in (Aufrufer prüft eigene Rechte und auditiert) */
	getPayeeIban(actionId: string, payeeId: string): Promise<string | null>;
	/** Auslagen als ausgezahlt markieren bzw. zurücknehmen (auch bei abgeschlossener Abrechnung) */
	markReimbursed(
		actionId: string,
		payeeId: string,
		reimbursed: boolean,
		/**
		 * `null` (Kasse) = alle freigegebenen Auslagen der Person (in einer Zwischenabrechnung enthalten oder
		 * abgeschlossen); fehlt = alle Auslagen der Person; ein konkreter (Alt-)Schlüssel einer
		 * Zwischenabrechnung ändert nichts (Rückgabe 0).
		 */
		interimId?: string | null
	): Promise<number>;
	/** Zwischenabrechnungen (alle Aktionen oder die genannten) */
	listInterims(query?: { actionIds?: string[] }): Promise<InterimRef[]>;
	/** PDF einer Zwischenabrechnung (mit Beleg-Anhängen) */
	interimReportPdf(
		actionId: string,
		interimId: string,
		withBank: boolean,
		auditCtx: RequestContext
	): Promise<{ data: Uint8Array; fileName: string }>;
	/** Einzelbeträge gebuchter Rückzahlungen des Überschusses */
	listRefundItems(): Promise<RefundItemSource[]>;
	/** Belege der Auslagen einer Empfänger*in (für die Kasse) */
	listReimbursementReceipts(
		actionId: string,
		payeeId: string,
		/**
		 * `null` (Kasse) = Belege aller freigegebenen Auslagen der Person; fehlt = alle Auslagen der Person;
		 * ein konkreter (Alt-)Schlüssel einer Zwischenabrechnung liefert eine leere Liste.
		 */
		interimId?: string | null
	): Promise<ReceiptRef[]>;
	/** Beleg einer Buchung laden (Systemkontext; nur Belege der genannten Aktion) */
	downloadReceipt(
		actionId: string,
		entryId: string
	): Promise<{ data: Uint8Array; name: string; contentType: string } | null>;
	/** Abgeschlossene Abrechnungen mit Ergebnis */
	listClosedAccountings(): Promise<ClosedAccounting[]>;
	/** Detail einer abgeschlossenen Abrechnung; `null`, wenn offen oder unbekannt */
	getClosedAccounting(actionId: string): Promise<ClosedAccountingDetail | null>;
	/** Ist die Abrechnung der Aktion abgeschlossen? (eine Abfrage, z. B. Prüfung vor dem PDF, #68) */
	isAccountingClosed(actionId: string): Promise<boolean>;
	/** Anzeigenamen der Abrechnungskategorien (Schlüssel `AccountingEntry.category`) */
	accountingCategoryLabels(): Record<string, string>;
	/** Ausgaben des Stammes (ohne Rückzahlung), offen oder bezahlt */
	listClubExpenses(): Promise<ClubExpenseSource[]>;
	/** Klartext-IBAN des Empfängers einer Stamm-Ausgabe (Aufrufer prüft Rechte und auditiert) */
	getClubExpenseIban(actionId: string, entryId: string): Promise<string | null>;
	/**
	 * Stamm-Ausgabe als von der Kasse überwiesen markieren bzw. zurücknehmen (auch bei abgeschlossener
	 * Abrechnung). Eine manuelle Markierung („bereits bezahlt“) bleibt unberührt.
	 */
	markClubExpensePaid(actionId: string, entryId: string, paid: boolean): Promise<boolean>;
	/** Abrechnungsbericht als PDF (mit Beleg-Anhängen); `withBank` = IBAN im Klartext */
	accountingReportPdf(
		actionId: string,
		withBank: boolean,
		auditCtx: RequestContext
	): Promise<{ data: Uint8Array; fileName: string }>;
}
