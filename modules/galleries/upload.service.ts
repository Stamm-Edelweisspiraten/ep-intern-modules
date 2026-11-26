/**
 * Upload eines Bildes oder Videos (`POST /galleries/:id/images`).
 * - Bild: `core.images` erzeugt `thumb`/`web`/`full` ohne Metadaten.
 * - Video (MP4/MOV/WebM): Typ per Magic Bytes, Metadaten entfernt (`video.ts`), keine Neukodierung;
 *   Pflichtfeld `poster` (Vorschaubild aus dem Browser) → `thumb`/`web`; `full_path` = Videodatei.
 * Core-Aufrufe (Storage, Audit, Einstellungen) außerhalb der Modul-Transaktionen (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	type RequestContext,
	readFormData,
	rowsOf,
	takeUpload,
	type UploadedFile
} from '$lib/sdk/server';
import { requireAccess } from './access';
import {
	db,
	filesCtx,
	POSTER_SPECS,
	removeFiles,
	uploadLimits,
	VARIANT_SPECS,
	VIDEO_EXTENSION,
	variantPath,
	videoPath
} from './files';
import { requireImageRow, sanitizeOriginalName, toGalleryImage } from './images.service';
import {
	type GalleryImage,
	IMAGE_CONTENT_TYPES,
	type ImageVariant,
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_GALLERY,
	type MediaType,
	MODULE_ID,
	uploadFields,
	videoTypeOf
} from './schemas';
import { sniffVideoType, stripVideoMetadata, type VideoContentType } from './video';

/** Vorschaubild eines Videos (vom Browser erzeugt) */
const POSTER_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const VIDEOS_NOT_ALLOWED =
	'Der Dateispeicher lässt keine Videos zu. Bitte in den Einstellungen (Speicher → erlaubte ' +
	'Dateitypen) video/mp4, video/quicktime und video/webm freigeben.';

/** Textfeld aus Formulardaten (`undefined` = fehlt; Datei statt Text → 400) */
function textField(form: FormData, name: string): string | undefined {
	const v = form.get(name);
	if (v == null) return undefined;
	if (typeof v !== 'string') throw errors.badRequest(`Feld "${name}" muss Text sein`);
	return v;
}

interface StoreFile {
	path: string;
	bytes: Uint8Array;
	contentType: string;
	name: string;
}

interface VideoUpload {
	bytes: Uint8Array;
	contentType: VideoContentType;
	name: string;
	poster: UploadedFile;
}

/** Video + Vorschaubild aus den Formulardaten prüfen (vor der Rechteprüfung, ohne Verarbeitung) */
async function takeVideo(form: FormData): Promise<VideoUpload> {
	const limits = await uploadLimits();
	if (!limits.videosAllowed) {
		throw errors.validation([{ path: ['file'], message: VIDEOS_NOT_ALLOWED }]);
	}
	const file = await takeUpload(form, {
		maxBytes: limits.maxVideoBytes,
		sniff: false,
		fallbackName: 'video'
	});
	const contentType = sniffVideoType(file.bytes.subarray(0, 64));
	if (!contentType) {
		throw errors.validation([
			{ path: ['file'], message: 'Kein unterstütztes Video (MP4, MOV oder WebM)' }
		]);
	}
	const poster = await takeUpload(form, {
		field: 'poster',
		maxBytes: MAX_IMAGE_BYTES,
		allowedTypes: POSTER_CONTENT_TYPES,
		typesLabel: 'JPEG, PNG oder WebP',
		detectMissingType: true,
		sniff: false
	});
	return { bytes: file.bytes, contentType, name: file.name, poster };
}

