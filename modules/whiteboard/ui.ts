import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/BoardsPage.svelte'),
		':id': () => import('./pages/BoardPage.svelte')
	},
	fullBleedRoutes: [':id'],
	dashboardWidgets: [
		{
			id: 'recent-boards',
			title: 'Whiteboards',
			description: 'Zuletzt bearbeitete Whiteboards',
			order: 40,
			defaultHidden: true,
			size: 'md',
			permission: 'whiteboard.board.view',
			component: () => import('./pages/widgets/RecentBoardsWidget.svelte')
		}
	]
} satisfies ModuleUi;
