import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/PostsPage.svelte'),
		banners: () => import('./pages/BannersPage.svelte'),
		faq: () => import('./pages/FaqPage.svelte'),
		'posts/:id': () => import('./pages/PostEditorPage.svelte')
	}
} satisfies ModuleUi;
