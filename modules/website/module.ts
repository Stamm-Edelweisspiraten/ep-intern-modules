import { defineModule } from '$lib/sdk/server';
import { NOTIFY_POST_INVITED, NOTIFY_POST_STATUS } from './schemas';
import { contentEndpoints } from './content.endpoints';
import { postsEndpoints } from './posts.endpoints';
import { websiteEndpoints } from './website.endpoints';
import { websiteSearch } from './search';
import { onUserDeleted, subjectExport } from './privacy';
import { resetAreas, resetUsers } from './reset';
import m0001 from './migrations/0001_init.sql?raw';

export default defineModule({
	manifest: {
		id: 'website',
		name: 'Website',
		description: 'Inhalte der Stammeswebsite: Banner/Hinweise, häufige Fragen und Blog',
		version: '1.0.0',
		dependencies: [],
		/** Gruppen (Verknüpfung, Mitschreiben an Gruppen/Mitglieder), Termine und öffentliche Galerien */
		optionalDependencies: ['members', 'events', 'galleries'],
		permissions: [
			'website.content.manage',
			'website.post.write',
			'website.post.publish',
			'website.content.read'
		],
		permissionDescriptions: {
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
				description: 'Wenn eine andere Person deinen Beitrag veröffentlicht, einplant oder zurückzieht.',
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
