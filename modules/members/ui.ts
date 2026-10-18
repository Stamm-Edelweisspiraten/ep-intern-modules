import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/MembersPage.svelte'),
		groups: () => import('./pages/GroupsPage.svelte'),
		fields: () => import('./pages/FieldsPage.svelte')
	},
	publicRoutes: {
		'verknuepfen/:token': () => import('./pages/LinkAccount.svelte')
	},
	profileSections: [
		{
			id: 'members',
			title: 'Meine Mitglieder',
			order: 10,
			permission: 'members.own.view',
			component: () => import('./pages/ProfileMembers.svelte')
		},
		{
			id: 'mail',
			title: 'Benachrichtigungen',
			order: 20,
			permission: 'members.own.view',
			component: () => import('./pages/ProfileMailPrefs.svelte')
		}
	]
} satisfies ModuleUi;
