import { sql } from 'drizzle-orm';
import {
	core,
	inList,
	moduleDb,
	type PrincipalProvider,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import type { MemberGroupRef, MemberPrincipalRef, MembersService } from './contract';
import { MODULE_ID } from './schemas';

/**
 * Dienste für Freigaben an Principals (Gruppen, Mitglieder). In `module.ts` an `provides` gehängt
 * (Vertrag `PrincipalProvider` im SDK, erweitert in `contract.ts`).
 * `listGroups`/`principalIdsForUser`/`searchMembers` prüfen keine Rechte (Aufrufer prüft);
 * `searchMemberPrincipals` (Freigabe-Suche) prüft selbst `members.member.view`.
 */

/** Recht, ohne das die Freigabe-Suche keine Mitglieder (Kinder) liefert */
const MEMBER_VIEW = 'members.member.view';

/** Nicht ausgetreten: kein Austritt oder Austritt erst in der Zukunft */
const ACTIVE = sql`(m.exit_date IS NULL OR m.exit_date > CURRENT_DATE)`;

const SEARCH_MIN = 2;
const IDS_MAX = 100;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 30;

async function listGroups(): Promise<MemberGroupRef[]> {
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, name, color, meeting_weekday, meeting_time, meeting_end_time, meeting_place,
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
		meetingEndTime: timeOf(r.meeting_end_time),
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
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const members = await rowsOf(
			tx,
			sql`SELECT DISTINCT m.id FROM member_user_links l JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} AND ${ACTIVE} ORDER BY m.id`
		);
		const memberIds = members.map((r) => r.id as string);
		if (!memberIds.length) return { memberIds, groupIds: [] };
		const groups = await rowsOf(
			tx,
			sql`SELECT group_id FROM member_groups WHERE member_id IN (${inList(memberIds)})
				UNION
				SELECT group_id FROM group_leaders WHERE member_id IN (${inList(memberIds)})`
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
		where = sql`m.id IN (${inList(ids)})`;
	} else {
		return [];
	}

	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const list = await rowsOf(
			tx,
			sql`SELECT m.id, m.first_name, m.last_name FROM members m WHERE ${where}
				ORDER BY m.last_name, m.first_name, m.id LIMIT ${limit}`
		);
		if (!list.length) return [];
		const groups = await rowsOf(
			tx,
			sql`SELECT mg.member_id, g.id, g.name FROM member_groups mg JOIN groups g ON g.id = mg.group_id
				WHERE mg.member_id IN (${inList(list.map((r) => r.id as string))}) ORDER BY g.name, g.id`
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

/**
 * Freigabe-Suche/-Anzeige mit Rechteprüfung (Defense in Depth zu `$lib/sdk/server/sharing.ts`):
 * Namen und Gruppen von Mitgliedern nur mit `members.member.view` (System-Kontext immer).
 */
async function searchMemberPrincipals(
	ctx: RequestContext,
	query: { search?: string; ids?: string[]; limit?: number }
): Promise<MemberPrincipalRef[]> {
	if (!core.permissions.has(ctx, MEMBER_VIEW)) return [];
	return searchMembers(query);
}

/** Siehe `PrincipalProvider.userIdsForPrincipals` */
async function userIdsForPrincipals(input: {
	memberIds: string[];
	groupIds: string[];
}): Promise<string[]> {
	const memberIds = [...new Set(input.memberIds)].slice(0, 2000);
	const groupIds = [...new Set(input.groupIds)].slice(0, 50);
	if (!memberIds.length && !groupIds.length) return [];
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT DISTINCT l.user_id FROM member_user_links l
				JOIN members m ON m.id = l.member_id
				WHERE m.anonymized_at IS NULL AND ${ACTIVE} AND (
					l.member_id IN (${inList(memberIds)})
					OR l.member_id IN (SELECT member_id FROM member_groups WHERE group_id IN (${inList(groupIds)}))
					OR l.member_id IN (SELECT member_id FROM group_leaders WHERE group_id IN (${inList(groupIds)}))
				)`
		)
	);
	return found.map((r) => String(r.user_id));
}

export const principalsService = {
	listGroups,
	principalIdsForUser,
	searchMembers,
	searchMemberPrincipals,
	userIdsForPrincipals
} satisfies PrincipalProvider &
	Pick<MembersService, 'listGroups' | 'principalIdsForUser' | 'searchMembers'>;
