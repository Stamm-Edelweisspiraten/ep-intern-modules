/**
 * Bilder an Typen, Lagerartikeln und Lebensmitteln: Upload (multipart, Varianten `thumb`/`web` ohne Metadaten),
 * Auslieferung, Löschen, Reihenfolge (erstes Bild = Titelbild). Muster wie `orders/images.endpoints.ts`.
 * Pfade je Besitzer: `/types/:id/images…`, `/items/:id/images…` und `/pantry/products/:id/images…` (Lebensmittel,
 * Recht `pantry.manage`; dazu `POST …/images/off` = Produktbild aus Open Food Facts lokal übernehmen).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	type RequestContext,
	readUpload,
	type Tx
} from '$lib/sdk/server';
import { mdb, num, type Row, rows, str } from './db';
import {
	fileResponse,
	filesCtx,
	removeFiles,
	VARIANT_COLUMN,
	VARIANT_SPECS,
	variantPath
} from './files';
import { fetchOffImage } from './off.service';
import {
	IMAGE_CONTENT_TYPES,
	IMAGE_OWNERS,
	IMAGE_VARIANTS,
	type ImageOwner,
	type ImageRef,
	type ImageSource,
	type ImageVariant,
	imageOrderInput,
	imagesPath,
	imageUrl,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	MODULE_ID,
	PERMISSIONS
} from './schemas';

const tags = ['Modul: material'];
const MAX_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

const ownerParams = z.object({ id: z.uuid() });
const imageParams = ownerParams.extend({ imageId: z.uuid() });
const variantParams = imageParams.extend({ variant: z.enum(IMAGE_VARIANTS) });

const OWNER = {
	types: {
		column: sql`type_id`,
		table: sql`types`,
		label: 'Typ',
		audit: 'type',
		permission: PERMISSIONS.manage
	},
	items: {
		column: sql`item_id`,
		table: sql`items`,
		label: 'Artikel',
		audit: 'item',
		permission: PERMISSIONS.manage
	},
	products: {
		column: sql`product_id`,
		table: sql`food_products`,
		label: 'Lebensmittel',
		audit: 'pantry.product',
		permission: PERMISSIONS.pantry
	}
} as const;

/** Spalte des Besitzers in `images` */
export const imageOwnerColumn = (owner: ImageOwner) => OWNER[owner].column;

async function requireOwner(tx: Tx, owner: ImageOwner, id: string) {
	const [r] = await rows(tx, sql`SELECT id FROM ${OWNER[owner].table} WHERE id = ${id}`);
	if (!r) throw errors.notFound(`${OWNER[owner].label} nicht gefunden`);
}

async function requireImageRow(
	tx: Tx,
	owner: ImageOwner,
	id: string,
	imageId: string
): Promise<Row> {
	const [row] = await rows(
		tx,
		sql`SELECT id, width, height, position, thumb_path, web_path, source FROM images
			WHERE id = ${imageId} AND ${OWNER[owner].column} = ${id}`
	);
	if (!row) throw errors.notFound('Bild nicht gefunden');
	return row;
}

const toImage = (owner: ImageOwner, ownerId: string, r: Row): ImageRef => ({
	id: String(r.id),
	width: num(r.width),
	height: num(r.height),
	thumbUrl: imageUrl(owner, ownerId, String(r.id), 'thumb'),
	webUrl: imageUrl(owner, ownerId, String(r.id), 'web'),
	source: r.source === 'off' ? 'off' : 'upload'
});

async function imagesOf(tx: Tx, owner: ImageOwner, id: string): Promise<ImageRef[]> {
	return (
		await rows(
			tx,
			sql`SELECT id, width, height, source FROM images WHERE ${OWNER[owner].column} = ${id}
				ORDER BY position, created_at, id`
		)
	).map((r) => toImage(owner, id, r));
}

