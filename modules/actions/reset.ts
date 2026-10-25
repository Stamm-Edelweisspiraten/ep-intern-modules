/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

/**
 * Storage: das Modul legt ausschließlich Abrechnungsbelege ab (`<actionId>/<entryId>-…`, auch aus
 * Kosten-Link-Einreichungen). Die Pfade sind nicht per Präfix vom Rest trennbar, es gibt aber keine
 * anderen Dateien – daher räumt `accounting` mit `'all'` sämtliche Dateien des Moduls ab.
 */
export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Aktionen',
		description:
			'Löscht alle Aktionen mit Freigaben, Teilnehmenden, Kalkulationen, Anmeldeformularen, Kosten-Links, ' +
			'Abrechnungen und allen Belegen.',
		tables: [
			'expense_submissions',
			'expense_links',
			'accounting_refunds',
			'action_refund_booking',
			'accounting_interim_entries',
			'accounting_entries',
			'accounting_interims',
			'accounting_payees',
			'action_accounting',
			'action_forms',
			'calc_items',
			'action_calculations',
			'action_participants',
			'action_shares',
			'pending_registrations',
			'public_mail_counters',
			'actions'
		],
		storagePrefixes: 'all',
		rebuild: true,
		implies: [
			{
				area: 'treasury:invoices',
				reason: 'Rechnungen der Kasse werden aus den Teilnehmenden der Aktionen erzeugt.'
			},
			{
				area: 'treasury:payables',
				reason: 'Auszahlungen der Kasse stammen aus den Abrechnungen der Aktionen.'
			}
		]
	},
	{
		id: 'accounting',
		label: 'Abrechnungen',
		description:
			'Löscht alle Buchungen, Zwischenabrechnungen, Empfänger*innen, Rückzahlungen, Kosten-Link-Einreichungen ' +
			'und Abschlüsse aller Aktionen. Da das Modul nur Belege speichert, werden alle Dateien des Moduls gelöscht. ' +
			'Aktionen, Kalkulationen und Teilnehmende bleiben erhalten.',
		tables: [
			'expense_submissions',
			'accounting_refunds',
			'action_refund_booking',
			'accounting_interim_entries',
			'accounting_entries',
			'accounting_interims',
			'accounting_payees',
			'action_accounting'
		],
		storagePrefixes: 'all',
		implies: [
			{
				area: 'treasury:payables',
				reason: 'Auslagen und Stamm-Ausgaben aus den Abrechnungen sind Auszahlungen in der Kasse.'
			}
		]
	},
	{
		id: 'participants',
		label: 'Teilnehmende',
		description:
			'Löscht alle Teilnehmenden und Anmeldungen aller Aktionen. Aktionen, Kalkulationen und Abrechnungen ' +
			'bleiben erhalten.',
		tables: ['pending_registrations', 'action_participants'],
		implies: [
			{
				area: 'treasury:invoices',
				reason: 'Rechnungen der Kasse gehören zu den Teilnehmenden der Aktionen.'
			}
		]
	}
];

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM action_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE actions SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE accounting_entries SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE accounting_interims SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	// Anmeldung mit Login: Bezug auf das Benutzerkonto entfällt
	await tx.execute(
		sql`UPDATE action_participants SET user_id = NULL
			WHERE user_id IS NOT NULL AND user_id <> ${keepUserId}`
	);
};
