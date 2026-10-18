import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, principalKeysFor, type ApiEndpoint } from '$lib/sdk/server';
import { requireAccess, rowsOf } from './access';
import { VARIANT_SPECS, db, fileResponse, filesCtx, removeFiles, variantPath } from './files';
import {
	downloadName,
	imagePathsOf,
	requireImageRow,
	requireImagesOfGallery,
	sanitizeOriginalName,
	toGalleryImage
} from './images.service';
import {
	IMAGE_CONTENT_TYPES,
	MAX_IMAGES_PER_GALLERY,
	MAX_IMAGE_BYTES,
	MODULE_ID,
	idParams,
	imageBulkInput,
	imageParams,
	imageUpdateInput,
	uploadFields,
	variantParams,
	type BulkResult,
	type GalleryImage,
	type ImageVariant
} from './schemas';

const tags = ['Modul: galleries'];

export const imagesEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/galleries/:id/images/bulk',
		summary: 'Sammelaktion für Bilder (löschen)',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		body: imageBulkInput,
		handler: async ({ ctx, params, body }): Promise<BulkResult> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			// einzige Aktion: delete (Termine hängen an der Galerie, nicht am Bild)
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
		summary: 'Bild hochladen (multipart, Feld "file", optional "description")',
		description:
			'Ein Request je Datei. Erlaubt: JPEG, PNG, WebP, AVIF, GIF bis 25 MB. Metadaten (EXIF/GPS) werden entfernt.',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<GalleryImage> => {
			const galleryId = params.id;
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) throw errors.badRequest('Feld "file" fehlt');
			const declared = (file.type || '').split(';')[0]!.trim().toLowerCase();
			if (declared && !(IMAGE_CONTENT_TYPES as readonly string[]).includes(declared)) {
				throw errors.badRequest('Dateityp nicht erlaubt (JPEG, PNG, WebP, AVIF oder GIF)');
			}
			if (file.size === 0) throw errors.badRequest('Datei ist leer');
			if (file.size > MAX_IMAGE_BYTES) {
				throw errors.tooLarge('Bild überschreitet das Limit von 25 MB');
			}
			const rawDescription = form.get('description');
			if (rawDescription != null && typeof rawDescription !== 'string') {
				throw errors.badRequest('Feld "description" muss Text sein');
			}
			const fields = uploadFields.parse({ description: rawDescription });

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

			const bytes = new Uint8Array(await file.arrayBuffer());
			const processed = await core.images.process(bytes, {
				variants: VARIANT_SPECS,
				maxInputBytes: MAX_IMAGE_BYTES
			});
			const full = processed.variants.find((v) => v.name === 'full');
			if (!full) throw errors.unavailable('Bildverarbeitung lieferte keine Vollansicht');

			const imageId = crypto.randomUUID();
			const originalName = sanitizeOriginalName(file.name);
			const paths: Partial<Record<ImageVariant, string>> = {};
			const uploaded: string[] = [];
			try {
				for (const spec of VARIANT_SPECS) {
					const variant = processed.variants.find((v) => v.name === spec.name);
					if (!variant) throw errors.unavailable('Bildverarbeitung unvollständig');
					const name = spec.name as ImageVariant;
					const path = variantPath(galleryId, imageId, name, variant.extension);
					await core.storage.upload(filesCtx(), {
						module: MODULE_ID,
						path,
						file: variant.bytes,
						contentType: variant.contentType,
						name: `${imageId}-${spec.name}.${variant.extension}`
					});
					uploaded.push(path);
					paths[name] = path;
				}
			} catch (e) {
				await removeFiles(uploaded);
				throw e;
			}

			let row: Record<string, unknown>;
			try {
				row = await db().transaction(async (tx) => {
					await requireAccess(tx, ctx, galleryId, keys, 'edit');
					await tx.execute(
						sql`INSERT INTO gallery_images (id, gallery_id, description, position, original_name,
								content_type, width, height, size_bytes, thumb_path, web_path, full_path, uploaded_by)
							VALUES (${imageId}, ${galleryId}, ${fields.description},
								(SELECT COALESCE(MAX(position), -1) + 1 FROM gallery_images WHERE gallery_id = ${galleryId}),
								${originalName}, ${full.contentType}, ${processed.width}, ${processed.height},
								${full.bytes.byteLength}, ${paths.thumb!}, ${paths.web!}, ${paths.full!},
								${ctx.userId ?? null})`
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
				metadata: { imageId, count: 1 }
			});
			return toGalleryImage(row);
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/galleries/:id/images/:imageId',
		summary: 'Beschreibung eines Bildes ersetzen',
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
						WHERE id = ${params.imageId} AND gallery_id = ${params.id}`
				);
				await tx.execute(sql`UPDATE galleries SET updated_at = now() WHERE id = ${params.id}`);
				return requireImageRow(tx, params.id, params.imageId);
			});
			const image = toGalleryImage(row);
			await core.audit.logFromContext(ctx, 'galleries.image.updated', {
				target: params.imageId,
				metadata: { galleryId: params.id }
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
		summary: 'Bilddatei abrufen (thumb, web, full)',
		description: '`full` wird als Download (content-disposition: attachment) ausgeliefert.',
		tags,
		permission: 'galleries.gallery.view',
		params: variantParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const image = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'read');
				return imagePathsOf(await requireImageRow(tx, params.id, params.imageId));
			});
			const path = image.paths[params.variant];
			return fileResponse(path, {
				cache: 'private, max-age=3600',
				attachmentName:
					params.variant === 'full' ? downloadName(image.originalName, path) : undefined
			});
		}
	}) as unknown as ApiEndpoint // Enum-Parameter (`variant`) passt nicht zu Record<string, string>
] as ApiEndpoint[];
