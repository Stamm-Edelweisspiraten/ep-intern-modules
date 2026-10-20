import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/FilesPage.svelte')
	},
	publicRoutes: {
		'link/:token': () => import('./pages/PublicLinkPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'recent',
			title: 'Zuletzt geändert',
			description: 'Zuletzt geänderte eigene und für dich freigegebene Dateien',
			order: 70,
			size: 'sm',
			permission: 'files.file.view',
			component: () => import('./pages/widgets/RecentFilesWidget.svelte')
		}
	]
} satisfies ModuleUi;
