/**
 * Gemeinsame Helfer für Bilddateien, Titelbild und Termin-Dienst. Dateien liegen im Core-Storage
 * (Modul `galleries`) und werden NACH der Objektprüfung mit einem System-Kontext gelesen/geschrieben –
 * Mitglieder und der Website-Key brauchen deshalb keine Storage-Rechte.
 * Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { type SQL, sql } from 'drizzle-orm';
import { DEFAULT_ALLOWED_CONTENT_TYPES } from '$lib/sdk/content-types';
import {
	core,
	type ImageVariantSpec,
	moduleDb,
	secureFileResponse,
	type Tx
} from '$lib/sdk/server';
import type { EventRefsService } from '$modules/events/contract';
import {
	type ImageVariant,
	MAX_IMAGE_BYTES,
	MAX_VIDEO_BYTES,
	type MediaVariant,
	MODULE_ID,
	type UploadLimits,
	VIDEO_CONTENT_TYPES,
	type VideoContentTypeName
} from './schemas';

export const db = () => moduleDb(MODULE_ID);
export const filesCtx = () => core.auth.systemContext('galleries-files');

/** Varianten für `core.images.process` (Reihenfolge = `IMAGE_VARIANTS`) */
export const VARIANT_SPECS: ImageVariantSpec[] = [
	{ name: 'thumb', maxEdge: 480, format: 'webp', quality: 75 },
	{ name: 'web', maxEdge: 2048, format: 'webp', quality: 82 },
	{ name: 'full', maxEdge: null, format: 'auto', quality: 90 }
];

/** Vorschaubilder eines Videos (`full` ist dort die Videodatei) */
export const POSTER_SPECS: ImageVariantSpec[] = VARIANT_SPECS.filter((v) => v.name !== 'full');

/** Storage-Pfad einer Variante: `<galleryId>/<imageId>-<variant>.<ext>` */
export function variantPath(
	galleryId: string,
	imageId: string,
	variant: ImageVariant,
	extension: string
): string {
	return `${galleryId}/${imageId}-${variant}.${extension}`;
}

/** Spalte mit dem Storage-Pfad je Variante (`video` = Videodatei in `full_path`) */
export const VARIANT_COLUMN: Record<MediaVariant, string> = {
	thumb: 'thumb_path',
	web: 'web_path',
	full: 'full_path',
	video: 'full_path'
};

/** Storage-Pfad eines Videos: `<galleryId>/<imageId>-video.<ext>` */
export function videoPath(galleryId: string, imageId: string, extension: string): string {
	return `${galleryId}/${imageId}-video.${extension}`;
}

/** Dateiendung je Videotyp */
export const VIDEO_EXTENSION: Record<VideoContentTypeName, string> = {
	'video/mp4': 'mp4',
	'video/quicktime': 'mov',
	'video/webm': 'webm'
};

