/**
 * Vorrat (rein, ohne Server-Imports – in Tests und UI nutzbar): Hersteller-Barcodes (EAN/GTIN),
 * Entnahme nach „zuerst ablaufend“ (FEFO) und Ablaufzustand je Charge.
 */
import { addDays } from '$lib/sdk/dates';

/** So viele Tage vor dem MHD gilt eine Charge als „läuft bald ab“ (Liste, Warnung) */
export const EXPIRY_WARN_DAYS = 14;

function checkDigitOk(digits: string): boolean {
	let sum = 0;
	for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
		sum += Number(digits[i]) * w;
	}
	return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * Barcode vereinheitlichen: nur Ziffern, EAN-8, UPC-A (12 → EAN-13 mit führender 0), EAN-13, GTIN-14
 * (mit führender 0 → EAN-13); Prüfziffer muss stimmen. Sonst `null`.
 */
export function normalizeBarcode(raw: string): string | null {
	const digits = raw.trim().replace(/[\s-]/g, '');
	if (!/^\d+$/.test(digits)) return null;
	let code = digits;
	if (code.length === 12) code = `0${code}`;
	if (code.length === 14 && code.startsWith('0')) code = code.slice(1);
	if (![8, 13, 14].includes(code.length)) return null;
	return checkDigitOk(code) ? code : null;
}

export interface BatchStock {
	id: string;
	quantity: number;
	bestBefore: string | null;
	createdAt: string;
}

/** Zuerst ablaufende Chargen zuerst, ohne MHD zuletzt, dann die ältesten */
export function fefoOrder<T extends BatchStock>(batches: readonly T[]): T[] {
	return [...batches].sort((a, b) => {
		if (a.bestBefore !== b.bestBefore) {
			if (a.bestBefore === null) return 1;
			if (b.bestBefore === null) return -1;
			return a.bestBefore < b.bestBefore ? -1 : 1;
		}
		return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
	});
}

/**
 * Entnahme auf Chargen verteilen; mit `batchId` nur aus dieser Charge. `null`, wenn nicht genug da ist.
 */
export function pickBatches(
	batches: readonly BatchStock[],
	quantity: number,
	batchId?: string | null
): { batchId: string; quantity: number }[] | null {
	const pool = batchId ? batches.filter((b) => b.id === batchId) : fefoOrder(batches);
	const out: { batchId: string; quantity: number }[] = [];
	let left = quantity;
	for (const b of pool) {
		if (left <= 0) break;
		if (b.quantity <= 0) continue;
		const n = Math.min(b.quantity, left);
		out.push({ batchId: b.id, quantity: n });
		left -= n;
	}
	return left > 0 ? null : out;
}

export type ExpiryState = 'none' | 'ok' | 'soon' | 'expired';

export const EXPIRY_LABELS: Record<ExpiryState, string> = {
	none: 'Ohne MHD',
	ok: 'Haltbar',
	soon: 'Läuft bald ab',
	expired: 'Abgelaufen'
};

/** Abgelaufen = MHD vor heute; bald = höchstens `warnDays` Tage bis zum MHD */
export function expiryState(
	bestBefore: string | null,
	today: string,
	warnDays = EXPIRY_WARN_DAYS
): ExpiryState {
	if (!bestBefore) return 'none';
	if (bestBefore < today) return 'expired';
	if (bestBefore <= addDays(today, warnDays)) return 'soon';
	return 'ok';
}
