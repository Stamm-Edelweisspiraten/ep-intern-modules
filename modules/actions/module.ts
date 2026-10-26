import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import {
	NOTIFY_ACCOUNTING,
	NOTIFY_ACTION_SHARED,
	NOTIFY_EXPENSE_SUBMITTED,
	NOTIFY_REGISTRATION_NEW,
	NOTIFY_REGISTRATION_OWN
} from './schemas';
import { actionsSearch } from './search';
import { actionEndpoints } from './actions.endpoints';
import { shareEndpoints } from './shares.endpoints';
import { withActionKeys } from './access';
import { myEndpoints } from './my.endpoints';
import { calculationEndpoints } from './calculation.endpoints';
import { accountingEndpoints } from './accounting.endpoints';
import { formEndpoints, purgeExpiredRegistrations } from './form.endpoints';
import { payoutEndpoints } from './payouts.endpoints';
import { participantEndpoints } from './participants.endpoints';
import { participantSheetEndpoints } from './participants-sheet.endpoints';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_calculation.sql?raw';
import m0003 from './migrations/0003_calc_v2.sql?raw';
import m0004 from './migrations/0004_registration_form.sql?raw';
import m0005 from './migrations/0005_accounting.sql?raw';
import m0006 from './migrations/0006_refunds.sql?raw';
import m0007 from './migrations/0007_refund_mode.sql?raw';
import m0008 from './migrations/0008_refund_position.sql?raw';
import m0009 from './migrations/0009_subsidy_eligibility.sql?raw';
import m0010 from './migrations/0010_member_registration.sql?raw';
import m0011 from './migrations/0011_club_expenses.sql?raw';
import m0012 from './migrations/0012_action_past_flag.sql?raw';
import m0013 from './migrations/0013_entry_reimbursed_upfront.sql?raw';
import { refundEndpoints } from './refund.endpoints';
import { exportImportEndpoints } from './export-import.endpoints';
import { actionsService } from './service';
import type { ActionsService } from './contract';
import { interimEndpoints } from './interim.endpoints';
import { expenseLinkEndpoints } from './expense-link.endpoints';
import { resetAreas, resetUsers } from './reset';
import { onUserDeleted } from './user-deleted';
import m0014 from './migrations/0014_accounting_interims.sql?raw';
import m0015 from './migrations/0015_expense_links.sql?raw';
import m0016 from './migrations/0016_interim_snapshots.sql?raw';
import m0017 from './migrations/0017_expense_batches.sql?raw';
import m0018 from './migrations/0018_health_encryption.sql?raw';
import m0019 from './migrations/0019_registration_optin.sql?raw';
import m0020 from './migrations/0020_link_token_hash_constraints.sql?raw';
import m0021 from './migrations/0021_camp_fees.sql?raw';
import m0022 from './migrations/0022_principal_shares.sql?raw';
import m0023 from './migrations/0023_subsidy_application.sql?raw';
import { PARISH_SETTING, subsidyApplicationEndpoints } from './subsidy-application.endpoints';
import { encryptStoredHealthData } from './health';
import { actionsBackup, hashStoredLinkTokens } from './link-tokens';
import { withTreasurySync } from './treasury-sync';
import { healthRetentionSetting, onMemberDeleted, purgeHealthJob, subjectExport } from './privacy';

