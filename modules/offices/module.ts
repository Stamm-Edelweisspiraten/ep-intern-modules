import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { officesAssist, PERM_AI } from './assist';
import { syncGrants } from './grants.service';
import { holderEndpoints } from './holders.endpoints';
import {
	migrateLegacyPrefs,
	notificationScopesFor,
	officesService,
	sendDigest,
	TEMPLATE_TYPE
} from './notify.service';
import type { OfficesService } from './contract';
import { officeEndpoints } from './offices.endpoints';
import { profileEndpoints } from './profile.endpoints';
import { resetAreas, resetUsers } from './reset';
import { onUserDeleted } from './user-deleted';
import { officesSearch } from './search';
import { subjectExport } from './subject-export';
import { applyTemplates } from './templates.service';
import { websiteEndpoints } from './website.endpoints';
import { HOLDER_ROLE_NAME } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_templates_notifications.sql?raw';
import m0003 from './migrations/0003_notification_queue_retention.sql?raw';
import m0004 from './migrations/0004_website_optin.sql?raw';
import m0005 from './migrations/0005_bio_check.sql?raw';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		...manifestFromPackage(pkg),
		/** Jede*r Inhaber*in erhält diese Rolle automatisch (Ämter ansehen, eigene Beschreibung) */
		defaultRoleGrants: { [HOLDER_ROLE_NAME]: ['offices.office.view'] },
		permissions: [PERM_AI, 'offices.office.view', 'offices.office.manage', 'offices.website.read'],
		permissionDescriptions: {
			[PERM_AI]: 'KI-Schreibhilfe für Amtsbeschreibungen und die eigene Beschreibung nutzen',
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
				permission: 'offices.office.view',
				order: 90
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_templates_notifications', sql: m0002 },
		{ name: '0003_notification_queue_retention', sql: m0003 },
		{ name: '0004_website_optin', sql: m0004 },
		{ name: '0005_bio_check', sql: m0005 }
	],
	/** Dienst für andere Module (`OfficesService`, siehe `contract.ts`) */
	provides: officesService satisfies OfficesService,
	resetAreas,
	resetUsers,
	onUserDeleted,
	/** Datenauskunft (Art. 15/20): Ämter, Beschreibung, Website-Zustimmung, Benachrichtigungen */
	subjectExport,
	notifications: {
		types: [
			{
				key: TEMPLATE_TYPE,
				label: 'Benachrichtigung eines Amts',
				description: 'Hinweise der Module an die Inhaber*innen ihrer Ämter.',
				scoped: true,
				digest: true
			}
		],
		forUser: notificationScopesFor
	},
	jobs: [
		{
			id: 'sync-grants',
			summary: 'Rechte der Amtsinhaber*innen abgleichen',
			schedule: 'hourly',
			run: async (ctx) => {
				const t = await applyTemplates(ctx);
				const r = await syncGrants(ctx);
				await migrateLegacyPrefs();
				const created = t.created.length ? `, ${t.created.length} Ämter aus Vorlagen angelegt` : '';
				return `${r.users} Personen, ${r.grants} Rollen-Zuweisungen${created}`;
			}
		},
		{
			id: 'notify-digest',
			// Nur noch Altbestand der eigenen Warteschlange; neue Einträge sammelt der Core (`core.notifications-digest`)
			summary: 'Alte Tageszusammenfassung der Amt-Benachrichtigungen abarbeiten',
			schedule: 'daily',
			run: async (ctx) => {
				const r = await sendDigest(ctx);
				return `${r.sent} Mails mit ${r.events} Hinweisen, ${r.failed} fehlgeschlagen, ${r.dropped} verworfen (davon ${r.expired} wegen Alter/Versuchen)`;
			}
		}
	],
	/**
	 * Ämter verleihen Rollen (`user_role_grant`): Wiederherstellen nur für Administrator*innen (#16); danach die
	 * Verleihungen aus den wiederhergestellten Ämtern neu bilden (das Modul-Rebuild löscht sie).
	 */
	backup: {
		adminOnlyRestore: 'Ämter verleihen Rollen und damit Rechte',
		afterRestoreJobs: ['sync-grants']
	},
	assist: officesAssist,
	search: officesSearch,
	// Feste Pfade (`/offices/order`, `/me`, `/website/…`) vor den Parameter-Pfaden
	endpoints: [...websiteEndpoints, ...profileEndpoints, ...holderEndpoints, ...officeEndpoints]
});
