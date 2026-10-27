/** Lokale Typen für die Rückzahlung des Überschusses (API: .../accounting/refund). */
export interface RefundItem {
	/** Posten-ID (nur gebucht) */
	id: string | null;
	participantId: string;
	name: string;
	amountCents: number;
	/** An den Stamm gespendet */
	donatedCents: number;
	/** Auszuzahlen = Anteil − Spende */
	payoutCents: number;
	decidedVia: 'internal' | 'link' | null;
	decidedAt: string | null;
	hasLink: boolean;
	/** Von der Kasse bereits überwiesen (> 0 = gesperrt) */
	paidCents: number;
}

export interface RefundBooked {
	bookedAt: string;
	entryId: string | null;
	surplusCents: number;
	totalCents: number;
	remainderCents: number;
	donatedCents: number;
	payoutCents: number;
	items: RefundItem[];
	mode?: RefundMode;
	count?: number;
	perHeadCents?: number;
}

export type RefundMode = 'auto' | 'manual';

export interface RefundState {
	mode: RefundMode;
	/** Angesetzte Personenzahl (Liste oder manuell) */
	count: number;
	/** Zahl der zahlenden Teilnehmenden laut Liste */
	autoCount: number;
	minPerHeadCents: number;
	thresholdOk: boolean;
	surplusCents: number;
	payingCount: number;
	perHeadCents: number;
	items: RefundItem[];
	totalCents: number;
	remainderCents: number;
	booked: RefundBooked | null;
	canBook: boolean;
	blockers: string[];
	feeCents: number;
	teamFeeCents: number;
}

/** Kategorie der Rückzahlungs-Buchung (string-tolerant, falls schemas.ts sie noch nicht kennt). */
export const REFUND_CATEGORY = 'refund';
export const REFUND_CATEGORY_LABEL = 'Rückzahlung an Teilnehmende';
