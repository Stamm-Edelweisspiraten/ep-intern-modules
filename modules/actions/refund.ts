/**
 * Reine Rueckzahlungslogik: Ueberschuss gleichmaessig je zahlender Person, auf ganze Euro
 * abgerundet; der Rest bleibt in der Stammkasse. Alle Betraege Integer-Cent, nie NaN/negativ.
 */

export interface RefundPayer {
	id: string;
	name: string;
	feeCents: number;
}

export interface RefundItem {
	participantId: string;
	name: string;
	amountCents: number;
}

export interface RefundResult {
	items: RefundItem[];
	totalCents: number;
	remainderCents: number;
	/** Groesster Einzelbetrag oder 0 */
	perHeadCents: number;
	/** Anzahl der Personen mit Rueckzahlung > 0 */
	payingCount: number;
}

const safe = (v: unknown): number =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

export function computeRefund(input: {
	surplusCents: number;
	payers: RefundPayer[];
}): RefundResult {
	const surplus = safe(input.surplusCents);
	const payers = (input.payers ?? []).filter((p) => safe(p.feeCents) > 0);
	const empty: RefundResult = {
		items: [],
		totalCents: 0,
		remainderCents: surplus,
		perHeadCents: 0,
		payingCount: 0
	};
	if (surplus <= 0 || payers.length === 0) return empty;

	const sumFees = payers.reduce((a, p) => a + safe(p.feeCents), 0);
	const items: RefundItem[] = [];
	for (const p of payers) {
		const euros = Math.floor((surplus * safe(p.feeCents)) / (sumFees * 100));
		const amountCents = euros * 100;
		if (amountCents > 0) items.push({ participantId: p.id, name: p.name, amountCents });
	}
	const totalCents = items.reduce((a, i) => a + i.amountCents, 0);
	return {
		items,
		totalCents,
		remainderCents: surplus - totalCents,
		perHeadCents: items.reduce((m, i) => Math.max(m, i.amountCents), 0),
		payingCount: items.length
	};
}

/** Mindestbetrag: je Person muessen MEHR als 5 EUR bleiben, sonst lohnt sich die Rueckzahlung nicht. */
export const MIN_REFUND_PER_HEAD_CENTS = 500;

/** Schwelle erfuellt: Betrag je Person strikt groesser als 5 EUR. */
export const refundThresholdOk = (perHeadCents: number): boolean =>
	safe(perHeadCents) > MIN_REFUND_PER_HEAD_CENTS;

export interface ManualRefundResult {
	count: number;
	perHeadCents: number;
	totalCents: number;
	remainderCents: number;
}

/** Manuelle Personenzahl: Ueberschuss / Anzahl, auf ganze Euro abgerundet. */
export function computeManualRefund(input: {
	surplusCents: number;
	count: number;
}): ManualRefundResult {
	const surplus = safe(input.surplusCents);
	const count = safe(input.count);
	if (surplus <= 0 || count <= 0) {
		return { count, perHeadCents: 0, totalCents: 0, remainderCents: surplus };
	}
	const perHeadCents = Math.floor(surplus / count / 100) * 100;
	const totalCents = perHeadCents * count;
	return { count, perHeadCents, totalCents, remainderCents: surplus - totalCents };
}
