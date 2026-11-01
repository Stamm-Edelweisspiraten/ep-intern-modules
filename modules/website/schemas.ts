/**
 * API-Vertrag des Moduls `website` (Inhalte der Stammeswebsite): Banner/Hinweise, FAQ und Blog-Beiträge.
 * Rein (Zod + Typen), Client und Server.
 */
import { z } from 'zod';
import { SLUG_PATTERN } from '$lib/sdk/slug';

export const MODULE_ID = 'website';
/** Benachrichtigungen (core.notifications): zum Mitschreiben eingeladen, Beitrag veröffentlicht/zurückgezogen */
export const NOTIFY_POST_INVITED = 'post-invited';
export const NOTIFY_POST_STATUS = 'post-status';

export const PERM = {
	contentManage: 'website.content.manage',
	postWrite: 'website.post.write',
	postPublish: 'website.post.publish',
	contentRead: 'website.content.read'
} as const;

export const MAX_BANNER_TEXT = 500;
export const MAX_BANNER_TITLE = 100;
export const MAX_BANNERS = 50;
export const MAX_FAQ_QUESTION = 200;
export const MAX_FAQ_ANSWER = 5000;
export const MAX_FAQS = 100;
export const MAX_POST_TITLE = 150;
export const MAX_POST_TEASER = 300;
export const MAX_POST_BODY = 100_000;
export const MAX_SLUG = 80;
export const MAX_TAGS = 10;
export const MAX_TAG = 40;
export const MAX_POST_GROUPS = 20;
export const MAX_POST_IMAGES = 100;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_SHARES = 50;
export const IMAGE_CONTENT_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/gif'
] as const;

