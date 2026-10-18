import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import {
	DOCUMENT_CONTENT_TYPES,
	MAX_DOCUMENT_BYTES,
	documentParams,
	type DocumentKind
} from './schemas';

const MODULE = 'members';
const mdb = () => core.database.forModule(MODULE);

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
	const r = result as { rows?: Row[] } | Row[];
	return Array.isArray(r) ? r : (r.rows ?? []);
}

interface DocRef {
	path: string | null;
	name: string | null;
}

/** Liest Pfad/Name des Dokuments; wirft not_found, wenn das Mitglied fehlt. */
async function readRef(tx: Tx, memberId: string, kind: DocumentKind): Promise<DocRef> {
	const rows = rowsOf(
		await tx.execute(
			kind === 'privacy'
				? sql`SELECT privacy_consent_path AS path, privacy_consent_name AS name FROM members WHERE id = ${memberId}`
				: sql`SELECT registration_path AS path, registration_name AS name FROM members WHERE id = ${memberId}`
		)
	);
	const r = rows[0];
	if (!r) throw errors.notFound('Mitglied nicht gefunden');
	return {
		path: r.path == null ? null : String(r.path),
		name: r.name == null ? null : String(r.name)
	};
}

async function writeRef(tx: Tx, memberId: string, kind: DocumentKind, ref: DocRef): Promise<void> {
	await tx.execute(
		kind === 'privacy'
			? sql`UPDATE members SET privacy_consent_path = ${ref.path}, privacy_consent_name = ${ref.name},
					updated_at = now() WHERE id = ${memberId}`
			: sql`UPDATE members SET registration_path = ${ref.path}, registration_name = ${ref.name},
					updated_at = now() WHERE id = ${memberId}`
	);
}

function sanitizeName(name: string): string {
	const cleaned = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+/, '')
		.slice(-100);
	return cleaned || 'dokument';
}

export const documentEndpoints: ApiEndpoint[] = [
	{
		method: 'POST',
		path: '/members/:id/documents/:kind',
		summary: 'Dokument hochladen (multipart, Feld "file")',
		description:
			'Ersetzt ein vorhandenes Dokument. Erlaubt: PDF, JPEG, PNG, WebP bis 10 MB. Rückgabe: { name }.',
		tags: ['Modul: members'],
		permission: 'members.member.edit',
		params: documentParams,
		handler: async ({ ctx, params, request }) => {
			const { id, kind } = params as { id: string; kind: DocumentKind };
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) throw errors.badRequest('Feld "file" fehlt');
			const contentType = (file.type || '').split(';')[0]!.trim().toLowerCase();
			if (!(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
				throw errors.badRequest('Dateityp nicht erlaubt (PDF, JPEG, PNG oder WebP)');
			}
			if (file.size === 0) throw errors.badRequest('Datei ist leer');
			if (file.size > MAX_DOCUMENT_BYTES) {
				throw errors.tooLarge('Datei überschreitet das Limit von 10 MB');
			}

			const old = await mdb().transaction((tx) => readRef(tx, id, kind));
			const bytes = new Uint8Array(await file.arrayBuffer());
			const displayName = file.name?.trim() || 'dokument';
			const path = `${id}/${kind}-${crypto.randomUUID()}-${sanitizeName(displayName)}`;
			await core.storage.upload(ctx, {
				module: MODULE,
				path,
				file: bytes,
				contentType,
				name: displayName
			});
			try {
				await mdb().transaction((tx) => writeRef(tx, id, kind, { path, name: displayName }));
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE, path }).catch(() => undefined);
				throw e;
			}
			if (old.path) {
				await core.storage.remove(ctx, { module: MODULE, path: old.path }).catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'members.document.uploaded', {
				target: id,
				metadata: { kind, name: displayName }
			});
			return { name: displayName };
		}
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/members/:id/documents/:kind',
		summary: 'Dokument herunterladen',
		tags: ['Modul: members'],
		permission: 'members.member.view',
		params: documentParams,
		handler: async ({ ctx, params }) => {
			const { id, kind } = params as { id: string; kind: DocumentKind };
			const ref = await mdb().transaction((tx) => readRef(tx, id, kind));
			if (!ref.path) throw errors.notFound('Kein Dokument vorhanden');
			const { buffer, file } = await core.storage.download(ctx, { module: MODULE, path: ref.path });
			const name = ref.name || file.name || 'dokument';
			return new Response(buffer as BodyInit, {
				status: 200,
				headers: {
					'content-type': file.contentType,
					'content-length': String(buffer.byteLength),
					'content-disposition': `inline; filename="${sanitizeName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/members/:id/documents/:kind',
		summary: 'Dokument löschen',
		tags: ['Modul: members'],
		permission: 'members.member.edit',
		params: documentParams,
		handler: async ({ ctx, params }) => {
			const { id, kind } = params as { id: string; kind: DocumentKind };
			const ref = await mdb().transaction((tx) => readRef(tx, id, kind));
			if (!ref.path) throw errors.notFound('Kein Dokument vorhanden');
			await core.storage.remove(ctx, { module: MODULE, path: ref.path });
			await mdb().transaction((tx) => writeRef(tx, id, kind, { path: null, name: null }));
			await core.audit.logFromContext(ctx, 'members.document.deleted', {
				target: id,
				metadata: { kind, name: ref.name }
			});
			return { deleted: true };
		}
	} as ApiEndpoint
];
