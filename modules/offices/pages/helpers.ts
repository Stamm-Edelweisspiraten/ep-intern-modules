import { ApiClientError } from '$lib/sdk/client';

export const BASE = '/modules/offices';

/** `JJJJ-MM-TT` → `TT.MM.JJJJ` (ungültige Werte unverändert) */
export function formatDate(iso: string | null | undefined): string {
	if (!iso) return '';
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
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

/** Verständlicher Fehlertext; 403 beim Bearbeiten = Rechteausweitung */
export function errorText(e: unknown, fallback: string): string {
	if (e instanceof ApiClientError) {
		if (e.status === 403) {
			// Eigene Server-Meldung (z. B. „Rolle X enthält Rechte, die du nicht hast“) bevorzugen
			return e.message && e.message !== 'Keine Berechtigung'
				? e.message
				: 'Dafür fehlen dir Rechte. Du kannst nur Rollen verknüpfen und Personen zuordnen, wenn du die Rechte dieser Rollen selbst hast.';
		}
		return e.message || fallback;
	}
	return fallback;
}

/** Element an Position `from` nach `to` verschieben (neues Array) */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
		return [...list];
	}
	const next = [...list];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item as T);
	return next;
}
