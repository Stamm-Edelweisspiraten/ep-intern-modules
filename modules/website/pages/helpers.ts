import { ApiClientError } from '$lib/sdk/client';
import type { BannerState, PostListItem } from '../schemas';

export const BASE = '/modules/website';

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

/** `ApiClientError.details` (Zod-Issues) → Feldfehler */
export function detailsToErrors(details: unknown): Record<string, string> {
	if (Array.isArray(details)) return issuesToErrors(details as Issue[]);
	const issues = (details as { issues?: Issue[] } | null)?.issues;
	return Array.isArray(issues) ? issuesToErrors(issues) : {};
}

export function errorText(e: unknown, fallback: string): string {
	return e instanceof ApiClientError ? e.message || fallback : fallback;
}

/** ISO-Zeitpunkt → Wert für `<input type="datetime-local">` (Ortszeit des Browsers) */
export function toLocalInput(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Wert aus `<input type="datetime-local">` → ISO-Zeitpunkt oder `null` */
export function fromLocalInput(value: string): string | null {
	if (!value) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return '';
	return new Date(iso).toLocaleString('de-DE', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export const BANNER_STATE_LABELS: Record<BannerState, string> = {
	live: 'Läuft',
	scheduled: 'Geplant',
	expired: 'Abgelaufen',
	inactive: 'Ausgeschaltet'
};

/** Status eines Beitrags für die Anzeige */
export function postStatusLabel(p: Pick<PostListItem, 'status' | 'live'>): string {
	if (p.status === 'draft') return 'Entwurf';
	return p.live ? 'Veröffentlicht' : 'Geplant';
}

export function postStatusVariant(
	p: Pick<PostListItem, 'status' | 'live'>
): 'default' | 'secondary' | 'outline' {
	if (p.status === 'draft') return 'outline';
	return p.live ? 'default' : 'secondary';
}

/** Bildadresse eines Beitragsbilds im Intern-Bereich (Editor-Vorschau) */
export function postImageSrc(postId: string, imageId: string, variant: 'thumb' | 'web' = 'web') {
	return `/api/v1${BASE}/posts/${postId}/images/${imageId}/${variant}`;
}
