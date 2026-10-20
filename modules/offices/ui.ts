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
	]
} satisfies ModuleUi;
