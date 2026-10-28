/**
 * Gescannten Inhalt (Code oder volle Scan-URL aus dem QR-Code) auflösen.
 */
import { ApiClientError, apiFetch } from '$lib/sdk/client';
import { API } from '../helpers';
import { codeFromScan, type CodeTarget } from '../../schemas';

/** `null` bei unbekanntem oder fremdem Code; andere Fehler werden geworfen */
export async function resolveScan(raw: string): Promise<CodeTarget | null> {
	const code = codeFromScan(raw);
	if (!code) return null;
	try {
		return await apiFetch<CodeTarget>(`${API}/codes/${encodeURIComponent(code)}`);
	} catch (e) {
		if (e instanceof ApiClientError && e.status === 404) return null;
		throw e;
	}
}
