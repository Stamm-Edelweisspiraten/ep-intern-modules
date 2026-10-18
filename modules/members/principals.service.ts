import { sql } from 'drizzle-orm';
import { core, type Tx } from '$lib/sdk/server';
import type { MemberGroupRef, MemberPrincipalRef, MembersService } from './contract';
import { MODULE_ID } from './schemas';

/**
 * Dienste für Freigaben an Principals (Gruppen, Mitglieder) – ohne Rechteprüfung, nur Namen/Farben.
 * In `module.ts` an `provides` gehängt (Vertrag `contract.ts`).
 */

type Row = Record<string, unknown>;
const mdb = () => core.database.forModule(MODULE_ID);

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	return ((await tx.execute(query)) as unknown as { rows: Row[] }).rows;
}

const idList = (ids: readonly string[]) =>
	sql.join(
		ids.map((v) => sql`${v}`),
		sql`, `
	);

/** Nicht ausgetreten: kein Austritt oder Austritt erst in der Zukunft */
const ACTIVE = sql`(m.exit_date IS NULL OR m.exit_date > CURRENT_DATE)`;

const SEARCH_MIN = 2;
const IDS_MAX = 100;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 30;

async function listGroups(): Promise<MemberGroupRef[]> {
	const found = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT id, name, color, meeting_weekday, meeting_time, meeting_place,
					image_path IS NOT NULL AS has_image, updated_at
				FROM groups ORDER BY name, id`
		)
	);
	return found.map((r) => ({
		id: r.id as string,
		name: r.name as string,
		color: (r.color as string | null) ?? null,
		image: groupImageUrl(r),
		meetingWeekday: weekdayOf(r.meeting_weekday),
		meetingTime: timeOf(r.meeting_time),
		meetingPlace: textOf(r.meeting_place)
	}));
}

/** Adresse des Gruppenbilds (Cache-Schlüssel = letzte Änderung) oder `null` ohne Bild */
function groupImageUrl(r: Record<string, unknown>): string | null {
	if (r.has_image !== true && r.has_image !== 't') return null;
	const v = new Date(String(r.updated_at)).getTime();
	return `/api/v1/modules/members/groups/${encodeURIComponent(String(r.id))}/image?v=${v}`;
}

/** Wochentag 1–7 als Zahl, sonst `null` */
function weekdayOf(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
}

/** Freitext getrimmt, leer → `null` */
function textOf(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t ? t : null;
}

/** Uhrzeit auf `HH:MM` gekürzt (z. B. `18:30:00` → `18:30`), leer → `null` */
function timeOf(v: unknown): string | null {
	const t = textOf(v);
	if (!t) return null;
	const m = /^(\d{1,2}):(\d{2})/.exec(t);
	return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : t;
}

async function principalIdsForUser(
	userId: string
): Promise<{ memberIds: string[]; groupIds: string[] }> {
	if (!userId) return { memberIds: [], groupIds: [] };
	return mdb().transaction(async (tx) => {
		const members = await rows(
			tx,
			sql`SELECT DISTINCT m.id FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} AND ${ACTIVE} ORDER BY m.id`
		);
		const memberIds = members.map((r) => r.id as string);
		if (!memberIds.length) return { memberIds, groupIds: [] };
		const groups = await rows(
			tx,
			sql`SELECT group_id FROM member_groups WHERE member_id IN (${idList(memberIds)})
				UNION
				SELECT group_id FROM group_leaders WHERE member_id IN (${idList(memberIds)})`
		);
		const groupIds = [...new Set(groups.map((r) => r.group_id as string))].sort();
		return { memberIds, groupIds };
	});
}

async function searchMembers(query: {
	search?: string;
	ids?: string[];
	limit?: number;
}): Promise<MemberPrincipalRef[]> {
	const rawLimit = Number(query.limit ?? LIMIT_DEFAULT);
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(1, Math.floor(rawLimit)), LIMIT_MAX)
		: LIMIT_DEFAULT;
	const search = (query.search ?? '').trim();
	const ids = [...new Set((query.ids ?? []).filter((v) => typeof v === 'string' && v))].slice(
		0,
		IDS_MAX
	);

	let where;
	if (search.length >= SEARCH_MIN) {
		const cleaned = search.replace(/[%_\\]/g, '');
		if (!cleaned.trim()) return [];
		const p = `%${cleaned}%`;
		where = sql`${ACTIVE} AND (m.first_name ILIKE ${p} OR m.last_name ILIKE ${p}
			OR m.scout_name ILIKE ${p} OR (m.first_name || ' ' || m.last_name) ILIKE ${p})`;
	} else if (ids.length) {
		where = sql`m.id IN (${idList(ids)})`;
	} else {
		return [];
	}

	return mdb().transaction(async (tx) => {
		const list = await rows(
			tx,
			sql`SELECT m.id, m.first_name, m.last_name FROM members m WHERE ${where}
				ORDER BY m.last_name, m.first_name, m.id LIMIT ${limit}`
		);
		if (!list.length) return [];
		const groups = await rows(
			tx,
			sql`SELECT mg.member_id, g.id, g.name FROM member_groups mg JOIN groups g ON g.id = mg.group_id
				WHERE mg.member_id IN (${idList(list.map((r) => r.id as string))}) ORDER BY g.name, g.id`
		);
		return list.map((r) => ({
			id: r.id as string,
			name: `${r.first_name as string} ${r.last_name as string}`.trim(),
			groups: groups
				.filter((g) => g.member_id === r.id)
				.map((g) => ({ id: g.id as string, name: g.name as string }))
		}));
	});
}

export const principalsService: Pick<
	MembersService,
	'listGroups' | 'principalIdsForUser' | 'searchMembers'
> = { listGroups, principalIdsForUser, searchMembers };
