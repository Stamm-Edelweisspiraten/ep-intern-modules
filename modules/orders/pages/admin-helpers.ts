/**
 * Hilfen für die Verwaltungs-Oberfläche (Kämmerer*in): Bestellungen, Lager, Einkauf.
 * Nur von den Admin-Tabs/Dialogen genutzt (Team E); keine Server-Imports.
 */
import { ApiClientError } from '$lib/sdk/client';
import { BASE_PATH, ORDER_STATUS_LABELS, SUPPLIER_STATUS_LABELS } from '../schemas';

export const API = BASE_PATH;

/** `YYYY-MM-DD` oder ISO → `TT.MM.JJJJ` */
export function fmtDate(d: string | null | undefined): string {
	if (!d) return '–';
	const [y, m, day] = d.slice(0, 10).split('-');
	return y && m && day ? `${day}.${m}.${y}` : '–';
}

export function fmtDateTime(iso: string | null | undefined): string {
	if (!iso) return '–';
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? '–'
		: d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Heute als `YYYY-MM-DD` (lokale Zeit) */
export function todayIso(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Menge „3/5“ */
export const fmtRatio = (done: number, total: number) => `${done}/${total}`;

/** „3 Stück“ / „1 Stück“ */
export const fmtPieces = (n: number) => `${n} Stück`;

/** Artikel mit Größe: „Halstuch (M)“ bzw. „Liederbuch“ */
export const itemName = (title: string, label: string) => (label ? `${title} (${label})` : title);

/** Lagerbewegung mit Vorzeichen */
export const fmtDelta = (n: number) => (n > 0 ? `+${n}` : String(n));

export const errorMessage = (e: unknown, fallback: string) =>
	e instanceof ApiClientError ? e.message : fallback;

/** Feldfehler aus `ApiClientError.details` (Zod-Issues) → `{ 'items.0.quantity': '…', items: '…' }` */
export function fieldErrorsFrom(details: unknown): Record<string, string> {
	const list = Array.isArray(details)
		? details
		: (details as { issues?: unknown[] } | null)?.issues;
	return Array.isArray(list)
		? issuesToErrors(list as { path?: PropertyKey[]; message?: string }[])
		: {};
}

export function issuesToErrors(
	issues: { path?: PropertyKey[]; message?: string }[]
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const i of issues) {
		if (!i.message) continue;
		const path = i.path ?? [];
		const key = path.map(String).join('.');
		if (!out[key]) out[key] = i.message;
		const top = String(path[0] ?? '');
		if (top && !out[top]) out[top] = i.message;
	}
	return out;
}

export type OrderFilter = 'active' | 'all' | 'open' | 'partial' | 'delivered' | 'cancelled';
export const ORDER_FILTERS: { value: OrderFilter; label: string }[] = [
	{ value: 'active', label: 'Aktiv' },
	{ value: 'all', label: 'Alle' },
	{ value: 'open', label: ORDER_STATUS_LABELS.open },
	{ value: 'partial', label: 'Teilweise' },
	{ value: 'delivered', label: ORDER_STATUS_LABELS.delivered },
	{ value: 'cancelled', label: ORDER_STATUS_LABELS.cancelled }
];

export type SupplierFilter = 'active' | 'all' | 'ordered' | 'partial' | 'received' | 'closed';
export const SUPPLIER_FILTERS: { value: SupplierFilter; label: string }[] = [
	{ value: 'active', label: 'Aktiv' },
	{ value: 'all', label: 'Alle' },
	{ value: 'ordered', label: SUPPLIER_STATUS_LABELS.ordered },
	{ value: 'partial', label: 'Teilweise' },
	{ value: 'received', label: SUPPLIER_STATUS_LABELS.received },
	{ value: 'closed', label: SUPPLIER_STATUS_LABELS.closed }
];

/** Externe Links nur als http(s) anzeigen */
export const safeUrl = (u: string | null | undefined): string | null =>
	u && /^https?:\/\/\S+$/i.test(u) ? u : null;

/** Kurze Anzeige eines Links (Host) */
export function urlHost(u: string): string {
	try {
		return new URL(u).host.replace(/^www\./, '');
	} catch {
		return u;
	}
}
