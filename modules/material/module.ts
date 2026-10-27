import { defineModule } from '$lib/sdk/server';
import { catalogEndpoints } from './catalog.endpoints';
import { handoutEndpoints } from './handout.endpoints';
import { imagesEndpoints } from './images.endpoints';
import { labelsEndpoints } from './labels.endpoints';
import { runOverdueJob } from './notify';
import { reservationsEndpoints } from './reservations.endpoints';
import { resetAreas, resetUsers } from './reset';
import { materialSearch } from './search';
import { setsEndpoints } from './sets.endpoints';
import { stockEndpoints } from './stock.endpoints';
import { subjectExport } from './subject-export';
import { unitsEndpoints } from './units.endpoints';
import { onUserDeleted } from './user-deleted';
import {
	LEADER_ROLE_NAME,
	MANAGER_ROLE_NAME,
	NOTIFY_DAMAGE,
	NOTIFY_MY_OVERDUE,
	NOTIFY_OVERDUE,
	NOTIFY_RESERVATION_CREATED,
	OFFICE_KEY,
	PERMISSIONS
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';

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
			'Materialverwaltung: Bestand mit Lagerorten und Kisten, Zelt-Sets, Reservierungen für Aktionen, ' +
			'Ausgabe/Rückgabe per Barcode und Etiketten-Druck',
		version: '1.0.0',
		/** Aktionen: Reservierung je Aktion; Ämter: Vorlage „Materialwart*in“ mit Benachrichtigungen */
		dependencies: [],
		optionalDependencies: ['actions', 'offices'],
		permissions: ALL,
		permissionDescriptions: {
			[PERMISSIONS.view]:
				'Materialbestand, Lagerorte, Sets und Reservierungen ansehen, Codes scannen; Grundrecht für das Modul',
			[PERMISSIONS.manage]:
				'Bestand pflegen: Lagerorte, Kategorien, Artikel, Stücke, Kisten, Mengen, Sets und Set-Vorlagen; Etiketten drucken',
			[PERMISSIONS.reserve]:
				'Material reservieren (frei oder für eine Aktion), eigene Reservierungen ändern, ausgeben, zurücknehmen und Schäden melden',
			[PERMISSIONS.reservations]:
				'Alle Reservierungen ändern, stornieren, ausgeben und zurücknehmen',
			[PERMISSIONS.labels]: 'Etikettenformate und Etikett-Layouts gestalten; Etiketten drucken'
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
					'Verwaltet das Material des Stammes: Bestand, Lager, Zelte, Reservierungen, Ausgabe und Rückgabe. ' +
					'Tipp: die Rolle „Materialwart*in“ mit diesem Amt verknüpfen.',
				notifications: [
					{
						key: NOTIFY_RESERVATION_CREATED,
						label: 'Neue Reservierung für eine Aktion',
						description: 'Jemand hat Material für eine Aktion reserviert'
					},
					{
						key: NOTIFY_DAMAGE,
						label: 'Schaden oder Verlust',
						description:
							'Bei der Rückgabe wurde etwas als beschädigt, defekt oder verloren gemeldet'
					},
					{
						key: NOTIFY_OVERDUE,
						label: 'Rückgabe überfällig',
						description: 'Täglich, wenn ausgegebenes Material nach dem Ende nicht zurück ist'
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
	migrations: [{ name: '0001_init', sql: m0001 }],
	resetAreas,
	resetUsers,
	onUserDeleted,
	subjectExport,
	search: materialSearch,
	jobs: [
		{
			id: 'overdue',
			summary: 'Überfällige Rückgaben melden',
			schedule: 'daily',
			run: runOverdueJob
		}
	],
	notifications: {
		types: [
			{
				key: NOTIFY_MY_OVERDUE,
				label: 'Meine Reservierung: Rückgabe überfällig',
				description:
					'Wenn ausgegebenes Material aus deiner Reservierung nach dem Ende nicht zurück ist.',
				permission: PERMISSIONS.reserve
			}
		]
	},
	// Reihenfolge: erster Treffer gewinnt (feste Pfade vor `:id`)
	endpoints: [
		...imagesEndpoints,
		...catalogEndpoints,
		...unitsEndpoints,
		...stockEndpoints,
		...setsEndpoints,
		...handoutEndpoints,
		...reservationsEndpoints,
		...labelsEndpoints
	]
});
