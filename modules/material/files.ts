/**
 * Bilddateien der Artikel im Core-Storage (Modul `material`). Gelesen/geschrieben wird NACH der
 * Rechteprüfung mit einem System-Kontext – Mitglieder brauchen keine Storage-Rechte.
 * Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { core, secureFileResponse, type ImageVariantSpec } from '$lib/sdk/server';
import { MODULE_ID, type ImageVariant } from './schemas';

export const filesCtx = () => core.auth.systemContext('material-files');

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

/** Dateien best-effort entfernen (Fehler werden ignoriert); Sammel-Löschung, ein Audit-Eintrag */
export async function removeFiles(paths: readonly (string | null | undefined)[]): Promise<void> {
	const list = paths.filter((p): p is string => !!p);
	if (!list.length) return;
	await core.storage
		.removeMany(filesCtx(), { module: MODULE_ID, paths: list })
		.catch(() => undefined);
}

/** Datei als rohe Response (Anzeige im Browser), gestreamt */
export async function fileResponse(path: string, opts: { cache: string }): Promise<Response> {
	const { stream, file } = await core.storage.downloadStream(filesCtx(), {
		module: MODULE_ID,
		path
	});
	// Gemeinsame gehärtete Antwort (CSP-Sandbox, nosniff, RFC-5987-Name; #67, 01b-11)
	return secureFileResponse(stream, {
		contentType: file.contentType,
		size: file.size,
		name: path.split('/').pop() ?? 'bild',
		cache: opts.cache
	});
}
