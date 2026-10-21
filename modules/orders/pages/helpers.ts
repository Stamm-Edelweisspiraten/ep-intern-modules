/**
 * Hilfen für die Oberfläche Bestellen & Artikelpflege (ohne Server-Imports).
 */
import { ApiClientError } from '$lib/sdk/client';
import { formatEuro } from '$lib/components/layout/money';
import { formatDateDe } from '$lib/sdk/dates';
import { BASE_PATH, MAX_QUANTITY, type Article } from '../schemas';

export const BASE = BASE_PATH;

/** Einzelpreis „8,00 €“ bzw. Spanne „8,00 € – 12,00 €“ */
export function formatPriceRange(min: number, max: number): string {
	const lo = Number.isFinite(min) ? Math.max(0, Math.round(min)) : 0;
	const hi = Number.isFinite(max) ? Math.max(0, Math.round(max)) : lo;
	if (hi <= lo) return formatEuro(lo);
	return `${formatEuro(lo)} – ${formatEuro(hi)}`;
}

/** ISO-Zeitstempel oder `JJJJ-MM-TT` → `TT.MM.JJJJ` */
export const formatDate = (iso: string | null | undefined): string => formatDateDe(iso);

/** Verständlicher Fehlertext aus einem API-Fehler */
export function errorText(e: unknown, fallback: string): string {
	if (e instanceof ApiClientError) {
		if (e.status === 503 && e.code === 'unavailable') return e.message || 'Dienst nicht verfügbar';
		return e.message || fallback;
	}
	return fallback;
}

type Issue = { path?: readonly PropertyKey[]; message?: string };

/** Zod-Issues → `{ 'pfad.0.feld': 'Meldung' }` (erste Meldung je Pfad gewinnt) */
export function issuesToErrors(issues: readonly Issue[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const i of issues) {
		const key = (i.path ?? []).map(String).join('.');
		if (key && i.message && !out[key]) out[key] = i.message;
	}
	return out;
}

/** `ApiClientError.details` (Zod-Issues oder `{ feld: meldung }`) → Feldfehler */
export function detailsToErrors(details: unknown): Record<string, string> {
	if (Array.isArray(details)) return issuesToErrors(details as Issue[]);
	const issues = (details as { issues?: Issue[] } | null)?.issues;
	if (Array.isArray(issues)) return issuesToErrors(issues);
	const out: Record<string, string> = {};
	if (details && typeof details === 'object') {
		for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
			const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
			if (msg && !out[k]) out[k] = msg;
		}
	}
	return out;
}

/** Element in einer Liste verschieben (Reihenfolge) */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
		return [...list];
	}
	const next = [...list];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item as T);
	return next;
}

// --- Warenkorb -------------------------------------------------------------------

export interface CartItem {
	variantId: string;
	articleId: string;
	articleTitle: string;
	/** '' = ohne Größe */
	variantLabel: string;
	unitPriceCents: number;
	quantity: number;
	thumbUrl: string | null;
}

const CART_KEY = 'orders.cart.v1';

const clampQty = (n: number) =>
	Math.min(MAX_QUANTITY, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1));

function isCartItem(v: unknown): v is CartItem {
	const o = v as Partial<CartItem> | null;
	return (
		!!o &&
		typeof o.variantId === 'string' &&
		typeof o.articleId === 'string' &&
		typeof o.articleTitle === 'string' &&
		typeof o.variantLabel === 'string' &&
		typeof o.unitPriceCents === 'number' &&
		typeof o.quantity === 'number'
	);
}

/** Warenkorb aus `sessionStorage` (leer, wenn nicht verfügbar oder kaputt) */
export function loadCart(): CartItem[] {
	try {
		const raw = sessionStorage.getItem(CART_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isCartItem).map((i) => ({
			...i,
			quantity: clampQty(i.quantity),
			thumbUrl: typeof i.thumbUrl === 'string' ? i.thumbUrl : null
		}));
	} catch {
		return [];
	}
}

