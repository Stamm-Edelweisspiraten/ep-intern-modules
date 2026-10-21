/**
 * Globale Suche (Befehlspalette): Mitglieder nach Vor-/Nach-/Pfadfindername und Gruppen nach Name.
 * Mitglieder sieht jede*r mit `members.member.view` (wie `GET /members`), Gruppen nur mit
 * `members.group.view`. Keine sensiblen Felder (Geburtsdatum, Kontakte, Gesundheit) in den Treffern.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	moduleDb,
	type ModuleSearchProvider,
	type Row,
	rowsOf,
	type SearchHit,
	type Tx
} from '$lib/sdk/server';
import { GROUP_TYPE_LABELS, MODULE_ID, STAGE_LABELS, type GroupType, type Stage } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function memberTitle(r: Row): string {
	const name = `${String(r.first_name)} ${String(r.last_name)}`.trim();
	return r.scout_name ? `${name} (${String(r.scout_name)})` : name;
}

async function searchMembers(tx: Tx, p: string, limit: number): Promise<SearchHit[]> {
	const found = await rowsOf(
		tx,
		sql`SELECT m.id, m.first_name, m.last_name, m.scout_name, m.stage,
				(m.exit_date IS NOT NULL AND m.exit_date <= CURRENT_DATE) AS has_left,
				(SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM member_groups mg
					JOIN groups g ON g.id = mg.group_id WHERE mg.member_id = m.id) AS group_names
			FROM members m
			WHERE m.first_name ILIKE ${p} OR m.last_name ILIKE ${p} OR m.scout_name ILIKE ${p}
				OR (m.first_name || ' ' || m.last_name) ILIKE ${p}
			ORDER BY has_left, m.last_name, m.first_name, m.id
			LIMIT ${limit}`
	);
	return found.map((r) => {
		const left = r.has_left === true || r.has_left === 't';
		const parts = [
			r.group_names ? String(r.group_names) : null,
			STAGE_LABELS[r.stage as Stage] ?? null,
			left ? 'ausgetreten' : null
		].filter(Boolean);
		return {
			id: `member:${String(r.id)}`,
			title: memberTitle(r),
			subtitle: parts.join(' · ') || undefined,
			href: `/modules/members?open=${encodeURIComponent(String(r.id))}${left ? '&status=all' : ''}`,
			icon: 'users',
			type: 'Mitglied'
		};
	});
}

async function searchGroups(tx: Tx, p: string, limit: number): Promise<SearchHit[]> {
	const found = await rowsOf(
		tx,
		sql`SELECT g.id, g.name, g.type,
				(SELECT count(*)::int FROM member_groups mg WHERE mg.group_id = g.id) AS member_count
			FROM groups g WHERE g.name ILIKE ${p}
			ORDER BY g.name, g.id LIMIT ${limit}`
	);
	return found.map((r) => {
		const n = Number(r.member_count ?? 0);
		const type = GROUP_TYPE_LABELS[r.type as GroupType] ?? null;
		return {
			id: `group:${String(r.id)}`,
			title: String(r.name),
			subtitle: [type, `${n} ${n === 1 ? 'Mitglied' : 'Mitglieder'}`].filter(Boolean).join(' · '),
			href: `/modules/members/groups?open=${encodeURIComponent(String(r.id))}`,
			icon: 'folder',
			type: 'Gruppe'
		};
	});
}

export const membersSearch: ModuleSearchProvider = {
	anyPermission: ['members.member.view', 'members.group.view'],
	async run(ctx, query, limit) {
		const members = core.permissions.has(ctx, 'members.member.view');
		const groups = core.permissions.has(ctx, 'members.group.view');
		const p = like(query);
		const { m, g } = await moduleDb(MODULE_ID).transaction(async (tx) => ({
			m: members ? await searchMembers(tx, p, limit) : [],
			g: groups ? await searchGroups(tx, p, limit) : []
		}));
		// Gemeinsames Limit fair teilen: Gruppen bekommen mindestens die Hälfte, wenn es so viele gibt
		const gTake = Math.min(g.length, Math.max(limit - m.length, Math.floor(limit / 2)));
		return [...m.slice(0, limit - gTake), ...g.slice(0, gTake)];
	}
};
