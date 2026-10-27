/**
 * Hook `onUserDeleted` (Core `deleteUser`): Bestand, Reservierungen und Verlauf bleiben; nur die
 * Verweise auf das gelöschte Konto werden auf `NULL` gesetzt.
 */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition } from '$lib/sdk/server';
import { USER_COLUMNS } from './reset';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	for (const [table, column] of USER_COLUMNS) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = NULL
				WHERE ${sql.identifier(column)} = ${userId}`
		);
	}
};
