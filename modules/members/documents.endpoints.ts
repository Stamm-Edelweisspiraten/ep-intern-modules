import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	core,
	errors,
	moduleDb,
	readUpload,
	resultRows,
	safeFileName,
	secureFileResponse,
	type Tx
} from '$lib/sdk/server';
import {
	DOCUMENT_CONTENT_TYPES,
	MAX_DOCUMENT_BYTES,
	documentParams,
	type DocumentKind
} from './schemas';

const MODULE = 'members';

interface DocRef {
	path: string | null;
	name: string | null;
}

/** Liest Pfad/Name des Dokuments; wirft not_found, wenn das Mitglied fehlt. */
async function readRef(tx: Tx, memberId: string, kind: DocumentKind): Promise<DocRef> {
	const rows = resultRows(
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
			// Typ, Größe und Inhalt (Magic Bytes) einheitlich geprüft, sonst 422/413 (#33, #67)
			const file = await readUpload(request, {
				maxBytes: MAX_DOCUMENT_BYTES,
				allowedTypes: DOCUMENT_CONTENT_TYPES,
				typesLabel: 'PDF, JPEG, PNG oder WebP',
				fallbackName: 'dokument'
			});
			const { bytes, contentType } = file;

			const old = await moduleDb(MODULE).transaction((tx) => readRef(tx, id, kind));
			const displayName = file.name;
			const path = `${id}/${kind}-${crypto.randomUUID()}-${safeFileName(displayName, { fallback: 'dokument' })}`;
			await core.storage.upload(ctx, {
				module: MODULE,
				path,
				file: bytes,
				contentType,
				name: displayName
			});
			try {
				await moduleDb(MODULE).transaction((tx) =>
					writeRef(tx, id, kind, { path, name: displayName })
				);
			} catch (e) {
				await core.storage.remove(ctx, { module: MODULE, path }).catch(() => undefined);
				throw e;
			}
			if (old.path) {
				await core.storage.remove(ctx, { module: MODULE, path: old.path }).catch(() => undefined);
			}
			await core.audit.logFromContext(ctx, 'members.document.uploaded', {
				target: id,
				metadata: { kind } // ohne Original-Dateinamen (#26)
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
			const ref = await moduleDb(MODULE).transaction((tx) => readRef(tx, id, kind));
			if (!ref.path) throw errors.notFound('Kein Dokument vorhanden');
			const { buffer, file } = await core.storage.download(ctx, { module: MODULE, path: ref.path });
			const name = ref.name || file.name || 'dokument';
			// Gemeinsame gehärtete Antwort (CSP-Sandbox, nosniff, RFC-5987-Name; #67, 01b-11)
			return secureFileResponse(buffer, {
				contentType: file.contentType,
				size: buffer.byteLength,
				name,
				cache: 'private, no-store'
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
			const ref = await moduleDb(MODULE).transaction((tx) => readRef(tx, id, kind));
			if (!ref.path) throw errors.notFound('Kein Dokument vorhanden');
			await core.storage.remove(ctx, { module: MODULE, path: ref.path });
			await moduleDb(MODULE).transaction((tx) =>
				writeRef(tx, id, kind, { path: null, name: null })
			);
			await core.audit.logFromContext(ctx, 'members.document.deleted', {
				target: id,
				metadata: { kind }
			});
			return { deleted: true };
		}
	} as ApiEndpoint
];
