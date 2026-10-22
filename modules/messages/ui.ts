import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/InboxPage.svelte'),
		sent: () => import('./pages/HistoryPage.svelte'),
		new: () => import('./pages/ComposePage.svelte'),
		'inbox/:id': () => import('./pages/InboxMessagePage.svelte'),
		':id': () => import('./pages/MessageDetailPage.svelte')
	},
	profileSections: [
		{
			id: 'inbox-notifications',
			title: 'Posteingang',
			order: 60,
			permission: 'messages.message.send',
			component: () => import('./pages/InboxNotificationsCard.svelte')
		}
	]
} satisfies ModuleUi;
