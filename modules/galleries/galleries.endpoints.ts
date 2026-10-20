import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	principalKeysFor,
	validatePrincipals,
	type ApiEndpoint
} from '$lib/sdk/server';
import { accessForMany, requireAccess, rowsOf, visibleGalleriesFilter } from './access';
import { db, effectiveCoverSql, removeFiles } from './files';
import {
	describeEvents,
	eventIdsByGallery,
	finishDetail,
	iso,
	likePattern,
	loadDetailData,
	loadEventIds,
	loadShares,
	pickEvents,
	replaceGalleryEvents,
	replaceShares,
	validateEventIds
} from './galleries.service';
import {
	MODULE_ID,
	coverInput,
	galleryInput,
	idParams,
	listQuery,
	type GalleryItem,
	type GalleryList,
	type Visibility
} from './schemas';

const tags = ['Modul: galleries'];

export const galleriesEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/galleries',
		summary: 'Sichtbare Galerien (Suche, Sichtbarkeit, Termin)',
		tags,
		permission: 'galleries.gallery.view',
		query: listQuery,
		handler: async ({ ctx, query }): Promise<GalleryList> => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const conds: SQL[] = [visibleGalleriesFilter(ctx, keys)];
			if (query.search) {
				const p = likePattern(query.search);
				conds.push(sql`(g.title ILIKE ${p} OR g.description ILIKE ${p})`);
			}
			if (query.visibility) conds.push(sql`g.visibility = ${query.visibility}`);
			if (query.eventId) {
				conds.push(sql`EXISTS (SELECT 1 FROM gallery_events ge
					WHERE ge.gallery_id = g.id AND ge.event_id = ${query.eventId})`);
			}
			const where = sql.join(conds, sql` AND `);

			const page = await db().transaction(async (tx) => {
				const [count] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS total FROM galleries g WHERE ${where}`
				);
				const rows = await rowsOf(
					tx,
					sql`SELECT g.id, g.title, g.description, g.visibility, g.owner_id,
							g.created_at, g.updated_at,
							(SELECT count(*)::int FROM gallery_images x WHERE x.gallery_id = g.id) AS image_count,
							c.id AS cover_id, c.width AS cover_width, c.height AS cover_height
						FROM galleries g
						LEFT JOIN gallery_images c ON c.id = ${effectiveCoverSql}
						WHERE ${where}
						ORDER BY g.updated_at DESC, g.title, g.id
						LIMIT ${query.limit} OFFSET ${query.offset}`
				);
				const access = await accessForMany(
					tx,
					ctx,
					rows.map((r) => ({ id: String(r.id), ownerId: String(r.owner_id) })),
					keys
				);
				const eventIds = await eventIdsByGallery(
					tx,
					rows.map((r) => String(r.id))
				);
				const items: Omit<GalleryItem, 'events'>[] = rows.map((r) => {
					const id = String(r.id);
					return {
						id,
						title: String(r.title),
						description: r.description == null ? null : String(r.description),
						visibility: String(r.visibility) as Visibility,
						imageCount: Number(r.image_count),
						cover:
							r.cover_id == null
								? null
								: {
										imageId: String(r.cover_id),
										width: Number(r.cover_width),
										height: Number(r.cover_height)
									},
						ownerId: String(r.owner_id),
						access: access.get(id) ?? { level: 'read', isOwner: false },
						createdAt: iso(r.created_at),
						updatedAt: iso(r.updated_at)
					};
				});
				return { items, eventIds, total: Number(count?.total ?? 0) };
			});
			// Termine nach der Transaktion auflösen (events-Dienst, nur sichtbare)
			const refs = await describeEvents(ctx, [...page.eventIds.values()].flat());
			const items: GalleryItem[] = page.items.map((item) => ({
				...item,
				events: pickEvents(page.eventIds.get(item.id) ?? [], refs)
			}));
			return { items, total: page.total };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/galleries/:id',
		summary: 'Galerie mit Bildern (Freigaben nur bei Bearbeiten-Zugriff)',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await db().transaction((tx) => loadDetailData(tx, ctx, params.id, keys));
			return finishDetail(ctx, data);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/galleries',
		summary: 'Galerie anlegen',
		tags,
		permission: 'galleries.gallery.create',
		body: galleryInput,
		handler: async ({ ctx, body }) => {
			await core.permissions.require(ctx, 'galleries.gallery.view');
			const ownerId = ctx.userId;
			if (!ownerId) throw errors.badRequest('Galerien können nur von Benutzern angelegt werden');
			const keys = await principalKeysFor(ctx, MODULE_ID);
			await validatePrincipals(ctx, MODULE_ID, body.shares);
			await validateEventIds(ctx, body.eventIds);

			const id = crypto.randomUUID();
			const data = await db().transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO galleries (id, title, description, visibility, owner_id, created_by)
						VALUES (${id}, ${body.title}, ${body.description}, ${body.visibility},
							${ownerId}, ${ownerId})`
				);
				await replaceShares(tx, ctx, id, body.shares);
				await replaceGalleryEvents(tx, id, body.eventIds);
				return loadDetailData(tx, ctx, id, keys);
			});
			const detail = await finishDetail(ctx, data);
			await core.audit.logFromContext(ctx, 'galleries.gallery.created', {
				target: id,
				metadata: {
					visibility: body.visibility,
					shares: body.shares.length,
					events: body.eventIds.length
				}
			});
			return detail;
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/galleries/:id/cover',
		summary: 'Titelbild festlegen (null = ältestes Bild)',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		body: coverInput,
		handler: async ({ ctx, params, body }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				if (body.imageId) {
					const [img] = await rowsOf(
						tx,
						sql`SELECT 1 AS ok FROM gallery_images
							WHERE id = ${body.imageId} AND gallery_id = ${params.id}`
					);
					if (!img) {
						throw errors.validation([
							{ path: ['imageId'], message: 'Bild gehört nicht zu dieser Galerie' }
						]);
					}
				}
				await tx.execute(
					sql`UPDATE galleries SET cover_image_id = ${body.imageId}, updated_at = now()
						WHERE id = ${params.id}`
				);
				return loadDetailData(tx, ctx, params.id, keys);
			});
			const detail = await finishDetail(ctx, data);
			await core.audit.logFromContext(ctx, 'galleries.gallery.cover_changed', {
				target: params.id,
				metadata: { visibility: detail.visibility, images: detail.imageCount }
			});
			return detail;
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/galleries/:id',
		summary: 'Galerie ersetzen (Titel, Beschreibung, Sichtbarkeit, Freigaben, Termine)',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		body: galleryInput,
		handler: async ({ ctx, params, body }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			// Zugriff zuerst (Fremde → 404 vor jeder Validierung); gespeicherte Freigaben und Termine
			// gelten als gültig, auch wenn ihr Anbieter (members) inzwischen deaktiviert ist bzw. der
			// Termin für den Aufrufer nicht (mehr) sichtbar ist.
			const stored = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				return {
					shares: await loadShares(tx, params.id),
					eventIds: await loadEventIds(tx, params.id)
				};
			});
			await validatePrincipals(ctx, MODULE_ID, body.shares, {
				keep: new Set(stored.shares.map((s) => `${s.type}:${s.id}`))
			});
			await validateEventIds(ctx, body.eventIds, new Set(stored.eventIds));

			const data = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				await tx.execute(
					sql`UPDATE galleries SET title = ${body.title}, description = ${body.description},
							visibility = ${body.visibility}, updated_at = now()
						WHERE id = ${params.id}`
				);
				await replaceShares(tx, ctx, params.id, body.shares);
				await replaceGalleryEvents(tx, params.id, body.eventIds);
				// Zugriff neu bestimmen (Freigaben können sich geändert haben)
				return loadDetailData(tx, ctx, params.id, keys);
			});
			const detail = await finishDetail(ctx, data);
			await core.audit.logFromContext(ctx, 'galleries.gallery.updated', {
				target: params.id,
				metadata: {
					visibility: body.visibility,
					shares: body.shares.length,
					events: body.eventIds.length
				}
			});
			return detail;
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/galleries/:id',
		summary: 'Galerie mit allen Bildern löschen',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const paths = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				const rows = await rowsOf(
					tx,
					sql`SELECT thumb_path, web_path, full_path FROM gallery_images
						WHERE gallery_id = ${params.id}`
				);
				await tx.execute(sql`DELETE FROM galleries WHERE id = ${params.id}`);
				return rows.flatMap((r) => [r.thumb_path, r.web_path, r.full_path].map((p) => String(p)));
			});
			await removeFiles(paths);
			await core.audit.logFromContext(ctx, 'galleries.gallery.deleted', {
				target: params.id,
				metadata: { images: paths.length / 3 }
			});
			return { id: params.id, deleted: true };
		}
	})
] as ApiEndpoint[];
