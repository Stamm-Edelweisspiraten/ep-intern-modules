import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/GalleriesPage.svelte'),
		':id': () => import('./pages/GalleryDetailPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'latest',
			title: 'Neue Galerien',
			description: 'Zuletzt geänderte Galerien mit Titelbild',
			order: 60,
			size: 'md',
			permission: 'galleries.gallery.view',
			component: () => import('./pages/widgets/LatestGalleriesWidget.svelte')
		}
	]
} satisfies ModuleUi;
