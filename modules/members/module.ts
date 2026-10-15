import { defineModule } from '$lib/sdk/server';
import { documentEndpoints } from './documents.endpoints';
import { groupEndpoints } from './groups.endpoints';
import { groupImageEndpoints } from './group-image.endpoints';
import { memberEndpoints } from './members.endpoints';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_members_v2.sql?raw';

export default defineModule({
	manifest: {
		id: 'members',
		name: 'Mitglieder & Gruppen',
		version: '1.0.0',
		dependencies: [],
		permissions: [
			'members.member.view',
			'members.member.edit',
			'members.member.delete',
			'members.group.view',
			'members.group.edit',
			'members.group.delete',
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
				label: 'Gruppen',
				icon: 'folder',
				path: '/modules/members/groups',
				permission: 'members.group.view',
				group: 'Stamm',
				groupIcon: 'users'
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_members_v2', sql: m0002 }
	],
	endpoints: [...memberEndpoints, ...groupEndpoints, ...groupImageEndpoints, ...documentEndpoints]
});
