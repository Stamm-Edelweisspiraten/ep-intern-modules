import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/TreasuryPage.svelte'),
		'invoices/:id': () => import('./pages/InvoicePage.svelte'),
		'accountings/:id': () => import('./pages/AccountingPage.svelte'),
		settings: () => import('./pages/TreasurySettingsPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'mine',
			title: 'Meine offenen Rechnungen',
			description: 'Offene Rechnungen deiner verknüpften Mitglieder mit Zahlungsdaten',
			order: 12,
			size: 'sm',
			permission: 'treasury.own.view',
			component: () => import('./pages/widgets/MyInvoicesWidget.svelte')
		},
		{
			id: 'tasks',
			title: 'Aufgaben der Kasse',
			description: 'Was in der Kasse gerade zu tun ist',
			order: 15,
			size: 'sm',
			permission: 'treasury.cash.view',
			component: () => import('./pages/widgets/CashTasksWidget.svelte')
		}
	]
} satisfies ModuleUi;
