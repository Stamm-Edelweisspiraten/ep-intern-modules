import { defineModule } from '$lib/sdk/server';
import { galleriesSearch } from './search';
import { galleriesEndpoints } from './galleries.endpoints';
import { imagesEndpoints } from './images.endpoints';
import { metaEndpoints } from './meta.endpoints';
import { websiteEndpoints } from './website.endpoints';
import { resetAreas, resetUsers } from './reset';
import { onUserDeleted } from './user-deleted';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_gallery_events.sql?raw';
import m0003 from './migrations/0003_publish_confirmation.sql?raw';
import { subjectExport } from './subject-export';

export default defineModule({
	manifest: {
		id: 'galleries',
		name: 'Galerien',
		description: 'Bildergalerien mit Freigaben, Termin-Zuordnung und Stammeswebsite',
		version: '1.2.0',
		dependencies: [],
		/** Gruppen/Mitglieder als Freigabe-Ziele, Termine für die Zuordnung von Galerien */
		optionalDependencies: ['members', 'events'],
		/** Verknüpfungs-Konten (Rolle „Mitglied“) sehen öffentliche und für sie freigegebene Galerien */
		defaultRoleGrants: { Mitglied: ['galleries.gallery.view'] },
		permissions: [
			'galleries.gallery.view',
			'galleries.gallery.create',
			'galleries.gallery.view-all',
			'galleries.gallery.edit-all',
			'galleries.gallery.publish',
			'galleries.website.read'
		],
		permissionDescriptions: {
			'galleries.gallery.view':
				'Galerien ansehen (eigene, freigegebene und öffentliche); Grundrecht für das Modul',
			'galleries.gallery.create': 'Galerien anlegen und Bilder hochladen',
			'galleries.gallery.view-all': 'Alle Galerien ansehen, auch ohne Freigabe',
			'galleries.gallery.edit-all': 'Alle Galerien bearbeiten und löschen',
			'galleries.gallery.publish':
				'Galerien veröffentlichen (Sichtbarkeit „Öffentlich“, erscheinen auf der Stammeswebsite)',
			'galleries.website.read':
				'Öffentliche Galerien und Bilder für die Stammeswebsite abrufen (nur API-Key-Scope)'
		},
		navigation: [
			{
				label: 'Galerien',
				icon: 'images',
				path: '/modules/galleries',
				permission: 'galleries.gallery.view'
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_gallery_events', sql: m0002 },
		{ name: '0003_publish_confirmation', sql: m0003 }
	],
	search: galleriesSearch,
	resetAreas,
	resetUsers,
	onUserDeleted,
	/** Datenauskunft (Art. 15/20): Galerien, Uploads und Freigaben der Person */
	subjectExport,
	// Reihenfolge: erster Treffer gewinnt (spezifische Pfade zuerst)
	endpoints: [...websiteEndpoints, ...metaEndpoints, ...imagesEndpoints, ...galleriesEndpoints]
});
