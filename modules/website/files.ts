/**
 * Bilddateien der Beiträge. Dateien liegen im Core-Storage (Modul `website`) und werden NACH der Objektprüfung
 * mit einem System-Kontext gelesen/geschrieben – Autor*innen und der Website-Key brauchen deshalb keine
 * Storage-Rechte. Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { core, moduleDb, secureFileResponse, type ImageVariantSpec } from '$lib/sdk/server';
import { MODULE_ID, type ImageVariant } from './schemas';

export const db = () => moduleDb(MODULE_ID);
export const filesCtx = () => core.auth.systemContext('website-files');

/** Varianten für `core.images.process` (Metadaten/GPS entfernt) */
export const VARIANT_SPECS: ImageVariantSpec[] = [
	{ name: 'thumb', maxEdge: 640, format: 'webp', quality: 76 },
	{ name: 'web', maxEdge: 1600, format: 'webp', quality: 82 }
];

/** Storage-Pfad einer Variante: `posts/<postId>/<imageId>-<variant>.<ext>` */
export function variantPath(
	postId: string,
	imageId: string,
	variant: ImageVariant,
	extension: string
): string {
	return `posts/${postId}/${imageId}-${variant}.${extension}`;
}

/** Dateien best-effort entfernen (Fehler werden ignoriert) */
export async function removeFiles(paths: readonly (string | null | undefined)[]): Promise<void> {
	const list = paths.filter((p): p is string => !!p);
	if (!list.length) return;
	await core.storage
		.removeMany(filesCtx(), { module: MODULE_ID, paths: list })
		.catch(() => undefined);
}

/** Bild als rohe Response (gestreamt) */
export async function fileResponse(path: string, cache: string): Promise<Response> {
	const { stream, file } = await core.storage.downloadStream(filesCtx(), {
		module: MODULE_ID,
		path
	});
	return secureFileResponse(stream, {
		contentType: file.contentType,
		size: file.size,
		name: path.split('/').pop() ?? 'bild',
		download: false,
		cache
	});
}
