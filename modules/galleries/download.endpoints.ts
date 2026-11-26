/**
 * Ganze Galerie als ZIP herunterladen (eigenes Recht `galleries.gallery.download`).
 *
 * Inhalt: je Bild die Variante `full` (metadatenfrei), je Video die Videodatei – in Upload-Reihenfolge,
 * auch Einträge „nur intern“ (interner Download). Das ZIP wird **gestreamt** (fflate, ohne Kompression –
 * Bilder und Videos sind schon komprimiert): Dateien werden nacheinander aus dem Storage gelesen, nie
 * komplett im Arbeitsspeicher gesammelt. fflate schreibt kein ZIP64 → Obergrenze `MAX_ZIP_BYTES`.
 * Core-Aufrufe (Storage, Audit) laufen außerhalb der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import { Zip, ZipPassThrough } from 'fflate';
import { safeFileName } from '$lib/sdk/file-names';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	principalKeysFor,
	rowsOf,
	secureFileResponse,
	toIso
} from '$lib/sdk/server';
import { requireAccess } from './access';
import { db, filesCtx } from './files';
import { downloadName } from './images.service';
import { DOWNLOAD_PERMISSION, idParams, MODULE_ID } from './schemas';

const tags = ['Modul: galleries'];

/** Unter der ZIP32-Grenze von 4 GiB (Header und Verzeichnis eingerechnet) */
export const MAX_ZIP_BYTES = 3.5 * 1024 * 1024 * 1024;

export interface ZipEntry {
	/** Name im Archiv (eindeutig) */
	name: string;
	/** Storage-Pfad */
	path: string;
	mtime: Date;
}

/**
 * Eindeutige, bereinigte Dateinamen (`bild.jpg`, `bild (2).jpg`, …); Vergleich ohne Groß-/Kleinschreibung,
 * weil Windows und macOS beim Entpacken sonst überschreiben.
 */
export function uniqueNames(names: readonly string[]): string[] {
	const used = new Set<string>();
	return names.map((raw) => {
		const clean = safeFileName(raw, { german: true, fallback: 'bild' });
		const ext = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? '';
		const stem = ext ? clean.slice(0, -ext.length) : clean;
		let name = clean;
		for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
		used.add(name.toLowerCase());
		return name;
	});
}

/** ZIP als Stream: liest die Dateien nacheinander (Backpressure über `pull`) */
export function zipStream(entries: readonly ZipEntry[]): ReadableStream<Uint8Array> {
	let zip: Zip;
	let index = 0;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let entry: ZipPassThrough | null = null;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			zip = new Zip((err, chunk, final) => {
				if (err) {
					controller.error(err);
					return;
				}
				if (chunk.length) controller.enqueue(chunk);
				if (final) controller.close();
			});
		},
		async pull(controller) {
			try {
				for (;;) {
					if (!reader) {
						if (index >= entries.length) {
							zip.end();
							return;
						}
						const e = entries[index++]!;
						const { stream } = await core.storage.downloadStream(filesCtx(), {
							module: MODULE_ID,
							path: e.path
						});
						entry = new ZipPassThrough(e.name);
						entry.mtime = e.mtime;
						zip.add(entry);
						reader = stream.getReader();
					}
					const { done, value } = await reader.read();
					if (done) {
						entry!.push(new Uint8Array(0), true);
						reader = null;
						entry = null;
						return;
					}
					if (value?.length) {
						entry!.push(value);
						return;
					}
				}
			} catch (e) {
				controller.error(e);
			}
		},
		async cancel() {
			await reader?.cancel().catch(() => {});
		}
	});
}

export const downloadEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/galleries/:id/download',
		summary: 'Ganze Galerie als ZIP herunterladen',
		description:
			'Braucht zusätzlich `galleries.gallery.download` und Lesezugriff auf die Galerie. Enthält je ' +
			'Bild die Variante `full` (ohne Metadaten) und je Video die Videodatei, auch Einträge „nur ' +
			'intern“. Gestreamt, ohne Kompression; leere Galerie → 422, mehr als 3,5 GB → 413.',
		tags,
		permission: 'galleries.gallery.view',
		params: idParams,
		rateLimit: { limit: 10, windowSec: 60 },
		handler: async ({ ctx, params }) => {
			await core.permissions.require(ctx, DOWNLOAD_PERMISSION);
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const { title, rows } = await db().transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'read');
				const [g] = await rowsOf(tx, sql`SELECT title FROM galleries WHERE id = ${params.id}`);
				if (!g) throw errors.notFound('Galerie nicht gefunden');
				const rows = await rowsOf(
					tx,
					sql`SELECT id, original_name, full_path, media_type, size_bytes, created_at
						FROM gallery_images WHERE gallery_id = ${params.id} ORDER BY created_at, id`
				);
				return { title: String(g.title), rows };
			});
			if (rows.length === 0) {
				throw errors.validation([{ path: ['id'], message: 'Die Galerie enthält keine Bilder' }]);
			}
			const total = rows.reduce((sum, r) => sum + Number(r.size_bytes ?? 0), 0);
			if (total > MAX_ZIP_BYTES) {
				throw errors.tooLarge(
					'Die Galerie ist zu groß für einen ZIP-Download (höchstens 3,5 GB). Bitte Bilder einzeln herunterladen.'
				);
			}
			const names = uniqueNames(
				rows.map((r) => downloadName(String(r.original_name), String(r.full_path)))
			);
			const entries: ZipEntry[] = rows.map((r, i) => ({
				name: names[i]!,
				path: String(r.full_path),
				mtime: new Date(toIso(r.created_at))
			}));
			const videos = rows.filter((r) => String(r.media_type) === 'video').length;
			await core.audit.logFromContext(ctx, 'galleries.gallery.downloaded', {
				target: params.id,
				metadata: { images: rows.length - videos, videos }
			});
			return secureFileResponse(zipStream(entries), {
				contentType: 'application/zip',
				name: `${safeFileName(title, { german: true, fallback: 'galerie' })}.zip`,
				download: true,
				cache: 'no-store'
			});
		}
	})
];
