import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { cleanup, resumeDeliveries } from './delivery.service';
import { messageEndpoints } from './messages.endpoints';
import { isValidDomain } from './sender';
import {
	MAX_RECIPIENTS_DEFAULT,
	MAX_RECIPIENTS_LIMIT,
	PERM_SEND,
	PERM_SETTINGS,
	PERM_VIEW_ALL,
	REPLY_TO_MODES,
	SETTING_KEYS
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';

export default defineModule({
	manifest: {
		id: 'messages',
		name: 'Nachrichten',
		description: 'E-Mails an Mitglieder und Gruppen mit Editor, Anhängen und wählbarem Absender',
		version: '1.0.0',
		dependencies: ['members'],
		optionalDependencies: ['offices'],
		permissions: [PERM_SEND, PERM_VIEW_ALL, PERM_SETTINGS],
		permissionDescriptions: {
			[PERM_SEND]:
				'Nachrichten an Mitglieder und Gruppen senden (Gruppenleitungen nur an die Mitglieder ihrer Gruppen) und die eigenen gesendeten Nachrichten ansehen',
			[PERM_VIEW_ALL]: 'Die gesendeten Nachrichten aller Personen mit Empfängerstatus ansehen',
			[PERM_SETTINGS]:
				'Einstellungen der Nachrichten ändern (Domain für persönliche Absenderadressen, Antwortadresse, Empfängerlimit)'
		},
		navigation: [
			{
				label: 'Nachrichten',
				icon: 'mail',
				path: '/modules/messages',
				permission: PERM_SEND,
				group: 'Stamm',
				groupIcon: 'users'
			}
		]
	},
	migrations: [{ name: '0001_init', sql: m0001 }],
	settings: [
		{
			key: SETTING_KEYS.domain,
			label: 'Nachrichten: Domain der persönlichen Absenderadressen',
			description:
				'Aus Vorname und Nachname wird vorname.nachname@domain gebildet (bei mehreren Vornamen zählt nur der erste). Der Mailserver muss das Senden als diese Adressen erlauben. Leer = keine persönlichen Adressen.',
			schema: z.union([
				z.literal(''),
				z
					.string()
					.trim()
					.toLowerCase()
					.refine(isValidDomain, 'Bitte eine Domain wie beispiel.de eingeben')
			]),
			default: ''
		},
		{
			key: SETTING_KEYS.personalEnabled,
			label: 'Nachrichten: Persönliche Absenderadresse anbieten',
			schema: z.boolean(),
			default: true
		},
		{
			key: SETTING_KEYS.replyTo,
			label: 'Nachrichten: Antworten gehen standardmäßig an',
			description:
				'„account“ = E-Mail-Adresse des eigenen Kontos, „sender“ = die gewählte Absenderadresse. Im Formular änderbar.',
			schema: z.enum(REPLY_TO_MODES),
			default: 'account'
		},
		{
			key: SETTING_KEYS.maxRecipients,
			label: 'Nachrichten: Höchstzahl Empfänger je Nachricht',
			schema: z.number().int().min(1).max(MAX_RECIPIENTS_LIMIT),
			default: MAX_RECIPIENTS_DEFAULT
		}
	],
	jobs: [
		{
			id: 'resume',
			summary: 'Unterbrochene Nachrichten-Versände fortsetzen',
			schedule: 'hourly',
			run: (ctx) => resumeDeliveries(ctx)
		},
		{
			id: 'cleanup',
			summary: 'Alte Nachrichten und Anhänge löschen (Aufbewahrung)',
			schedule: 'daily',
			run: () => cleanup()
		}
	],
	endpoints: messageEndpoints
});
