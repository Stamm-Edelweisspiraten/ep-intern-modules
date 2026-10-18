import { defineModule } from '$lib/sdk/server';

/** Platzhalter: interne Bestellungen (Halstuch, Liederbuch …) – Umfang siehe `pages/OrdersPage.svelte` */
export default defineModule({
	manifest: {
		id: 'orders',
		name: 'Bestellungen',
		description: 'Interne Bestellungen mit Lager- und Bestellverwaltung (in Planung)',
		version: '0.1.0',
		dependencies: [],
		permissions: ['orders.order.view'],
		navigation: [
			{
				label: 'Bestellungen',
				icon: 'shopping-basket',
				path: '/modules/orders',
				permission: 'orders.order.view'
			}
		]
	}
});
