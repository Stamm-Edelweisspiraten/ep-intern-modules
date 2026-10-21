import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	core,
	errors,
	IMAGE_RATE_LIMIT,
	moduleDb,
	readUpload,
	resultRows,
	safeFileName,
	secureFileResponse,
	type Tx
} from '$lib/sdk/server';
import { processGroupImage, processedGroupImagePath } from './group-image.service';
import { GROUP_IMAGE_CONTENT_TYPES, MAX_GROUP_IMAGE_BYTES, idParams } from './schemas';

const MODULE = 'members';

interface ImageRef {
	path: string | null;
	name: string | null;
}

/** Liest Pfad/Name des Bildes; wirft not_found, wenn die Gruppe fehlt. */
async function readRef(tx: Tx, groupId: string): Promise<ImageRef> {
	const r = resultRows(
		await tx.execute(sql`SELECT image_path, image_name FROM groups WHERE id = ${groupId}`)
	)[0];
	if (!r) throw errors.notFound('Gruppe nicht gefunden');
	return {
		path: r.image_path == null ? null : String(r.image_path),
		name: r.image_name == null ? null : String(r.image_name)
	};
}

async function writeRef(tx: Tx, groupId: string, ref: ImageRef): Promise<void> {
	await tx.execute(
		sql`UPDATE groups SET image_path = ${ref.path}, image_name = ${ref.name}, updated_at = now()
			WHERE id = ${groupId}`
	);
}

export const groupImageEndpoints: ApiEndpoint[] = [
	{
		method: 'POST',
		path: '/groups/:id/image',
		summary: 'Gruppenbild hochladen (multipart, Feld "file")',
		description:
			'Ersetzt ein vorhandenes Bild. Erlaubt: JPEG, PNG, WebP bis 2 MB; der Inhalt muss zum Typ passen ' +
			'(sonst 400). Gespeichert wird nur eine bereinigte WebP-Variante (ohne EXIF/GPS, lange Kante ' +
			'≤ 1600 px). Rückgabe: { name }.',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		params: idParams,
		handler: async ({ ctx, params, request }) => {
			const { id } = params as { id: string };
			// Typ/leer/fehlend → 422, Größe → 413 (#33); den Bildinhalt prüft core.images.process
			const file = await readUpload(request, {
				maxBytes: MAX_GROUP_IMAGE_BYTES,
				allowedTypes: GROUP_IMAGE_CONTENT_TYPES,
				typesLabel: 'JPEG, PNG oder WebP',
				sniff: false,
				fallbackName: 'bild'
			});
			const { contentType } = file;

			const old = await moduleDb(MODULE).transaction((tx) => readRef(tx, id));
			// Inhalt prüfen und bereinigen (Metadaten inkl. GPS weg, WebP) – nie das Original speichern (#19)
			const clean = await processGroupImage(file.bytes, contentType);
			const displayName = file.name;
			const path = processedGroupImagePath(id);
			await core.storage.upload(ctx, {
				module: MODULE,
				path,
				file: clean.bytes,
				contentType: clean.contentType,
				name: `${safeFileName(displayName, { fallback: 'bild' }).replace(/\.[A-Za-z0-9]{1,5}$/, '')}.webp`
			});
			try {
				await moduleDb(MODULE).transaction((tx) => writeRef(tx, id, { path, name: displayName }));
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE, path }).catch(() => undefined);
				throw e;
			}
			if (old.path) {
				await core.storage.remove(ctx, { module: MODULE, path: old.path }).catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'members.group.image.uploaded', {
				target: id // ohne Original-Dateinamen (#26)
			});
			return { name: displayName };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/groups/:id/image',
		summary: 'Gruppenbild abrufen',
		tags: ['Modul: members'],
		permission: 'members.group.view',
		params: idParams,
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const ref = await moduleDb(MODULE).transaction((tx) => readRef(tx, id));
			if (!ref.path) throw errors.notFound('Kein Bild vorhanden');
			const { buffer, file } = await core.storage.download(ctx, { module: MODULE, path: ref.path });
			// Gemeinsame gehärtete Antwort (CSP-Sandbox, nosniff; #67, 01b-11)
			return secureFileResponse(buffer, {
				contentType: file.contentType,
				size: buffer.byteLength,
				name: file.name || 'gruppenbild.webp',
				cache: 'private, max-age=3600'
			});
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/groups/:id/image',
		summary: 'Gruppenbild löschen',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const ref = await moduleDb(MODULE).transaction((tx) => readRef(tx, id));
			if (!ref.path) throw errors.notFound('Kein Bild vorhanden');
			await core.storage.remove(ctx, { module: MODULE, path: ref.path });
			await moduleDb(MODULE).transaction((tx) => writeRef(tx, id, { path: null, name: null }));
			await core.audit.logFromContext(ctx, 'members.group.image.deleted', {
				target: id
			});
			return { deleted: true };
		}
	} as ApiEndpoint
];
