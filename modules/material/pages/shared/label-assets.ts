/**
 * Große Etiketten-Bausteine (Barcode-Bibliothek, Logos) nur bei Bedarf laden und Barcodes zwischenspeichern.
 */
import type { BarcodeType, LabelLogo } from '$lib/sdk/labels';

type BarcodeModule = typeof import('$lib/sdk/labels/barcode');

let barcodeModule: Promise<BarcodeModule> | null = null;
let logos: Promise<Record<LabelLogo, string>> | null = null;
const cache = new Map<string, string | null>();

export function loadBarcodes(): Promise<BarcodeModule> {
	barcodeModule ??= import('$lib/sdk/labels/barcode');
	return barcodeModule;
}

export function loadLogos(): Promise<Record<LabelLogo, string>> {
	logos ??= import('$lib/sdk/labels/logos').then((m) => m.LABEL_LOGO_DATA);
	return logos;
}

/** Barcode als `data:`-URL (ungültiger Inhalt → `null`), zwischengespeichert */
export async function barcodeUrl(type: BarcodeType, value: string): Promise<string | null> {
	const key = `${type}\n${value}`;
	if (cache.has(key)) return cache.get(key)!;
	const mod = await loadBarcodes();
	const url = mod.barcodeDataUrl(type, value);
	if (cache.size > 500) cache.clear();
	cache.set(key, url);
	return url;
}
