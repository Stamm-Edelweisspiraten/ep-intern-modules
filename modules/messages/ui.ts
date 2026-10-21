import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/HistoryPage.svelte'),
		new: () => import('./pages/ComposePage.svelte'),
		':id': () => import('./pages/MessageDetailPage.svelte')
	}
} satisfies ModuleUi;
