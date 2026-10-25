/**
 * Blog-Beiträge im Intern-Bereich. Basisrecht `website.post.write` (Router); Objektzugriff über `access.ts`:
 * Autor*in und `edit`-Freigaben („Mitschreiben“) bearbeiten, `website.post.publish` sieht/bearbeitet alle und
 * veröffentlicht, zieht zurück und löscht. Fremde Beiträge → 404. Core-Dienste nie in der Transaktion.
 */
import { notifyPostInvited, notifyPostStatus } from './notify';
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	principalKeysFor,
	readFormData,
	requireShareCapability,
	richTextImageIds,
	rowsOf,
	sanitizeRichText,
	searchPrincipals,
	takeUpload,
	validatePrincipals,
	type AnyApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import {
	accessForMany,
	canPublish,
	loadShares,
	replaceShares,
	requireAccess,
	visiblePostsFilter
} from './access';
import { VARIANT_SPECS, db, fileResponse, filesCtx, removeFiles, variantPath } from './files';
import {
	EVERYONE_LABEL,
	SHARE_TYPES,
	buildDetail,
	buildList,
	eventsService,
	galleriesService,
	imagesFor,
	listGroups,
	loadPostData,
	loadPostRow,
	replaceGroups,
	replaceTags,
	slugTaken,
	tagsFor,
	toImage,
	toListItem,
	uniqueSlug
} from './posts.service';
import {
	IMAGE_CONTENT_TYPES,
	MAX_IMAGE_BYTES,
	MAX_POST_IMAGES,
	MODULE_ID,
	PERM,
	idParams,
	imageParams,
	imageUpdateInput,
	postCreateInput,
	postListQuery,
	postUpdateInput,
	principalSearchQuery,
	publishInput,
	refSearchQuery,
	sharesInput,
	type ImageVariant,
	type PostDetail,
	type PostImage,
	type PostListPage,
	type RefOption
} from './schemas';

const tags = ['Modul: website'];
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function detailOf(ctx: RequestContext, tx: Tx, id: string, keys: readonly string[]) {
	const access = await requireAccess(tx, ctx, id, keys, 'read');
	const row = (await loadPostRow(tx, id))!;
	return loadPostData(tx, row, access, loadShares);
}

function requirePublisher(ctx: RequestContext) {
	if (!canPublish(ctx)) {
		throw errors.forbidden('Veröffentlichen, Zurückziehen und Löschen braucht das Recht „Beiträge veröffentlichen“');
	}
}

