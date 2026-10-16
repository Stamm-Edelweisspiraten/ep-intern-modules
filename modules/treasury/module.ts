import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { accountEndpoints } from './accounts.endpoints';
import { importEndpoints } from './import.endpoints';
import { invoiceEndpoints } from './invoices.endpoints';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_extensions.sql?raw';
import { runReminderJob } from './notify';
import { payableEndpoints } from './payables';
import { reportEndpoints } from './reports.endpoints';
import {
	DEFAULT_INVOICE_BODY,
	DEFAULT_INVOICE_SUBJECT,
	DEFAULT_PAID_BODY,
	DEFAULT_PAID_SUBJECT,
	DEFAULT_REMINDER_BODY,
	DEFAULT_REMINDER_SUBJECT,
	SETTING_KEYS
} from './schemas';
import { treasuryService } from './service';
import { syncActions } from './sync';
import { transactionEndpoints } from './transactions.endpoints';

const days = z.number().int().min(0).max(365);

export default defineModule({
	manifest: {
		id: 'treasury',
		name: 'Kasse',
		description:
			'Konten und Buchungen, offene Beiträge aus Aktionen, Rechnungen, Zahlungserinnerungen und Kassenberichte.',
		version: '1.0.0',
		dependencies: ['members', 'actions'],
		permissions: [
			'treasury.cash.view',
			'treasury.transaction.edit',
			'treasury.transaction.delete',
			'treasury.account.manage',
			'treasury.invoice.edit',
			'treasury.invoice.delete',
			'treasury.invoice.send',
			'treasury.report.view',
			'treasury.settings.manage',
			'treasury.bank.view',
			'treasury.payable.edit',
			'treasury.storage.read',
			'treasury.storage.write',
			'treasury.storage.delete'
		],
		navigation: [
			{
				label: 'Kasse',
				icon: 'wallet',
				path: '/modules/treasury',
				permission: 'treasury.cash.view'
			},
			{
				label: 'Kasse',
				icon: 'wallet',
				path: '/modules/treasury/settings',
				permission: 'treasury.settings.manage',
				admin: true
			}
		]
	},
	/** Dienste für `actions` (Vertrag: `contract.ts`) */
	provides: treasuryService as unknown as Record<string, unknown>,
	settings: [
		{
			key: SETTING_KEYS.bankHolder,
			label: 'Kasse: Kontoinhaber',
			schema: z.string().max(100),
			default: ''
		},
		{ key: SETTING_KEYS.bankIban, label: 'Kasse: IBAN', schema: z.string().max(40), default: '' },
		{ key: SETTING_KEYS.bankBic, label: 'Kasse: BIC', schema: z.string().max(20), default: '' },
		{ key: SETTING_KEYS.bankName, label: 'Kasse: Bank', schema: z.string().max(100), default: '' },
		{
			key: SETTING_KEYS.daysBeforeStart,
			label: 'Kasse: Beiträge fällig (Tage vor Beginn der Aktion)',
			schema: days,
			default: 14
		},
		{
			key: SETTING_KEYS.minDays,
			label: 'Kasse: Mindest-Zahlungsfrist neuer Rechnungen (Tage)',
			schema: days,
			default: 14
		},
		{
			key: SETTING_KEYS.remindersEnabled,
			label: 'Kasse: Automatische Zahlungserinnerungen',
			schema: z.boolean(),
			default: true
		},
		{
			key: SETTING_KEYS.firstDays,
			label: 'Kasse: 1. Erinnerung (Tage nach Fälligkeit)',
			schema: days.min(1),
			default: 7
		},
		{
			key: SETTING_KEYS.secondDays,
			label: 'Kasse: 2. Erinnerung (Tage nach der ersten)',
			schema: days.min(1),
			default: 14
		},
		{
			key: SETTING_KEYS.paidMailEnabled,
			label: 'Kasse: Zahlungsbestätigung per E-Mail',
			schema: z.boolean(),
			default: true
		},
		{
			key: SETTING_KEYS.paidSubject,
			label: 'Kasse: Betreff Zahlungsbestätigung',
			schema: z.string().max(150),
			default: DEFAULT_PAID_SUBJECT
		},
		{
			key: SETTING_KEYS.paidBody,
			label: 'Kasse: Text Zahlungsbestätigung',
			schema: z.string().max(5000),
			default: DEFAULT_PAID_BODY
		},
		{
			key: SETTING_KEYS.reminderSubject,
			label: 'Kasse: Betreff Zahlungserinnerung',
			schema: z.string().max(150),
			default: DEFAULT_REMINDER_SUBJECT
		},
		{
			key: SETTING_KEYS.reminderBody,
			label: 'Kasse: Text Zahlungserinnerung',
			schema: z.string().max(5000),
			default: DEFAULT_REMINDER_BODY
		},
		{
			key: SETTING_KEYS.invoiceSubject,
			label: 'Kasse: Betreff Rechnungs-Mail',
			schema: z.string().max(150),
			default: DEFAULT_INVOICE_SUBJECT
		},
		{
			key: SETTING_KEYS.invoiceBody,
			label: 'Kasse: Text Rechnungs-Mail (neue/geänderte/stornierte Rechnung)',
			schema: z.string().max(5000),
			default: DEFAULT_INVOICE_BODY
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_extensions', sql: m0002 }
	],
	jobs: [
		{
			id: 'sync',
			summary: 'Rechnungen mit Aktionen abgleichen',
			schedule: 'hourly',
			run: async (ctx) => {
				const r = await syncActions(ctx);
				return `${r.created} neu, ${r.updated} geändert, ${r.cancelled} storniert, ${r.reactivated} reaktiviert`;
			}
		},
		{
			id: 'reminders',
			summary: 'Zahlungserinnerungen für überfällige Rechnungen versenden',
			schedule: 'daily',
			run: async (ctx) => {
				const r = await runReminderJob(ctx);
				return `${r.invoices} Rechnungen erinnert, ${r.mailsSent} Mails, ${r.mailErrors} Fehler, ${r.withoutAddress} ohne Adresse`;
			}
		}
	],
	endpoints: [
		...accountEndpoints,
		...transactionEndpoints,
		...invoiceEndpoints,
		...payableEndpoints,
		...importEndpoints,
		...reportEndpoints
	]
});
