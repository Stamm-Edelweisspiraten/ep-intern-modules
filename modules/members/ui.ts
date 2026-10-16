import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/MembersPage.svelte'),
		groups: () => import('./pages/GroupsPage.svelte'),
		fields: () => import('./pages/FieldsPage.svelte')
	},
	publicRoutes: {
		'verknuepfen/:token': () => import('./pages/LinkAccount.svelte')
	}
} satisfies ModuleUi;
