/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Bestellungen und Artikel',
		description:
			'Löscht alle Artikel (inkl. Bilder), Bestellungen, Lagerbewegungen und Lieferantenbestellungen. ' +
			'Rechnungen und Auszahlungen in der Kasse bleiben bestehen.',
		// Kind vor Eltern
		tables: [
			'digest_state',
			'stock_movements',
			'supplier_order_items',
			'supplier_orders',
			'order_items',
			'orders',
			'article_images',
			'article_variants',
			'articles'
		],
		storagePrefixes: 'all',
		rebuild: true
	}
];

/** Verweise auf gelöschte Benutzer auf die verbleibende Person umschreiben (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`UPDATE articles SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE article_images SET uploaded_by = ${keepUserId}
			WHERE uploaded_by IS NOT NULL AND uploaded_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE orders SET ordered_by = ${keepUserId}
			WHERE ordered_by IS NOT NULL AND ordered_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE supplier_orders SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE stock_movements SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
};
