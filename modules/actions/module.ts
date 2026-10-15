import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { actionEndpoints } from './actions.endpoints';
import { calculationEndpoints } from './calculation.endpoints';
import { accountingEndpoints } from './accounting.endpoints';
import { formEndpoints } from './form.endpoints';
import { payoutEndpoints } from './payouts.endpoints';
import { participantEndpoints } from './participants.endpoints';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_calculation.sql?raw';
import m0003 from './migrations/0003_calc_v2.sql?raw';
import m0004 from './migrations/0004_registration_form.sql?raw';
import m0005 from './migrations/0005_accounting.sql?raw';
import m0006 from './migrations/0006_refunds.sql?raw';
import m0007 from './migrations/0007_refund_mode.sql?raw';
import m0008 from './migrations/0008_refund_position.sql?raw';
import m0009 from './migrations/0009_subsidy_eligibility.sql?raw';
import { refundEndpoints } from './refund.endpoints';
import { exportImportEndpoints } from './export-import.endpoints';

export default defineModule({
	manifest: {
		id: 'actions',
		name: 'Aktionen',
		version: '1.0.0',
		dependencies: [],
		permissions: [
			'actions.action.view',
			'actions.action.create',
			'actions.action.view-all',
			'actions.action.edit-all',
			'actions.action.delete',
			'actions.payout.view',
			'actions.storage.read',
			'actions.storage.write',
			'actions.storage.delete'
		],
		navigation: [
			{
				label: 'Aktionen',
				icon: 'calendar',
				path: '/modules/actions',
				permission: 'actions.action.view'
			}
		]
	},
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
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_calculation', sql: m0002 },
		{ name: '0003_calc_v2', sql: m0003 },
		{ name: '0004_registration_form', sql: m0004 },
		{ name: '0005_accounting', sql: m0005 },
		{ name: '0006_refunds', sql: m0006 },
		{ name: '0007_refund_mode', sql: m0007 },
		{ name: '0008_refund_position', sql: m0008 },
		{ name: '0009_subsidy_eligibility', sql: m0009 }
	],
	endpoints: [
		...actionEndpoints,
		...participantEndpoints,
		...calculationEndpoints,
		...formEndpoints,
		...accountingEndpoints,
		...payoutEndpoints,
		...refundEndpoints,
		...exportImportEndpoints
	]
});
