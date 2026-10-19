/**
 * Bilddateien der Artikel im Core-Storage (Modul `orders`). Gelesen/geschrieben wird NACH der
 * Rechteprüfung mit einem System-Kontext – Mitglieder brauchen keine Storage-Rechte.
 * Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { core, type ImageVariantSpec } from '$lib/sdk/server';
import { MODULE_ID, type ImageVariant } from './schemas';

export const filesCtx = () => core.auth.systemContext('orders-files');

/** Varianten für `core.images.process` (Reihenfolge = `IMAGE_VARIANTS`) */
export const VARIANT_SPECS: ImageVariantSpec[] = [
	{ name: 'thumb', maxEdge: 480, format: 'webp', quality: 75 },
	{ name: 'web', maxEdge: 1600, format: 'webp', quality: 82 }
];

/** Storage-Pfad einer Variante: `<articleId>/<imageId>-<variant>.<ext>` */
export function variantPath(
	articleId: string,
	imageId: string,
	variant: ImageVariant,
	extension: string
): string {
	return `${articleId}/${imageId}-${variant}.${extension}`;
}

/** Spalte mit dem Storage-Pfad je Variante */
export const VARIANT_COLUMN: Record<ImageVariant, 'thumb_path' | 'web_path'> = {
	thumb: 'thumb_path',
	web: 'web_path'
};

/** Dateien best-effort entfernen (Fehler werden ignoriert) */
export async function removeFiles(paths: readonly (string | null | undefined)[]): Promise<void> {
	const ctx = filesCtx();
	for (const path of paths) {
		if (!path) continue;
		await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
	}
}

/** Datei als rohe Response (Anzeige im Browser) */
export async function fileResponse(path: string, opts: { cache: string }): Promise<Response> {
	const { buffer, file } = await core.storage.download(filesCtx(), { module: MODULE_ID, path });
	return new Response(buffer as BodyInit, {
		status: 200,
		headers: {
			'content-type': file.contentType,
			'content-length': String(buffer.byteLength),
			'cache-control': opts.cache,
			'x-content-type-options': 'nosniff',
			'content-disposition': 'inline'
		}
	});
}
