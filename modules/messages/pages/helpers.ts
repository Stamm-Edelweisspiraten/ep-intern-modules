import { ApiClientError } from '$lib/sdk/client';

export const BASE = '/modules/messages';

/** Aktionen auf Ordnern im Posteingang (Baum, Kopfzeile) */
export type FolderAction = 'create' | 'rename' | 'move' | 'delete' | 'details';

/** Schlüssel in `sessionStorage`, über den Mitglieder-/Gruppenliste die Auswahl an die Nachricht übergeben */
export const COMPOSE_KEY = 'messages:compose';

export interface ComposePreset {
	groupIds?: string[];
	members?: { id: string; name: string }[];
}

/**
 * Auswahl für „Neue Nachricht“ merken und die Seite öffnen. Wird auch von der Mitglieder- und
 * Gruppenliste benutzt (dort als `location.assign` auf den gleichen Pfad).
 */
export function composeUrl(): string {
	return `${BASE}/new`;
}

/** Verständlicher Fehlertext der API (Server-Meldungen sind deutsch und schon passend) */
export function errorText(e: unknown, fallback: string): string {
	if (e instanceof ApiClientError) return e.message || fallback;
	return fallback;
}

export function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024)
		return `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
	return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString('de-DE', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}