/** Grenzen für den Upload aus den Speicher-Einstellungen (Videotypen erlaubt? Höchstgröße) */
export async function uploadLimits(): Promise<UploadLimits> {
	const s = await core.settings.getMany([
		'core.storage.maxFileSizeMb',
		'core.storage.allowedContentTypes'
	]);
	const mb = Number(s['core.storage.maxFileSizeMb'] ?? 50);
	const storageMax = (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
	const configured = Array.isArray(s['core.storage.allowedContentTypes'])
		? (s['core.storage.allowedContentTypes'] as unknown[])
				.map((v) => String(v).trim().toLowerCase())
				.filter(Boolean)
		: [];
	const list = configured.length ? configured : [...DEFAULT_ALLOWED_CONTENT_TYPES];
	const allowed = (ct: string) =>
		list.some((a) => (a.endsWith('/*') ? ct.startsWith(a.slice(0, -1)) : a === ct));
	return {
		maxImageBytes: Math.min(MAX_IMAGE_BYTES, storageMax),
		maxVideoBytes: Math.min(MAX_VIDEO_BYTES, storageMax),
		videosAllowed: VIDEO_CONTENT_TYPES.every(allowed)
	};
}

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

/** Byte-Bereich aus einem `Range`-Header (nur ein Bereich) */
export function parseRange(
	header: string | null,
	size: number
): { start: number; end: number } | 'invalid' | null {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	// Mehrere Bereiche oder andere Einheit: ganze Datei (erlaubt nach RFC 9110)
	if (!m) return null;
	const [, a, b] = m;
	if (!a && !b) return 'invalid';
	let start: number;
	let end: number;
	if (!a) {
		// Suffix: die letzten N Byte
		const n = Number(b);
		if (n <= 0) return 'invalid';
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(a);
		end = b ? Math.min(Number(b), size - 1) : size - 1;
	}
	if (!Number.isSafeInteger(start) || start >= size || end < start) return 'invalid';
	return { start, end };
}

/** Stream auf die Bytes `start`…`end` (inklusive) zuschneiden; der Rest wird nicht mehr gelesen */
export function sliceStream(
	src: ReadableStream<Uint8Array>,
	start: number,
	end: number
): ReadableStream<Uint8Array> {
	const reader = src.getReader();
	let pos = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				const chunkStart = pos;
				const chunkEnd = pos + value.byteLength;
				pos = chunkEnd;
				if (chunkEnd <= start) continue;
				const from = Math.max(0, start - chunkStart);
				const to = Math.min(value.byteLength, end + 1 - chunkStart);
				if (to > from) controller.enqueue(value.subarray(from, to));
				if (chunkEnd > end) {
					controller.close();
					void reader.cancel().catch(() => undefined);
				}
				return;
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

/**
 * Wie `fileResponse`, beantwortet aber `Range`-Anfragen mit 206 (Videos: Spulen, Safari verlangt es).
 * Der Bereich wird aus dem gestreamten Objekt geschnitten (Bytes davor werden gelesen und verworfen).
 */
export async function rangeFileResponse(
	request: Request,
	path: string,
	opts: { cache: string; contentType?: string; attachmentName?: string; name?: string }
): Promise<Response> {
	const { stream, file } = await core.storage.downloadStream(filesCtx(), {
		module: MODULE_ID,
		path
	});
	const size = file.size;
	const base = {
		contentType: opts.contentType ?? file.contentType,
		name: opts.attachmentName ?? opts.name ?? path.split('/').pop() ?? 'video',
		download: !!opts.attachmentName,
		cache: opts.cache
	};
	const range = parseRange(request.headers.get('range'), size);
	if (range === 'invalid') {
		await stream.cancel().catch(() => undefined);
		const res = secureFileResponse(new Uint8Array(0), { ...base, size: 0, status: 416 });
		res.headers.set('content-range', `bytes */${size}`);
		res.headers.set('accept-ranges', 'bytes');
		return res;
	}
	if (!range) {
		const res = secureFileResponse(stream, { ...base, size });
		res.headers.set('accept-ranges', 'bytes');
		return res;
	}
	const res = secureFileResponse(sliceStream(stream, range.start, range.end), {
		...base,
		size: range.end - range.start + 1,
		status: 206
	});
	res.headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
	res.headers.set('accept-ranges', 'bytes');
	return res;
}

/**
 * SQL-Ausdruck für das effektive Titelbild einer Galerie (Alias `g`): gesetztes Titelbild,
 * sonst das älteste Bild (`created_at`, `id`). Liefert die Bild-ID oder NULL.
 */
export const effectiveCoverSql: SQL = sql`COALESCE(g.cover_image_id, (
	SELECT i.id FROM gallery_images i WHERE i.gallery_id = g.id ORDER BY i.created_at, i.id LIMIT 1
))`;

/**
 * Titelbild für die Website (Alias `g`): wie `effectiveCoverSql`, aber nur Bilder ohne „nur intern“ –
 * ist das gesetzte Titelbild privat, gilt das älteste nicht private Bild.
 */
export const websiteCoverSql: SQL = sql`COALESCE(
	(SELECT i.id FROM gallery_images i WHERE i.id = g.cover_image_id AND NOT i.is_private),
	(SELECT i.id FROM gallery_images i WHERE i.gallery_id = g.id AND NOT i.is_private
		ORDER BY i.created_at, i.id LIMIT 1)
)`;

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
