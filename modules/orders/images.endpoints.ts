/**
 * Artikelbilder: Upload (multipart, Varianten `thumb`/`web` ohne Metadaten), Auslieferung,
 * Löschen, Reihenfolge (erstes Bild = Titelbild). Muster wie `galleries/images.endpoints.ts`.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { canManageArticles, requireArticleRow, toArticleImage } from './articles.service';
import { mdb, rows, type Row } from './db';
import {
	VARIANT_COLUMN,
	VARIANT_SPECS,
	fileResponse,
	filesCtx,
	removeFiles,
	variantPath
} from './files';
import {
	IMAGE_CONTENT_TYPES,
	MAX_IMAGES_PER_ARTICLE,
	MAX_IMAGE_BYTES,
	MODULE_ID,
	PERMISSIONS,
	idParams,
	imageOrderInput,
	imageParams,
	imageVariantParams,
	type ArticleImage,
	type ImageVariant
} from './schemas';

const tags = ['Modul: orders'];
const MAX_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

async function requireImageRow(tx: Tx, articleId: string, imageId: string): Promise<Row> {
	const [row] = await rows(
		tx,
		sql`SELECT id, article_id, width, height, position, thumb_path, web_path
			FROM article_images WHERE id = ${imageId} AND article_id = ${articleId}`
	);
	if (!row) throw errors.notFound('Bild nicht gefunden');
	return row;
}

const touchArticle = (tx: Tx, articleId: string) =>
	tx.execute(sql`UPDATE articles SET updated_at = now() WHERE id = ${articleId}`);

async function imagesOf(tx: Tx, articleId: string): Promise<ArticleImage[]> {
	return (
		await rows(
			tx,
			sql`SELECT id, article_id, width, height, position FROM article_images
				WHERE article_id = ${articleId} ORDER BY position, created_at, id`
		)
	).map(toArticleImage);
}

export const imagesEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'PUT',
		path: '/articles/:id/images/order',
		summary: 'Reihenfolge der Artikelbilder festlegen (erstes Bild = Titelbild)',
		tags,
		permission: PERMISSIONS.articles,
		params: idParams,
		body: imageOrderInput,
		handler: async ({ ctx, params, body }): Promise<ArticleImage[]> => {
			const images = await mdb().transaction(async (tx) => {
				await requireArticleRow(tx, params.id);
				const current = (
					await rows(tx, sql`SELECT id FROM article_images WHERE article_id = ${params.id}`)
				).map((r) => String(r.id));
				const given = new Set(body.ids);
				const valid =
					given.size === body.ids.length &&
					body.ids.length === current.length &&
					current.every((id) => given.has(id));
				if (!valid) {
					throw errors.validation([
						{ path: ['ids'], message: 'Alle Bilder müssen genau einmal enthalten sein' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(
						sql`UPDATE article_images SET position = ${i} WHERE id = ${id} AND article_id = ${params.id}`
					);
				}
				await touchArticle(tx, params.id);
				return imagesOf(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'orders.article.images-reordered', {
				target: params.id,
				metadata: { count: body.ids.length }
			});
			return images;
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/articles/:id/images',
		summary: 'Artikelbild hochladen (multipart, Feld "file")',
		description: `Ein Request je Datei. Erlaubt: JPEG, PNG, WebP, AVIF, GIF bis ${MAX_MB} MB, höchstens ${MAX_IMAGES_PER_ARTICLE} Bilder je Artikel. Metadaten (EXIF/GPS) werden entfernt.`,
		tags,
		permission: PERMISSIONS.articles,
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<ArticleImage> => {
			const articleId = params.id;
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
				throw errors.tooLarge(`Bild überschreitet das Limit von ${MAX_MB} MB`);
			}

			const assertRoom = async (tx: Tx) => {
				await requireArticleRow(tx, articleId);
				const [r] = await rows(
					tx,
					sql`SELECT count(*)::int AS n FROM article_images WHERE article_id = ${articleId}`
				);
				if (Number(r?.n ?? 0) >= MAX_IMAGES_PER_ARTICLE) {
					throw errors.conflict(`Höchstens ${MAX_IMAGES_PER_ARTICLE} Bilder je Artikel`);
				}
			};
			await mdb().transaction(assertRoom);

			const bytes = new Uint8Array(await file.arrayBuffer());
			const processed = await core.images.process(bytes, {
				variants: VARIANT_SPECS,
				maxInputBytes: MAX_IMAGE_BYTES
			});

			const imageId = crypto.randomUUID();
			const paths: Partial<Record<ImageVariant, string>> = {};
			const uploaded: string[] = [];
			try {
				for (const spec of VARIANT_SPECS) {
					const variant = processed.variants.find((v) => v.name === spec.name);
					if (!variant) throw errors.unavailable('Bildverarbeitung unvollständig');
					const name = spec.name as ImageVariant;
					const path = variantPath(articleId, imageId, name, variant.extension);
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

			let row: Row;
			try {
				row = await mdb().transaction(async (tx) => {
					await assertRoom(tx);
					await tx.execute(
						sql`INSERT INTO article_images (id, article_id, position, width, height, thumb_path, web_path, uploaded_by)
							VALUES (${imageId}, ${articleId},
								(SELECT COALESCE(MAX(position), -1) + 1 FROM article_images WHERE article_id = ${articleId}),
								${processed.width}, ${processed.height}, ${paths.thumb!}, ${paths.web!},
								${ctx.userId ?? null})`
					);
					await touchArticle(tx, articleId);
					return requireImageRow(tx, articleId, imageId);
				});
			} catch (e) {
				await removeFiles(uploaded);
				throw e;
			}

			await core.audit.logFromContext(ctx, 'orders.article.image-uploaded', {
				target: articleId,
				metadata: { imageId }
			});
			return toArticleImage(row);
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/articles/:id/images/:imageId',
		summary: 'Artikelbild löschen (inkl. Dateien)',
		tags,
		permission: PERMISSIONS.articles,
		params: imageParams,
		handler: async ({ ctx, params }) => {
			const row = await mdb().transaction(async (tx) => {
				await requireArticleRow(tx, params.id);
				const r = await requireImageRow(tx, params.id, params.imageId);
				await tx.execute(
					sql`DELETE FROM article_images WHERE id = ${params.imageId} AND article_id = ${params.id}`
				);
				await touchArticle(tx, params.id);
				return r;
			});
			await removeFiles([String(row.thumb_path), String(row.web_path)]);
			await core.audit.logFromContext(ctx, 'orders.article.image-deleted', {
				target: params.id,
				metadata: { imageId: params.imageId }
			});
			return { id: params.imageId, deleted: true };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/articles/:id/images/:imageId/:variant',
		summary: 'Artikelbild abrufen (thumb, web)',
		description:
			'Bilder inaktiver oder archivierter Artikel nur mit Artikel- oder Lagerrecht (sonst 404).',
		tags,
		permission: PERMISSIONS.view,
		params: imageVariantParams,
		handler: async ({ ctx, params }) => {
			const manage = canManageArticles(ctx);
			const path = await mdb().transaction(async (tx) => {
				const [article] = await rows(
					tx,
					sql`SELECT active, archived_at FROM articles WHERE id = ${params.id}`
				);
				const visible =
					!!article &&
					(manage ||
						((article.active === true || article.active === 't') && article.archived_at == null));
				if (!visible) throw errors.notFound('Artikel nicht gefunden');
				const row = await requireImageRow(tx, params.id, params.imageId);
				return String(row[VARIANT_COLUMN[params.variant]]);
			});
			return fileResponse(path, { cache: 'private, max-age=3600' });
		}
	}) as unknown as ApiEndpoint // Enum-Parameter (`variant`) passt nicht zu Record<string, string>
] as ApiEndpoint[];
