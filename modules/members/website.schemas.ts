/**
 * Vertrag der Website-Endpunkte von `members` (#48): Zod-Schema des öffentlichen Gruppen-DTOs. Die
 * Integrationstests parsen die Antworten dagegen; die Typprüfung hält Schema und DTO deckungsgleich.
 */
import { z } from 'zod';
import { GROUP_TYPES, type WebsiteGroup } from './schemas';

/** Exakte Typgleichheit (beide Richtungen) */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const websiteGroupSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		name: z.string(),
		type: z.enum(GROUP_TYPES),
		description: z.string().nullable(),
		ageRange: z.string().nullable(),
		ageMin: z.number().int().min(0).max(99).nullable(),
		ageMax: z.number().int().min(0).max(99).nullable(),
		meetingPlace: z.string().nullable(),
		meetingWeekday: z.number().int().min(1).max(7).nullable(),
		meetingTime: hhmm.nullable(),
		meetingEndTime: hhmm.nullable(),
		color: z.string().nullable(),
		contactEmail: z.string().nullable(),
		leaders: z.array(z.object({ firstName: z.string() }).strict()),
		imagePath: z.string().nullable()
	})
	.strict();

const _groupExact: Exact<z.infer<typeof websiteGroupSchema>, WebsiteGroup> = true;
void _groupExact;
