/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Daten eines Benutzerkontos im Modul
 * Galerien – eigene Galerien, hochgeladene Bilder (nur Metadaten, keine Bilddaten), Freigaben an das
 * Konto und Veröffentlichungs-Bestätigungen. Mitglieder ohne Konto haben hier keine Daten.
 * Eigene Modul-Transaktion, keine Core-Services darin.
 */
import { sql } from 'drizzle-orm';
import { type ModuleSubjectExport, rowsOf, toIso } from '$lib/sdk/server';
import { db } from './files';

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export const subjectExport: ModuleSubjectExport = {
	run: async ({ userId }) => {
		if (!userId) return null;
		const data = await db().transaction(async (tx) => {
			const owned = await rowsOf(
				tx,
				sql`SELECT id, title, description, visibility, created_at, updated_at
					FROM galleries WHERE owner_id = ${userId} ORDER BY created_at, id`
			);
			const uploads = await rowsOf(
				tx,
				sql`SELECT id, gallery_id, description, original_name, content_type, size_bytes, created_at
					FROM gallery_images WHERE uploaded_by = ${userId} ORDER BY created_at, id`
			);
			const shares = await rowsOf(
				tx,
				sql`SELECT s.gallery_id, g.title, s.level, s.created_at
					FROM gallery_shares s JOIN galleries g ON g.id = s.gallery_id
					WHERE s.principal_type = 'user' AND s.principal_id = ${userId}
					ORDER BY s.created_at, s.gallery_id`
			);
			const confirmations = await rowsOf(
				tx,
				sql`SELECT id, title, visibility, public_confirmed_at
					FROM galleries WHERE public_confirmed_by = ${userId} ORDER BY public_confirmed_at, id`
			);
			return { owned, uploads, shares, confirmations };
		});
		if (
			!data.owned.length &&
			!data.uploads.length &&
			!data.shares.length &&
			!data.confirmations.length
		) {
			return null;
		}
		return {
			ownedGalleries: data.owned.map((r) => ({
				id: String(r.id),
				title: String(r.title),
				description: text(r.description),
				visibility: String(r.visibility),
				createdAt: toIso(r.created_at),
				updatedAt: toIso(r.updated_at)
			})),
			uploadedImages: data.uploads.map((r) => ({
				id: String(r.id),
				galleryId: String(r.gallery_id),
				description: text(r.description),
				originalName: String(r.original_name),
				contentType: String(r.content_type),
				sizeBytes: Number(r.size_bytes),
				createdAt: toIso(r.created_at)
			})),
			sharesToAccount: data.shares.map((r) => ({
				galleryId: String(r.gallery_id),
				galleryTitle: String(r.title),
				level: String(r.level),
				createdAt: toIso(r.created_at)
			})),
			publishConfirmations: data.confirmations.map((r) => ({
				galleryId: String(r.id),
				galleryTitle: String(r.title),
				visibility: String(r.visibility),
				confirmedAt: toIso(r.public_confirmed_at)
			}))
		};
	}
};
