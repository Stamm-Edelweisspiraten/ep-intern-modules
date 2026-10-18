import { sql } from 'drizzle-orm';
import { core, defineEndpoint, searchPrincipals, type ApiEndpoint } from '$lib/sdk/server';
import { loadGroupMap, stammName } from './groups';
import { MODULE_ID, principalSearchQuery, tagsQuery } from './schemas';

const TAGS = ['Modul: events'];
const MAX_TAG_SUGGESTIONS = 50;

/** LIKE-Sonderzeichen maskieren (Escape-Zeichen `\`) */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const metaEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/groups',
		summary: 'Zuordenbare Gruppen (ganzer Stamm zuerst, danach Gruppen aus Mitglieder)',
		tags: TAGS,
		permission: 'events.event.view',
		handler: async ({ ctx }) => [...(await loadGroupMap(ctx)).values()]
	}),
	defineEndpoint({
		method: 'GET',
		path: '/tags',
		summary: 'Bereits verwendete Tags (häufigste zuerst, max. 50, optional Teilsuche)',
		tags: TAGS,
		permission: 'events.event.view',
		query: tagsQuery,
		handler: async ({ query }) => {
			const search = query.search?.trim();
			const filter = search
				? sql`WHERE lower(tag) LIKE ${`%${escapeLike(search.toLowerCase())}%`} ESCAPE '\\'`
				: sql``;
			const rows = await core.database.forModule(MODULE_ID).transaction(async (tx) => {
				const res = await tx.execute(sql`
					SELECT min(tag) AS tag, count(*)::int AS uses
					FROM event_tags
					${filter}
					GROUP BY lower(tag)
					ORDER BY uses DESC, lower(tag) ASC
					LIMIT ${MAX_TAG_SUGGESTIONS}
				`);
				return res.rows as { tag: string }[];
			});
			return rows.map((r) => String(r.tag));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Kandidaten suchen (Stamm, Gruppen, Rollen, Benutzer*innen, Mitglieder)',
		tags: TAGS,
		permission: 'events.event.view',
		query: principalSearchQuery,
		handler: async ({ ctx, query }) =>
			searchPrincipals(ctx, MODULE_ID, query.search, { everyoneLabel: await stammName() })
	}),
	defineEndpoint({
		method: 'GET',
		path: '/settings/stamm',
		summary: 'Name des Stamms (Anzeige „ganzer Stamm“)',
		tags: TAGS,
		permission: 'events.event.view',
		handler: async () => ({ name: await stammName() })
	})
] as ApiEndpoint[];
