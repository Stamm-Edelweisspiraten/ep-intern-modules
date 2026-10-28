import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/MaterialPage.svelte'),
		'scan/:code': () => import('./pages/ScanRedirectPage.svelte'),
		'labels/:id': () => import('./pages/labels/LabelDesigner.svelte')
	},
	fullBleedRoutes: ['labels/:id'],
	dashboardWidgets: [
		{
			id: 'mine',
			title: 'Meine Materialreservierungen',
			description: 'Deine laufenden und kommenden Reservierungen',
			order: 45,
			size: 'sm',
			permission: 'material.reservation.create',
			component: () => import('./pages/widgets/MyReservationsWidget.svelte')
		},
		{
			id: 'manage',
			title: 'Material',
			description: 'Anstehende Reservierungen und gemeldete Schäden',
			order: 46,
			size: 'sm',
			permission: 'material.inventory.manage',
			component: () => import('./pages/widgets/MaterialManageWidget.svelte')
		}
	]
} satisfies ModuleUi;
