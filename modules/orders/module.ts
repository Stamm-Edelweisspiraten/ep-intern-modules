import { defineModule } from '$lib/sdk/server';
import { articlesEndpoints } from './articles.endpoints';
import { imagesEndpoints } from './images.endpoints';
import { ordersEndpoints } from './orders.endpoints';
import { stockEndpoints } from './stock.endpoints';
import { supplierEndpoints } from './supplier.endpoints';
import { runDeficitDigest } from './notify';
import { syncTreasury } from './treasury-link';
import { resetAreas, resetUsers } from './reset';
import { ordersSearch } from './search';
import {
	MANAGER_ROLE_NAME,
	NOTIFY_ORDER_CREATED,
	NOTIFY_STOCK_DEFICIT,
	OFFICE_KEY,
	PERMISSIONS
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_digest_state.sql?raw';

export default defineModule({
	manifest: {
		id: 'orders',
		name: 'Bestellungen',
		description:
			'Stammesartikel bestellen (Halstuch, Liederbuch …) mit Rechnung über die Kasse, Lager und Einkauf für die*den Kämmerer*in',
		version: '1.0.0',
		dependencies: ['members'],
		/** Kasse: Rechnungen/Auszahlungen (Push); Ämter: Vorlage „Kämmerer*in“ mit Benachrichtigungen */
		optionalDependencies: ['treasury', 'offices'],
		permissions: [
			PERMISSIONS.view,
			PERMISSIONS.create,
			PERMISSIONS.manage,
			PERMISSIONS.articles,
			PERMISSIONS.stock
		],
		permissionDescriptions: {
			[PERMISSIONS.view]:
				'Artikelkatalog und eigene Bestellungen ansehen; Grundrecht für das Modul',
			[PERMISSIONS.create]:
				'Für die mit dem eigenen Konto verknüpften Mitglieder bestellen und eigene Bestellungen stornieren, solange nichts ausgegeben ist',
			[PERMISSIONS.manage]:
				'Alle Bestellungen sehen, für jedes Mitglied bestellen, Ware ausgeben (auch teilweise) und stornieren',
			[PERMISSIONS.articles]:
				'Artikel pflegen: Titel, Beschreibung, Notizen, Größen, Preise, Nachbestelllinks und Bilder',
			[PERMISSIONS.stock]:
				'Lager und Fehlmengen sehen, Bestand korrigieren, beim Lieferanten bestellen, Wareneingang buchen und Lieferantenrechnungen an die Kasse geben'
		},
		defaultRoleGrants: {
			Mitglied: [PERMISSIONS.view, PERMISSIONS.create],
			[MANAGER_ROLE_NAME]: [
				PERMISSIONS.view,
				PERMISSIONS.create,
				PERMISSIONS.manage,
				PERMISSIONS.articles,
				PERMISSIONS.stock
			]
		},
		offices: [
			{
				key: OFFICE_KEY,
				name: 'Kämmerer*in',
				description:
					'Verwaltet Stammesartikel (Halstücher, Liederbücher …), Bestellungen der Mitglieder, Lager und Einkauf. ' +
					'Tipp: die Rolle „Kämmerer*in“ mit diesem Amt verknüpfen.',
				notifications: [
					{
						key: NOTIFY_ORDER_CREATED,
						label: 'Neue Bestellung',
						description: 'Ein Mitglied hat Artikel bestellt'
					},
					{
						key: NOTIFY_STOCK_DEFICIT,
						label: 'Nachbestellung nötig',
						description: 'Täglich, wenn Artikel fehlen (offene Bestellungen oder Mindestbestand)'
					}
				]
			}
		],
		navigation: [
			{
				label: 'Bestellungen',
				icon: 'shopping-basket',
				path: '/modules/orders',
				permission: PERMISSIONS.view
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_digest_state', sql: m0002 }
	],
	resetAreas,
	resetUsers,
	jobs: [
		{
			id: 'sync-treasury',
			summary: 'Rechnungen und Lieferantenrechnungen mit der Kasse abgleichen',
			schedule: 'hourly',
			run: syncTreasury
		},
		{
			id: 'deficit-digest',
			summary: 'Kämmerer*in über Fehlmengen benachrichtigen',
			schedule: 'daily',
			run: runDeficitDigest
		}
	],
	search: ordersSearch,
	// Reihenfolge: erster Treffer gewinnt (feste Pfade vor `:id`)
	endpoints: [
		...imagesEndpoints,
		...articlesEndpoints,
		...stockEndpoints,
		...supplierEndpoints,
		...ordersEndpoints
	]
});
