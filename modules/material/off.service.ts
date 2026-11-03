/**
 * Vorschlag für unbekannte Lebensmittel-Barcodes aus Open Food Facts (freie Datenbank). Es geht nur der
 * Barcode hinaus. Wirft nie; ohne Treffer, bei Fehlern oder Zeitüberschreitung `found: false`.
 */
import type { BarcodeSuggestion } from './schemas';

const BASE = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'product_name,product_name_de,brands,quantity';
const TIMEOUT_MS = 4000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

const NOT_FOUND: BarcodeSuggestion = { found: false, name: '', brand: '', packageSize: '' };

let fetcher: typeof fetch = (...args) => fetch(...args);
const cache = new Map<string, { at: number; value: BarcodeSuggestion }>();

/** Ersetzt den Fetch in Tests. */
export function setOffFetchForTests(f: typeof fetch | undefined): void {
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
	};
}

const clean = (v: unknown, max: number) =>
	typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** `barcode` muss bereits normalisiert sein (nur Ziffern) */
export async function lookupBarcode(barcode: string): Promise<BarcodeSuggestion> {
	const hit = cache.get(barcode);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
	let value = NOT_FOUND;
	try {
		const res = await fetcher(`${BASE}${encodeURIComponent(barcode)}.json?fields=${FIELDS}`, {
			headers: { accept: 'application/json', 'user-agent': 'EP-Intern/1.0 (Materialverwaltung)' },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (res.ok) {
			const data = (await res.json()) as OffResponse;
			const p = data.status === 1 ? data.product : undefined;
			const name = clean(p?.product_name_de, 150) || clean(p?.product_name, 150);
			if (name) {
				value = {
					found: true,
					name,
					// „Marke A, Marke B“ → erste Marke
					brand: clean(p?.brands, 150).split(',')[0]!.trim(),
					packageSize: clean(p?.quantity, 150)
				};
			}
		}
	} catch {
		return NOT_FOUND;
	}
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(barcode, { at: Date.now(), value });
	return value;
}
