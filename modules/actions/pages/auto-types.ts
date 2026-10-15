/**
 * Erweiterungen der API-Antworten um die Zuschuss-Automatik (Vertrag des Backends).
 * Die Felder sind optional, damit die Oberfläche auch mit älteren Antworten funktioniert.
 */
export interface SubsidyFields {
	/** Override: null = automatisch */
	subsidyEligible?: boolean | null;
	/** so wird tatsächlich gerechnet */
	subsidyEffective?: boolean;
}

export interface AutoIncome {
	contributions: {
		cents: number;
		payingCount: number;
		teamCount: number;
		feeCents: number;
		teamFeeCents: number;
	} | null;
	subsidy: { cents: number; eligibleCount: number } | null;
	overridden: ('contributions' | 'subsidy')[];
}
