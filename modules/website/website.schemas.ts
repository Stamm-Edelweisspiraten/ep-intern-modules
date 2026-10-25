/**
 * Vertrag der Website-Endpunkte von `website`: Zod-Schemas der öffentlichen DTOs. Die Integrationstests parsen die
 * Antworten dagegen; die Typprüfung hält Schema und DTO deckungsgleich.
 */
import { z } from 'zod';
import type {
	WebsiteBanner,
	WebsiteFaq,
	WebsitePost,
	WebsitePostPage,
	WebsitePostSummary
} from './schemas';

/** Exakte Typgleichheit (beide Richtungen) */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const websiteBannerSchema = z
	.object({
		id: z.string(),
		title: z.string().nullable(),
		text: z.string(),
		level: z.enum(['info', 'important']),
		placement: z.enum(['bar', 'home']),
		linkUrl: z.string().nullable(),
		linkLabel: z.string().nullable(),
		dismissible: z.boolean(),
		updatedAt: z.string()
	})
	.strict();

export const websiteFaqSchema = z
	.object({ id: z.string(), question: z.string(), answerHtml: z.string(), featured: z.boolean() })
	.strict();

const imageSchema = z
	.object({ id: z.string(), width: z.number(), height: z.number(), alt: z.string().nullable() })
	.strict();

export const websitePostSummarySchema = z
	.object({
		slug: z.string(),
		title: z.string(),
		teaser: z.string().nullable(),
		publishedAt: z.string(),
		cover: imageSchema.nullable(),
		tags: z.array(z.string()),
		authorName: z.string().nullable()
	})
	.strict();

export const websitePostPageSchema = z
	.object({
		items: z.array(websitePostSummarySchema),
		total: z.number().int().min(0),
		tags: z.array(z.object({ tag: z.string(), count: z.number().int() }).strict())
	})
	.strict();

export const websitePostSchema = websitePostSummarySchema
	.extend({
		bodyHtml: z.string(),
		images: z.array(imageSchema),
		groupIds: z.array(z.string()),
		eventId: z.string().nullable(),
		galleryId: z.string().nullable(),
		updatedAt: z.string()
	})
	.strict();

const _banner: Exact<z.infer<typeof websiteBannerSchema>, WebsiteBanner> = true;
const _faq: Exact<z.infer<typeof websiteFaqSchema>, WebsiteFaq> = true;
const _summary: Exact<z.infer<typeof websitePostSummarySchema>, WebsitePostSummary> = true;
const _page: Exact<z.infer<typeof websitePostPageSchema>, WebsitePostPage> = true;
const _post: Exact<z.infer<typeof websitePostSchema>, WebsitePost> = true;
void _banner;
void _faq;
void _summary;
void _page;
void _post;
