import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/TreasuryPage.svelte'),
		'invoices/:id': () => import('./pages/InvoicePage.svelte'),
		'accountings/:id': () => import('./pages/AccountingPage.svelte'),
		settings: () => import('./pages/TreasurySettingsPage.svelte')
	}
} satisfies ModuleUi;
