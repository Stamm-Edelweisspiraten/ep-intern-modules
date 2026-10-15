import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/ActionsPage.svelte'),
		':id': () => import('./pages/ActionDetailPage.svelte')
	},
	publicRoutes: {
		'anmeldung/:token': () => import('./pages/PublicRegistration.svelte')
	}
} satisfies ModuleUi;