export function saveCart(cart: readonly CartItem[]): void {
	try {
		if (cart.length) sessionStorage.setItem(CART_KEY, JSON.stringify(cart));
		else sessionStorage.removeItem(CART_KEY);
	} catch {
		// Speicher nicht verfügbar (privates Fenster o. Ä.) – Warenkorb lebt nur im Speicher
	}
}

/** Position hinzufügen; gleiche Größe → Menge addieren */
export function addToCart(cart: readonly CartItem[], item: CartItem): CartItem[] {
	const existing = cart.find((c) => c.variantId === item.variantId);
	if (!existing) return [...cart, { ...item, quantity: clampQty(item.quantity) }];
	return cart.map((c) =>
		c.variantId === item.variantId ? { ...c, quantity: clampQty(c.quantity + item.quantity) } : c
	);
}

export function setCartQuantity(
	cart: readonly CartItem[],
	variantId: string,
	quantity: number
): CartItem[] {
	return cart.map((c) => (c.variantId === variantId ? { ...c, quantity: clampQty(quantity) } : c));
}

export function cartTotal(cart: readonly CartItem[]): number {
	return cart.reduce((s, c) => s + c.unitPriceCents * c.quantity, 0);
}

export function cartCount(cart: readonly CartItem[]): number {
	return cart.reduce((s, c) => s + c.quantity, 0);
}

/**
 * Warenkorb mit dem aktuellen Katalog abgleichen: Preise/Titel aktualisieren,
 * nicht mehr bestellbare Größen entfernen.
 */
export function reconcileCart(
	cart: readonly CartItem[],
	articles: readonly Article[]
): { cart: CartItem[]; removed: number; changed: boolean } {
	const byVariant = new Map<string, { a: Article; label: string; price: number }>();
	for (const a of articles) {
		if (!a.active || a.archived) continue;
		for (const v of a.variants) {
			if (!v.archived) byVariant.set(v.id, { a, label: v.label, price: v.priceCents });
		}
	}
	let removed = 0;
	let changed = false;
	const next: CartItem[] = [];
	for (const c of cart) {
		const hit = byVariant.get(c.variantId);
		if (!hit) {
			removed++;
			continue;
		}
		const updated: CartItem = {
			...c,
			articleId: hit.a.id,
			articleTitle: hit.a.title,
			variantLabel: hit.label,
			unitPriceCents: hit.price,
			thumbUrl: hit.a.cover?.thumbUrl ?? null
		};
		if (
			updated.articleTitle !== c.articleTitle ||
			updated.variantLabel !== c.variantLabel ||
			updated.unitPriceCents !== c.unitPriceCents ||
			updated.thumbUrl !== c.thumbUrl
		)
			changed = true;
		next.push(updated);
	}
	return { cart: next, removed, changed: changed || removed > 0 };
}

/** Bezeichnung einer Position, z. B. „Halstuch (Gr. M)“ */
export function itemLabel(title: string, size: string): string {
	return size ? `${title} (Gr. ${size})` : title;
}

// --- Größen ------------------------------------------------------------------------

export const SIZE_PRESETS: { id: string; label: string; sizes: string[] }[] = [
	{ id: 'adult', label: 'XS–XXL', sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
	{ id: 'kids', label: 'Kinder 116–164', sizes: ['116', '128', '140', '152', '164'] }
];

/** Bearbeitbare Zeile im Größen-Editor */
export interface VariantRow {
	key: string;
	id?: string;
	label: string;
	priceCents: number;
	reorderUrl: string;
	minStock: number;
	/** Nur Anzeige (Verwaltung) */
	stock: number | null;
}

export function newVariantRow(partial: Partial<VariantRow> = {}): VariantRow {
	return {
		key: crypto.randomUUID(),
		label: '',
		priceCents: 0,
		reorderUrl: '',
		minStock: 0,
		stock: null,
		...partial
	};
}
