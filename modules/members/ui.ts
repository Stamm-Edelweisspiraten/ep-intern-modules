import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/MembersPage.svelte'),
		groups: () => import('./pages/GroupsPage.svelte')
	}
} satisfies ModuleUi;
