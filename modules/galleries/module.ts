import { defineModule } from '$lib/sdk/server';
import { galleriesEndpoints } from './galleries.endpoints';
import { imagesEndpoints } from './images.endpoints';
import { metaEndpoints } from './meta.endpoints';
import { websiteEndpoints } from './website.endpoints';
import { resetAreas, resetUsers } from './reset';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_gallery_events.sql?raw';

export default defineModule({
	manifest: {
		id: 'galleries',
		name: 'Galerien',
		description: 'Bildergalerien mit Freigaben, Termin-Zuordnung und Stammeswebsite',
		version: '1.1.0',
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
			'galleries.website.read'
		],
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
		{ name: '0002_gallery_events', sql: m0002 }
	],
	resetAreas,
	resetUsers,
	// Reihenfolge: erster Treffer gewinnt (spezifische Pfade zuerst)
	endpoints: [...websiteEndpoints, ...metaEndpoints, ...imagesEndpoints, ...galleriesEndpoints]
});
