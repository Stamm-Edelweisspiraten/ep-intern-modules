import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	type ApiEndpoint,
	core,
	defineEndpoint,
	errors,
	inList,
	isUniqueViolation,
	moduleDb,
	resultRows,
	type RequestContext,
	type Row,
	toIso,
	type Tx
} from '$lib/sdk/server';
import {
	groupInput,
	idParams,
	type Group,
	type GroupInput,
	type GroupLeaderUser,
	type GroupType,
	type GroupWebsite,
	type LinkUserRef,
	linkUserSearchQuery,
	type MemberRef
} from './schemas';
import { assertCanGrantLeader, syncLeaderGrantsAfterChange } from './leader.service';

const MODULE = 'members';

const SLUG_TAKEN = 'Diese Website-Adresse wird bereits von einer anderen Gruppe verwendet';
const NAME_TAKEN = 'Eine Gruppe mit diesem Namen existiert bereits';

/** Lädt Gruppen (optional eine einzelne) inkl. Leiter und Mitgliederzahl, sortiert nach Name. */
async function loadGroups(tx: Tx, id?: string): Promise<Group[]> {
	const groups = resultRows(
		await tx.execute(
			id
				? sql`SELECT id, name, type, description, meeting_place, meeting_weekday, meeting_time, meeting_end_time, color,
						(image_path IS NOT NULL) AS has_image, on_website, slug, website_description, age_range,
						contact_email, created_at, updated_at
						FROM groups WHERE id = ${id} ORDER BY name`
				: sql`SELECT id, name, type, description, meeting_place, meeting_weekday, meeting_time, meeting_end_time, color,
						(image_path IS NOT NULL) AS has_image, on_website, slug, website_description, age_range,
						contact_email, created_at, updated_at
						FROM groups ORDER BY name`
		)
	);
	if (!groups.length) return [];
	const ids = inList(groups.map((g) => String(g.id)));

	const counts = resultRows(
		await tx.execute(
			sql`SELECT group_id, count(*)::int AS n FROM member_groups WHERE group_id IN (${ids}) GROUP BY group_id`
		)
	);
	const countBy = new Map(counts.map((r) => [String(r.group_id), Number(r.n)]));

	const leaderRows = resultRows(
		await tx.execute(
			sql`SELECT gl.group_id, m.id, m.first_name, m.last_name, m.scout_name
				FROM group_leaders gl JOIN members m ON m.id = gl.member_id
				WHERE gl.group_id IN (${ids})
				ORDER BY m.last_name, m.first_name`
		)
	);
	const leadersBy = new Map<string, MemberRef[]>();
	for (const r of leaderRows) {
		const list = leadersBy.get(String(r.group_id)) ?? [];
		list.push({
			id: String(r.id),
			firstName: String(r.first_name),
			lastName: String(r.last_name),
			scoutName: r.scout_name == null ? null : String(r.scout_name)
		});
		leadersBy.set(String(r.group_id), list);
	}

	// Namen der Konten löst `withLeaderNames` nach der Transaktion auf (Core-Dienst)
	const userRows = resultRows(
		await tx.execute(
			sql`SELECT group_id, user_id FROM group_leader_users
				WHERE group_id IN (${ids}) ORDER BY created_at, user_id`
		)
	);
	const usersBy = new Map<string, GroupLeaderUser[]>();
	for (const r of userRows) {
		const list = usersBy.get(String(r.group_id)) ?? [];
		list.push({ id: String(r.user_id), name: '', active: false });
		usersBy.set(String(r.group_id), list);
	}

	return groups.map((g) => ({
		id: String(g.id),
		name: String(g.name),
		type: g.type as GroupType,
		description: g.description == null ? null : String(g.description),
		meetingPlace: g.meeting_place == null ? null : String(g.meeting_place),
		meetingWeekday: g.meeting_weekday == null ? null : Number(g.meeting_weekday),
		meetingTime: g.meeting_time == null ? null : String(g.meeting_time),
		meetingEndTime: g.meeting_end_time == null ? null : String(g.meeting_end_time),
		color: g.color == null ? null : String(g.color),
		hasImage: Boolean(g.has_image),
		imageVersion: g.has_image ? toIso(g.updated_at) : null,
		leaders: leadersBy.get(String(g.id)) ?? [],
		leaderUsers: usersBy.get(String(g.id)) ?? [],
		memberCount: countBy.get(String(g.id)) ?? 0,
		website: websiteOf(g),
		createdAt: toIso(g.created_at),
		updatedAt: toIso(g.updated_at)
	}));
}

