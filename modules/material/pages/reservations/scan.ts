/**
 * Gemeinsame Hilfen für Scannen, Ausgabe und Rückgabe (Oberfläche, ohne Server-Imports).
 */
import { ApiClientError, apiFetch } from '$lib/sdk/client';
import { codeFromScan, type CodeTarget, type MaterialSet, type Reservation } from '../../schemas';
import { API } from '../helpers';

/**
 * Gescannten Inhalt (Code oder volle Scan-URL) auflösen. Unbekannt bzw. fremde URL → `null`,
 * andere Fehler werden weitergereicht.
 */
export async function resolveCode(raw: string): Promise<CodeTarget | null> {
	const code = codeFromScan(raw);
	if (!code) return null;
	try {
		return await apiFetch<CodeTarget>(`${API}/codes/${encodeURIComponent(code)}`);
	} catch (e) {
		if (e instanceof ApiClientError && e.status === 404) return null;
		throw e;
	}
}

/** Stücke eines Sets laden (für „ganzes Set ausgeben“ und Set-Scans) */
export async function loadSetUnits(setId: string): Promise<MaterialSet['units']> {
	const set = await apiFetch<MaterialSet>(`${API}/sets/${setId}`);
	return set.units;
}

/** Ist der API-Fehler „Stück gehört nicht zu dieser Reservierung“ (→ Rückfrage `allowExtra`)? */
export function isNotPartOfReservation(e: unknown): e is ApiClientError {
	return e instanceof ApiClientError && e.status === 422 && /gehört nicht/.test(e.message);
}

/** Stücke ausgeben (POST …/issue) */
export function issueUnits(
	reservationId: string,
	body: { unitIds?: string[]; bulk?: { lineId: string; quantity: number }[]; allowExtra?: boolean }
): Promise<Reservation> {
	return apiFetch<Reservation>(`${API}/reservations/${reservationId}/issue`, {
		method: 'POST',
		body: JSON.stringify({ unitIds: [], bulk: [], allowExtra: false, ...body })
	});
}

/** Ausgabe eines Stücks zurücknehmen (Fehlscan) */
export function unissueUnit(reservationId: string, unitId: string): Promise<Reservation> {
	return apiFetch<Reservation>(`${API}/reservations/${reservationId}/unissue`, {
		method: 'POST',
		body: JSON.stringify({ unitId })
	});
}

/** Text für einen nicht passenden Treffer beim Ausgeben/Zurücknehmen */
export function targetHint(t: CodeTarget | null): string {
	if (!t) return 'Unbekannter Code';
	if (t.type === 'location') return `${t.name} ist ein Lagerort, kein Stück`;
	if (t.type === 'reserved') return `${t.code} ist noch keinem Stück zugeordnet`;
	return '';
}

/** Vorbelegung einer neuen Reservierung (z. B. aus einer Aktion) */
export interface ReservationPrefill {
	actionId?: string | null;
	actionName?: string | null;
	from?: string | null;
	to?: string | null;
	title?: string | null;
}