export const BANNER_LEVELS = ['info', 'important'] as const;
export type BannerLevel = (typeof BANNER_LEVELS)[number];
export const BANNER_PLACEMENTS = ['bar', 'home'] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];
export const POST_STATUSES = ['draft', 'published'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const IMAGE_VARIANTS = ['thumb', 'web'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

const uuid = z.string().uuid('Ungültige ID');
export const idParams = z.object({ id: uuid });
export const imageParams = z.object({ id: uuid, imageId: uuid, variant: z.enum(IMAGE_VARIANTS) });

/** Leerer Text → `null` */
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

/** ISO-Zeitpunkt (mit Zeitzone) oder `null` */
const optionalInstant = z
	.string()
	.trim()
	.nullish()
	.transform((v) => (v ? v : null))
	.refine((v) => v === null || !Number.isNaN(Date.parse(v)), 'Ungültiger Zeitpunkt');

/** Link: relativer Website-Pfad (`/…`) oder http(s)/mailto */
export const linkUrl = z
	.string()
	.trim()
	.max(500, 'Höchstens 500 Zeichen')
	.nullish()
	.transform((v) => (v ? v : null))
	.refine(
		(v) => v === null || /^\/(?!\/)[^\s]*$/.test(v) || /^(https?:\/\/|mailto:)[^\s]+$/i.test(v),
		'Link muss mit „/“, „https://“ oder „mailto:“ beginnen'
	);

export const slugInput = z
	.string()
	.trim()
	.min(1, 'Pflichtfeld')
	.max(MAX_SLUG, `Höchstens ${MAX_SLUG} Zeichen`)
	.regex(SLUG_PATTERN, 'Nur Kleinbuchstaben, Ziffern und einzelne Bindestriche');

const tagList = z
	.array(z.string().trim().min(1).max(MAX_TAG, `Höchstens ${MAX_TAG} Zeichen`))
	.max(MAX_TAGS, `Höchstens ${MAX_TAGS} Themen`)
	.transform((tags) => {
		const seen = new Set<string>();
		return tags.filter((t) => {
			const k = t.toLocaleLowerCase('de');
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	});

export const orderInput = z.object({ ids: z.array(uuid).max(200) });

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export const bannerInput = z
	.object({
		title: optionalText(MAX_BANNER_TITLE),
		text: z
			.string()
			.trim()
			.min(1, 'Pflichtfeld')
			.max(MAX_BANNER_TEXT, `Höchstens ${MAX_BANNER_TEXT} Zeichen`),
		level: z.enum(BANNER_LEVELS).default('info'),
		placement: z.enum(BANNER_PLACEMENTS).default('bar'),
		linkUrl,
		linkLabel: optionalText(60),
		startsAt: optionalInstant,
		endsAt: optionalInstant,
		dismissible: z.boolean().default(true),
		active: z.boolean().default(true)
	})
	.superRefine((v, ctx) => {
		if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
			ctx.addIssue({
				code: 'custom',
				path: ['endsAt'],
				message: 'Ende muss nach dem Beginn liegen'
			});
		}
		if (v.linkLabel && !v.linkUrl) {
			ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: 'Link fehlt' });
		}
	});
export type BannerInput = z.infer<typeof bannerInput>;

/** Zustand eines Banners zum jetzigen Zeitpunkt */
export type BannerState = 'live' | 'scheduled' | 'expired' | 'inactive';

export interface Banner {
	id: string;
	title: string | null;
	text: string;
	level: BannerLevel;
	placement: BannerPlacement;
	linkUrl: string | null;
	linkLabel: string | null;
	startsAt: string | null;
	endsAt: string | null;
	dismissible: boolean;
	active: boolean;
	position: number;
	state: BannerState;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

export const faqInput = z.object({
	question: z
		.string()
		.trim()
		.min(1, 'Pflichtfeld')
		.max(MAX_FAQ_QUESTION, `Höchstens ${MAX_FAQ_QUESTION} Zeichen`),
	answerHtml: z.string().max(MAX_FAQ_ANSWER * 4, 'Antwort zu lang'),
	featured: z.boolean().default(true),
	active: z.boolean().default(true)
});
export type FaqInput = z.infer<typeof faqInput>;

export interface Faq {
	id: string;
	question: string;
	answerHtml: string;
	featured: boolean;
	active: boolean;
	position: number;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Beiträge
// ---------------------------------------------------------------------------

export const postCreateInput = z.object({
	title: z
		.string()
		.trim()
		.min(1, 'Pflichtfeld')
		.max(MAX_POST_TITLE, `Höchstens ${MAX_POST_TITLE} Zeichen`)
});

export const postUpdateInput = z
	.object({
		title: z
			.string()
			.trim()
			.min(1, 'Pflichtfeld')
			.max(MAX_POST_TITLE, `Höchstens ${MAX_POST_TITLE} Zeichen`),
		slug: slugInput,
		teaser: optionalText(MAX_POST_TEASER),
		bodyHtml: z.string().max(MAX_POST_BODY, 'Text zu lang'),
		coverImageId: uuid.nullable(),
		authorNameOverride: optionalText(60),
		tags: tagList,
		groupIds: z.array(uuid).max(MAX_POST_GROUPS),
		eventId: z.string().trim().max(100).nullable(),
		galleryId: uuid.nullable()
	})
	.partial();
export type PostUpdateInput = z.infer<typeof postUpdateInput>;

export const publishInput = z.object({
	/** Veröffentlichungszeitpunkt (Zukunft = geplant); ohne Angabe sofort */
	publishedAt: optionalInstant
});

export const postListQuery = z.object({
	status: z.enum(['all', 'draft', 'published', 'scheduled']).default('all'),
	tag: z.string().trim().max(MAX_TAG).optional(),
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});
export type PostListQuery = z.infer<typeof postListQuery>;

export const shareInput = z.object({
	type: z.enum(['user', 'role', 'group', 'member']),
	id: z.string().trim().min(1).max(100),
	level: z.literal('edit').default('edit')
});
export const sharesInput = z.object({ shares: z.array(shareInput).max(MAX_SHARES) });
export const imageUpdateInput = z.object({ alt: optionalText(300) });

export const principalSearchQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});
export const refSearchQuery = z.object({
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(50).default(20)
});

export interface PostAccess {
	level: 'read' | 'edit';
	isOwner: boolean;
	canPublish: boolean;
}

export interface PostImage {
	id: string;
	alt: string | null;
	width: number;
	height: number;
}

export interface PostShare {
	type: 'user' | 'role' | 'group' | 'member';
	id: string;
	name: string;
	detail: string | null;
	color: string | null;
	image: string | null;
	level: 'edit';
}

export interface PostListItem {
	id: string;
	slug: string;
	title: string;
	teaser: string | null;
	status: PostStatus;
	publishedAt: string | null;
	/** veröffentlicht und Zeitpunkt erreicht */
	live: boolean;
	coverImageId: string | null;
	tags: string[];
	authorId: string | null;
	authorName: string;
	access: PostAccess;
	createdAt: string;
	updatedAt: string;
}

export interface PostDetail extends PostListItem {
	bodyHtml: string;
	authorNameOverride: string | null;
	groupIds: string[];
	eventId: string | null;
	galleryId: string | null;
	/** Anzeige der Verknüpfungen (nur für den Aufrufer sichtbare Termine, öffentliche Galerien) */
	eventRef: RefOption | null;
	galleryRef: RefOption | null;
	images: PostImage[];
	shares: PostShare[];
}

export interface PostListPage {
	items: PostListItem[];
	total: number;
}

export interface RefOption {
	id: string;
	label: string;
	detail: string | null;
	color: string | null;
}

// ---------------------------------------------------------------------------
// Website-DTOs (API-Key mit Scope `website.content.read`)
// ---------------------------------------------------------------------------

export interface WebsiteBanner {
	id: string;
	title: string | null;
	text: string;
	level: BannerLevel;
	placement: BannerPlacement;
	linkUrl: string | null;
	linkLabel: string | null;
	dismissible: boolean;
	updatedAt: string;
}

export interface WebsiteFaq {
	id: string;
	question: string;
	/** bereinigtes HTML (einfache Formatierung, Links) */
	answerHtml: string;
	featured: boolean;
}

export interface WebsitePostImage {
	id: string;
	width: number;
	height: number;
	alt: string | null;
}

export interface WebsitePostSummary {
	slug: string;
	title: string;
	teaser: string | null;
	publishedAt: string;
	cover: WebsitePostImage | null;
	tags: string[];
	/** nur Vorname bzw. die eingetragene Anzeige */
	authorName: string | null;
}

export interface WebsiteTagCount {
	tag: string;
	count: number;
}

export interface WebsitePostPage {
	items: WebsitePostSummary[];
	total: number;
	tags: WebsiteTagCount[];
}

export interface WebsitePost extends WebsitePostSummary {
	/** bereinigtes HTML; Bilder als `<img data-image-id="…" alt="…">` (Maße in `images`) */
	bodyHtml: string;
	images: WebsitePostImage[];
	groupIds: string[];
	eventId: string | null;
	galleryId: string | null;
	updatedAt: string;
}

export const websitePostsQuery = z.object({
	tag: z.string().trim().max(MAX_TAG).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(12),
	offset: z.coerce.number().int().min(0).default(0)
});
export const websiteSlugParams = z.object({ slug: slugInput });
export const websiteImageParams = z.object({
	slug: slugInput,
	imageId: uuid,
	variant: z.enum(IMAGE_VARIANTS)
});

// ---------------------------------------------------------------------------
// Reine Helfer
// ---------------------------------------------------------------------------

/** Zustand eines Banners zum Zeitpunkt `now` */
export function bannerState(
	b: { active: boolean; startsAt: string | null; endsAt: string | null },
	now: number = Date.now()
): BannerState {
	if (!b.active) return 'inactive';
	if (b.endsAt && Date.parse(b.endsAt) <= now) return 'expired';
	if (b.startsAt && Date.parse(b.startsAt) > now) return 'scheduled';
	return 'live';
}

/** Vorname = erstes Wort des Kontonamens („Anna-Lena Muster“ → „Anna-Lena“) */
export function firstNameOf(name: string): string {
	return name.trim().split(/\s+/)[0] ?? '';
}
