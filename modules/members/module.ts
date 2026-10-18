import { z } from 'zod';
import { defineModule } from '$lib/sdk/server';
import { resetAreas, resetUsers } from './reset';
import { addressEndpoints } from './address.endpoints';
import { fieldEndpoints } from './fields.endpoints';
import { membersService } from './fields.service';
import { documentEndpoints } from './documents.endpoints';
import { groupEndpoints } from './groups.endpoints';
import { groupImageEndpoints } from './group-image.endpoints';
import { linkEndpoints } from './link.endpoints';
import { listMemberSheets } from './sheets.service';
import { principalsService } from './principals.service';
import { sheetEndpoints } from './sheets.endpoints';
import { memberEndpoints } from './members.endpoints';
import { LINK_DEFAULT_ROLE } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_members_v2.sql?raw';
import m0003 from './migrations/0003_user_links.sql?raw';
import m0004 from './migrations/0004_address_fields.sql?raw';
import m0005 from './migrations/0005_member_fields.sql?raw';
import m0006 from './migrations/0006_membership.sql?raw';
import m0008 from './migrations/0008_member_mail_prefs.sql?raw';

export default defineModule({
	manifest: {
		id: 'members',
		name: 'Mitglieder & Gruppen',
		version: '1.6.0',
		dependencies: [],
		/** Rolle „Mitglied“ (Verknüpfungs-Konten) darf die eigenen Mitglieder sehen/bearbeiten */
		defaultRoleGrants: { [LINK_DEFAULT_ROLE]: ['members.own.view', 'members.own.edit'] },
		permissions: [
			'members.own.view',
			'members.own.edit',
			'members.member.view',
			'members.member.edit',
			'members.member.delete',
			'members.group.view',
			'members.group.edit',
			'members.group.delete',
			'members.field.manage',
			'members.link.view',
			'members.link.manage',
			'members.data.export',
			'members.storage.read',
			'members.storage.write',
			'members.storage.delete'
		],
		navigation: [
			{
				label: 'Mitglieder',
				icon: 'users',
				path: '/modules/members',
				permission: 'members.member.view',
				group: 'Stamm',
				groupIcon: 'users'
			},
			{
				label: 'Zusatzfelder',
				icon: 'settings',
				path: '/modules/members/fields',
				permission: 'members.field.manage',
				group: 'Stamm',
				groupIcon: 'users'
			},
			{
				label: 'Gruppen',
				icon: 'folder',
				path: '/modules/members/groups',
				permission: 'members.group.view',
				group: 'Stamm',
				groupIcon: 'users'
			}
		]
	},
	/** Dienste für abhängige Module (Vertrag: `contract.ts`, Abruf: `core.modules.use`) */
	provides: {
		...membersService,
		listMemberSheets,
		...principalsService
	} as unknown as Record<string, unknown>,
	settings: [
		{
			key: 'members.address.photonUrl',
			label: 'Adress-Autovervollständigung (Photon-URL)',
			description:
				'Basis-URL eines Photon-Dienstes (OpenStreetMap). Beim Tippen einer Adresse wird der Suchtext serverseitig dorthin gesendet. Leer = Autovervollständigung aus (nur PLZ → Ort offline).',
			schema: z.union([z.literal(''), z.string().url().max(300)]),
			default: 'https://photon.komoot.io'
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_members_v2', sql: m0002 },
		{ name: '0003_user_links', sql: m0003 },
		{ name: '0004_address_fields', sql: m0004 },
		{ name: '0005_member_fields', sql: m0005 },
		{ name: '0006_membership', sql: m0006 },
		{ name: '0008_member_mail_prefs', sql: m0008 }
	],
	resetAreas,
	resetUsers,
	endpoints: [
		// Vor `memberEndpoints`: `GET /members/sheet-columns` darf nicht von `/members/:id` abgefangen werden
		...sheetEndpoints,
		...memberEndpoints,
		...addressEndpoints,
		...fieldEndpoints,
		...linkEndpoints,
		...groupEndpoints,
		...groupImageEndpoints,
		...documentEndpoints
	]
});
