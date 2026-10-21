/**
 * API-Vertrag des Moduls `galleries` (Bilder / Galerien): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';
import { PRINCIPAL_TYPES, type PrincipalType } from '$lib/sdk/types/sharing';

export const MODULE_ID = 'galleries';

/** Recht zum Veröffentlichen (Sichtbarkeit „öffentlich“ = Stammeswebsite), #67 01b-06 */
export const PUBLISH_PERMISSION = 'galleries.gallery.publish';

export const VISIBILITIES = ['private', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<Visibility, string> = {
	private: 'Privat',
	public: 'Öffentlich'
};
export const VISIBILITY_DESCRIPTIONS: Record<Visibility, string> = {
	private: 'Nur Eigentümer*in und Personen mit Freigabe',
	public: 'Für alle intern sichtbar und für die Stammeswebsite abrufbar'
};

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_LEVEL_LABELS: Record<ShareLevel, string> = { read: 'Sehen', edit: 'Bearbeiten' };

/** Bildvarianten (vom Server mit `core.images` erzeugt) */
export const IMAGE_VARIANTS = ['thumb', 'web', 'full'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];
/** Für die Website freigegebene Varianten (`full` nur intern) */
export const WEBSITE_VARIANTS = ['thumb', 'web'] as const;
export type WebsiteVariant = (typeof WEBSITE_VARIANTS)[number];

/** Annahme beim Upload (Inhalt wird serverseitig zusätzlich per sharp geprüft) */
export const IMAGE_CONTENT_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/gif'
] as const;
export const IMAGE_ACCEPT = IMAGE_CONTENT_TYPES.join(',');
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES_PER_GALLERY = 2000;
export const MAX_EVENTS_PER_GALLERY = 20;
export const MAX_SHARES = 200;
export const MAX_BULK = 200;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_IMAGE_DESCRIPTION = 2000;
/** Gleichzeitige Uploads im Browser */
export const UPLOAD_CONCURRENCY = 3;

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

const refId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9*_-]+$/, 'Ungültige ID');

/** Termin-ID aus `events` (dort `text`, UUID) */
export const eventId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Ungültige Termin-ID');

export const shareInput = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: refId,
		level: z.enum(SHARE_LEVELS)
	})
	.strict();
export type ShareInput = z.infer<typeof shareInput>;

const eventIdList = z
	.array(eventId)
	.max(MAX_EVENTS_PER_GALLERY, `Höchstens ${MAX_EVENTS_PER_GALLERY} Termine`)
	.transform((ids) => [...new Set(ids)]);

/** POST/PUT `/galleries[/:id]` – PUT ersetzt alles (auch Freigaben und Termine) */
export const galleryInput = z
	.object({
		title: z.string().trim().min(1, 'Pflichtfeld').max(MAX_TITLE, `Höchstens ${MAX_TITLE} Zeichen`),
		description: optionalText(MAX_DESCRIPTION),
		visibility: z.enum(VISIBILITIES).default('private'),
		shares: z.array(shareInput).max(MAX_SHARES).default([]),
		/** Termine aus `events`, denen die ganze Galerie zugeordnet ist */
		eventIds: eventIdList.default([]),
		/**
		 * Bestätigung „für alle erkennbaren Personen liegt eine Website-Einwilligung vor“ – Pflicht,
		 * wenn die Galerie dadurch öffentlich wird (Neuanlage öffentlich oder Wechsel privat → öffentlich)
		 */
		consentConfirmed: z.boolean().optional()
	})
	.strict()
	.superRefine((v, ctx) => {
		const seen = new Set<string>();
		v.shares.forEach((s, i) => {
			const k = `${s.type}:${s.id}`;
			if (seen.has(k)) {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Doppelte Freigabe' });
			}
			seen.add(k);
			if (s.type === 'everyone' && s.id !== '*') {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Ungültige ID' });
			}
		});
	});
export type GalleryInput = z.infer<typeof galleryInput>;

/** PUT `/galleries/:id/cover` – `null` = Standard (zuerst hochgeladenes Bild) */
export const coverInput = z.object({ imageId: z.uuid('Ungültige ID').nullable() }).strict();

/** Textfelder des Upload-Formulars (multipart; Datei im Feld `file`) */
export const uploadFields = z.object({ description: optionalText(MAX_IMAGE_DESCRIPTION) });

/** PUT `/galleries/:id/images/:imageId` – ersetzt die Beschreibung */
export const imageUpdateInput = z
	.object({ description: optionalText(MAX_IMAGE_DESCRIPTION) })
	.strict();
export type ImageUpdateInput = z.infer<typeof imageUpdateInput>;

