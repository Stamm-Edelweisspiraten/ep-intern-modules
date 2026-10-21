import { defineEndpoint, type AnyApiEndpoint } from '$lib/sdk/server';
import { listFieldDefs, putFieldDefs } from './fields.service';
import { memberFieldsInput } from './schemas';

const tags = ['Mitglieder'];

export const fieldEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/fields',
		summary: 'Zusatzfelder der Mitglieder (Vorlagen und eigene)',
		tags,
		permission: 'members.member.view',
		handler: async () => ({ fields: await listFieldDefs() })
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/fields',
		summary: 'Zusatzfelder der Mitglieder ersetzen (Vorlagen bleiben erhalten)',
		tags,
		permission: 'members.field.manage',
		body: memberFieldsInput,
		handler: async ({ ctx, body }) => ({
			fields: await putFieldDefs(
				ctx,
				body.fields.map((f) => ({ active: f.active, field: f.field as Record<string, unknown> }))
			)
		})
	})
];
