/**
 * Vorschlag für unbekannte Lebensmittel-Barcodes aus Open Food Facts (freie Datenbank). Es geht nur der
 * Barcode hinaus. Wirft nie; ohne Treffer, bei Fehlern oder Zeitüberschreitung `found: false`.
 * Produktbilder lädt nur der Server (`fetchOffImage`) – vom OFF-Bildserver, die URL kommt aus der OFF-Antwort,
 * nie vom Client. Gespeichert wird das Bild danach lokal wie ein Upload.
 */
import { type BarcodeSuggestion, MAX_IMAGE_BYTES } from './schemas';

const BASE = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'product_name,product_name_de,brands,quantity,image_front_url,image_url';
const TIMEOUT_MS = 4000;
const IMAGE_TIMEOUT_MS = 8000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const USER_AGENT = 'EP-Intern/1.0 (Materialverwaltung)';
/** Nur Bilder von diesen Hosts (OFF-Bildserver) werden geladen */
const IMAGE_HOSTS = new Set(['images.openfoodfacts.org', 'static.openfoodfacts.org']);

const NOT_FOUND: BarcodeSuggestion = {
	found: false,
	name: '',
	brand: '',
	packageSize: '',
	hasImage: false
};

interface Lookup {
	value: BarcodeSuggestion;
	imageUrl: string | null;
}

/** Fetch-Ersatz in Tests (ohne Buns `fetch.preconnect`) */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (...args) => fetch(...args);
const cache = new Map<string, { at: number; lookup: Lookup }>();

/** Ersetzt den Fetch in Tests. */
export function setOffFetchForTests(f: FetchLike | undefined): void {
	fetcher = f ?? ((...args) => fetch(...args));
	cache.clear();
}

interface OffResponse {
	status?: number;
	product?: {
		product_name?: string;
		product_name_de?: string;
		brands?: string;
		quantity?: string;
		image_front_url?: string;
		image_url?: string;
	};
}

const clean = (v: unknown, max: number) =>
	typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Nur https-URLs vom OFF-Bildserver */
export function allowedImageUrl(v: unknown): string | null {
	if (typeof v !== 'string' || v.length > 500) return null;
	try {
		const u = new URL(v);
		if (u.protocol !== 'https:' || !IMAGE_HOSTS.has(u.hostname) || u.port || u.username)
			return null;
		return u.toString();
	} catch {
		return null;
	}
}

async function lookup(barcode: string): Promise<Lookup> {
	const hit = cache.get(barcode);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.lookup;
	let result: Lookup = { value: NOT_FOUND, imageUrl: null };
	try {
		const res = await fetcher(`${BASE}${encodeURIComponent(barcode)}.json?fields=${FIELDS}`, {
			headers: { accept: 'application/json', 'user-agent': USER_AGENT },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (res.ok) {
			const data = (await res.json()) as OffResponse;
			const p = data.status === 1 ? data.product : undefined;
			const name = clean(p?.product_name_de, 150) || clean(p?.product_name, 150);
			const imageUrl = allowedImageUrl(p?.image_front_url) ?? allowedImageUrl(p?.image_url);
			if (name || imageUrl) {
				result = {
					imageUrl,
					value: {
						found: !!name,
						name,
						// „Marke A, Marke B“ → erste Marke
						brand: clean(p?.brands, 150).split(',')[0]!.trim(),
						packageSize: clean(p?.quantity, 150),
						hasImage: !!imageUrl
					}
				};
			}
		}
	} catch {
		return { value: NOT_FOUND, imageUrl: null };
	}
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(barcode, { at: Date.now(), lookup: result });
	return result;
}

/** `barcode` muss bereits normalisiert sein (nur Ziffern) */
export async function lookupBarcode(barcode: string): Promise<BarcodeSuggestion> {
	return (await lookup(barcode)).value;
}

/** Größenbegrenzt lesen; zu groß → `null` */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
	const length = Number(res.headers.get('content-length') ?? '');
	if (Number.isFinite(length) && length > max) return null;
	if (!res.body) {
		const buf = new Uint8Array(await res.arrayBuffer());
		return buf.byteLength > max ? null : buf;
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * Produktbild aus Open Food Facts laden (Bytes, noch unverarbeitet). `null`, wenn OFF kein Bild kennt, der Host nicht
 * erlaubt ist, das Bild zu groß ist oder der Abruf scheitert. Wirft nie.
 */
export async function fetchOffImage(barcode: string): Promise<Uint8Array | null> {
	const { imageUrl } = await lookup(barcode);
	if (!imageUrl) return null;
	try {
		const res = await fetcher(imageUrl, {
			headers: { accept: 'image/*', 'user-agent': USER_AGENT },
			redirect: 'error',
			signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
		});
		const type = res.headers.get('content-type') ?? '';
		if (!res.ok || !type.toLowerCase().startsWith('image/')) return null;
		const bytes = await readLimited(res, MAX_IMAGE_BYTES);
		return bytes && bytes.byteLength > 0 ? bytes : null;
	} catch {
		return null;
	}
}
