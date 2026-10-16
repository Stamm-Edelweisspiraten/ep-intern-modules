/**
 * Vertrag der Dienste, die `actions` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.use<ActionsService>('actions', '<aufrufendes Modul>')`.
 * Die Funktionen pruefen KEINE Objektrechte – der Aufrufer verantwortet den Zugriff (z. B. Kasse).
 */
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

export interface ActionsService {
	/** Aktionen mit uebernommenem Beitrag (`fee_applied_at` gesetzt) inkl. Teilnehmender */
	listReceivableSources(query?: { actionIds?: string[] }): Promise<ReceivableSource[]>;
	/** Kurzdaten von Aktionen (Anzeige, Auswahl); `search` im Namen, max. 200 */
	listActionRefs(query?: { ids?: string[]; search?: string; limit?: number }): Promise<ActionRef[]>;
	/** Auslagen je Aktion und Empfaenger*in (bezahlt von Person) */
	listReimbursements(): Promise<ReimbursementSource[]>;
	/** Klartext-IBAN der Empfaenger*in (Aufrufer prueft eigene Rechte und auditiert) */
	getPayeeIban(actionId: string, payeeId: string): Promise<string | null>;
	/** Auslagen als ausgezahlt markieren bzw. zuruecknehmen (auch bei abgeschlossener Abrechnung) */
	markReimbursed(actionId: string, payeeId: string, reimbursed: boolean): Promise<number>;
	/** Einzelbetraege gebuchter Rueckzahlungen des Ueberschusses */
	listRefundItems(): Promise<RefundItemSource[]>;
}
