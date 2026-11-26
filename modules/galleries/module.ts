import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import { galleriesAssist, PERM_AI } from './assist';
import pkg from './atrium-module.json';
import type { GalleryRefsService } from './contract';
import { downloadEndpoints } from './download.endpoints';
import { galleriesEndpoints } from './galleries.endpoints';
import { imagesEndpoints } from './images.endpoints';
import { metaEndpoints } from './meta.endpoints';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_gallery_events.sql?raw';
import m0003 from './migrations/0003_publish_confirmation.sql?raw';
import m0004 from './migrations/0004_image_private.sql?raw';
import m0005 from './migrations/0005_videos.sql?raw';
import m0006 from './migrations/0006_gallery_dates.sql?raw';
import { galleryRefsService } from './refs.service';
import { resetAreas, resetUsers } from './reset';
import { NOTIFY_GALLERY_SHARED } from './schemas';
import { galleriesSearch } from './search';
import { subjectExport } from './subject-export';
import { onUserDeleted } from './user-deleted';
import { websiteEndpoints } from './website.endpoints';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		/** Gruppen/Mitglieder als Freigabe-Ziele, Termine für die Zuordnung von Galerien */
		...manifestFromPackage(pkg),
		/** Verknüpfungs-Konten (Rolle „Mitglied“) sehen öffentliche und für sie freigegebene Galerien */
		defaultRoleGrants: { Mitglied: ['galleries.gallery.view'] },
		permissions: [
			PERM_AI,
			'galleries.gallery.view',
			'galleries.gallery.create',
			'galleries.gallery.view-all',
			'galleries.gallery.edit-all',
			'galleries.gallery.publish',
			'galleries.gallery.download',
			'galleries.website.read'
		],
		permissionDescriptions: {
			[PERM_AI]:
				'KI-Schreibhilfe für Galerie- und Bildbeschreibungen nutzen (Bilder nur, wenn die Verwaltung es erlaubt)',
			'galleries.gallery.view':
				'Galerien ansehen (eigene, freigegebene und öffentliche); Grundrecht für das Modul',
			'galleries.gallery.create': 'Galerien anlegen und Bilder hochladen',
			'galleries.gallery.view-all': 'Alle Galerien ansehen, auch ohne Freigabe',
			'galleries.gallery.edit-all': 'Alle Galerien bearbeiten und löschen',
			'galleries.gallery.publish':
				'Galerien veröffentlichen (Sichtbarkeit „Öffentlich“, erscheinen auf der Stammeswebsite)',
			'galleries.gallery.download':
				'Ganze Galerien als ZIP herunterladen (nur Galerien, die man sehen darf)',
			'galleries.website.read':
				'Öffentliche Galerien und Bilder für die Stammeswebsite abrufen (nur API-Key-Scope)'
		},
		navigation: [
			{
				label: 'Galerien',
				icon: 'images',
				path: '/modules/galleries',
				permission: 'galleries.gallery.view',
				order: 20
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_gallery_events', sql: m0002 },
		{ name: '0003_publish_confirmation', sql: m0003 },
		{ name: '0004_image_private', sql: m0004 },
		{ name: '0005_videos', sql: m0005 },
		{ name: '0006_gallery_dates', sql: m0006 }
	],
	/** Verweise auf öffentliche Galerien (z. B. Blog-Beiträge im Modul `website`) */
	provides: galleryRefsService satisfies GalleryRefsService,
	assist: galleriesAssist,
	search: galleriesSearch,
	notifications: {
		types: [
			{
				key: NOTIFY_GALLERY_SHARED,
				label: 'Galerie mit mir geteilt',
				description:
					'Wenn eine Galerie mit dir, deiner Gruppe, deinem Mitglied oder deiner Rolle geteilt wird.',
				digest: true,
				permission: 'galleries.gallery.view'
			}
		]
	},
	resetAreas,
	resetUsers,
	onUserDeleted,
	/** Datenauskunft (Art. 15/20): Galerien, Uploads und Freigaben der Person */
	subjectExport,
	// Reihenfolge: erster Treffer gewinnt (spezifische Pfade zuerst)
	endpoints: [
		...websiteEndpoints,
		...metaEndpoints,
		...downloadEndpoints,
		...imagesEndpoints,
		...galleriesEndpoints
	]
});
