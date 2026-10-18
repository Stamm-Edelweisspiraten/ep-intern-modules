/**
 * Bild-Logik des Moduls `galleries`: Zeilen-Mapping, Zugehörigkeit, Dateinamen.
 * Termine hängen an der Galerie (siehe `galleries.service.ts`), nicht an einzelnen Bildern.
 */
import { sql } from 'drizzle-orm';
import { errors, type Tx } from '$lib/sdk/server';
import { rowsOf } from './access';
import { type GalleryImage, type ImageVariant } from './schemas';

type Row = Record<string, unknown>;

/** Spalten für `toGalleryImage` (Alias `i` für `gallery_images`) */
export const IMAGE_COLUMNS = sql`i.id, i.gallery_id, i.description, i.position, i.original_name,
	i.content_type, i.width, i.height, i.size_bytes, i.thumb_path, i.web_path, i.full_path,
	i.uploaded_by, i.created_at`;

function iso(v: unknown): string {
	return new Date(String(v)).toISOString();
}

/** Zeile aus `gallery_images` → DTO */
export function toGalleryImage(row: Row): GalleryImage {
	return {
		id: String(row.id),
		description: row.description == null ? null : String(row.description),
		width: Number(row.width),
		height: Number(row.height),
		sizeBytes: Number(row.size_bytes),
		contentType: String(row.content_type),
		originalName: String(row.original_name),
		position: Number(row.position),
		uploadedBy: row.uploaded_by == null ? null : String(row.uploaded_by),
		createdAt: iso(row.created_at)
	};
}

export interface ImagePaths {
	id: string;
	originalName: string;
	paths: Record<ImageVariant, string>;
}

/** Pfade/Name aus einer Bildzeile */
export function imagePathsOf(row: Row): ImagePaths {
	return {
		id: String(row.id),
		originalName: String(row.original_name),
		paths: {
			thumb: String(row.thumb_path),
			web: String(row.web_path),
			full: String(row.full_path)
		}
	};
}

/** Bildzeile einer Galerie oder 404 */
export async function requireImageRow(tx: Tx, galleryId: string, imageId: string): Promise<Row> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT ${IMAGE_COLUMNS} FROM gallery_images i
			WHERE i.id = ${imageId} AND i.gallery_id = ${galleryId}`
	);
	if (!row) throw errors.notFound('Bild nicht gefunden');
	return row;
}

/** Bildzeilen (nur Pfade) zu `ids`; 404, wenn nicht alle zur Galerie gehören */
export async function requireImagesOfGallery(
	tx: Tx,
	galleryId: string,
	ids: readonly string[]
): Promise<ImagePaths[]> {
	if (ids.length === 0) return [];
	const rows = await rowsOf(
		tx,
		sql`SELECT i.id, i.original_name, i.thumb_path, i.web_path, i.full_path
			FROM gallery_images i
			WHERE i.gallery_id = ${galleryId} AND i.id IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)})`
	);
	if (rows.length !== ids.length) throw errors.notFound('Bild nicht gefunden');
	return rows.map(imagePathsOf);
}

/** Dateiname für die Anzeige/Speicherung: ohne Pfad und Steuerzeichen, höchstens 200 Zeichen */
export function sanitizeOriginalName(name: string | null | undefined): string {
	const base = (name ?? '').split(/[\\/]/).pop() ?? '';
	const cleaned = base
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200)
		.trim();
	return cleaned || 'bild';
}

/** Download-Name der `full`-Variante: Originalname mit der Endung der gespeicherten Datei */
export function downloadName(originalName: string, fullPath: string): string {
	const ext = /\.([A-Za-z0-9]+)$/.exec(fullPath)?.[1] ?? 'jpg';
	const stem = originalName.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'bild';
	return `${stem}.${ext}`;
}