const textOrNull = (v: unknown): string | null => (v == null ? null : String(v));

function websiteOf(g: Row): GroupWebsite {
	return {
		onWebsite: g.on_website === true || g.on_website === 't',
		slug: textOrNull(g.slug),
		description: textOrNull(g.website_description),
		ageRange: textOrNull(g.age_range),
		contactEmail: textOrNull(g.contact_email)
	};
}

/** Namen der leitenden Konten ergänzen (nach der Transaktion); deaktiviert/gelöscht → „Unbekannt“ */
async function withLeaderNames(ctx: RequestContext, groups: Group[]): Promise<Group[]> {
	const ids = groups.flatMap((g) => g.leaderUsers.map((u) => u.id));
	if (!ids.length) return groups;
	const users = await core.users.byIds(ctx, ids);
	for (const g of groups) {
		g.leaderUsers = g.leaderUsers
			.map((u) => {
				const found = users.get(u.id);
				return { id: u.id, name: found?.name ?? 'Unbekannt', active: !!found };
			})
			.sort((a, b) => a.name.localeCompare(b.name, 'de'));
	}
	return groups;
}

async function requireGroup(tx: Tx, id: string): Promise<Group> {
	const [g] = await loadGroups(tx, id);
	if (!g) throw errors.notFound('Gruppe nicht gefunden');
	return g;
}

async function assertLeadersExist(tx: Tx, leaderIds: string[]): Promise<string[]> {
	const unique = [...new Set(leaderIds)];
	const found = resultRows(
		await tx.execute(sql`SELECT id FROM members WHERE id IN (${inList(unique)})`)
	);
	if (found.length !== unique.length) {
		throw errors.validation({ leaderIds: 'Unbekanntes Mitglied als Gruppenleiter' });
	}
	return unique;
}

async function assertNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
	const rows = resultRows(
		await tx.execute(
			sql`SELECT id FROM groups WHERE lower(name) = lower(${name}) AND id <> ${exceptId ?? ''}`
		)
	);
	if (rows.length) throw errors.conflict(NAME_TAKEN);
}

async function assertSlugFree(tx: Tx, slug: string | null, exceptId: string): Promise<void> {
	if (!slug) return;
	const rows = resultRows(
		await tx.execute(sql`SELECT id FROM groups WHERE slug = ${slug} AND id <> ${exceptId}`)
	);
	if (rows.length) throw errors.conflict(SLUG_TAKEN);
}

/** Schreibt die Website-Felder (nur aufgerufen, wenn `website` übergeben wurde). */
async function writeWebsite(
	tx: Tx,
	groupId: string,
	w: NonNullable<GroupInput['website']>
): Promise<void> {
	await tx.execute(
		sql`UPDATE groups SET on_website = ${w.onWebsite}, slug = ${w.slug},
			website_description = ${w.description}, age_range = ${w.ageRange},
			contact_email = ${w.contactEmail}
			WHERE id = ${groupId}`
	);
}

async function replaceLeaders(
	tx: Tx,
	groupId: string,
	leaderIds: string[],
	leaderUserIds: string[]
): Promise<void> {
	await tx.execute(sql`DELETE FROM group_leaders WHERE group_id = ${groupId}`);
	for (const memberId of leaderIds) {
		await tx.execute(
			sql`INSERT INTO group_leaders (group_id, member_id) VALUES (${groupId}, ${memberId})`
		);
	}
	await tx.execute(sql`DELETE FROM group_leader_users WHERE group_id = ${groupId}`);
	for (const userId of leaderUserIds) {
		await tx.execute(
			sql`INSERT INTO group_leader_users (group_id, user_id) VALUES (${groupId}, ${userId})`
		);
	}
}