export async function uploadMedia(
	ctx: RequestContext,
	galleryId: string,
	keys: readonly string[],
	request: Request
): Promise<GalleryImage> {
	const form = await readFormData(request);
	const entry = form.get('file');
	const isVideo = entry instanceof File && videoTypeOf(entry) !== null;
	const fields = uploadFields.parse({
		description: textField(form, 'description'),
		duration: isVideo ? textField(form, 'duration') : undefined
	});

	// Typ/leer/fehlend → 422, Größe → 413 (#33); den Inhalt prüfen core.images bzw. sniffVideoType
	const video = isVideo ? await takeVideo(form) : null;
	const image = video
		? null
		: await takeUpload(form, {
				maxBytes: MAX_IMAGE_BYTES,
				allowedTypes: IMAGE_CONTENT_TYPES,
				typesLabel: 'JPEG, PNG, WebP, AVIF oder GIF',
				detectMissingType: true,
				sniff: false
			});

	await db().transaction(async (tx) => {
		await requireAccess(tx, ctx, galleryId, keys, 'edit');
		const [r] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM gallery_images WHERE gallery_id = ${galleryId}`
		);
		if (Number(r?.n ?? 0) >= MAX_IMAGES_PER_GALLERY) {
			throw errors.conflict(`Höchstens ${MAX_IMAGES_PER_GALLERY} Bilder je Galerie`);
		}
	});

	const imageId = crypto.randomUUID();
	const specs = video ? POSTER_SPECS : VARIANT_SPECS;
	// Bilder: alle Varianten; Videos: nur Vorschaubilder, `full` ist die Videodatei
	const processed = await core.images.process((video ? video.poster : image!).bytes, {
		variants: specs,
		maxInputBytes: MAX_IMAGE_BYTES
	});
	const toStore: StoreFile[] = [];
	const paths: Partial<Record<ImageVariant, string>> = {};
	for (const spec of specs) {
		const variant = processed.variants.find((v) => v.name === spec.name);
		if (!variant) throw errors.unavailable('Bildverarbeitung unvollständig');
		const name = spec.name as ImageVariant;
		const path = variantPath(galleryId, imageId, name, variant.extension);
		toStore.push({
			path,
			bytes: variant.bytes,
			contentType: variant.contentType,
			name: `${imageId}-${spec.name}.${variant.extension}`
		});
		paths[name] = path;
	}
	let stored: { contentType: string; size: number };
	if (video) {
		const ext = VIDEO_EXTENSION[video.contentType];
		const path = videoPath(galleryId, imageId, ext);
		const clean = stripVideoMetadata(video.bytes, video.contentType).bytes;
		toStore.push({
			path,
			bytes: clean,
			contentType: video.contentType,
			name: `${imageId}-video.${ext}`
		});
		paths.full = path;
		stored = { contentType: video.contentType, size: clean.byteLength };
	} else {
		const full = processed.variants.find((v) => v.name === 'full');
		if (!full) throw errors.unavailable('Bildverarbeitung lieferte keine Vollansicht');
		stored = { contentType: full.contentType, size: full.bytes.byteLength };
	}

	const uploaded: string[] = [];
	try {
		for (const f of toStore) {
			await core.storage.upload(filesCtx(), {
				module: MODULE_ID,
				path: f.path,
				file: f.bytes,
				contentType: f.contentType,
				name: f.name
			});
			uploaded.push(f.path);
		}
	} catch (e) {
		await removeFiles(uploaded);
		throw e;
	}

	const mediaType: MediaType = video ? 'video' : 'image';
	const originalName = sanitizeOriginalName((video ?? image)!.name, video ? 'video' : 'bild');
	const duration = video ? fields.duration : null;
	let row: Record<string, unknown>;
	try {
		row = await db().transaction(async (tx) => {
			await requireAccess(tx, ctx, galleryId, keys, 'edit');
			// MAX(position) nur unter Sperre je Galerie (parallele Uploads, #73)
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${'galleries:images:' + galleryId}))`
			);
			await tx.execute(
				sql`INSERT INTO gallery_images (id, gallery_id, description, position, original_name,
						content_type, width, height, size_bytes, thumb_path, web_path, full_path, uploaded_by,
						media_type, duration_seconds)
					VALUES (${imageId}, ${galleryId}, ${fields.description},
						(SELECT COALESCE(MAX(position), -1) + 1 FROM gallery_images WHERE gallery_id = ${galleryId}),
						${originalName}, ${stored.contentType}, ${processed.width}, ${processed.height},
						${stored.size}, ${paths.thumb!}, ${paths.web!}, ${paths.full!},
						${ctx.userId ?? null}, ${mediaType}, ${duration})`
			);
			await tx.execute(sql`UPDATE galleries SET updated_at = now() WHERE id = ${galleryId}`);
			return requireImageRow(tx, galleryId, imageId);
		});
	} catch (e) {
		await removeFiles(uploaded);
		throw e;
	}

	await core.audit.logFromContext(ctx, 'galleries.image.uploaded', {
		target: galleryId,
		metadata: { imageId, count: 1, mediaType }
	});
	return toGalleryImage(row);
}