/** Alle Bilder eines Besitzers samt Dateien löschen (vor dem Löschen des Typs/Artikels/Lebensmittels) */
export async function removeImagesOf(owner: ImageOwner, id: string): Promise<void> {
	const list = await mdb().transaction(async (tx) => {
		const r = await rows(
			tx,
			sql`DELETE FROM images WHERE ${OWNER[owner].column} = ${id} RETURNING thumb_path, web_path`
		);
		return r.flatMap((x) => [String(x.thumb_path), String(x.web_path)]);
	});
	await removeFiles(list);
}

/**
 * Bild verarbeiten (Varianten ohne Metadaten), im Storage ablegen und eintragen. Prüft Besitzer und Höchstzahl vorher
 * und noch einmal unter Sperre; räumt hochgeladene Dateien bei Fehlern wieder ab. Außerhalb von Transaktionen aufrufen.
 */
async function storeImage(
	ctx: RequestContext,
	owner: ImageOwner,
	ownerId: string,
	bytes: Uint8Array,
	source: ImageSource
): Promise<ImageRef> {
	const what = OWNER[owner];
	const assertRoom = async (tx: Tx) => {
		await requireOwner(tx, owner, ownerId);
		const [r] = await rows(
			tx,
			sql`SELECT count(*)::int AS n FROM images WHERE ${what.column} = ${ownerId}`
		);
		if (num(r?.n) >= MAX_IMAGES) throw errors.conflict(`Höchstens ${MAX_IMAGES} Bilder`);
	};
	await mdb().transaction(assertRoom);

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
			const path = variantPath(owner, ownerId, imageId, name, variant.extension);
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
			// Sperre je Besitzer: eindeutige Positionen, Höchstzahl hält (#73)
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${`material:images:${ownerId}`}))`
			);
			await assertRoom(tx);
			if (source === 'off') await assertNoOffImage(tx, owner, ownerId);
			const typeId = owner === 'types' ? ownerId : null;
			const itemId = owner === 'items' ? ownerId : null;
			const productId = owner === 'products' ? ownerId : null;
			await tx.execute(
				sql`INSERT INTO images (id, type_id, item_id, product_id, position, width, height, thumb_path, web_path,
						source, uploaded_by)
					VALUES (${imageId}, ${typeId}, ${itemId}, ${productId},
						(SELECT COALESCE(MAX(position), -1) + 1 FROM images WHERE ${what.column} = ${ownerId}),
						${processed.width}, ${processed.height}, ${paths.thumb!}, ${paths.web!}, ${source},
						${ctx.userId ?? null})`
			);
			return requireImageRow(tx, owner, ownerId, imageId);
		});
	} catch (e) {
		await removeFiles(uploaded);
		throw e;
	}
	await core.audit.logFromContext(ctx, `material.${what.audit}.image-uploaded`, {
		target: ownerId,
		metadata: { imageId, source }
	});
	return toImage(owner, ownerId, row);
}

async function assertNoOffImage(tx: Tx, owner: ImageOwner, ownerId: string) {
	const [r] = await rows(
		tx,
		sql`SELECT 1 AS x FROM images WHERE ${OWNER[owner].column} = ${ownerId} AND source = 'off'`
	);
	if (r) throw errors.conflict('Das Bild aus Open Food Facts ist schon übernommen');
}

function endpointsFor(owner: ImageOwner): AnyApiEndpoint[] {
	const what = OWNER[owner];
	const base = imagesPath(owner, ':id');
	return [
		defineEndpoint({
			method: 'PUT',
			path: `${base}/order`,
			summary: `Reihenfolge der Bilder (${what.label}; erstes Bild = Titelbild)`,
			tags,
			permission: what.permission,
			params: ownerParams,
			body: imageOrderInput,
			handler: async ({ ctx, params, body }): Promise<ImageRef[]> => {
				const images = await mdb().transaction(async (tx) => {
					await requireOwner(tx, owner, params.id);
					const current = (
						await rows(tx, sql`SELECT id FROM images WHERE ${what.column} = ${params.id}`)
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
							sql`UPDATE images SET position = ${i} WHERE id = ${id} AND ${what.column} = ${params.id}`
						);
					}
					return imagesOf(tx, owner, params.id);
				});
				await core.audit.logFromContext(ctx, `material.${what.audit}.images-reordered`, {
					target: params.id,
					metadata: { count: body.ids.length }
				});
				return images;
			}
		}),
		defineEndpoint({
			method: 'POST',
			path: base,
			summary: `Bild hochladen (${what.label}; multipart, Feld "file")`,
			description: `Ein Request je Datei. Erlaubt: JPEG, PNG, WebP, AVIF, GIF bis ${MAX_MB} MB, höchstens ${MAX_IMAGES} Bilder. Metadaten (EXIF/GPS) werden entfernt.`,
			tags,
			permission: what.permission,
			params: ownerParams,
			handler: async ({ ctx, params, request }): Promise<ImageRef> => {
				const file = await readUpload(request, {
					maxBytes: MAX_IMAGE_BYTES,
					allowedTypes: IMAGE_CONTENT_TYPES,
					typesLabel: 'JPEG, PNG, WebP, AVIF oder GIF',
					detectMissingType: true,
					sniff: false
				});
				return storeImage(ctx, owner, params.id, file.bytes, 'upload');
			}
		}),
		defineEndpoint({
			method: 'DELETE',
			path: `${base}/:imageId`,
			summary: `Bild löschen (${what.label}, inkl. Dateien)`,
			tags,
			permission: what.permission,
			params: imageParams,
			handler: async ({ ctx, params }) => {
				const row = await mdb().transaction(async (tx) => {
					const r = await requireImageRow(tx, owner, params.id, params.imageId);
					await tx.execute(sql`DELETE FROM images WHERE id = ${params.imageId}`);
					return r;
				});
				await removeFiles([String(row.thumb_path), String(row.web_path)]);
				await core.audit.logFromContext(ctx, `material.${what.audit}.image-deleted`, {
					target: params.id,
					metadata: { imageId: params.imageId }
				});
				return { id: params.imageId, deleted: true };
			}
		}),
		defineEndpoint({
			method: 'GET',
			path: `${base}/:imageId/:variant`,
			summary: `Bild abrufen (${what.label}; thumb, web)`,
			tags,
			permission: PERMISSIONS.view,
			params: variantParams,
			rateLimit: IMAGE_RATE_LIMIT,
			handler: async ({ params }) => {
				const path = await mdb().transaction(async (tx) => {
					const row = await requireImageRow(tx, owner, params.id, params.imageId);
					return String(row[VARIANT_COLUMN[params.variant]]);
				});
				return fileResponse(path, { cache: 'private, max-age=3600' });
			}
		})
	];
}

/** Produktbild aus Open Food Facts holen und lokal speichern (wie ein Upload, Herkunft `off`) */
const offImportEndpoint = defineEndpoint({
	method: 'POST',
	path: '/pantry/products/:id/images/off',
	summary: 'Produktbild aus Open Food Facts übernehmen (lokal gespeichert)',
	description:
		'Der Server schlägt den Strichcode des Lebensmittels bei Open Food Facts nach und lädt das Produktbild vom OFF-Bildserver. Ohne Strichcode 422, ohne Bild 404, schon übernommen 409.',
	tags,
	permission: PERMISSIONS.pantry,
	params: ownerParams,
	rateLimit: { limit: 30, windowSec: 60 },
	handler: async ({ ctx, params }): Promise<ImageRef> => {
		const barcode = await mdb().transaction(async (tx) => {
			const [p] = await rows(tx, sql`SELECT barcode FROM food_products WHERE id = ${params.id}`);
			if (!p) throw errors.notFound('Lebensmittel nicht gefunden');
			await assertNoOffImage(tx, 'products', params.id);
			return str(p.barcode);
		});
		if (!barcode) {
			throw errors.validation([
				{ path: ['barcode'], message: 'Das Lebensmittel hat keinen Strichcode' }
			]);
		}
		const bytes = await fetchOffImage(barcode);
		if (!bytes) throw errors.notFound('Open Food Facts hat kein Bild zu diesem Produkt');
		return storeImage(ctx, 'products', params.id, bytes, 'off');
	}
});

export const imagesEndpoints: AnyApiEndpoint[] = [
	offImportEndpoint,
	...IMAGE_OWNERS.flatMap(endpointsFor)
];
