import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { GROUP_IMAGE_CONTENT_TYPES, MAX_GROUP_IMAGE_BYTES, idParams } from './schemas';

const MODULE = 'members';
const mdb = () => core.database.forModule(MODULE);

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
	const r = result as { rows?: Row[] } | Row[];
	return Array.isArray(r) ? r : (r.rows ?? []);
}

interface ImageRef {
	path: string | null;
	name: string | null;
}

/** Liest Pfad/Name des Bildes; wirft not_found, wenn die Gruppe fehlt. */
async function readRef(tx: Tx, groupId: string): Promise<ImageRef> {
	const r = rowsOf(
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

function sanitizeName(name: string): string {
	const cleaned = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+/, '')
		.slice(-100);
	return cleaned || 'bild';
}

export const groupImageEndpoints: ApiEndpoint[] = [
	{
		method: 'POST',
		path: '/groups/:id/image',
		summary: 'Gruppenbild hochladen (multipart, Feld "file")',
		description:
			'Ersetzt ein vorhandenes Bild. Erlaubt: JPEG, PNG, WebP bis 2 MB. Rueckgabe: { name }.',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		params: idParams,
		handler: async ({ ctx, params, request }) => {
			const { id } = params as { id: string };
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungueltige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) throw errors.badRequest('Feld "file" fehlt');
			const contentType = (file.type || '').split(';')[0]!.trim().toLowerCase();
			if (!(GROUP_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
				throw errors.badRequest('Dateityp nicht erlaubt (JPEG, PNG oder WebP)');
			}
			if (file.size === 0) throw errors.badRequest('Datei ist leer');
			if (file.size > MAX_GROUP_IMAGE_BYTES) {
				throw errors.tooLarge('Bild ueberschreitet das Limit von 2 MB');
			}

			const old = await mdb().transaction((tx) => readRef(tx, id));
			const bytes = new Uint8Array(await file.arrayBuffer());
			const displayName = file.name?.trim() || 'bild';
			const path = `groups/${id}/image-${crypto.randomUUID()}-${sanitizeName(displayName)}`;
			await core.storage.upload(ctx, {
				module: MODULE,
				path,
				file: bytes,
				contentType,
				name: displayName
			});
			try {
				await mdb().transaction((tx) => writeRef(tx, id, { path, name: displayName }));
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE, path }).catch(() => undefined);
				throw e;
			}
			if (old.path) {
				await core.storage.remove(ctx, { module: MODULE, path: old.path }).catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'members.group.image.uploaded', {
				target: id,
				metadata: { name: displayName }
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
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const ref = await mdb().transaction((tx) => readRef(tx, id));
			if (!ref.path) throw errors.notFound('Kein Bild vorhanden');
			const { buffer, file } = await core.storage.download(ctx, { module: MODULE, path: ref.path });
			return new Response(buffer as BodyInit, {
				status: 200,
				headers: {
					'content-type': file.contentType,
					'content-length': String(buffer.byteLength),
					'content-disposition': 'inline',
					'cache-control': 'private, max-age=3600',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/groups/:id/image',
		summary: 'Gruppenbild loeschen',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const ref = await mdb().transaction((tx) => readRef(tx, id));
			if (!ref.path) throw errors.notFound('Kein Bild vorhanden');
			await core.storage.remove(ctx, { module: MODULE, path: ref.path });
			await mdb().transaction((tx) => writeRef(tx, id, { path: null, name: null }));
			await core.audit.logFromContext(ctx, 'members.group.image.deleted', {
				target: id,
				metadata: { name: ref.name }
			});
			return { deleted: true };
		}
	} as ApiEndpoint
];
