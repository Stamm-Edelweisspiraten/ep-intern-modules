/**
 * Reine Logik des Moduls `orders` (ohne Server-/Svelte-Imports, in Tests und UI nutzbar):
 * Fehlmengen, Preisspanne, Statusableitung, Nummern.
 */
import type { OrderStatus, SupplierStatus } from './schemas';

/** Ganze, nicht negative Zahl (NaN/Infinity/negativ → 0) */
export function safeCount(n: unknown): number {
	const v = typeof n === 'number' ? n : Number(n);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface ItemQuantities {
	quantity: number;
	deliveredQty: number;
	cancelledQty: number;
}

/** Noch auszugebende Menge einer Mitgliedsposition */
export function openQty(it: ItemQuantities): number {
	return Math.max(
		0,
		safeCount(it.quantity) - safeCount(it.deliveredQty) - safeCount(it.cancelledQty)
	);
}

export interface SupplierItemQuantities {
	quantity: number;
	receivedQty: number;
	cancelledQty: number;
}

/** Noch nicht eingegangene Menge einer Lieferantenposition */
export function inTransitQty(it: SupplierItemQuantities): number {
	return Math.max(
		0,
		safeCount(it.quantity) - safeCount(it.receivedQty) - safeCount(it.cancelledQty)
	);
}

export interface DeficitInput {
	stock: number;
	minStock: number;
	demand: number;
	inTransit: number;
}

/** Nachzubestellende Menge: max(0, offene Nachfrage + Mindestbestand − Bestand − unterwegs) */
export function deficit(v: DeficitInput): number {
	return Math.max(
		0,
		safeCount(v.demand) + safeCount(v.minStock) - safeCount(v.stock) - safeCount(v.inTransit)
	);
}

/** min/max-Preis aktiver Varianten; leere Liste → 0/0 */
export function priceRange(prices: readonly number[]): { min: number; max: number } {
	const valid = prices.filter((p) => Number.isFinite(p) && p >= 0);
	if (!valid.length) return { min: 0, max: 0 };
	return { min: Math.min(...valid), max: Math.max(...valid) };
}

/**
 * Status einer Mitgliedsbestellung aus ihren Positionen.
 * Alles storniert (oder Bestellung storniert) → cancelled; nichts offen → delivered;
 * etwas ausgegeben, aber noch offen → partial; sonst open.
 */
export function orderStatus(
	items: readonly ItemQuantities[],
	cancelledAt?: string | null
): OrderStatus {
	const qty = items.reduce((s, i) => s + safeCount(i.quantity), 0);
	const cancelled = items.reduce((s, i) => s + safeCount(i.cancelledQty), 0);
	const delivered = items.reduce((s, i) => s + safeCount(i.deliveredQty), 0);
	if (cancelledAt || qty === 0 || cancelled >= qty) return 'cancelled';
	const open = items.reduce((s, i) => s + openQty(i), 0);
	if (open === 0) return 'delivered';
	return delivered > 0 ? 'partial' : 'open';
}

/** Rechnungsbetrag einer Position: (Menge − storniert) × Einzelpreis */
export function billableCents(it: ItemQuantities & { unitPriceCents: number }): number {
	const n = Math.max(0, safeCount(it.quantity) - safeCount(it.cancelledQty));
	return n * safeCount(it.unitPriceCents);
}

/** Status einer Lieferantenbestellung */
export function supplierStatus(
	items: readonly SupplierItemQuantities[],
	closedAt?: string | null
): SupplierStatus {
	if (closedAt) return 'closed';
	const open = items.reduce((s, i) => s + inTransitQty(i), 0);
	const received = items.reduce((s, i) => s + safeCount(i.receivedQty), 0);
	if (open === 0) return 'received';
	return received > 0 ? 'partial' : 'ordered';
}

/** Nummer `<P>-JJJJ-NNNN` (z. B. `B-2026-0001`, `E-2026-0003`) */
export function formatNumber(prefix: string, year: number, seq: number): string {
	return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** Text eines Rechnungspostens, z. B. „Halstuch (Gr. M) × 2“ */
export function lineDescription(
	articleTitle: string,
	variantLabel: string,
	quantity: number
): string {
	const size = variantLabel ? ` (Gr. ${variantLabel})` : '';
	return `${articleTitle}${size} × ${quantity}`;
}
