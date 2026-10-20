import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { eventEndpoints } from './events.endpoints';
import { metaEndpoints } from './meta.endpoints';
import { websiteEndpoints } from './website.endpoints';
import { resetAreas, resetUsers } from './reset';
import { eventRefsService } from './refs.service';
import { DEFAULT_STAMM_NAME, STAMM_NAME_SETTING } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_recurrence.sql?raw';

export default defineModule({
	manifest: {
		id: 'events',
		name: 'Termine',
		description: 'Interne Termine und Termine für die Stammeswebsite',
		version: '1.2.0',
		dependencies: [],
		/** Gruppen und Mitglieder für Zuordnung und Sichtbarkeit (ohne `members`: nur Stamm, Rollen, Benutzer) */
		optionalDependencies: ['members'],
		/** Verknüpfungs-Konten (Rolle „Mitglied“) sehen die für sie sichtbaren Termine */
		defaultRoleGrants: { Mitglied: ['events.event.view'] },
		permissions: [
			'events.event.view',
			'events.event.create',
			'events.event.view-all',
			'events.event.edit-all',
			'events.website.read'
		],
		permissionDescriptions: {
			'events.event.view': 'Termine ansehen (eigene und freigegebene); Grundrecht für das Modul',
			'events.event.create': 'Termine und Serien anlegen',
			'events.event.view-all': 'Alle Termine ansehen, auch ohne Freigabe',
			'events.event.edit-all': 'Alle Termine bearbeiten und löschen',
			'events.website.read':
				'Termine für die Stammeswebsite abrufen (nur API-Key-Scope, kein Zugriff auf interne Funktionen)'
		},
		navigation: [
			{
				label: 'Termine',
				icon: 'calendar',
				path: '/modules/events',
				// Ohne `group`: Gruppen gelten je Modul, „Stamm“ würde neben `members` doppelt erscheinen
				permission: 'events.event.view'
			}
		]
	},
	settings: [
		{
			key: STAMM_NAME_SETTING,
			label: 'Name des Stamms',
			description:
				'Wird als Gruppe „ganzer Stamm“ bei Zuordnung, Sichtbarkeit und auf der Website angezeigt.',
			schema: z.string().trim().min(1).max(100),
			default: DEFAULT_STAMM_NAME
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_recurrence', sql: m0002 }
	],
	resetAreas,
	resetUsers,
	/** Dienst für andere Module (`EventRefsService`, siehe `contract.ts`) */
	provides: eventRefsService as unknown as Record<string, unknown>,
	endpoints: [...websiteEndpoints, ...metaEndpoints, ...eventEndpoints]
});
