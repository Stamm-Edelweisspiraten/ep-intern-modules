import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/FilesPage.svelte')
	}
} satisfies ModuleUi;
