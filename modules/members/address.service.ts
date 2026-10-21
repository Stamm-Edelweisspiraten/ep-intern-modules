import { sql } from 'drizzle-orm';
import { core, moduleDb } from '$lib/sdk/server';
import type { AddressSuggestion, AddressSuggestions } from './schemas';
import plzData from './data/plz-de.json';
import { directoryName, splitHouseNumber } from './address-utils';

export { directoryName, splitHouseNumber };

/**
 * Adress-Autovervollständigung, schnellste Quelle zuerst:
 * 1. **Mitglieder**: vorhandene Anschriften im Modul (sofort, z. B. Geschwister unter derselben Adresse).
 * 2. **OpenPLZ** (amtliches Straßenverzeichnis Deutschland, `members.address.openPlzUrl`, typ. < 0,6 s):
 *    Straße per Präfix, zuerst die Region des Stamms (häufigster PLZ-Bereich der Mitglieder bzw. die
 *    eingegebene PLZ), dann bundesweit. Die eingetippte Hausnummer wird übernommen.
 * 3. **Photon** (OpenStreetMap, `members.address.photonUrl`) nur als Ersatz: Ausland oder ohne OpenPLZ-Treffer
 *    (öffentlicher Dienst braucht oft 3–5 s).
 * Ergebnisse werden 10 min im Speicher gehalten, gleiche laufende Anfragen zusammengelegt. Fehler/Timeouts
 * führen nie zu einem Fehlerstatus, sondern zu `unavailable: true` – das Formular bleibt normal nutzbar.
 * PLZ → Ort (Deutschland): mitgelieferte Liste `data/plz-de.json` (GeoNames, CC BY 4.0), offline.
 */

export const PHOTON_SETTING = 'members.address.photonUrl';
export const PHOTON_DEFAULT_URL = 'https://photon.komoot.io';
export const OPENPLZ_SETTING = 'members.address.openPlzUrl';
export const OPENPLZ_DEFAULT_URL = 'https://openplzapi.org';
const OPENPLZ_TIMEOUT_MS = 2500;
const PHOTON_TIMEOUT_MS = 6000;
/** Photon erst starten, wenn das Verzeichnis so lange nicht geantwortet hat */
const PHOTON_AFTER_MS = 800;
const MAX_ITEMS = 8;
const MAX_LOCAL = 3;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const REGION_TTL_MS = 10 * 60_000;
const MODULE_ID = 'members';

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

interface OpenPlzStreet {
	name?: string;
	postalCode?: string;
	locality?: string;
}

export interface AddressHints {
	/** Bereits eingegebene PLZ (Region bevorzugen) */
	postalCode?: string;
	/** Bereits gewähltes Land (`DE` → OpenPLZ) */
	country?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function build(
	street: string,
	postalCode: string,
	city: string,
	country: string,
	source: AddressSuggestion['source']
): AddressSuggestion {
	const place = [postalCode, city].filter(Boolean).join(' ');
	return {
		label: [street, place].filter(Boolean).join(', '),
		street,
		postalCode,
		city,
		country,
		source
	};
}

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
	return build(street, postalCode, city, country, 'photon');
}

/** Straßennamen vergleichbar machen („Heerstraße“ = „Heerstr.“, Groß-/Kleinschreibung egal). */
export function normalizeStreet(s: string): string {
	return s
		.toLocaleLowerCase('de-DE')
		.replace(/straße\b/g, 'str.')
		.replace(/strasse\b/g, 'str.')
		.replace(/\s+/g, ' ')
		.trim();
}

function baseUrl(raw: unknown): URL | null {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v) return null;
	try {
		const u = new URL(v);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		if (!u.pathname.endsWith('/')) u.pathname += '/';
		return u;
	} catch {
		return null;
	}
}

/** Ersetzt den Fetch in Tests. */
let fetcher: typeof fetch = (...args) => fetch(...args);
export function setAddressFetchForTests(f: typeof fetch | undefined): void {
	fetcher = f ?? ((...args) => fetch(...args));
	streetCache.clear();
	photonCache.clear();
	inflight.clear();
	region = null;
}