export const BULK_ACTIONS = ['delete'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** POST `/galleries/:id/images/bulk` */
export const imageBulkInput = z
	.object({
		action: z.enum(BULK_ACTIONS),
		ids: z
			.array(z.uuid('Ungültige ID'))
			.min(1)
			.max(MAX_BULK)
			.transform((ids) => [...new Set(ids)])
	})
	.strict();
export type ImageBulkInput = z.infer<typeof imageBulkInput>;

export const idParams = z.object({ id: z.uuid('Ungültige ID') });
export const imageParams = z.object({
	id: z.uuid('Ungültige ID'),
	imageId: z.uuid('Ungültige ID')
});
export const variantParams = imageParams.extend({ variant: z.enum(IMAGE_VARIANTS) });
export const websiteVariantParams = imageParams.extend({ variant: z.enum(WEBSITE_VARIANTS) });

export const listQuery = z.object({
	search: z.string().trim().max(100).optional(),
	visibility: z.enum(VISIBILITIES).optional(),
	eventId: eventId.optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});
export type ListQuery = z.infer<typeof listQuery>;

export const principalSearchQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});

export const eventSearchQuery = z.object({
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(50).default(20)
});

export const websiteListQuery = z.object({
	/** Nur Galerien zu diesem Termin (der Termin muss „auf der Website“ stehen) */
	eventId: eventId.optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface GalleryAccess {
	level: ShareLevel;
	isOwner: boolean;
}

export interface GalleryShare {
	type: PrincipalType;
	id: string;
	name: string;
	detail: string | null;
	color: string | null;
	/** Profil- bzw. Gruppenbild oder `null` */
	image: string | null;
	level: ShareLevel;
}

/** Termin-Verweis (aus `events`, nur für den Aufrufer sichtbare Termine) */
export interface EventRef {
	id: string;
	title: string;
	startsOn: string;
	endsOn: string | null;
	color: string | null;
}

export interface ImageCover {
	imageId: string;
	width: number;
	height: number;
}

export interface GalleryItem {
	id: string;
	title: string;
	description: string | null;
	visibility: Visibility;
	imageCount: number;
	/** Effektives Titelbild (gesetzt oder ältestes Bild); `null` ohne Bilder */
	cover: ImageCover | null;
	/** Zugeordnete Termine, nur die für den Aufrufer sichtbaren */
	events: EventRef[];
	ownerId: string;
	access: GalleryAccess;
	createdAt: string;
	updatedAt: string;
}

export interface GalleryImage {
	id: string;
	description: string | null;
	width: number;
	height: number;
	sizeBytes: number;
	contentType: string;
	originalName: string;
	position: number;
	uploadedBy: string | null;
	createdAt: string;
}

export interface GalleryDetail extends GalleryItem {
	owner: { id: string; name: string; image: string | null } | null;
	/** Effektives Titelbild (wie `cover.imageId`) */
	coverImageId: string | null;
	/**
	 * Letzte Bestätigung der Einwilligungen beim Veröffentlichen (`by` = `null`, wenn das Konto nicht
	 * mehr existiert); bleibt nach dem Zurückstellen auf privat als Historie erhalten
	 */
	publicConfirmation: { at: string; by: { id: string; name: string } | null } | null;
	/** `true`, wenn kein Titelbild gesetzt ist (ältestes Bild gilt) */
	coverIsDefault: boolean;
	/** Nur bei Bearbeiten-Zugriff, sonst `[]` */
	shares: GalleryShare[];
	images: GalleryImage[];
}

export interface GalleryList {
	items: GalleryItem[];
	total: number;
}

export interface BulkResult {
	affected: number;
}

// Website (nur öffentliche Felder: keine Freigaben, Eigentümer*innen, Dateinamen, Uploader)
export interface WebsiteEventRef {
	id: string;
	title: string;
	startsOn: string;
	endsOn: string | null;
}

export interface WebsiteGallery {
	id: string;
	title: string;
	description: string | null;
	imageCount: number;
	cover: ImageCover | null;
	/** Nur Termine mit „auf der Website“ */
	events: WebsiteEventRef[];
	updatedAt: string;
}

export interface WebsiteImage {
	id: string;
	galleryId: string;
	description: string | null;
	width: number;
	height: number;
	position: number;
}

export interface WebsiteGalleryDetail extends WebsiteGallery {
	images: WebsiteImage[];
}

/** Relativer Pfad der Bilddatei für `apiFetch`/`<img src>` (intern) */
export function imageUrl(galleryId: string, imageId: string, variant: ImageVariant): string {
	return `/api/v1/modules/galleries/galleries/${galleryId}/images/${imageId}/${variant}`;
}
