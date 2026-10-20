import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/EventsPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'upcoming',
			title: 'Nächste Termine',
			description: 'Die nächsten Termine ab heute',
			order: 10,
			size: 'sm',
			permission: 'events.event.view',
			component: () => import('./pages/widgets/UpcomingEventsWidget.svelte')
		}
	]
} satisfies ModuleUi;
