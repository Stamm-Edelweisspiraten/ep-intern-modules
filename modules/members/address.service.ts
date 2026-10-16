import { core } from '$lib/sdk/server';
import type { AddressSuggestion, AddressSuggestions } from './schemas';
import plzData from './data/plz-de.json';

/**
 * Adress-Autovervollständigung.
 * - Straße/Hausnummer/PLZ/Ort: Photon (OpenStreetMap), serverseitig abgefragt. Die Dienst-URL steht in der
 *   Modul-Einstellung `members.address.photonUrl` (leer = abgeschaltet). Fehler/Timeouts führen nie zu einem
 *   Fehlerstatus, sondern zu `unavailable: true` – das Formular bleibt normal nutzbar.
 * - PLZ → Ort (Deutschland): mitgelieferte Liste `data/plz-de.json` (GeoNames, CC BY 4.0), offline.
 */

export const PHOTON_SETTING = 'members.address.photonUrl';
export const PHOTON_DEFAULT_URL = 'https://photon.komoot.io';
const TIMEOUT_MS = 3000;
const MAX_ITEMS = 6;

interface PhotonProperties {
	name?: string;
	street?: string;
	housenumber?: string;
	postcode?: string;
	city?: string;
	town?: string;
	village?: string;
	locality?: string;
	district?: string;
	countrycode?: string;
	osm_key?: string;
	type?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Photon-Feature → Vorschlag; `null`, wenn keine Straße oder weder PLZ noch Ort erkennbar sind. */
export function toSuggestion(p: PhotonProperties): AddressSuggestion | null {
	const road = str(p.street) || (p.osm_key === 'highway' || p.type === 'street' ? str(p.name) : '');
	if (!road) return null;
	const number = str(p.housenumber);
	const street = number ? `${road} ${number}` : road;
	const postalCode = str(p.postcode);
	const city = str(p.city) || str(p.town) || str(p.village) || str(p.locality) || str(p.district);
	if (!postalCode && !city) return null;
	const country = str(p.countrycode).toUpperCase() || 'DE';
	if (!/^[A-Z]{2}$/.test(country)) return null;
	const place = [postalCode, city].filter(Boolean).join(' ');
	return { label: [street, place].filter(Boolean).join(', '), street, postalCode, city, country };
}

function baseUrl(raw: unknown): URL | null {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v) return null;
	try {
		const u = new URL(v);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
	} catch {
		return null;
	}
}

/** Ersetzt den Fetch in Tests. */
let fetcher: typeof fetch = (...args) => fetch(...args);
export function setAddressFetchForTests(f: typeof fetch | undefined): void {
	fetcher = f ?? ((...args) => fetch(...args));
}

export async function suggestAddresses(q: string): Promise<AddressSuggestions> {
	const base = baseUrl(await core.settings.get(PHOTON_SETTING));
	if (!base) return { items: [], unavailable: true };
	const url = new URL('api/', base.href.endsWith('/') ? base.href : `${base.href}/`);
	url.searchParams.set('q', q);
	url.searchParams.set('limit', '10');
	url.searchParams.set('lang', 'de');
	url.searchParams.append('layer', 'house');
	url.searchParams.append('layer', 'street');
	try {
		const res = await fetcher(url, {
			headers: { accept: 'application/json', 'user-agent': 'EP-Intern/1.0 (address autocomplete)' },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!res.ok) return { items: [], unavailable: true };
		const json = (await res.json()) as { features?: { properties?: PhotonProperties }[] };
		const seen = new Set<string>();
		const items: AddressSuggestion[] = [];
		for (const f of json.features ?? []) {
			const s = f?.properties ? toSuggestion(f.properties) : null;
			if (!s || seen.has(s.label)) continue;
			seen.add(s.label);
			items.push(s);
			if (items.length >= MAX_ITEMS) break;
		}
		return { items, unavailable: false };
	} catch {
		return { items: [], unavailable: true };
	}
}

/** Orte zu einer deutschen Postleitzahl (offline). */
export function placesForPostalCode(postalCode: string): string[] {
	return (plzData as Record<string, string[]>)[postalCode] ?? [];
}
