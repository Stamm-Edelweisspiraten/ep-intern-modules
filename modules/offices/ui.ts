import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/OfficesPage.svelte')
	},
	profileSections: [
		{
			id: 'offices',
			title: 'Meine Ämter',
			order: 30,
			permission: 'offices.office.view',
			component: () => import('./pages/ProfileOfficesSection.svelte')
		}
	],
	dashboardWidgets: [
		{
			id: 'mine',
			title: 'Meine Ämter',
			description: 'Deine Ämter im Stamm',
			order: 30,
			size: 'sm',
			permission: 'offices.office.view',
			component: () => import('./pages/widgets/MyOfficesWidget.svelte')
		}
	]
} satisfies ModuleUi;
