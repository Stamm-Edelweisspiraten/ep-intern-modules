/**
 * Gruppenbilder: Verarbeitung über `core.images.process` (Inhalt prüfen, nach EXIF drehen, alle
 * Metadaten inkl. GPS entfernen, als WebP neu kodieren) und Nachverarbeitung des Bestands (#19).
 * Gruppenbilder erscheinen auf der öffentlichen Stammeswebsite und zeigen oft Kinder – gespeichert
 * und ausgeliefert wird deshalb nur die bereinigte Variante, nie das Original.
 * Core-Aufrufe (Storage, Bilder) nur AUSSERHALB offener Modul-Transaktionen (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	type ImageVariantSpec,
	isCoreError,
	moduleDb,
	type RequestContext,
	resultRows
} from '$lib/sdk/server';
import { MAX_GROUP_IMAGE_BYTES } from './schemas';

const MODULE = 'members';

/** Einzige gespeicherte Variante: lange Kante 1600 px, WebP */
export const GROUP_IMAGE_VARIANT: ImageVariantSpec = {
	name: 'web',
	maxEdge: 1600,
	format: 'webp',
	quality: 82
};

/** Erkanntes Format → erlaubter, angegebener Content-Type */
const FORMAT_CONTENT_TYPES: Record<string, string> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp'
};

/** Pfad eines bereinigten Gruppenbilds; ältere (unbereinigte) Bilder heißen `…/image-<uuid>-<name>` */
export function processedGroupImagePath(groupId: string): string {
	return `groups/${groupId}/img-${crypto.randomUUID()}.webp`;
}

/** SQL-Regex für Pfade bereinigter Bilder (Gegenstück zu `processedGroupImagePath`) */
const PROCESSED_PATH_RE = '^groups/[^/]+/img-[0-9a-f-]+\\.webp$';

export function isProcessedGroupImagePath(path: string): boolean {
	return new RegExp(PROCESSED_PATH_RE).test(path);
}

/**
 * Verarbeitet ein hochgeladenes Gruppenbild. Der Inhalt muss JPEG, PNG oder WebP sein und zum
 * angegebenen Typ passen (sonst 400). Ergebnis: metadatenfreie WebP-Bytes.
 */
export async function processGroupImage(
	bytes: Uint8Array,
	declaredContentType?: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
	const processed = await core.images.process(bytes, {
		variants: [GROUP_IMAGE_VARIANT],
		maxInputBytes: Math.max(MAX_GROUP_IMAGE_BYTES, bytes.byteLength)
	});
	const expected = FORMAT_CONTENT_TYPES[processed.format];
	if (!expected || (declaredContentType && expected !== declaredContentType)) {
		throw errors.badRequest('Dateiinhalt passt nicht zum Dateityp (JPEG, PNG oder WebP)');
	}
	const variant = processed.variants[0];
	if (!variant) throw errors.badRequest('Bild konnte nicht verarbeitet werden');
	return { bytes: variant.bytes, contentType: variant.contentType };
}

/** Höchstens so viele Bilder je Joblauf (der Rest folgt im nächsten Lauf) */
const REPROCESS_BATCH = 100;

/**
 * Job `members.reprocess-group-images` (stündlich, idempotent): vorhandene, noch unbereinigte
 * Gruppenbilder herunterladen, über `core.images.process` bereinigen, als WebP unter neuem Pfad
 * speichern, Verweis umstellen (nur wenn er sich inzwischen nicht geändert hat) und das Original
 * löschen. Fehlt die Datei im Speicher, wird der Verweis entfernt; nicht lesbare Bilder bleiben
 * unverändert und werden gemeldet. Ohne Bestand kostet ein Lauf eine Abfrage.
 */
export async function reprocessGroupImages(ctx: RequestContext): Promise<string> {
	const rows = await moduleDb(MODULE).transaction(async (tx) =>
		resultRows(
			await tx.execute(
				sql`SELECT id, image_path FROM groups
					WHERE image_path IS NOT NULL AND image_path !~ ${PROCESSED_PATH_RE}
					ORDER BY id LIMIT ${REPROCESS_BATCH}`
			)
		)
	);
	if (!rows.length) return 'Alle Gruppenbilder sind bereinigt';

	let done = 0;
	let cleared = 0;
	let failed = 0;
	for (const r of rows) {
		const groupId = String(r.id);
		const oldPath = String(r.image_path);
		let original: Uint8Array;
		try {
			original = (await core.storage.download(ctx, { module: MODULE, path: oldPath })).buffer;
		} catch (e) {
			if (isCoreError(e) && e.code === 'not_found') {
				await moduleDb(MODULE).transaction((tx) =>
					tx.execute(
						sql`UPDATE groups SET image_path = NULL, image_name = NULL, updated_at = now()
							WHERE id = ${groupId} AND image_path = ${oldPath}`
					)
				);
				cleared++;
				continue;
			}
			// Speicher nicht erreichbar/konfiguriert → später erneut versuchen
			throw e;
		}
		let clean: { bytes: Uint8Array; contentType: string };
		try {
			clean = await processGroupImage(original);
		} catch {
			failed++;
			continue;
		}
		const newPath = processedGroupImagePath(groupId);
		await core.storage.upload(ctx, {
			module: MODULE,
			path: newPath,
			file: clean.bytes,
			contentType: clean.contentType,
			name: 'gruppenbild.webp'
		});
		const updated = await moduleDb(MODULE).transaction(async (tx) =>
			resultRows(
				await tx.execute(
					sql`UPDATE groups SET image_path = ${newPath}, updated_at = now()
						WHERE id = ${groupId} AND image_path = ${oldPath} RETURNING id`
				)
			)
		);
		if (updated.length) {
			await core.storage.remove(ctx, { module: MODULE, path: oldPath }).catch(() => undefined);
			done++;
		} else {
			// Inzwischen neues Bild hochgeladen oder Gruppe gelöscht → eigene Kopie verwerfen
			await core.storage.remove(ctx, { module: MODULE, path: newPath }).catch(() => undefined);
		}
	}
	if (done || cleared || failed) {
		await core.audit.logFromContext(ctx, 'members.group.image.reprocessed', {
			metadata: { count: done, cleared, failed }
		});
	}
	const parts = [`${done} Gruppenbild(er) bereinigt`];
	if (cleared) parts.push(`${cleared} fehlende Datei(en) entfernt`);
	if (failed) parts.push(`${failed} nicht lesbar (unverändert)`);
	return parts.join(', ');
}
