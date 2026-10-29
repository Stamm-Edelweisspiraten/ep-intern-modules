import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/OrdersPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'manage',
			title: 'Bestellungen & Lager',
			description: 'Offene Bestellungen, Fehlmengen und Einkäufe',
			order: 25,
			size: 'sm',
			defaultHidden: true,
			permission: 'orders.order.view',
			anyPermission: ['orders.order.manage', 'orders.stock.manage'],
			component: () => import('./pages/widgets/OrdersManageWidget.svelte')
		},
		{
			id: 'mine',
			title: 'Meine Bestellungen',
			description: 'Deine noch nicht ausgegebenen Bestellungen',
			order: 40,
			size: 'sm',
			defaultHidden: true,
			permission: 'orders.order.view',
			component: () => import('./pages/widgets/MyOrdersWidget.svelte')
		}
	]
} satisfies ModuleUi;
