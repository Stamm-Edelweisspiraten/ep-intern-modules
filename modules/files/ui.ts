import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/FilesPage.svelte')
	},
	publicRoutes: {
		'link/:token': () => import('./pages/PublicLinkPage.svelte')
	}
} satisfies ModuleUi;
