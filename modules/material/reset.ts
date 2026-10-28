/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

export const resetAreas: ResetArea[] = [
	{
		id: 'reservations',
		label: 'Reservierungen',
		description: 'Löscht alle Materialreservierungen.',
		tables: ['reservation_lines', 'reservations']
	},
	{
		id: 'all',
		label: 'Gesamter Materialbestand',
		description:
			'Löscht Lagerorte, Kategorien, Typen, Lagerartikel (inkl. Bilder), Reservierungen und Etiketten.',
		implies: [
			{ area: 'material:reservations', reason: 'Reservierungen verweisen auf den Bestand' }
		],
		// Kind vor Eltern
		tables: [
			'reservation_lines',
			'reservations',
			'images',
			'items',
			'types',
			'categories',
			'locations',
			'label_templates',
			'label_formats',
			'reserved_codes',
			'code_counters',
			'legacy_cleanup'
		],
		storagePrefixes: 'all',
		rebuild: true
	}
];

/** Spalten mit Benutzer-IDs (ohne FK auf den Core) */
export const USER_COLUMNS: [string, string][] = [
	['types', 'created_by'],
	['items', 'created_by'],
	['items', 'condition_reported_by'],
	['images', 'uploaded_by'],
	['reservations', 'created_by'],
	['label_templates', 'created_by'],
	['reserved_codes', 'created_by']
];

/** Verweise auf gelöschte Benutzer auf die verbleibende Person umschreiben (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	for (const [table, column] of USER_COLUMNS) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${keepUserId}
				WHERE ${sql.identifier(column)} IS NOT NULL AND ${sql.identifier(column)} <> ${keepUserId}`
		);
	}
};
