/**
 * Reine Rückzahlungslogik: Überschuss gleichmäßig je zahlender Person, auf ganze Euro
 * abgerundet; der Rest bleibt in der Stammkasse. Alle Beträge Integer-Cent, nie NaN/negativ.
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
	/** Größter Einzelbetrag oder 0 */
	perHeadCents: number;
	/** Anzahl der Personen mit Rückzahlung > 0 */
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

/** Mindestbetrag: je Person müssen MEHR als 5 EUR bleiben, sonst lohnt sich die Rückzahlung nicht. */
export const MIN_REFUND_PER_HEAD_CENTS = 500;

/** Schwelle erfüllt: Betrag je Person strikt größer als 5 EUR. */
export const refundThresholdOk = (perHeadCents: number): boolean =>
	safe(perHeadCents) > MIN_REFUND_PER_HEAD_CENTS;

export interface ManualRefundResult {
	count: number;
	perHeadCents: number;
	totalCents: number;
	remainderCents: number;
}

/** Manuelle Personenzahl: Überschuss / Anzahl, auf ganze Euro abgerundet. */
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

// --- Spende der Rückzahlung an den Stamm ----------------------------------------

/** Wahl je Person: alles auszahlen, alles spenden oder einen Teil (ganze Euro) spenden. */
export type DonationChoice = 'payout' | 'donate' | 'partial';

/** Auszahlung = Anteil − Spende (nie negativ). */
export const payoutCents = (item: { amountCents: number; donatedCents: number }): number =>
	Math.max(0, safe(item.amountCents) - safe(item.donatedCents));

/** Summen über alle Personen. */
export function donationTotals(items: { amountCents: number; donatedCents: number }[]): {
	donatedCents: number;
	payoutCents: number;
	donorCount: number;
} {
	let donated = 0;
	let payout = 0;
	let donors = 0;
	for (const i of items) {
		const d = Math.min(safe(i.donatedCents), safe(i.amountCents));
		donated += d;
		payout += safe(i.amountCents) - d;
		if (d > 0) donors++;
	}
	return { donatedCents: donated, payoutCents: payout, donorCount: donors };
}

/**
 * Spendenbetrag prüfen: 0 … Anteil, ganze Euro – „alles spenden“ ist auch bei krummem Anteil erlaubt.
 * Liefert eine Fehlermeldung oder `null`.
 */
export function validateDonation(amountCents: number, donatedCents: number): string | null {
	if (!Number.isInteger(donatedCents) || donatedCents < 0) {
		return 'Der Spendenbetrag ist ungültig.';
	}
	if (donatedCents > amountCents) return 'Die Spende ist höher als die Rückzahlung.';
	if (donatedCents !== amountCents && donatedCents % 100 !== 0) {
		return 'Bitte nur ganze Euro spenden.';
	}
	return null;
}

/** Spendenbetrag zur Wahl (`partial` braucht einen Betrag). */
export function donationForChoice(
	amountCents: number,
	choice: DonationChoice,
	partialCents?: number
): number {
	if (choice === 'payout') return 0;
	if (choice === 'donate') return safe(amountCents);
	return safe(partialCents);
}

/** Wahl aus dem gespeicherten Betrag ableiten (für Anzeige). */
export function choiceOf(item: { amountCents: number; donatedCents: number }): DonationChoice {
	if (item.donatedCents <= 0) return 'payout';
	return item.donatedCents >= item.amountCents ? 'donate' : 'partial';
}
