import { core, defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import { bulkInput, idParams, memberIdsQuery, memberInput, memberListQuery } from './schemas';
import {
	bulkUpdateMembers,
	createMember,
	deleteMember,
	getMember,
	listMemberIds,
	listMembers,
	updateMember
} from './members.service';

const tags = ['Mitglieder'];

export const memberEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/members',
		summary: 'Mitglieder auflisten',
		tags,
		permission: 'members.member.view',
		query: memberListQuery,
		handler: ({ query }) => listMembers(query)
	}),
	// fester Pfad vor `/members/:id`
	defineEndpoint({
		method: 'GET',
		path: '/members/ids',
		summary: 'IDs und Namen aller Treffer eines Filters (für „alle Treffer auswählen“)',
		tags,
		permission: 'members.member.view',
		query: memberIdsQuery,
		rateLimit: { limit: 60, windowSec: 60 },
		handler: ({ query }) => listMemberIds(query)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/members/:id',
		summary: 'Mitglied abrufen',
		tags,
		permission: 'members.member.view',
		params: idParams,
		handler: ({ params }) => getMember(params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members',
		summary: 'Mitglied anlegen',
		tags,
		permission: 'members.member.edit',
		body: memberInput,
		handler: ({ ctx, body }) => createMember(ctx, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/bulk',
		summary: 'Sammelaktion auf mehreren Mitgliedern (Gruppen, Stand, Einwilligungen, Löschen)',
		tags,
		permission: 'members.member.edit',
		body: bulkInput,
		handler: async ({ ctx, body }) => {
			// Löschen braucht zusätzlich das Löschrecht
			if (body.action === 'delete') await core.permissions.require(ctx, 'members.member.delete');
			return bulkUpdateMembers(ctx, body);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/members/:id',
		summary: 'Mitglied bearbeiten',
		tags,
		permission: 'members.member.edit',
		params: idParams,
		body: memberInput,
		handler: ({ ctx, params, body }) => updateMember(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/members/:id',
		summary: 'Mitglied löschen',
		tags,
		permission: 'members.member.delete',
		params: idParams,
		handler: async ({ ctx, params }) => {
			await deleteMember(ctx, params.id);
			return null;
		}
	})
] as ApiEndpoint[];
