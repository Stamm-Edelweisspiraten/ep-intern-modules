/**
 * Löschfrist ehemaliger Mitglieder (#30): Vorschlagsliste und Sammel-Anonymisieren.
 * Beide Endpunkte brauchen `members.member.delete` (und `members.member.view` für die Liste).
 */
import { z } from 'zod';
import { core, defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import { anonymizeMembers, listRetentionCandidates } from './retention.service';

const tags = ['Mitglieder'];

export const anonymizeInput = z
	.object({
		ids: z.array(z.uuid('Ungültige ID')).min(1, 'Mindestens ein Mitglied').max(200)
	})
	.strict();

export const retentionEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/retention',
		summary: 'Ehemalige Mitglieder mit abgelaufener Löschfrist (Vorschlag)',
		description:
			'Austritt länger als `members.retention.exitYears` Jahre her und noch nicht anonymisiert; ' +
			'höchstens 500 Einträge (`total` = Gesamtzahl).',
		tags,
		permission: 'members.member.delete',
		handler: async ({ ctx }) => {
			await core.permissions.require(ctx, 'members.member.view');
			return listRetentionCandidates();
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/retention/anonymize',
		summary: 'Ehemalige Mitglieder anonymisieren (nur mit abgelaufener Frist)',
		description:
			'Entfernt Namen, Kontakte, Anschrift, Zusatzfelder, Einwilligungen, Verknüpfungen und ' +
			'Dokumente; andere Module anonymisieren ihre Kopien (z. B. Teilnehmende in Aktionen). ' +
			'Nicht fällige Mitglieder werden mit Grund übersprungen.',
		tags,
		permission: 'members.member.delete',
		body: anonymizeInput,
		rateLimit: { limit: 20, windowSec: 600 },
		handler: ({ ctx, body }) => anonymizeMembers(ctx, body.ids)
	})
] as ApiEndpoint[];
