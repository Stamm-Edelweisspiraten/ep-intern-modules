import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/ActionsPage.svelte'),
		':id': () => import('./pages/ActionDetailPage.svelte')
	},
	publicRoutes: {
		'anmeldung/:token': () => import('./pages/PublicRegistration.svelte'),
		'auslagen/:token': () => import('./pages/PublicExpense.svelte')
	},
	dashboardWidgets: [
		{
			id: 'registrations',
			title: 'Meine Anmeldungen',
			description: 'Kommende Aktionen, zu denen du oder deine Mitglieder angemeldet sind',
			order: 11,
			size: 'sm',
			permission: 'actions.own.view',
			component: () => import('./pages/widgets/MyRegistrationsWidget.svelte')
		},
		{
			id: 'open-accounting',
			title: 'Offene Abrechnungen',
			description: 'Vergangene Aktionen, deren Abrechnung noch nicht abgeschlossen ist',
			order: 16,
			size: 'sm',
			permission: 'actions.action.view',
			component: () => import('./pages/widgets/OpenAccountingWidget.svelte')
		}
	]
} satisfies ModuleUi;
