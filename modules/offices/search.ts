/**
 * Globale Suche (Befehlspalette): Ämter nach Name/Beschreibung und nach Namen der Inhaber*innen.
 * Alle Ämter sind mit `offices.office.view` sichtbar (wie `GET /offices`), daher keine weitere
 * Objektprüfung. Personennamen kommen über `core.users.directory` – vor bzw. nach der Transaktion.
 */
import { sql } from 'drizzle-orm';
import { core, type ModuleSearchProvider, type RequestContext } from '$lib/sdk/server';
import type { SearchHit } from '$lib/sdk/types/search';
import { inList, mdb, rowsOf, usersByIds } from './load';

function likePattern(q: string): string {
	return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function run(ctx: RequestContext, query: string, limit: number): Promise<SearchHit[]> {
	// Inhaber*innen, deren Name passt (nur aktive Konten, wie in der Ämterliste angezeigt)
	const matchingUsers = (await core.users.directory(ctx, { search: query, limit: 30 })).filter(
		(u) => u.name.toLowerCase().includes(query.toLowerCase())
	);
	const userIds = matchingUsers.map((u) => u.id);
	const pattern = likePattern(query);

	const data = await mdb().transaction(async (tx) => {
		const holderFilter = userIds.length
			? sql`OR o.id IN (SELECT office_id FROM office_holders WHERE user_id IN (${inList(userIds)}))`
			: sql``;
		const offices = await rowsOf(
			tx,
			sql`SELECT o.id, o.name FROM offices o
				WHERE lower(o.name) LIKE ${pattern} ESCAPE '\\'
					OR lower(coalesce(o.description, '')) LIKE ${pattern} ESCAPE '\\'
					${holderFilter}
				ORDER BY CASE WHEN lower(o.name) LIKE ${pattern} ESCAPE '\\' THEN 0 ELSE 1 END,
					o.position, o.name, o.id
				LIMIT ${limit}`
		);
		const ids = offices.map((r) => String(r.id));
		const holders = ids.length
			? await rowsOf(
					tx,
					sql`SELECT office_id, user_id FROM office_holders WHERE office_id IN (${inList(ids)})
						ORDER BY office_id, position, created_at, user_id`
				)
			: [];
		return { offices, holders };
	});

	const users = await usersByIds(
		ctx,
		data.holders.map((h) => String(h.user_id))
	);
	const namesByOffice = new Map<string, string[]>();
	for (const h of data.holders) {
		const name = users.get(String(h.user_id))?.name;
		if (!name) continue;
		const list = namesByOffice.get(String(h.office_id)) ?? [];
		list.push(name);
		namesByOffice.set(String(h.office_id), list);
	}
	return data.offices.map((o) => {
		const names = namesByOffice.get(String(o.id)) ?? [];
		return {
			id: String(o.id),
			title: String(o.name),
			subtitle: names.length ? names.join(', ') : 'Nicht besetzt',
			href: '/modules/offices',
			icon: 'offices',
			type: 'Amt'
		};
	});
}

export const officesSearch: ModuleSearchProvider = {
	permission: 'offices.office.view',
	run
};
