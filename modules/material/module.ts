import { defineModule } from '$lib/sdk/server';
import { catalogEndpoints } from './catalog.endpoints';
import { codesEndpoints } from './codes.endpoints';
import { exportsEndpoints } from './exports.endpoints';
import { imagesEndpoints } from './images.endpoints';
import { labelsEndpoints } from './labels.endpoints';
import { runLegacyCleanup } from './legacy-cleanup';
import { reservationsEndpoints } from './reservations.endpoints';
import { resetAreas, resetUsers } from './reset';
import { materialSearch } from './search';
import { subjectExport } from './subject-export';
import { onUserDeleted } from './user-deleted';
import {
	LEADER_ROLE_NAME,
	MANAGER_ROLE_NAME,
	NOTIFY_DAMAGE,
	NOTIFY_RESERVATION_CREATED,
	OFFICE_KEY,
	PERMISSIONS
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_article_codes.sql?raw';
import m0003 from './migrations/0003_set_bulk_lines.sql?raw';
import m0004 from './migrations/0004_rebuild.sql?raw';

const ALL = [
	PERMISSIONS.view,
	PERMISSIONS.manage,
	PERMISSIONS.reserve,
	PERMISSIONS.reservations,
	PERMISSIONS.labels
];

export default defineModule({
	manifest: {
		id: 'material',
		name: 'Material',
		description:
			'Materialverwaltung: Lager mit Typen, Artikeln, Kategorien und Lagerorten, Reservierungen für ' +
			'Aktionen und Gruppen, Scannen per Kamera oder USB-Scanner, Etiketten und Listen',
		version: '2.0.0',
		/** Aktionen/Gruppen als Zweck einer Reservierung; Ämter: Vorlage „Materialwart*in“ */
		dependencies: [],
		optionalDependencies: ['actions', 'members', 'offices'],
		permissions: ALL,
		permissionDescriptions: {
			[PERMISSIONS.view]:
				'Lager, Kategorien, Lagerorte und Reservierungen ansehen, Codes scannen, Listen exportieren; Grundrecht für das Modul',
			[PERMISSIONS.manage]:
				'Lager pflegen: Typen, Lagerartikel, Kategorien, Lagerorte und Bilder; Etiketten drucken',
			[PERMISSIONS.reserve]:
				'Material reservieren (für Aktion, Gruppe oder Sonstiges), eigene Reservierungen ändern und stornieren, Schäden melden',
			[PERMISSIONS.reservations]: 'Alle Reservierungen sehen, ändern, stornieren und löschen',
			[PERMISSIONS.labels]: 'Etikettengrößen und Etiketten gestalten; Etiketten drucken'
		},
		defaultRoleGrants: {
			[MANAGER_ROLE_NAME]: ALL,
			[LEADER_ROLE_NAME]: [PERMISSIONS.view, PERMISSIONS.reserve]
		},
		offices: [
			{
				key: OFFICE_KEY,
				name: 'Materialwart*in',
				description:
					'Verwaltet das Material des Stammes: Lager, Reservierungen und Etiketten. ' +
					'Tipp: die Rolle „Materialwart*in“ mit diesem Amt verknüpfen.',
				notifications: [
					{
						key: NOTIFY_RESERVATION_CREATED,
						label: 'Neue Reservierung',
						description: 'Jemand hat Material reserviert'
					},
					{
						key: NOTIFY_DAMAGE,
						label: 'Schaden oder Verlust',
						description: 'Ein Artikel wurde als beschädigt, defekt oder verloren gemeldet'
					}
				]
			}
		],
		navigation: [
			{
				label: 'Material',
				icon: 'boxes',
				path: '/modules/material',
				permission: PERMISSIONS.view,
				order: 45
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_article_codes', sql: m0002 },
		{ name: '0003_set_bulk_lines', sql: m0003 },
		{ name: '0004_rebuild', sql: m0004 }
	],
	resetAreas,
	resetUsers,
	onUserDeleted,
	subjectExport,
	search: materialSearch,
	jobs: [
		{
			id: 'legacy-cleanup',
			summary: 'Bilddateien des alten Materialbestands löschen (einmalig nach dem Neuaufbau)',
			schedule: 'hourly',
			run: runLegacyCleanup
		}
	],
	// Reihenfolge: erster Treffer gewinnt (feste Pfade vor `:id`)
	endpoints: [
		...imagesEndpoints,
		...exportsEndpoints,
		...catalogEndpoints,
		...codesEndpoints,
		...reservationsEndpoints,
		...labelsEndpoints
	]
});
