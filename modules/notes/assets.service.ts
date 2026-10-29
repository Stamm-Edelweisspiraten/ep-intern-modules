/**
 * Bilder in Notizen: über `core.images.process` neu kodiert (Metadaten/GPS entfernt, Varianten `thumb`/`web`).
 * Ablauf: Vorprüfung (Transaktion 1) → Verarbeitung + Speicher → Eintrag mit erneuter Prüfung (Transaktion 2);
 * schlägt Transaktion 2 fehl, werden die Dateien wieder entfernt.
 */
import { sql } from 'drizzle-orm';
import { core, errors, num, type RequestContext, type Row } from '$lib/sdk/server';
import { requireNoteAccess } from './access';
import { mdb } from './db';
import { assetPath, IMAGE_TYPES, IMAGE_VARIANTS, removeFiles, storeFile } from './storage';
import type { NoteAsset } from './schemas';

export function assetOf(r: Row): NoteAsset {
	return {
		id: String(r.id),
		kind: r.kind === 'file' ? 'file' : 'image',
		name: String(r.name ?? ''),
		contentType: String(r.content_type ?? ''),
		sizeBytes: num(r.size_bytes),
		width: r.width == null ? null : num(r.width),
		height: r.height == null ? null : num(r.height)
	};
}

export const assetPaths = (v: unknown): Record<string, string> =>
	((typeof v === 'string' ? JSON.parse(v) : v) ?? {}) as Record<string, string>;

/** Bild hochladen (Bearbeiten-Zugriff) → Eintrag */
export async function uploadImage(
	ctx: RequestContext,
	noteId: string,
	file: { bytes: Uint8Array; contentType: string; name: string }
): Promise<NoteAsset> {
	if (!IMAGE_TYPES.includes(file.contentType)) {
		throw errors.validation([
			{ path: ['file'], message: 'Nur Bilder (JPEG, PNG, WebP, AVIF, GIF) erlaubt' }
		]);
	}
	await mdb().transaction((tx) => requireNoteAccess(tx, ctx, noteId, 'edit'));
	const assetId = crypto.randomUUID();
	const processed = await core.images.process(file.bytes, { variants: IMAGE_VARIANTS });
	const paths: Record<string, string> = {};
	let size = 0;
	let web: (typeof processed.variants)[number] | undefined;
	try {
		for (const v of processed.variants) {
			const path = assetPath(noteId, assetId, v.name as 'thumb' | 'web', v.extension);
			await storeFile(path, v.bytes, v.contentType, `${assetId}-${v.name}.${v.extension}`);
			paths[v.name] = path;
			size += v.bytes.byteLength;
			if (v.name === 'web') web = v;
		}
		if (!web) throw errors.unavailable('Bildverarbeitung unvollständig');
		const asset: NoteAsset = {
			id: assetId,
			kind: 'image',
			name: file.name,
			contentType: web.contentType,
			sizeBytes: size,
			width: web.width,
			height: web.height
		};
		await mdb().transaction(async (tx) => {
			await requireNoteAccess(tx, ctx, noteId, 'edit');
			await tx.execute(
				sql`INSERT INTO note_assets (id, note_id, kind, name, content_type, size_bytes, width, height,
						paths, created_by)
					VALUES (${asset.id}, ${noteId}, 'image', ${asset.name}, ${asset.contentType}, ${asset.sizeBytes},
						${asset.width}, ${asset.height}, ${JSON.stringify(paths)}::jsonb, ${ctx.userId})`
			);
		});
		return asset;
	} catch (e) {
		await removeFiles(Object.values(paths));
		throw e;
	}
}