async function getJson<T>(url: URL, timeoutMs: number): Promise<T | null> {
	try {
		const res = await fetcher(url, {
			headers: { accept: 'application/json', 'user-agent': 'EP-Intern/1.0 (address autocomplete)' },
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

// --- Quelle 1: Anschriften der Mitglieder ------------------------------------------

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function localAddresses(q: string): Promise<AddressSuggestion[]> {
	const pattern = `${likeEscape(q.trim())}%`;
	try {
		const rows = await moduleDb(MODULE_ID).transaction(async (tx) => {
			const r = await tx.execute(sql`
				SELECT street, postal_code, city, country, count(*)::int AS n
				FROM members
				WHERE street ILIKE ${pattern} AND postal_code IS NOT NULL AND city IS NOT NULL
				GROUP BY street, postal_code, city, country
				ORDER BY n DESC, street
				LIMIT ${MAX_LOCAL}`);
			return r.rows as { street: string; postal_code: string; city: string; country: string }[];
		});
		return rows.map((r) =>
			build(str(r.street), str(r.postal_code), str(r.city), str(r.country) || 'DE', 'members')
		);
	} catch {
		return [];
	}
}

/** Häufigster PLZ-Bereich (2 Ziffern) der Mitglieder in Deutschland, 10 min zwischengespeichert. */
let region: { prefix: string | null; at: number } | null = null;
async function homeRegion(): Promise<string | null> {
	if (region && Date.now() - region.at < REGION_TTL_MS) return region.prefix;
	let prefix: string | null;
	try {
		prefix = await moduleDb(MODULE_ID).transaction(async (tx) => {
			const r = await tx.execute(sql`
				SELECT left(postal_code, 2) AS p, count(*)::int AS n
				FROM members
				WHERE country = 'DE' AND postal_code ~ '^[0-9]{5}$'
				GROUP BY 1 ORDER BY n DESC LIMIT 1`);
			const p = (r.rows[0] as { p?: string } | undefined)?.p;
			return p && /^\d{2}$/.test(p) ? p : null;
		});
	} catch {
		prefix = null;
	}
	region = { prefix, at: Date.now() };
	return prefix;
}

// --- Zwischenspeicher ---------------------------------------------------------------

interface Cached<T> {
	at: number;
	value: T;
}
const streetCache = new Map<string, Cached<{ list: OpenPlzStreet[]; complete: boolean }>>();
const photonCache = new Map<string, Cached<AddressSuggestion[]>>();
const inflight = new Map<string, Promise<unknown>>();

function remember<T>(map: Map<string, Cached<T>>, key: string, value: T) {
	if (map.size >= CACHE_MAX) map.delete(map.keys().next().value!);
	map.set(key, { at: Date.now(), value });
}
function fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
	return !!c && Date.now() - c.at < CACHE_TTL_MS;
}
/** Gleiche laufende Anfragen zusammenlegen */
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
	const running = inflight.get(key) as Promise<T> | undefined;
	if (running) return running;
	const p = run().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

// --- Quelle 2: OpenPLZ (Deutschland) ------------------------------------------------

const OPENPLZ_PAGE = 50;

/**
 * Straßen zu einem Namen (OpenPLZ sucht „enthält“, ohne Groß-/Kleinschreibung). Ein vollständig
 * geladenes Ergebnis für einen kürzeren Namen wird nur gefiltert – weiteres Tippen fragt nicht neu.
 * `null` = Dienst nicht erreichbar.
 */
async function openPlzStreets(
	base: URL,
	name: string,
	postalCode: string | null
): Promise<OpenPlzStreet[] | null> {
	const lower = name.toLocaleLowerCase('de-DE');
	const scope = `${base.origin}|${postalCode ?? ''}|`;
	const exact = streetCache.get(scope + lower);
	if (fresh(exact)) return exact.value.list;
	for (const [key, c] of streetCache) {
		if (!key.startsWith(scope) || !fresh(c) || !c.value.complete) continue;
		const shorter = key.slice(scope.length);
		if (shorter.length < lower.length && lower.includes(shorter)) {
			return c.value.list.filter((s) => str(s.name).toLocaleLowerCase('de-DE').includes(lower));
		}
	}
	return once(`openplz:${scope}${lower}`, async () => {
		const url = new URL('de/Streets', base);
		url.searchParams.set('name', name);
		if (postalCode) url.searchParams.set('postalCode', postalCode);
		url.searchParams.set('page', '1');
		url.searchParams.set('pageSize', String(OPENPLZ_PAGE));
		const json = await getJson<unknown>(url, OPENPLZ_TIMEOUT_MS);
		if (!Array.isArray(json)) return null;
		const list = json as OpenPlzStreet[];
		remember(streetCache, scope + lower, { list, complete: list.length < OPENPLZ_PAGE });
		return list;
	});
}

/** Straßen aus dem Verzeichnis: Region zuerst, dann bundesweit; `ok` = mindestens eine Antwort. */
async function openPlz(
	base: URL,
	name: string,
	prefix: string | null
): Promise<{ streets: OpenPlzStreet[]; ok: boolean }> {
	const search = directoryName(name);
	if (search.length < 3) return { streets: [], ok: true };
	const [regional, national] = await Promise.all([
		prefix ? openPlzStreets(base, search, prefix) : Promise.resolve(null),
		openPlzStreets(base, search, null)
	]);
	if (regional === null && national === null) return { streets: [], ok: false };
	const inRegion = (regional ?? []).filter((s) => !prefix || str(s.postalCode).startsWith(prefix));
	// Treffer, die mit dem Suchtext beginnen, vor solchen, die ihn nur enthalten („Brockwinkler“)
	const lower = search.toLocaleLowerCase('de-DE');
	const starts = (s: OpenPlzStreet) =>
		str(s.name).toLocaleLowerCase('de-DE').startsWith(lower) ? 0 : 1;
	const sorted = (l: OpenPlzStreet[]) => [...l].sort((a, b) => starts(a) - starts(b));
	return { streets: [...sorted(inRegion), ...sorted(national ?? [])], ok: true };
}

// --- Quelle 3: Photon ----------------------------------------------------------------

/** Grobe Umrandung Deutschlands (lon/lat) – verhindert Treffer aus anderen Ländern bei `DE` */
const DE_BBOX = '5.8,47.2,15.1,55.1';

async function photon(base: URL, q: string, country: string): Promise<AddressSuggestion[] | null> {
	const key = `${base.origin}|${country}|${q.toLocaleLowerCase('de-DE')}`;
	const hit = photonCache.get(key);
	if (fresh(hit)) return hit.value;
	return once(`photon:${key}`, async () => {
		const url = new URL('api/', base);
		url.searchParams.set('q', q);
		url.searchParams.set('limit', '10');
		url.searchParams.set('lang', 'de');
		url.searchParams.append('layer', 'house');
		url.searchParams.append('layer', 'street');
		if (country === 'DE') url.searchParams.set('bbox', DE_BBOX);
		const json = await getJson<{ features?: { properties?: PhotonProperties }[] }>(
			url,
			PHOTON_TIMEOUT_MS
		);
		if (!json) return null;
		const items: AddressSuggestion[] = [];
		for (const f of json.features ?? []) {
			const s = f?.properties ? toSuggestion(f.properties) : null;
			if (s && (country !== 'DE' || s.country === 'DE')) items.push(s);
		}
		remember(photonCache, key, items);
		return items;
	});
}

// --- Zusammenführen -----------------------------------------------------------------

function merge(lists: AddressSuggestion[][]): AddressSuggestion[] {
	const seen = new Set<string>();
	const out: AddressSuggestion[] = [];
	for (const s of lists.flat()) {
		const key = `${normalizeStreet(s.street)}|${s.postalCode}|${s.city.toLocaleLowerCase('de-DE')}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s);
		if (out.length >= MAX_ITEMS) break;
	}
	return out;
}

export async function suggestAddresses(
	q: string,
	hints: AddressHints = {}
): Promise<AddressSuggestions> {
	const query = q.trim().replace(/\s+/g, ' ');
	const country = (hints.country ?? 'DE').toUpperCase();
	const [openBase, photonBase] = await Promise.all([
		core.settings.get(OPENPLZ_SETTING).then(baseUrl),
		core.settings.get(PHOTON_SETTING).then(baseUrl)
	]);
	// Nacheinander: PGlite (Tests/Demo) hat nur eine Sitzung; Mitglieder-Anschriften immer frisch
	const local = await localAddresses(query);
	const { name, number } = splitHouseNumber(query);
	const typed = str(hints.postalCode);
	const useDirectory = country === 'DE' && !!openBase;
	const prefix = !useDirectory
		? null
		: /^\d{2}/.test(typed)
			? typed.slice(0, 2)
			: await homeRegion();

	// Photon (langsam, öffentlich) erst starten, wenn das Verzeichnis nach PHOTON_AFTER_MS noch nicht
	// geantwortet hat oder nichts findet – oder sofort bei Anschriften im Ausland
	let photonRun: Promise<AddressSuggestion[] | null> | null = null;
	const startPhoton = () => {
		if (!photonRun && photonBase) photonRun = photon(photonBase, query, country);
		return photonRun;
	};
	const directory: AddressSuggestion[] = [];
	let ok = false;
	if (useDirectory && openBase) {
		const running = openPlz(openBase, name, prefix);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const slow = new Promise<'slow'>((resolve) => {
			timer = setTimeout(() => resolve('slow'), PHOTON_AFTER_MS);
		});
		if ((await Promise.race([running.then(() => 'done' as const), slow])) === 'slow') {
			startPhoton();
		}
		clearTimeout(timer);
		const r = await running;
		ok = r.ok;
		for (const s of r.streets) {
			const road = str(s.name);
			const postalCode = str(s.postalCode);
			const city = str(s.locality);
			if (!road || (!postalCode && !city)) continue;
			directory.push(
				build(number ? `${road} ${number}` : road, postalCode, city, 'DE', 'directory')
			);
		}
	}
	let fallback: AddressSuggestion[] = [];
	const pending = directory.length === 0 ? startPhoton() : null;
	if (pending) {
		const r = await pending;
		ok ||= r !== null;
		fallback = r ?? [];
	}
	if (!useDirectory && !photonBase) return { items: local, unavailable: true };
	const items = merge([local, directory, fallback]);
	return { items, unavailable: !ok && items.length === 0 };
}

/** Orte zu einer deutschen Postleitzahl (offline). */
export function placesForPostalCode(postalCode: string): string[] {
	return (plzData as Record<string, string[]>)[postalCode] ?? [];
}