export const postsEndpoints: AnyApiEndpoint[] = [
	// --- Hilfen -----------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/tags',
		summary: 'Vorhandene Themen der Beiträge (mit Anzahl)',
		tags,
		permission: PERM.postWrite,
		handler: async () => {
			const rows = await db().transaction((tx) =>
				rowsOf(
					tx,
					sql`SELECT min(tag) AS tag, count(*)::int AS n FROM post_tags
						GROUP BY lower(tag) ORDER BY count(*) DESC, min(tag) LIMIT 200`
				)
			);
			return rows.map((r) => ({ tag: String(r.tag), count: Number(r.n) }));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/refs/groups',
		summary: 'Gruppen für die Verknüpfung (aus „Mitglieder & Gruppen“)',
		tags,
		permission: PERM.postWrite,
		handler: async (): Promise<RefOption[]> =>
			(await listGroups()).map((g) => ({ id: g.id, label: g.name, detail: null, color: g.color }))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/refs/events',
		summary: 'Termine für die Verknüpfung suchen (nur für den Aufrufer sichtbare)',
		tags,
		permission: PERM.postWrite,
		query: refSearchQuery,
		handler: async ({ ctx, query }): Promise<RefOption[]> => {
			const service = await eventsService();
			if (!service) return [];
			const refs = await service.searchEventRefs(ctx, {
				search: query.search || undefined,
				limit: query.limit
			});
			return refs.map((e) => ({ id: e.id, label: e.title, detail: e.startsOn, color: e.color }));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/refs/galleries',
		summary: 'Öffentliche Galerien für die Verknüpfung suchen',
		tags,
		permission: PERM.postWrite,
		query: refSearchQuery,
		handler: async ({ query }): Promise<RefOption[]> => {
			const service = await galleriesService();
			if (!service) return [];
			const refs = await service.searchPublicGalleryRefs({
				search: query.search || undefined,
				limit: query.limit
			});
			return refs.map((g) => ({
				id: g.id,
				label: g.title,
				detail: `${g.imageCount} Bilder`,
				color: null
			}));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Personen zum Mitschreiben suchen (Benutzer*innen, Rollen, Gruppen, Mitglieder)',
		description:
			'Nur für Personen, die Beiträge teilen können (`website.post.publish` oder Autor*in eines Beitrags), sonst 403.',
		tags,
		permission: PERM.postWrite,
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalSearchQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: [PERM.postPublish],
				canShareSql: (userId) => sql`SELECT 1 FROM posts WHERE author_id = ${userId}`
			});
			return searchPrincipals(ctx, MODULE_ID, query.search, {
				everyoneLabel: EVERYONE_LABEL,
				types: SHARE_TYPES
			});
		}
	}),

	// --- Beiträge ---------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/posts',
		summary: 'Beiträge (eigene und zum Mitschreiben freigegebene; mit „veröffentlichen“ alle)',
		tags,
		permission: PERM.postWrite,
		query: postListQuery,
		handler: async ({ ctx, query }): Promise<PostListPage> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const where = [visiblePostsFilter(ctx, keys)];
			if (query.status === 'draft') where.push(sql`p.status = 'draft'`);
			if (query.status === 'published') {
				where.push(sql`p.status = 'published' AND p.published_at <= now()`);
			}
			if (query.status === 'scheduled') {
				where.push(sql`p.status = 'published' AND p.published_at > now()`);
			}
			if (query.search) {
				const p = like(query.search);
				where.push(sql`(p.title ILIKE ${p} OR p.teaser ILIKE ${p})`);
			}
			if (query.tag) {
				where.push(
					sql`EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND lower(t.tag) = lower(${query.tag}))`
				);
			}
			const cond = sql.join(where, sql` AND `);
			const data = await db().transaction(async (tx) => {
				const rows = await rowsOf(
					tx,
					sql`SELECT p.* FROM posts p WHERE ${cond}
						ORDER BY (p.status = 'draft') DESC, COALESCE(p.published_at, p.updated_at) DESC, p.id
						LIMIT ${query.limit} OFFSET ${query.offset}`
				);
				const [c] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM posts p WHERE ${cond}`);
				const ids = rows.map((r) => String(r.id));
				const tagMap = await tagsFor(tx, ids);
				const access = await accessForMany(
					tx,
					ctx,
					rows.map((r) => ({ id: String(r.id), ownerId: String(r.author_id ?? '') })),
					keys
				);
				return {
					total: Number(c?.n ?? 0),
					items: rows.map((r) => ({
						...toListItem(ctx, r, tagMap.get(String(r.id)) ?? [], access.get(String(r.id))!),
						authorNameOverride: r.author_name_override ? String(r.author_name_override) : null
					}))
				};
			});
			return { total: data.total, items: await buildList(ctx, data.items) };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/posts',
		summary: 'Beitrag anlegen (Entwurf, Adresse aus dem Titel)',
		tags,
		permission: PERM.postWrite,
		body: postCreateInput,
		handler: async ({ ctx, body }): Promise<PostDetail> => {
			const authorId = ctx.userId;
			if (!authorId) throw errors.badRequest('Beiträge können nur von Benutzer*innen angelegt werden');
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const id = crypto.randomUUID();
			const data = await db().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('website:post-slug'))`);
				const slug = await uniqueSlug(tx, body.title);
				await tx.execute(
					sql`INSERT INTO posts (id, slug, title, author_id, created_by)
						VALUES (${id}, ${slug}, ${body.title}, ${authorId}, ${authorId})`
				);
				return detailOf(ctx, tx, id, keys);
			});
			await core.audit.logFromContext(ctx, 'website.post.created', { target: id });
			return buildDetail(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/posts/:id',
		summary: 'Beitrag mit Text, Bildern, Themen, Verknüpfungen und Freigaben',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		handler: async ({ ctx, params }): Promise<PostDetail> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await db().transaction((tx) => detailOf(ctx, tx, params.id, keys));
			return buildDetail(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/posts/:id',
		summary: 'Beitrag ändern (nur übergebene Felder; Listen ersetzen)',
		description:
			'Der Text wird bereinigt; Bilder nur als `<img data-image-id>` mit Bildern dieses Beitrags. ' +
			'Nicht mehr verwendete Bilder (weder im Text noch Titelbild) werden beim Speichern des Texts gelöscht.',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		body: postUpdateInput,
		handler: async ({ ctx, params, body }): Promise<PostDetail> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const { data, removed } = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				const row = (await loadPostRow(tx, params.id))!;
				const images = await imagesFor(tx, params.id);
				const imageIds = new Set(images.map((i) => String(i.id)));
				const set = [sql`updated_at = now()`];

				if (body.slug !== undefined && body.slug !== String(row.slug)) {
					await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('website:post-slug'))`);
					if (await slugTaken(tx, body.slug, params.id)) {
						throw errors.conflict('Diese Adresse hat schon ein anderer Beitrag');
					}
					set.push(sql`slug = ${body.slug}`);
				}
				if (body.title !== undefined) set.push(sql`title = ${body.title}`);
				if (body.teaser !== undefined) set.push(sql`teaser = ${body.teaser}`);
				if (body.authorNameOverride !== undefined) {
					set.push(sql`author_name_override = ${body.authorNameOverride}`);
				}
				if (body.eventId !== undefined) set.push(sql`event_id = ${body.eventId || null}`);
				if (body.galleryId !== undefined) set.push(sql`gallery_id = ${body.galleryId}`);
				let bodyHtml = String(row.body_html ?? '');
				if (body.bodyHtml !== undefined) {
					bodyHtml = sanitizeRichText(body.bodyHtml, { images: (id) => imageIds.has(id) });
					set.push(sql`body_html = ${bodyHtml}`);
				}
				let cover = row.cover_image_id ? String(row.cover_image_id) : null;
				if (body.coverImageId !== undefined) {
					if (body.coverImageId && !imageIds.has(body.coverImageId)) {
						throw errors.validation([
							{ path: ['coverImageId'], message: 'Bild gehört nicht zu diesem Beitrag' }
						]);
					}
					cover = body.coverImageId;
					set.push(sql`cover_image_id = ${cover}`);
				}
				await tx.execute(sql`UPDATE posts SET ${sql.join(set, sql`, `)} WHERE id = ${params.id}`);
				if (body.tags !== undefined) await replaceTags(tx, params.id, body.tags);
				if (body.groupIds !== undefined) await replaceGroups(tx, params.id, body.groupIds);

				// Nicht mehr verwendete Bilder entfernen (nur wenn Text oder Titelbild gespeichert wurden)
				let removedPaths: string[] = [];
				if (body.bodyHtml !== undefined || body.coverImageId !== undefined) {
					const used = new Set(richTextImageIds(bodyHtml));
					if (cover) used.add(cover);
					const unused = images.filter((i) => !used.has(String(i.id)));
					if (unused.length) {
						await tx.execute(
							sql`DELETE FROM post_images WHERE post_id = ${params.id} AND id IN (${sql.join(
								unused.map((i) => sql`${String(i.id)}`),
								sql`, `
							)})`
						);
						removedPaths = unused.flatMap((i) => [String(i.thumb_path), String(i.web_path)]);
					}
				}
				return { data: await detailOf(ctx, tx, params.id, keys), removed: removedPaths };
			});
			await removeFiles(removed);
			await core.audit.logFromContext(ctx, 'website.post.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body), imagesRemoved: removed.length / 2 }
			});
			return buildDetail(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/posts/:id/publish',
		summary: 'Beitrag veröffentlichen (sofort oder zum angegebenen Zeitpunkt)',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		body: publishInput,
		handler: async ({ ctx, params, body }): Promise<PostDetail> => {
			requirePublisher(ctx);
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				await tx.execute(
					sql`UPDATE posts SET status = 'published',
							published_at = ${body.publishedAt ? sql`${body.publishedAt}::timestamptz` : sql`now()`},
							updated_at = now()
						WHERE id = ${params.id}`
				);
				return detailOf(ctx, tx, params.id, keys);
			});
			const scheduled = !!body.publishedAt && Date.parse(body.publishedAt) > Date.now();
			await core.audit.logFromContext(ctx, 'website.post.published', {
				target: params.id,
				metadata: { scheduled }
			});
			await notifyPostStatus(ctx, params.id, scheduled ? 'scheduled' : 'published');
			return buildDetail(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/posts/:id/unpublish',
		summary: 'Beitrag zurückziehen (wieder Entwurf)',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		handler: async ({ ctx, params }): Promise<PostDetail> => {
			requirePublisher(ctx);
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				await tx.execute(
					sql`UPDATE posts SET status = 'draft', published_at = NULL, updated_at = now()
						WHERE id = ${params.id}`
				);
				return detailOf(ctx, tx, params.id, keys);
			});
			await core.audit.logFromContext(ctx, 'website.post.unpublished', { target: params.id });
			await notifyPostStatus(ctx, params.id, 'unpublished');
			return buildDetail(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/posts/:id',
		summary: 'Beitrag löschen (Entwürfe auch durch die Autor*in, sonst nur mit „veröffentlichen“)',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const paths = await db().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, params.id, keys, 'edit');
				const row = (await loadPostRow(tx, params.id))!;
				if (!canPublish(ctx) && !(access.isOwner && String(row.status) === 'draft')) {
					throw errors.forbidden('Veröffentlichte Beiträge löschen nur Personen mit „Beiträge veröffentlichen“');
				}
				const images = await imagesFor(tx, params.id);
				await tx.execute(sql`DELETE FROM posts WHERE id = ${params.id}`);
				return images.flatMap((i) => [String(i.thumb_path), String(i.web_path)]);
			});
			await removeFiles(paths);
			await core.audit.logFromContext(ctx, 'website.post.deleted', {
				target: params.id,
				metadata: { images: paths.length / 2 }
			});
			return { deleted: true };
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/posts/:id/shares',
		summary: 'Mitschreiben: Freigaben ersetzen (Autor*in oder „veröffentlichen“)',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		body: sharesInput,
		handler: async ({ ctx, params, body }): Promise<PostDetail> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const stored = await db().transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, params.id, keys, 'edit');
				if (!access.isOwner && !canPublish(ctx)) {
					throw errors.forbidden('Freigaben ändern nur die Autor*in oder Personen mit „veröffentlichen“');
				}
				return loadShares(tx, params.id);
			});
			await validatePrincipals(ctx, MODULE_ID, body.shares, {
				types: SHARE_TYPES,
				keep: new Set(stored.map((s) => `${s.type}:${s.id}`))
			});
			const data = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				await replaceShares(tx, ctx, params.id, body.shares);
				return detailOf(ctx, tx, params.id, keys);
			});
			await core.audit.logFromContext(ctx, 'website.post.shared', {
				target: params.id,
				metadata: { shares: body.shares.length }
			});
			await notifyPostInvited(ctx, params.id, stored, body.shares);
			return buildDetail(ctx, data);
		}
	}),

	// --- Bilder -----------------------------------------------------------------
	defineEndpoint({
		method: 'POST',
		path: '/posts/:id/images',
		summary: 'Bild hochladen (multipart, Feld "file", optional "alt")',
		description:
			'Erlaubt: JPEG, PNG, WebP, AVIF, GIF bis 25 MB. Metadaten (EXIF/GPS) werden entfernt; gespeichert werden ' +
			'nur WebP-Varianten (thumb 640 px, web 1600 px). Bis zum nächsten Speichern des Texts gilt das Bild als ' +
			'unbenutzt und wird dann entfernt, wenn es weder im Text noch Titelbild ist.',
		tags,
		permission: PERM.postWrite,
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<PostImage> => {
			const postId = params.id;
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const form = await readFormData(request);
			const file = await takeUpload(form, {
				maxBytes: MAX_IMAGE_BYTES,
				allowedTypes: IMAGE_CONTENT_TYPES,
				typesLabel: 'JPEG, PNG, WebP, AVIF oder GIF',
				detectMissingType: true,
				sniff: false
			});
			const rawAlt = form.get('alt');
			if (rawAlt != null && typeof rawAlt !== 'string') {
				throw errors.badRequest('Feld "alt" muss Text sein');
			}
			const alt = imageUpdateInput.parse({ alt: rawAlt }).alt;

			await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, postId, keys, 'edit');
				const [r] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n FROM post_images WHERE post_id = ${postId}`
				);
				if (Number(r?.n ?? 0) >= MAX_POST_IMAGES) {
					throw errors.conflict(`Höchstens ${MAX_POST_IMAGES} Bilder je Beitrag`);
				}
			});

			const processed = await core.images.process(file.bytes, {
				variants: VARIANT_SPECS,
				maxInputBytes: MAX_IMAGE_BYTES
			});
			const imageId = crypto.randomUUID();
			const paths: Partial<Record<ImageVariant, string>> = {};
			let size = 0;
			const uploaded: string[] = [];
			try {
				for (const spec of VARIANT_SPECS) {
					const variant = processed.variants.find((v) => v.name === spec.name);
					if (!variant) throw errors.unavailable('Bildverarbeitung unvollständig');
					const name = spec.name as ImageVariant;
					const path = variantPath(postId, imageId, name, variant.extension);
					await core.storage.upload(filesCtx(), {
						module: MODULE_ID,
						path,
						file: variant.bytes,
						contentType: variant.contentType,
						name: `${imageId}-${spec.name}.${variant.extension}`
					});
					uploaded.push(path);
					paths[name] = path;
					if (name === 'web') size = variant.bytes.byteLength;
				}
			} catch (e) {
				await removeFiles(uploaded);
				throw e;
			}
			const web = processed.variants.find((v) => v.name === 'web');
			try {
				const row = await db().transaction(async (tx) => {
					await requireAccess(tx, ctx, postId, keys, 'edit');
					const [r] = await rowsOf(
						tx,
						sql`INSERT INTO post_images (id, post_id, alt, width, height, size_bytes, thumb_path, web_path,
								uploaded_by)
							VALUES (${imageId}, ${postId}, ${alt}, ${web?.width ?? processed.width},
								${web?.height ?? processed.height}, ${size}, ${paths.thumb!}, ${paths.web!}, ${ctx.userId ?? null})
							RETURNING *`
					);
					return r!;
				});
				await core.audit.logFromContext(ctx, 'website.post.image-uploaded', {
					target: postId,
					metadata: { imageId }
				});
				return toImage(row);
			} catch (e) {
				await removeFiles(uploaded);
				throw e;
			}
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/posts/:id/images/:imageId',
		summary: 'Bildbeschreibung (Alt-Text) eines Bildes ändern',
		tags,
		permission: PERM.postWrite,
		params: idParams.extend({ imageId: idParams.shape.id }),
		body: imageUpdateInput,
		handler: async ({ ctx, params, body }): Promise<PostImage> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const row = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				const [r] = await rowsOf(
					tx,
					sql`UPDATE post_images SET alt = ${body.alt}
						WHERE id = ${params.imageId} AND post_id = ${params.id} RETURNING *`
				);
				if (!r) throw errors.notFound('Bild nicht gefunden');
				return r;
			});
			return toImage(row);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/posts/:id/images/:imageId/:variant',
		summary: 'Bilddatei eines Beitrags (thumb, web) für den Editor',
		tags,
		permission: PERM.postWrite,
		params: imageParams,
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const path = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'read');
				const [r] = await rowsOf(
					tx,
					sql`SELECT thumb_path, web_path FROM post_images WHERE id = ${params.imageId} AND post_id = ${params.id}`
				);
				if (!r) throw errors.notFound('Bild nicht gefunden');
				return String(params.variant === 'thumb' ? r.thumb_path : r.web_path);
			});
			return fileResponse(path, 'private, max-age=3600');
		}
	})
];
