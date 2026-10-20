import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import {
	groupInput,
	idParams,
	type Group,
	type GroupInput,
	type GroupType,
	type GroupWebsite,
	type MemberRef
} from './schemas';

const MODULE = 'members';
const mdb = () => core.database.forModule(MODULE);

type Row = Record<string, unknown>;

/** Liest die Zeilen eines tx.execute-Ergebnisses (node-postgres und PGlite liefern `rows`). */
function rowsOf(result: unknown): Row[] {
	const r = result as { rows?: Row[] } | Row[];
	return Array.isArray(r) ? r : (r.rows ?? []);
}

const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

/** Liefert bei einer Unique-Verletzung (23505) Constraint-Name/Meldung, sonst `null`. */
function uniqueViolation(e: unknown): string | null {
	let cur = e as
		{ code?: string; constraint?: string; message?: string; cause?: unknown } | undefined;
	for (let i = 0; cur && i < 4; i++) {
		if (cur.code === '23505') return `${cur.constraint ?? ''} ${cur.message ?? ''}`;
		cur = cur.cause as typeof cur;
	}
	return null;
}

const SLUG_TAKEN = 'Diese Website-Adresse wird bereits von einer anderen Gruppe verwendet';
const NAME_TAKEN = 'Eine Gruppe mit diesem Namen existiert bereits';

const inList = (values: string[]) =>
	sql.join(
		values.map((v) => sql`${v}`),
		sql`, `
	);

/** Lädt Gruppen (optional eine einzelne) inkl. Leiter und Mitgliederzahl, sortiert nach Name. */
async function loadGroups(tx: Tx, id?: string): Promise<Group[]> {
	const groups = rowsOf(
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

	const counts = rowsOf(
		await tx.execute(
			sql`SELECT group_id, count(*)::int AS n FROM member_groups WHERE group_id IN (${ids}) GROUP BY group_id`
		)
	);
	const countBy = new Map(counts.map((r) => [String(r.group_id), Number(r.n)]));

	const leaderRows = rowsOf(
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
		imageVersion: g.has_image ? iso(g.updated_at) : null,
		leaders: leadersBy.get(String(g.id)) ?? [],
		memberCount: countBy.get(String(g.id)) ?? 0,
		website: websiteOf(g),
		createdAt: iso(g.created_at),
		updatedAt: iso(g.updated_at)
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

async function requireGroup(tx: Tx, id: string): Promise<Group> {
	const [g] = await loadGroups(tx, id);
	if (!g) throw errors.notFound('Gruppe nicht gefunden');
	return g;
}

async function assertLeadersExist(tx: Tx, leaderIds: string[]): Promise<string[]> {
	const unique = [...new Set(leaderIds)];
	const found = rowsOf(
		await tx.execute(sql`SELECT id FROM members WHERE id IN (${inList(unique)})`)
	);
	if (found.length !== unique.length) {
		throw errors.validation({ leaderIds: 'Unbekanntes Mitglied als Gruppenleiter' });
	}
	return unique;
}

async function assertNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
	const rows = rowsOf(
		await tx.execute(
			sql`SELECT id FROM groups WHERE lower(name) = lower(${name}) AND id <> ${exceptId ?? ''}`
		)
	);
	if (rows.length) throw errors.conflict(NAME_TAKEN);
}

async function assertSlugFree(tx: Tx, slug: string | null, exceptId: string): Promise<void> {
	if (!slug) return;
	const rows = rowsOf(
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

async function replaceLeaders(tx: Tx, groupId: string, leaderIds: string[]): Promise<void> {
	await tx.execute(sql`DELETE FROM group_leaders WHERE group_id = ${groupId}`);
	for (const memberId of leaderIds) {
		await tx.execute(
			sql`INSERT INTO group_leaders (group_id, member_id) VALUES (${groupId}, ${memberId})`
		);
	}
}

async function save(id: string | null, input: GroupInput): Promise<Group> {
	try {
		return await mdb().transaction(async (tx) => {
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
			await replaceLeaders(tx, groupId, leaderIds);
			return requireGroup(tx, groupId);
		});
	} catch (e) {
		const violation = uniqueViolation(e);
		if (violation !== null) {
			throw errors.conflict(violation.includes('slug') ? SLUG_TAKEN : NAME_TAKEN);
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

export const groupEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/groups',
		summary: 'Gruppen auflisten',
		tags: ['Modul: members'],
		permission: 'members.group.view',
		handler: async () => mdb().transaction((tx) => loadGroups(tx))
	} as ApiEndpoint,
	{
		method: 'GET',
		path: '/groups/:id',
		summary: 'Gruppe abrufen',
		tags: ['Modul: members'],
		permission: 'members.group.view',
		params: idParams,
		handler: async ({ params }) =>
			mdb().transaction((tx) => requireGroup(tx, (params as { id: string }).id))
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/groups',
		summary: 'Gruppe anlegen',
		tags: ['Modul: members'],
		permission: 'members.group.edit',
		body: groupInput,
		handler: async ({ ctx, body }) => {
			const group = await save(null, body as GroupInput);
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
			const group = await save((params as { id: string }).id, body as GroupInput);
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
			const { name, imagePath } = await mdb().transaction(async (tx) => {
				const group = await requireGroup(tx, id);
				const ref = rowsOf(await tx.execute(sql`SELECT image_path FROM groups WHERE id = ${id}`));
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
			await core.audit.logFromContext(ctx, 'members.group.deleted', {
				target: id,
				metadata: { name }
			});
			return { id };
		}
	} as ApiEndpoint
];
