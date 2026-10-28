/**
 * Bilddateien der Typen und Lagerartikel im Core-Storage (Modul `material`). Gelesen/geschrieben wird NACH der
 * Rechteprüfung mit einem System-Kontext – Mitglieder brauchen keine Storage-Rechte.
 * Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { core, secureFileResponse, type ImageVariantSpec } from '$lib/sdk/server';
import { MODULE_ID, type ImageOwner, type ImageVariant } from './schemas';

export const filesCtx = () => core.auth.systemContext('material-files');

/** Varianten für `core.images.process` (Reihenfolge = `IMAGE_VARIANTS`) */
export const VARIANT_SPECS: ImageVariantSpec[] = [
	{ name: 'thumb', maxEdge: 480, format: 'webp', quality: 75 },
	{ name: 'web', maxEdge: 1600, format: 'webp', quality: 82 }
];

/** Storage-Pfad einer Variante: `<owner>/<ownerId>/<imageId>-<variant>.<ext>` */
export function variantPath(
	owner: ImageOwner,
	ownerId: string,
	imageId: string,
	variant: ImageVariant,
	extension: string
): string {
	return `${owner}/${ownerId}/${imageId}-${variant}.${extension}`;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bilddateien des alten Bestands (v1: `<articleId>/<imageId>-<variant>.<ext>`) löschen. Neue Bilder liegen
 * unter `types/…` bzw. `items/…` und bleiben unberührt. Liefert die Zahl gelöschter Dateien.
 */
export async function removeLegacyImages(): Promise<number> {
	const ctx = filesCtx();
	const root = await core.storage.list(ctx, { module: MODULE_ID });
	const paths = root.files.map((f) => f.path);
	for (const folder of root.folders.filter((f) => UUID_RE.test(f))) {
		const inner = await core.storage.list(ctx, { module: MODULE_ID, prefix: folder });
		paths.push(...inner.files.map((f) => f.path));
	}
	if (!paths.length) return 0;
	const result = await core.storage.removeMany(ctx, { module: MODULE_ID, paths });
	return result.removed;
}
