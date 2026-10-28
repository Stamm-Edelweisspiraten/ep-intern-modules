/**
 * Hilfen für die Oberfläche des Moduls `material` (ohne Server-Imports).
 */
import { ApiClientError } from '$lib/sdk/client';
import { formatDateDe } from '$lib/sdk/dates';
import type { BadgeVariant } from '$lib/components/ui/badge';
import {
	BASE_PATH,
	CONDITION_LABELS,
	RESERVATION_STATE_LABELS,
	type Condition,
	type ReservationState
} from '../schemas';

/** Basis für `apiFetch` */
export const API = BASE_PATH;

/** ISO-Zeitstempel oder `JJJJ-MM-TT` → `TT.MM.JJJJ` */
export const formatDate = (iso: string | null | undefined): string => formatDateDe(iso);

/** Zeitraum „01.07.2026 – 10.07.2026“ (gleicher Tag nur einmal) */
export function formatPeriod(from: string, to: string): string {
	return from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
}

/** Verständlicher Fehlertext aus einem API-Fehler */
export function errorText(e: unknown, fallback: string): string {
	if (e instanceof ApiClientError) return e.message || fallback;
	return fallback;
}

type Issue = { path?: readonly PropertyKey[]; message?: string };

/** Zod-Issues bzw. `ApiClientError.details` → `{ 'pfad.0.feld': 'Meldung' }` */
export function fieldErrors(source: unknown): Record<string, string> {
	const list: Issue[] = Array.isArray(source)
		? (source as Issue[])
		: Array.isArray((source as { issues?: Issue[] } | null)?.issues)
			? (source as { issues: Issue[] }).issues
			: [];
	const out: Record<string, string> = {};
	for (const i of list) {
		const key = (i.path ?? []).map(String).join('.');
		if (key && i.message && !out[key]) out[key] = i.message;
	}
	return out;
}

/** Feldfehler aus einem API-Fehler (422) */
export function apiFieldErrors(e: unknown): Record<string, string> {
	return e instanceof ApiClientError ? fieldErrors(e.details) : {};
}

export const CONDITION_VARIANTS: Record<Condition, BadgeVariant> = {
	ok: 'success',
	worn: 'secondary',
	damaged: 'warning',
	defect: 'destructive',
	lost: 'destructive'
};

export const STATE_VARIANTS: Record<ReservationState, BadgeVariant> = {
	upcoming: 'info',
	running: 'warning',
	past: 'secondary',
	cancelled: 'outline'
};

export { CONDITION_LABELS, RESERVATION_STATE_LABELS };

/** Reiter der Materialseite (`?tab=`) */
export type MaterialTab = 'reservieren' | 'meine' | 'alle' | 'lager' | 'etiketten';

/** Link zu einem Artikel im Lager (öffnet den Artikel-Dialog) */
export const itemHref = (id: string) => `${BASE_PATH}?tab=lager&open=${id}`;
/** Link zu einer Reservierung */
export const reservationHref = (id: string, mine = true) =>
	`${BASE_PATH}?tab=${mine ? 'meine' : 'alle'}&open=${id}`;

/** Anzahl mit Name: „3 × Kohtenbahn“ bzw. „Kohtenbahn“ */
export const qtyName = (quantity: number, name: string) =>
	quantity > 1 ? `${quantity} × ${name}` : name;
