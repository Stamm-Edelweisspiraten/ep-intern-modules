/**
 * Vertrag der Website-Endpunkte von `galleries` (#48): Zod-Schemas der öffentlichen DTOs. Die
 * Integrationstests parsen die Antworten dagegen; die Typprüfung hält Schema und DTO deckungsgleich.
 */
import { z } from 'zod';
import type { WebsiteGallery, WebsiteGalleryDetail } from './schemas';

/** Exakte Typgleichheit (beide Richtungen) */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const websiteEventRefSchema = z
	.object({ id: z.string(), title: z.string(), startsOn: isoDate, endsOn: isoDate.nullable() })
	.strict();

export const websiteGallerySchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string().nullable(),
		imageCount: z.number().int().min(0),
		cover: z
			.object({ imageId: z.string(), width: z.number(), height: z.number() })
			.strict()
			.nullable(),
		events: z.array(websiteEventRefSchema),
		updatedAt: z.string()
	})
	.strict();

export const websiteGalleryDetailSchema = websiteGallerySchema
	.extend({
		images: z.array(
			z
				.object({
					id: z.string(),
					galleryId: z.string(),
					description: z.string().nullable(),
					width: z.number(),
					height: z.number(),
					position: z.number().int()
				})
				.strict()
		)
	})
	.strict();

/** `GET /website/galleries` */
export const websiteGalleryListSchema = z
	.object({ items: z.array(websiteGallerySchema), total: z.number().int().min(0) })
	.strict();

const _galleryExact: Exact<z.infer<typeof websiteGallerySchema>, WebsiteGallery> = true;
const _detailExact: Exact<z.infer<typeof websiteGalleryDetailSchema>, WebsiteGalleryDetail> = true;
void _galleryExact;
void _detailExact;
