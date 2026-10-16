/**
 * Vertrag der Dienste, die `actions` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.use<ActionsService>('actions', '<aufrufendes Modul>')`.
 * Die Funktionen pruefen KEINE Objektrechte – der Aufrufer verantwortet den Zugriff (z. B. Kasse).
 */
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

/** Ausgabe „bezahlt vom Stamm“ mit Empfaenger fuer die Ueberweisung durch die Kasse. */
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

export interface ActionsService {
	/** Aktionen mit uebernommenem Beitrag (`fee_applied_at` gesetzt) inkl. Teilnehmender */
	listReceivableSources(query?: { actionIds?: string[] }): Promise<ReceivableSource[]>;
	/** Kurzdaten von Aktionen (Anzeige, Auswahl); `search` im Namen, max. 200 */
	listActionRefs(query?: { ids?: string[]; search?: string; limit?: number }): Promise<ActionRef[]>;
	/** Auslagen je Aktion und Empfaenger*in (bezahlt von Person), nur aus abgeschlossenen Abrechnungen */
	listReimbursements(): Promise<ReimbursementSource[]>;
	/** Klartext-IBAN der Empfaenger*in (Aufrufer prueft eigene Rechte und auditiert) */
	getPayeeIban(actionId: string, payeeId: string): Promise<string | null>;
	/** Auslagen als ausgezahlt markieren bzw. zuruecknehmen (auch bei abgeschlossener Abrechnung) */
	markReimbursed(actionId: string, payeeId: string, reimbursed: boolean): Promise<number>;
	/** Einzelbetraege gebuchter Rueckzahlungen des Ueberschusses */
	listRefundItems(): Promise<RefundItemSource[]>;
	/** Belege der Auslagen einer Empfaenger*in (fuer die Kasse) */
	listReimbursementReceipts(actionId: string, payeeId: string): Promise<ReceiptRef[]>;
	/** Beleg einer Buchung laden (Systemkontext; nur Belege der genannten Aktion) */
	downloadReceipt(
		actionId: string,
		entryId: string
	): Promise<{ data: Uint8Array; name: string; contentType: string } | null>;
	/** Abgeschlossene Abrechnungen mit Ergebnis */
	listClosedAccountings(): Promise<ClosedAccounting[]>;
	/** Detail einer abgeschlossenen Abrechnung; `null`, wenn offen oder unbekannt */
	getClosedAccounting(actionId: string): Promise<ClosedAccountingDetail | null>;
	/** Ausgaben des Stammes (ohne Rueckzahlung), offen oder bezahlt */
	listClubExpenses(): Promise<ClubExpenseSource[]>;
	/** Klartext-IBAN des Empfaengers einer Stamm-Ausgabe (Aufrufer prueft Rechte und auditiert) */
	getClubExpenseIban(actionId: string, entryId: string): Promise<string | null>;
	/**
	 * Stamm-Ausgabe als von der Kasse ueberwiesen markieren bzw. zuruecknehmen (auch bei abgeschlossener
	 * Abrechnung). Eine manuelle Markierung („bereits bezahlt“) bleibt unberuehrt.
	 */
	markClubExpensePaid(actionId: string, entryId: string, paid: boolean): Promise<boolean>;
	/** Abrechnungsbericht als PDF (mit Beleg-Anhaengen); `withBank` = IBAN im Klartext */
	accountingReportPdf(
		actionId: string,
		withBank: boolean,
		auditCtx: import('$lib/sdk/types').RequestContext
	): Promise<{ data: Uint8Array; fileName: string }>;
}
