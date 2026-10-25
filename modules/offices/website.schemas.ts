/**
 * Vertrag der Website-Endpunkte von `offices` (#48): Zod-Schema des öffentlichen DTOs. Die
 * Integrationstests parsen die Antworten dagegen; die Typprüfung hält Schema und DTO deckungsgleich.
 */
import { z } from 'zod';
import type { WebsiteOffice } from './schemas';

/** Exakte Typgleichheit (beide Richtungen) */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const websiteOfficeHolderSchema = z
	.object({
		id: z.string(),
		firstName: z.string(),
		bio: z.string().nullable(),
		since: z.string().nullable(),
		avatarPath: z.string().nullable()
	})
	.strict();

export const websiteOfficeSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string().nullable(),
		position: z.number().int(),
		emails: z.array(z.object({ label: z.string().nullable(), email: z.string() }).strict()),
		holders: z.array(websiteOfficeHolderSchema)
	})
	.strict();

const _officeExact: Exact<z.infer<typeof websiteOfficeSchema>, WebsiteOffice> = true;
void _officeExact;
