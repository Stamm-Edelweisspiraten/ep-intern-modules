import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	principalKeysFor
} from '$lib/sdk/server';
import { requireAccess } from './access';
import { db, fileResponse, rangeFileResponse, removeFiles } from './files';
import {
	downloadName,
	imagePathsOf,
	requireImageRow,
	requireImagesOfGallery,
	toGalleryImage
} from './images.service';
import {
	type BulkResult,
	type GalleryImage,
	idParams,
	imageBulkInput,
	imageParams,
	imageUpdateInput,
	MODULE_ID,
	variantParams
} from './schemas';
import { uploadMedia } from './upload.service';

const tags = ['Modul: galleries'];

export const imagesEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/galleries/:id/images/bulk',
		summary: 'Sammelaktion für Bilder (löschen, nur intern / wieder öffentlich)',
		description:
			'`delete` löscht Bilder samt Dateien. `make-private` markiert Bilder als „nur intern“: Sie ' +
			'erscheinen nie über die Website-API, auch wenn die Galerie öffentlich ist. `make-public` ' +
			'hebt das wieder auf (sichtbar, sobald die Galerie öffentlich ist).',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		body: imageBulkInput,
		handler: async ({ ctx, params, body }): Promise<BulkResult> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			if (body.action !== 'delete') {
				const isPrivate = body.action === 'make-private';
				const count = await db().transaction(async (tx) => {
					await requireAccess(tx, ctx, params.id, keys, 'edit');
					const images = await requireImagesOfGallery(tx, params.id, body.ids);
					await tx.execute(
						sql`UPDATE gallery_images SET is_private = ${isPrivate}
							WHERE gallery_id = ${params.id} AND id IN (${sql.join(
								body.ids.map((id) => sql`${id}`),
								sql`, `
							)})`
					);
					await tx.execute(sql`UPDATE galleries SET updated_at = now() WHERE id = ${params.id}`);
					return images.length;
				});
				await core.audit.logFromContext(ctx, 'galleries.image.bulk_updated', {
					target: params.id,
					metadata: { action: body.action, count }
				});
				return { affected: count };
			}
			// Termine hängen an der Galerie, nicht am Bild
			const removed = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				const images = await requireImagesOfGallery(tx, params.id, body.ids);
				await tx.execute(
					sql`DELETE FROM gallery_images WHERE gallery_id = ${params.id} AND id IN (${sql.join(
						body.ids.map((id) => sql`${id}`),
						sql`, `
					)})`
				);
				await tx.execute(sql`UPDATE galleries SET updated_at = now() WHERE id = ${params.id}`);
				return images;
			});
			await removeFiles(removed.flatMap((i) => Object.values(i.paths)));
			await core.audit.logFromContext(ctx, 'galleries.image.bulk_updated', {
				target: params.id,
				metadata: { action: body.action, count: removed.length }
			});
			return { affected: removed.length };
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/galleries/:id/images',
		summary: 'Bild oder Video hochladen (multipart, Feld "file", optional "description")',
		description:
			'Ein Request je Datei. Bilder: JPEG, PNG, WebP, AVIF, GIF bis 25 MB, Metadaten (EXIF/GPS) werden ' +
			'entfernt. Videos: MP4/M4V, MOV oder WebM bis 100 MB (bzw. `core.storage.maxFileSizeMb`), dazu ' +
			'Pflichtfeld `poster` (Vorschaubild JPEG/PNG/WebP, z. B. ein Einzelbild) und optional ' +
			'`duration` (Sekunden). Videos werden nicht neu kodiert; Metadaten (Ort, Gerät) werden ' +
			'entfernt. Der Dateispeicher muss die Videotypen zulassen (siehe `GET /limits`), sonst 422.',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<GalleryImage> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			return uploadMedia(ctx, params.id, keys, request);
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/galleries/:id/images/:imageId',
		summary: 'Beschreibung eines Bildes ersetzen, optional „nur intern“ setzen',
		description:
			'`isPrivate: true` = Bild nur intern (nie über die Website-API, auch nicht als Titelbild), ' +
			'`false` = mit der Galerie sichtbar; fehlt das Feld, bleibt es unverändert.',
		tags,
		permission: 'galleries.gallery.view',
		params: imageParams,
		body: imageUpdateInput,
		handler: async ({ ctx, params, body }): Promise<GalleryImage> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const row = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				await requireImageRow(tx, params.id, params.imageId);
				await tx.execute(
					sql`UPDATE gallery_images SET description = ${body.description}
						${body.isPrivate === undefined ? sql`` : sql`, is_private = ${body.isPrivate}`}
						WHERE id = ${params.imageId} AND gallery_id = ${params.id}`
				);
				await tx.execute(sql`UPDATE galleries SET updated_at = now() WHERE id = ${params.id}`);
				return requireImageRow(tx, params.id, params.imageId);
			});
			const image = toGalleryImage(row);
			await core.audit.logFromContext(ctx, 'galleries.image.updated', {
				target: params.imageId,
				metadata: { galleryId: params.id, isPrivate: image.isPrivate }
			});
			return image;
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/galleries/:id/images/:imageId',
		summary: 'Bild löschen (inkl. Dateien)',
		tags,
		permission: 'galleries.gallery.view',
		params: imageParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const image = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				const r = imagePathsOf(await requireImageRow(tx, params.id, params.imageId));
				await tx.execute(
					sql`DELETE FROM gallery_images WHERE id = ${params.imageId} AND gallery_id = ${params.id}`
				);
				await tx.execute(sql`UPDATE galleries SET updated_at = now() WHERE id = ${params.id}`);
				return r;
			});
			await removeFiles(Object.values(image.paths));
			await core.audit.logFromContext(ctx, 'galleries.image.deleted', {
				target: params.imageId,
				metadata: { galleryId: params.id }
			});
			return { id: params.imageId, deleted: true };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/galleries/:id/images/:imageId/:variant',
		summary: 'Bild- oder Videodatei abrufen (thumb, web, full, video)',
		description:
			'`full` wird als Download (content-disposition: attachment) ausgeliefert. Bei Videos sind ' +
			'`thumb`/`web` Vorschaubilder, `full` ist der Download und `video` die Datei zum Abspielen ' +
			'(beide beantworten `Range`-Anfragen mit 206); `video` bei einem Bild → 404.',
		tags,
		permission: 'galleries.gallery.view',
		params: variantParams,
		// eigenes Kontingent: eine Galerie lädt Hunderte Vorschaubilder (#23)
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ ctx, params, request }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const image = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'read');
				return imagePathsOf(await requireImageRow(tx, params.id, params.imageId));
			});
			if (params.variant === 'video') {
				if (image.mediaType !== 'video') throw errors.notFound('Kein Video');
				return rangeFileResponse(request, image.paths.full, {
					cache: 'private, max-age=3600',
					contentType: image.contentType,
					name: downloadName(image.originalName, image.paths.full)
				});
			}
			const path = image.paths[params.variant];
			if (params.variant === 'full' && image.mediaType === 'video') {
				return rangeFileResponse(request, path, {
					cache: 'private, max-age=3600',
					contentType: image.contentType,
					attachmentName: downloadName(image.originalName, path)
				});
			}
			return fileResponse(path, {
				cache: 'private, max-age=3600',
				attachmentName:
					params.variant === 'full' ? downloadName(image.originalName, path) : undefined
			});
		}
	})
];
