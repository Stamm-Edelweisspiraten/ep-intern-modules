import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { linksEndpoints } from './links.endpoints';
import { metaEndpoints } from './meta.endpoints';
import { nodesEndpoints } from './nodes.endpoints';
import { recentEndpoints } from './recent.endpoints';
import { sharesEndpoints } from './shares.endpoints';
import { trashEndpoints } from './trash.endpoints';
import { uploadEndpoints } from './upload.endpoints';
import { resetAreas, resetUsers } from './reset';
import { onUserDeleted } from './user-deleted';
import { subjectExport } from './subject-export';
import { filesBackup } from './backup';
import { filesSearch } from './search';
import { purgeExpired } from './trash.service';
import {
	DEFAULT_LINK_UPLOAD_MB,
	DEFAULT_QUOTA_MB,
	DEFAULT_TRASH_DAYS,
	PERMISSIONS,
	SETTING_KEYS
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_link_lockout.sql?raw';
import m0003 from './migrations/0003_single_view_upload_links.sql?raw';

/** Dateien: eine Ansicht (eigene + freigegebene), Freigaben an Principals, öffentliche Ansicht-/Upload-Links, Papierkorb */
export default defineModule({
	manifest: {
		id: 'files',
		name: 'Dateien',
		description: 'Cloud-Ablage mit Ordnern, Vorschau, Freigaben und öffentlichen Links',
		version: '1.1.0',
		dependencies: [],
		/** Gruppen/Mitglieder als Freigabe-Ziele */
		optionalDependencies: ['members'],
		/** Verknüpfungs-Konten bekommen eine eigene Ablage und sehen Freigegebenes */
		defaultRoleGrants: { Mitglied: [PERMISSIONS.view] },
		permissions: [PERMISSIONS.view, PERMISSIONS.linkCreate, PERMISSIONS.manageAll],
		permissionDescriptions: {
			[PERMISSIONS.view]:
				'Eigene Dateien ablegen und für mich (oder den ganzen Stamm) freigegebene Dateien sehen; Grundrecht für das Modul',
			[PERMISSIONS.linkCreate]:
				'Öffentliche Links zum Ansehen oder Hochladen für Personen ohne Konto anlegen (nur für eigene Dateien und Ordner)',
			[PERMISSIONS.manageAll]: 'Alle Dateien sehen und verwalten, auch die anderer Personen'
		},
		navigation: [
			{
				label: 'Dateien',
				icon: 'cloud',
				path: '/modules/files',
				permission: PERMISSIONS.view,
				order: 30
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
		},
		{
			key: SETTING_KEYS.linkUploadMb,
			label: 'Dateien: Höchstmenge je Upload-Link (MB, 0 = unbegrenzt)',
			schema: z.number().int().min(0).max(1_000_000),
			default: DEFAULT_LINK_UPLOAD_MB
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_link_lockout', sql: m0002 },
		{ name: '0003_single_view_upload_links', sql: m0003 }
	],
	resetAreas,
	backup: filesBackup,
	resetUsers,
	onUserDeleted,
	subjectExport,
	jobs: [
		{
			id: 'purge-trash',
			summary: 'Abgelaufene Einträge im Papierkorb endgültig löschen',
			schedule: 'daily',
			run: (ctx) => purgeExpired(ctx)
		}
	],
	search: filesSearch,
	// Reihenfolge: erster Treffer gewinnt (öffentliche und feste Pfade vor `:id`)
	endpoints: [
		...linksEndpoints,
		...metaEndpoints,
		...recentEndpoints,
		...trashEndpoints,
		...sharesEndpoints,
		...uploadEndpoints,
		...nodesEndpoints
	]
});
