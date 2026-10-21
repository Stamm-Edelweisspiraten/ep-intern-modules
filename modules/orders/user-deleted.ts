/**
 * Hook `onUserDeleted` (Core `deleteUser`): Artikel, Bestellungen, Einkäufe und Lagerbewegungen bleiben
 * (Rechnungen laufen über die Kasse); nur die Verweise auf das gelöschte Konto werden auf `NULL` gesetzt.
 */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition } from '$lib/sdk/server';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	await tx.execute(sql`UPDATE articles SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE article_images SET uploaded_by = NULL WHERE uploaded_by = ${userId}`);
	await tx.execute(sql`UPDATE orders SET ordered_by = NULL WHERE ordered_by = ${userId}`);
	await tx.execute(sql`UPDATE supplier_orders SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE stock_movements SET created_by = NULL WHERE created_by = ${userId}`);
};
