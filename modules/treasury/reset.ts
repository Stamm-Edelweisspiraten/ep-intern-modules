/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

/**
 * Storage: Buchungsbelege liegen unter `<transactionId>/…` (nicht per Präfix trennbar), Belege von
 * Auszahlungen unter `payables/…`. `sync_state` (Startzeile id = 1) wird nur beim Neuaufbau geleert,
 * sonst fehlte die Zeile für den Abgleich.
 */
export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Gesamte Kasse',
		description:
			'Löscht alle Konten, Buchungen, Importe, Rechnungen, Auszahlungen, Zahler*innen, Jahresbeiträge und ' +
			'Belege. Die Standard-Kategorien werden neu angelegt. Rechnungen aus Aktionen entstehen beim nächsten ' +
			'stündlichen Abgleich neu.',
		tables: [
			'allocations',
			'payable_payments',
			'reminders',
			'invoice_documents',
			'annual_fee_items',
			'invoice_lines',
			'invoices',
			'annual_fee_runs',
			'payables',
			'payer_members',
			'transactions',
			'import_batches',
			'payers',
			'accounts',
			'categories',
			'action_settings',
			'filed_accountings',
			'sync_state'
		],
		storagePrefixes: 'all',
		rebuild: true
	},
	{
		id: 'transactions',
		label: 'Buchungen und Importe',
		description:
			'Löscht alle Buchungen, Umbuchungen, Kontoauszug-Importe und deren Zuordnungen zu Rechnungen und ' +
			'Auszahlungen. Konten bleiben erhalten. Hochgeladene Buchungsbelege werden nicht gelöscht ' +
			'(nicht getrennt ablegbar) und bleiben als verwaiste Dateien im Speicher.',
		tables: ['allocations', 'payable_payments', 'transactions', 'import_batches']
	},
	{
		id: 'invoices',
		label: 'Rechnungen',
		description:
			'Löscht alle Rechnungen mit Positionen, Zahlungszuordnungen, Erinnerungen und Rechnungsversionen ' +
			'sowie die Jahresbeitragsläufe. Rechnungen aus noch vorhandenen Aktionen entstehen beim nächsten ' +
			'stündlichen Abgleich neu (mit neuen Nummern).',
		tables: [
			'allocations',
			'reminders',
			'invoice_documents',
			'annual_fee_items',
			'invoice_lines',
			'invoices',
			'annual_fee_runs'
		]
	},
	{
		id: 'payables',
		label: 'Auszahlungen',
		description:
			'Löscht alle Auszahlungen (Eingangsrechnungen, Auslagen, Rückzahlungen, Guthaben), deren ' +
			'Zahlungszuordnungen und Belege. Die zugehörigen Buchungen bleiben erhalten.',
		tables: ['payable_payments', 'payables'],
		storagePrefixes: ['payables/']
	},
	{
		id: 'annual',
		label: 'Jahresbeiträge',
		description: 'Löscht alle Jahresbeitragsläufe und die Beitragsaufschlüsselung.',
		tables: ['annual_fee_items', 'annual_fee_runs'],
		implies: [
			{
				area: 'treasury:invoices',
				reason:
					'Jahresbeiträge werden als normale Rechnungen gestellt und lassen sich nicht getrennt löschen.'
			}
		]
	},
	{
		id: 'payers',
		label: 'Zahler*innen',
		description:
			'Löscht alle Zahler*innen (Familien) mit gespeicherten Kontodaten und Mitglieder-Zuordnungen. ' +
			'Rechnungen, Buchungen und Auszahlungen bleiben erhalten, verlieren aber den Bezug zur Zahler*in.',
		tables: ['payer_members', 'payers']
	}
];

/** Die Kasse speichert Benutzer nur als `created_by`/`filed_by` (Historie) – nichts zu bereinigen. */
export const resetUsers: ModuleDefinition['resetUsers'] = async () => {};