/** Gespeicherte Leitungen (Mitglieder und Konten); neue Gruppe → leer */
async function currentLeaders(id: string | null): Promise<{ members: string[]; users: string[] }> {
	if (!id) return { members: [], users: [] };
	return moduleDb(MODULE).transaction(async (tx) => ({
		members: resultRows(
			await tx.execute(sql`SELECT member_id FROM group_leaders WHERE group_id = ${id}`)
		).map((r) => String(r.member_id)),
		users: resultRows(
			await tx.execute(sql`SELECT user_id FROM group_leader_users WHERE group_id = ${id}`)
		).map((r) => String(r.user_id))
	}));
}

async function save(ctx: RequestContext, id: string | null, input: GroupInput): Promise<Group> {
	const current = await currentLeaders(id);
	const leaderUserIds = [...new Set(input.leaderUserIds)];
	const addedMembers = [...new Set(input.leaderIds)].filter((m) => !current.members.includes(m));
	const addedUsers = leaderUserIds.filter((u) => !current.users.includes(u));
	// Neue Konten müssen aktiv sein; bereits eingetragene, inzwischen deaktivierte dürfen bleiben
	if (addedUsers.length) {
		const active = await core.users.byIds(ctx, addedUsers);
		if (addedUsers.some((u) => !active.has(u))) {
			throw errors.validation({
				leaderUserIds: 'Unbekanntes oder deaktiviertes Benutzerkonto als Gruppenleitung'
			});
		}
	}
	// Neue Leitung mit Konto erhält die Rolle „Gruppenleitung“ → Rechteprüfung vorab (403)
	await assertCanGrantLeader(ctx, addedMembers, 'becomesLeader', addedUsers);
	const group = await saveGroup(id, { ...input, leaderUserIds });
	await syncLeaderGrantsAfterChange(ctx);
	return (await withLeaderNames(ctx, [group]))[0]!;
}

async function saveGroup(id: string | null, input: GroupInput): Promise<Group> {
	try {
		return await moduleDb(MODULE).transaction(async (tx) => {
			if (id) await requireGroup(tx, id);
			await assertNameFree(tx, input.name, id ?? undefined);
			const leaderIds = await assertLeadersExist(tx, input.leaderIds);
			const groupId = id ?? crypto.randomUUID();
			if (id) {
				await tx.execute(
					sql`UPDATE groups SET name = ${input.name}, type = ${input.type},
						description = ${input.description}, meeting_place = ${input.meetingPlace},
						meeting_weekday = ${input.meetingWeekday}, meeting_time = ${input.meetingTime},
						meeting_end_time = ${input.meetingEndTime},
							color = ${input.color}, updated_at = now()
						WHERE id = ${groupId}`
				);
			} else {
				await tx.execute(
					sql`INSERT INTO groups (id, name, type, description, meeting_place,
							meeting_weekday, meeting_time, meeting_end_time, color)
						VALUES (${groupId}, ${input.name}, ${input.type}, ${input.description},
							${input.meetingPlace}, ${input.meetingWeekday}, ${input.meetingTime},
							${input.meetingEndTime}, ${input.color})`
				);
			}
			if (input.website) {
				await assertSlugFree(tx, input.website.slug, groupId);
				await writeWebsite(tx, groupId, input.website);
			}
			await replaceLeaders(tx, groupId, leaderIds, input.leaderUserIds);
			return requireGroup(tx, groupId);
		});
	} catch (e) {
		if (isUniqueViolation(e)) {
			throw errors.conflict(isUniqueViolation(e, 'slug') ? SLUG_TAKEN : NAME_TAKEN);
		}
		throw e;
	}
}

