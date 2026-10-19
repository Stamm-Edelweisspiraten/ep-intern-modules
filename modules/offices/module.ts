import { defineModule } from '$lib/sdk/server';
import { syncGrants } from './grants.service';
import { holderEndpoints } from './holders.endpoints';
import { notificationEndpoints } from './notifications.endpoints';
import { officesService, sendDigest } from './notify.service';
import { officeEndpoints } from './offices.endpoints';
import { profileEndpoints } from './profile.endpoints';
import { resetAreas, resetUsers } from './reset';
import { applyTemplates } from './templates.service';
import { websiteEndpoints } from './website.endpoints';
import { HOLDER_ROLE_NAME } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_templates_notifications.sql?raw';

export default defineModule({
	manifest: {
		id: 'offices',
		name: 'Ämter',
		description: 'Ämter mit Reihenfolge, E-Mail-Adressen, Inhaber*innen und verknüpften Rollen',
		version: '1.0.0',
		dependencies: [],
		/** Jede*r Inhaber*in erhält diese Rolle automatisch (Ämter ansehen, eigene Beschreibung) */
		defaultRoleGrants: { [HOLDER_ROLE_NAME]: ['offices.office.view'] },
		permissions: ['offices.office.view', 'offices.office.manage', 'offices.website.read'],
		permissionDescriptions: {
			'offices.office.view':
				'Ämter mit Beschreibung, E-Mail-Adressen und Inhaber*innen ansehen; Grundrecht für das Modul',
			'offices.office.manage':
				'Ämter anlegen, bearbeiten, sortieren und löschen, Rollen verknüpfen und Personen zuordnen (nur Rollen, deren Rechte man selbst hat)',
			'offices.website.read':
				'Ämter und Inhaber*innen für die Stammeswebsite abrufen (nur API-Key-Scope, kein Zugriff auf interne Funktionen)'
		},
		navigation: [
			{
				label: 'Ämter',
				icon: 'offices',
				path: '/modules/offices',
				permission: 'offices.office.view'
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_templates_notifications', sql: m0002 }
	],
	/** Dienst für andere Module (`OfficesService`, siehe `contract.ts`) */
	provides: officesService as unknown as Record<string, unknown>,
	resetAreas,
	resetUsers,
	jobs: [
		{
			id: 'sync-grants',
			summary: 'Rechte der Amtsinhaber*innen abgleichen',
			schedule: 'hourly',
			run: async (ctx) => {
				const t = await applyTemplates(ctx);
				const r = await syncGrants(ctx);
				const created = t.created.length ? `, ${t.created.length} Ämter aus Vorlagen angelegt` : '';
				return `${r.users} Personen, ${r.grants} Rollen-Zuweisungen${created}`;
			}
		},
		{
			id: 'notify-digest',
			summary: 'Tageszusammenfassung der Amt-Benachrichtigungen versenden',
			schedule: 'daily',
			run: async (ctx) => {
				const r = await sendDigest(ctx);
				return `${r.sent} Mails mit ${r.events} Hinweisen, ${r.failed} fehlgeschlagen, ${r.dropped} verworfen`;
			}
		}
	],
	// Feste Pfade (`/offices/order`, `/me`, `/website/…`) vor den Parameter-Pfaden
	endpoints: [
		...websiteEndpoints,
		...notificationEndpoints,
		...profileEndpoints,
		...holderEndpoints,
		...officeEndpoints
	]
});
