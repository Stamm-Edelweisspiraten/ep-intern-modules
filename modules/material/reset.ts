/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

export const resetAreas: ResetArea[] = [
	{
		id: 'reservations',
		label: 'Reservierungen',
		description:
			'Löscht alle Reservierungen samt Ausgaben/Rückgaben; ausgegebene Stücke gelten danach als zurück.',
		tables: ['reservation_units', 'reservation_lines', 'reservations']
	},
	{
		id: 'all',
		label: 'Gesamter Materialbestand',
		description:
			'Löscht Lagerorte, Kategorien, Artikel (inkl. Bilder), Stücke, Kisten, Bestand, Sets, Reservierungen, ' +
			'Verlauf und Etiketten-Layouts.',
		implies: [
			{ area: 'material:reservations', reason: 'Reservierungen verweisen auf den Bestand' }
		],
		// Kind vor Eltern
		tables: [
			'movements',
			'reservation_units',
			'reservation_lines',
			'set_units',
			'sets',
			'set_template_parts',
			'set_templates',
			'container_targets',
			'stock',
			'units',
			'reservations',
			'article_images',
			'articles',
			'categories',
			'locations',
			'label_templates',
			'label_formats',
			'reserved_codes',
			'code_counters'
		],
		storagePrefixes: 'all',
		rebuild: true
	}
];

/** Spalten mit Benutzer-IDs (ohne FK auf den Core) */
export const USER_COLUMNS: [string, string][] = [
	['articles', 'created_by'],
	['article_images', 'uploaded_by'],
	['units', 'created_by'],
	['reservations', 'created_by'],
	['reservations', 'issued_by'],
	['reservations', 'returned_by'],
	['reservation_units', 'issued_by'],
	['reservation_units', 'returned_by'],
	['movements', 'actor_id'],
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
