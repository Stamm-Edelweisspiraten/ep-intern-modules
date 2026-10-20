import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/GalleriesPage.svelte'),
		':id': () => import('./pages/GalleryDetailPage.svelte')
	}
} satisfies ModuleUi;
