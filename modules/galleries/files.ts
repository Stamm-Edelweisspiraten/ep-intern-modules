/**
 * Gemeinsame Helfer für Bilddateien, Titelbild und Termin-Dienst. Dateien liegen im Core-Storage
 * (Modul `galleries`) und werden NACH der Objektprüfung mit einem System-Kontext gelesen/geschrieben –
 * Mitglieder und der Website-Key brauchen deshalb keine Storage-Rechte.
 * Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	moduleDb,
	secureFileResponse,
	type ImageVariantSpec,
	type Tx
} from '$lib/sdk/server';
import type { EventRefsService } from '$modules/events/contract';
import { MODULE_ID, type ImageVariant } from './schemas';

export const db = () => moduleDb(MODULE_ID);
export const filesCtx = () => core.auth.systemContext('galleries-files');

/** Varianten für `core.images.process` (Reihenfolge = `IMAGE_VARIANTS`) */
export const VARIANT_SPECS: ImageVariantSpec[] = [
	{ name: 'thumb', maxEdge: 480, format: 'webp', quality: 75 },
	{ name: 'web', maxEdge: 2048, format: 'webp', quality: 82 },
	{ name: 'full', maxEdge: null, format: 'auto', quality: 90 }
];

/** Storage-Pfad einer Variante: `<galleryId>/<imageId>-<variant>.<ext>` */
export function variantPath(
	galleryId: string,
	imageId: string,
	variant: ImageVariant,
	extension: string
): string {
	return `${galleryId}/${imageId}-${variant}.${extension}`;
}

/** Spalte mit dem Storage-Pfad je Variante */
export const VARIANT_COLUMN: Record<ImageVariant, string> = {
	thumb: 'thumb_path',
	web: 'web_path',
	full: 'full_path'
};

/**
 * Dateien best-effort entfernen (Fehler werden ignoriert). Sammel-Löschung über
 * `core.storage.removeMany` (S3 DeleteObjects, ein Audit-Eintrag) – auch bei 2 000 Bildern × 3 Varianten.
 */
export async function removeFiles(paths: readonly (string | null | undefined)[]): Promise<void> {
	const list = paths.filter((p): p is string => !!p);
	if (!list.length) return;
	await core.storage
		.removeMany(filesCtx(), { module: MODULE_ID, paths: list })
		.catch(() => undefined);
}

/** Datei als rohe Response (Download/Anzeige), gestreamt statt komplett im Speicher */
export async function fileResponse(
	path: string,
	opts: { cache: string; attachmentName?: string }
): Promise<Response> {
	const { stream, file } = await core.storage.downloadStream(filesCtx(), {
		module: MODULE_ID,
		path
	});
	// Gemeinsame gehärtete Antwort (CSP-Sandbox, nosniff, RFC-5987-Name; #67, 01b-11)
	return secureFileResponse(stream, {
		contentType: file.contentType,
		size: file.size,
		name: opts.attachmentName ?? path.split('/').pop() ?? 'bild',
		download: !!opts.attachmentName,
		cache: opts.cache
	});
}

/**
 * SQL-Ausdruck für das effektive Titelbild einer Galerie (Alias `g`): gesetztes Titelbild,
 * sonst das älteste Bild (`created_at`, `id`). Liefert die Bild-ID oder NULL.
 */
export const effectiveCoverSql: SQL = sql`COALESCE(g.cover_image_id, (
	SELECT i.id FROM gallery_images i WHERE i.gallery_id = g.id ORDER BY i.created_at, i.id LIMIT 1
))`;

/** Effektives Titelbild einer Galerie (in der Transaktion) */
export async function effectiveCover(
	tx: Tx,
	galleryId: string
): Promise<{ imageId: string; width: number; height: number; isDefault: boolean } | null> {
	const res = (await tx.execute(
		sql`SELECT i.id, i.width, i.height, (g.cover_image_id IS NULL) AS is_default
			FROM galleries g JOIN gallery_images i ON i.id = ${effectiveCoverSql}
			WHERE g.id = ${galleryId}`
	)) as unknown as { rows: Record<string, unknown>[] };
	const r = res.rows[0];
	if (!r) return null;
	return {
		imageId: String(r.id),
		width: Number(r.width),
		height: Number(r.height),
		isDefault: r.is_default === true || r.is_default === 't'
	};
}

/** Termin-Dienst aus `events` oder `null`, wenn `events` nicht aktiv ist */
export function eventsService(): Promise<EventRefsService | null> {
	return core.modules.useOptional<EventRefsService>('events', MODULE_ID);
}