export default defineModule({
	manifest: {
		id: 'actions',
		name: 'Aktionen',
		version: '1.6.0',
		dependencies: ['members'],
		/** Kasse: tatsächlich eingegangene Beiträge für die Abrechnung (`TreasuryService`) */
		optionalDependencies: ['treasury'],
		/** Mitglieder sehen ihre Anmeldungen (und die ihrer verknüpften Mitglieder) */
		defaultRoleGrants: { Mitglied: ['actions.own.view'] },
		permissions: [
			'actions.action.view',
			'actions.own.view',
			'actions.action.create',
			'actions.action.view-all',
			'actions.action.edit-all',
			'actions.action.delete',
			'actions.payout.view',
			'actions.storage.read',
			'actions.storage.write',
			'actions.storage.delete'
		],
		permissionDescriptions: {
			'actions.action.view': 'Aktionen ansehen (eigene und freigegebene); Grundrecht für das Modul',
			'actions.own.view':
				'Eigene Anmeldungen und die der verknüpften Mitglieder sehen, z. B. auf dem Dashboard',
			'actions.action.create': 'Aktionen anlegen und importieren (Anleger*in wird Eigentümer*in)',
			'actions.action.view-all': 'Alle Aktionen ansehen, auch ohne Freigabe',
			'actions.action.edit-all':
				'Alle Aktionen bearbeiten, teilen und abgeschlossene Abrechnungen wieder öffnen',
			'actions.action.delete':
				'Aktionen löschen (nur als Eigentümer*in oder mit „alle bearbeiten“)',
			'actions.payout.view':
				'Bankdaten in Abrechnungen: IBAN im Klartext, Empfänger pflegen, Auszahlungen markieren, Auszahlungsliste',
			'actions.storage.read': 'Belege und Dateien von Aktionen ansehen und herunterladen',
			'actions.storage.write': 'Belege und Dateien zu Aktionen hochladen',
			'actions.storage.delete': 'Belege und Dateien von Aktionen löschen'
		},
		navigation: [
			{
				label: 'Aktionen',
				icon: 'backpack',
				path: '/modules/actions',
				permission: 'actions.action.view',
				order: 80
			}
		]
	},
	/** Dienste für abhängige Module (Vertrag: `contract.ts`) */
	provides: actionsService satisfies ActionsService,
	settings: [
		{
			key: 'actions.bank.holder',
			label: 'Kontoinhaber',
			description: 'Erscheint im Anmeldeformular (Zahlungsinformationen).',
			schema: z.string().max(100),
			default: ''
		},
		{ key: 'actions.bank.iban', label: 'IBAN', schema: z.string().max(40), default: '' },
		{ key: 'actions.bank.bic', label: 'BIC', schema: z.string().max(20), default: '' },
		{ key: 'actions.bank.name', label: 'Bank', schema: z.string().max(100), default: '' },
		{
			key: 'actions.payment.purposeTemplate',
			label: 'Verwendungszweck',
			description: 'Platzhalter: {{aktion}}. Beispiel: „{{aktion}} + Name“.',
			schema: z.string().max(140),
			default: '{{aktion}} + Name'
		},
		{
			key: PARISH_SETTING,
			label: 'Gemeinde im Zuschussantrag',
			description:
				'Erscheint im Antrag beim Landesjugendpfarramt (Feld „Gemeinde“). Die Bankverbindung kommt aus der Kasse bzw. den Kontodaten oben.',
			schema: z.string().max(120),
			default: ''
		},
		healthRetentionSetting
	],
	search: actionsSearch,
	notifications: {
		types: [
			{
				key: NOTIFY_EXPENSE_SUBMITTED,
				label: 'Neue Auslagen über den Kosten-Link',
				description: 'An die Eigentümer*in der Aktion, sobald jemand Auslagen einreicht.',
				anyPermission: ['actions.action.create', 'actions.action.edit-all']
			},
			{
				key: NOTIFY_REGISTRATION_NEW,
				label: 'Neue Anmeldung über den Anmeldelink',
				description: 'An Eigentümer*in und Personen mit Bearbeiten-Freigabe.',
				digest: true,
				permission: 'actions.action.view'
			},
			{
				key: NOTIFY_REGISTRATION_OWN,
				label: 'Anmeldung eingegangen (Push)',
				description:
					'Wenn du jemanden aus deinen Mitgliedern angemeldet hast. Die Bestätigung kommt immer per E-Mail.',
				pushOnly: true,
				defaultChannel: 'push',
				permission: 'actions.own.view'
			},
			{
				key: NOTIFY_ACTION_SHARED,
				label: 'Aktion mit mir geteilt',
				permission: 'actions.action.view'
			},
			{
				key: NOTIFY_ACCOUNTING,
				label: 'Abrechnung abgeschlossen, zwischenabgerechnet oder wieder geöffnet',
				description: 'An Eigentümer*in und Bearbeitende, wenn eine andere Person das tut.',
				permission: 'actions.action.view'
			}
		]
	},
	resetAreas,
	resetUsers,
	onUserDeleted,
	onMemberDeleted,
	subjectExport,
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_calculation', sql: m0002 },
		{ name: '0003_calc_v2', sql: m0003 },
		{ name: '0004_registration_form', sql: m0004 },
		{ name: '0005_accounting', sql: m0005 },
		{ name: '0006_refunds', sql: m0006 },
		{ name: '0007_refund_mode', sql: m0007 },
		{ name: '0008_refund_position', sql: m0008 },
		{ name: '0009_subsidy_eligibility', sql: m0009 },
		{ name: '0010_member_registration', sql: m0010 },
		{ name: '0011_club_expenses', sql: m0011 },
		{ name: '0012_action_past_flag', sql: m0012 },
		{ name: '0013_entry_reimbursed_upfront', sql: m0013 },
		{ name: '0014_accounting_interims', sql: m0014 },
		{ name: '0015_expense_links', sql: m0015 },
		{ name: '0016_interim_snapshots', sql: m0016 },
		{ name: '0017_expense_batches', sql: m0017 },
		{ name: '0018_health_encryption', sql: m0018 },
		{ name: '0019_registration_optin', sql: m0019 },
		{ name: '0020_link_token_hash_constraints', sql: m0020 },
		{ name: '0021_camp_fees', sql: m0021 },
		{ name: '0022_principal_shares', sql: m0022 },
		{ name: '0023_subsidy_application', sql: m0023 }
	],
	/** Altbestand der Gesundheitsdaten verschlüsseln (idempotent, siehe `health.ts`) */
	jobs: [
		{
			id: 'encrypt-health',
			summary: 'Gesundheitsdaten der Teilnehmenden verschlüsseln (Altbestand)',
			schedule: 'hourly',
			run: async () => {
				const { updated } = await encryptStoredHealthData();
				return `${updated} Teilnehmende verschlüsselt`;
			}
		},
		{
			id: 'purge-pending',
			summary: 'Unbestätigte Anmeldungen und alte Mail-Zähler löschen',
			schedule: 'hourly',
			run: async () => {
				const { deleted } = await purgeExpiredRegistrations();
				return `${deleted} unbestätigte Anmeldungen gelöscht`;
			}
		},
		purgeHealthJob,
		{
			id: 'hash-link-tokens',
			summary: 'Öffentliche Link-Tokens nur noch als Hash speichern (Altbestand)',
			schedule: 'hourly',
			run: async () => {
				const { updated } = await hashStoredLinkTokens();
				return `${updated} Links umgestellt`;
			}
		}
	],
	onEnable: async () => {
		await encryptStoredHealthData();
		await hashStoredLinkTokens();
	},
	/** Datensicherung: `token_hash` der Links mit dem Schlüssel des Zielservers neu berechnen */
	backup: actionsBackup,
	/** Kasse: nach schreibenden Vorgängen gezielt diese Aktion abgleichen (`treasury-sync.ts`) */
	/** Principal-Schlüssel vor jedem Handler ermitteln (`access.ts`) */
	endpoints: withActionKeys(
		withTreasurySync([
			...myEndpoints,
			...actionEndpoints,
			...shareEndpoints,
			...participantEndpoints,
			...participantSheetEndpoints,
			...calculationEndpoints,
			...formEndpoints,
			...accountingEndpoints,
			...payoutEndpoints,
			...refundEndpoints,
			...exportImportEndpoints,
			...interimEndpoints,
			...expenseLinkEndpoints,
			...subsidyApplicationEndpoints
		])
	)
});
