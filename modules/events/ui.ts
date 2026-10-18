import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/EventsPage.svelte')
	}
} satisfies ModuleUi;
