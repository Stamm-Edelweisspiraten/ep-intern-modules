import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { linksEndpoints } from './links.endpoints';
import { metaEndpoints } from './meta.endpoints';
import { nodesEndpoints } from './nodes.endpoints';
import { sharesEndpoints } from './shares.endpoints';
import { trashEndpoints } from './trash.endpoints';
import { uploadEndpoints } from './upload.endpoints';
import { resetAreas, resetUsers } from './reset';
import { purgeExpired } from './trash.service';
import { DEFAULT_QUOTA_MB, DEFAULT_TRASH_DAYS, PERMISSIONS, SETTING_KEYS } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_link_lockout.sql?raw';

/** Dateien: eigene Ablage, Stammesordner, Freigaben an Principals, öffentliche Links, Papierkorb */
export default defineModule({
	manifest: {
		id: 'files',
		name: 'Dateien',
		description: 'Cloud-Ablage mit Ordnern, Vorschau, Freigaben und öffentlichen Links',
		version: '1.0.0',
		dependencies: [],
		/** Gruppen/Mitglieder als Freigabe-Ziele */
		optionalDependencies: ['members'],
		/** Verknüpfungs-Konten bekommen eine eigene Ablage und sehen Freigegebenes */
		defaultRoleGrants: { Mitglied: [PERMISSIONS.view] },
		permissions: [
			PERMISSIONS.view,
			PERMISSIONS.sharedView,
			PERMISSIONS.sharedEdit,
			PERMISSIONS.linkCreate,
			PERMISSIONS.manageAll
		],
		permissionDescriptions: {
			[PERMISSIONS.view]:
				'Eigene Ablage „Meine Dateien“ nutzen und für mich freigegebene Dateien sehen; Grundrecht für das Modul',
			[PERMISSIONS.sharedView]: 'Stammesordner ansehen und herunterladen',
			[PERMISSIONS.sharedEdit]:
				'Im Stammesordner hochladen, Ordner anlegen, umbenennen, verschieben und löschen',
			[PERMISSIONS.linkCreate]:
				'Öffentliche Links für Personen ohne Konto anlegen (nur für Dateien mit Bearbeiten-Zugriff)',
			[PERMISSIONS.manageAll]: 'Alle Dateien sehen und verwalten, auch die Ablagen anderer Personen'
		},
		navigation: [
			{
				label: 'Dateien',
				icon: 'cloud',
				path: '/modules/files',
				permission: PERMISSIONS.view
			}
		]
	},
	settings: [
		{
			key: SETTING_KEYS.quotaMb,
			label: 'Dateien: Speicherplatz je Person (MB, 0 = unbegrenzt)',
			schema: z.number().int().min(0).max(1_000_000),
			default: DEFAULT_QUOTA_MB
		},
		{
			key: SETTING_KEYS.trashDays,
			label: 'Dateien: Tage im Papierkorb bis zum endgültigen Löschen',
			schema: z.number().int().min(1).max(365),
			default: DEFAULT_TRASH_DAYS
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_link_lockout', sql: m0002 }
	],
	resetAreas,
	resetUsers,
	jobs: [
		{
			id: 'purge-trash',
			summary: 'Abgelaufene Einträge im Papierkorb endgültig löschen',
			schedule: 'daily',
			run: (ctx) => purgeExpired(ctx)
		}
	],
	// Reihenfolge: erster Treffer gewinnt (öffentliche und feste Pfade vor `:id`)
	endpoints: [
		...linksEndpoints,
		...metaEndpoints,
		...trashEndpoints,
		...sharesEndpoints,
		...uploadEndpoints,
		...nodesEndpoints
	]
});
