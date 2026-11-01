import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { websiteAssist, PERM_AI } from './assist';
import { NOTIFY_POST_INVITED, NOTIFY_POST_STATUS } from './schemas';
import { contentEndpoints } from './content.endpoints';
import { postsEndpoints } from './posts.endpoints';
import { websiteEndpoints } from './website.endpoints';
import { websiteSearch } from './search';
import { onUserDeleted, subjectExport } from './privacy';
import { resetAreas, resetUsers } from './reset';
import m0001 from './migrations/0001_init.sql?raw';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		/** Gruppen (Verknüpfung, Mitschreiben an Gruppen/Mitglieder), Termine und öffentliche Galerien */
		...manifestFromPackage(pkg),
		permissions: [
			PERM_AI,
			'website.content.manage',
			'website.post.write',
			'website.post.publish',
			'website.content.read'
		],
		permissionDescriptions: {
			[PERM_AI]: 'KI-Schreibhilfe für Blog, häufige Fragen und Banner nutzen',
			'website.content.manage': 'Banner/Hinweise und häufige Fragen der Stammeswebsite pflegen',
			'website.post.write':
				'Blog-Beiträge schreiben (Entwürfe) und freigegebene Beiträge mitbearbeiten; Grundrecht für den Blog',
			'website.post.publish':
				'Alle Blog-Beiträge sehen und bearbeiten, veröffentlichen, zurückziehen und löschen (zusätzlich zu „schreiben“)',
			'website.content.read':
				'Banner, Fragen und veröffentlichte Beiträge für die Stammeswebsite abrufen (nur API-Key-Scope)'
		},
		navigation: [
			{
				label: 'Website',
				icon: 'globe',
				path: '/modules/website',
				anyPermission: ['website.post.write', 'website.content.manage'],
				order: 25
			}
		]
	},
	migrations: [{ name: '0001_init', sql: m0001 }],
	assist: websiteAssist,
	search: websiteSearch,
	notifications: {
		types: [
			{
				key: NOTIFY_POST_INVITED,
				label: 'Zum Mitschreiben an einem Beitrag eingeladen',
				permission: 'website.post.write'
			},
			{
				key: NOTIFY_POST_STATUS,
				label: 'Mein Beitrag veröffentlicht oder zurückgezogen',
				description:
					'Wenn eine andere Person deinen Beitrag veröffentlicht, einplant oder zurückzieht.',
				permission: 'website.post.write'
			}
		]
	},
	resetAreas,
	resetUsers,
	onUserDeleted,
	/** Datenauskunft (Art. 15/20): eigene Beiträge und Freigaben zum Mitschreiben */
	subjectExport,
	// Reihenfolge: erster Treffer gewinnt (feste Pfade vor `:id`)
	endpoints: [...websiteEndpoints, ...contentEndpoints, ...postsEndpoints]
});
