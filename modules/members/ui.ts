import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/MembersPage.svelte'),
		groups: () => import('./pages/GroupsPage.svelte'),
		fields: () => import('./pages/FieldsPage.svelte'),
		retention: () => import('./pages/RetentionPage.svelte')
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
			title: 'Mails zu Mitgliedern',
			order: 20,
			permission: 'members.own.view',
			component: () => import('./pages/ProfileMailPrefs.svelte')
		}
	],
	dashboardWidgets: [
		{
			id: 'mine',
			title: 'Meine Mitglieder',
			description: 'Verknüpfte Mitglieder mit Gruppen und nächstem Geburtstag',
			order: 20,
			size: 'sm',
			permission: 'members.own.view',
			component: () => import('./pages/widgets/MyMembersWidget.svelte')
		}
	]
} satisfies ModuleUi;