/** Audit-Metadaten ohne personenbezogene Details (keine Kontakt-Mail, kein Text). */
function auditMeta(group: Group, input: GroupInput): Record<string, unknown> {
	return input.website
		? { name: group.name, onWebsite: group.website.onWebsite, slug: group.website.slug }
		: { name: group.name };
}

export const groupEndpoints: AnyApiEndpoint[] = [
	{
		method: 'GET',
		path: '/groups',
		summary: 'Gruppen auflisten',
		tags: ['Modul: members'],
		permission: 'members.group.view',
		handler: async ({ ctx }) =>
			withLeaderNames(ctx, await moduleDb(MODULE).transaction((tx) => loadGroups(tx)))
	} as ApiEndpoint,
	defineEndpoint({
		method: 'GET',
		path: '/groups/leader-users',
		summary: 'Aktive Benutzerkonten als Gruppenleitung suchen (ab 2 Zeichen)',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		query: linkUserSearchQuery,
		handler: async ({ ctx, query }): Promise<LinkUserRef[]> => {
			if (query.search.length < 2) return [];
			// E-Mail nur nach den Core-Regeln (core.users.view), sonst leer
			const users = await core.users.directory(ctx, { search: query.search, limit: 30 });
			return users.map((u) => ({ id: u.id, name: u.name, email: u.email }));
		}
	}),
	{
		method: 'GET',
		path: '/groups/:id',
		summary: 'Gruppe abrufen',
		tags: ['Modul: members'],
		permission: 'members.group.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const group = await moduleDb(MODULE).transaction((tx) =>
				requireGroup(tx, (params as { id: string }).id)
			);
			return (await withLeaderNames(ctx, [group]))[0]!;
		}
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/groups',
		summary: 'Gruppe anlegen',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		body: groupInput,
		handler: async ({ ctx, body }) => {
			const group = await save(ctx, null, body as GroupInput);
			await core.audit.logFromContext(ctx, 'members.group.created', {
				target: group.id,
				metadata: auditMeta(group, body as GroupInput)
			});
			return group;
		}
	} as ApiEndpoint,
	{
		method: 'PUT',
		path: '/groups/:id',
		summary: 'Gruppe ändern',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		params: idParams,
		body: groupInput,
		handler: async ({ ctx, params, body }) => {
			const group = await save(ctx, (params as { id: string }).id, body as GroupInput);
			await core.audit.logFromContext(ctx, 'members.group.updated', {
				target: group.id,
				metadata: auditMeta(group, body as GroupInput)
			});
			return group;
		}
	} as ApiEndpoint,
	{
		method: 'DELETE',
		path: '/groups/:id',
		summary: 'Gruppe löschen',
		description: 'Nicht möglich, solange der Gruppe Mitglieder zugeordnet sind.',
		tags: ['Modul: members'],
		permission: 'members.group.delete',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const id = (params as { id: string }).id;
			const { name, imagePath } = await moduleDb(MODULE).transaction(async (tx) => {
				const group = await requireGroup(tx, id);
				const ref = resultRows(
					await tx.execute(sql`SELECT image_path FROM groups WHERE id = ${id}`)
				);
				const imagePath = ref[0]?.image_path == null ? null : String(ref[0].image_path);
				if (group.memberCount > 0) {
					throw errors.conflict('Gruppe hat noch Mitglieder und kann nicht gelöscht werden');
				}
				await tx.execute(sql`DELETE FROM groups WHERE id = ${id}`);
				return { name: group.name, imagePath };
			});
			if (imagePath) {
				await core.storage.remove(ctx, { module: MODULE, path: imagePath }).catch(() => undefined);
			}
			await syncLeaderGrantsAfterChange(ctx);
			await core.audit.logFromContext(ctx, 'members.group.deleted', {
				target: id,
				metadata: { name }
			});
			return { id };
		}
	} as ApiEndpoint
];
