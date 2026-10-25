/**
 * Dienste für das Modul `messages` (Vertrag: `contract.ts`): Mitglieder von Gruppen und die vom Konto
 * geleiteten Gruppen mit Gruppen-Adresse. Ohne Rechteprüfung – der Aufrufer prüft seine Rechte.
 */
import { sql } from 'drizzle-orm';
import { inList, moduleDb, type RequestContext, rowsOf } from '$lib/sdk/server';
import { todayBerlin } from '$lib/sdk/dates';
import type { GroupMailbox, LedGroupRef, MembersService, WebsiteGroupRef } from './contract';
import { activeLeader, ledGroupIds } from './leader.service';
import { MODULE_ID } from './schemas';

/** Höchstzahl Gruppen je Aufruf */
const GROUPS_MAX = 50;

export const messagingService: Pick<
	MembersService,
	| 'listGroupMemberIds'
	| 'listLedGroups'
	| 'getOwnMemberName'
	| 'listSelfMemberNames'
	| 'listGroupMailboxes'
	| 'listWebsiteGroupRefs'
> = {
	async listGroupMemberIds(groupIds) {
		const ids = [...new Set(groupIds)].slice(0, GROUPS_MAX);
		const out: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
		if (!ids.length) return out;
		const rows = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT mg.group_id, mg.member_id
					FROM member_groups mg JOIN members m ON m.id = mg.member_id
					WHERE mg.group_id IN (${inList(ids)})
						AND m.anonymized_at IS NULL
						AND (m.exit_date IS NULL OR m.exit_date > ${todayBerlin()}::date)
					ORDER BY mg.group_id, mg.member_id`
			)
		);
		for (const r of rows) out[String(r.group_id)]?.push(String(r.member_id));
		return out;
	},

	async getOwnMemberName(ctx: RequestContext) {
		if (!ctx.userId) return null;
		const userId = ctx.userId;
		const rows = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT m.first_name, m.last_name FROM member_user_links l
					JOIN members m ON m.id = l.member_id
					WHERE l.user_id = ${userId} AND l.is_self AND m.anonymized_at IS NULL
					LIMIT 1`
			)
		);
		const r = rows[0];
		return r ? { firstName: String(r.first_name), lastName: String(r.last_name) } : null;
	},

	async listLedGroups(ctx: RequestContext): Promise<LedGroupRef[]> {
		const ids = await ledGroupIds(ctx);
		if (!ids.length) return [];
		const rows = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT id, name, contact_email FROM groups WHERE id IN (${inList(ids)}) ORDER BY name, id`
			)
		);
		return rows.map((r) => ({
			id: String(r.id),
			name: String(r.name),
			email: r.contact_email == null || r.contact_email === '' ? null : String(r.contact_email)
		}));
	},

	async listSelfMemberNames() {
		const rows = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT DISTINCT ON (l.user_id) l.user_id, m.first_name, m.last_name
					FROM member_user_links l JOIN members m ON m.id = l.member_id
					WHERE l.is_self AND m.anonymized_at IS NULL
					ORDER BY l.user_id, m.id`
			)
		);
		return rows.map((r) => ({
			userId: String(r.user_id),
			firstName: String(r.first_name),
			lastName: String(r.last_name)
		}));
	},

	async listGroupMailboxes(): Promise<GroupMailbox[]> {
		const rows = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT g.id, g.name, g.contact_email, l.user_id
					FROM groups g
					LEFT JOIN group_leaders gl ON gl.group_id = g.id
					LEFT JOIN members m ON m.id = gl.member_id AND ${activeLeader('m')}
					LEFT JOIN member_user_links l ON l.member_id = m.id AND l.is_self
					WHERE g.contact_email IS NOT NULL AND g.contact_email <> ''
					ORDER BY g.name, g.id`
			)
		);
		const byId = new Map<string, GroupMailbox>();
		for (const r of rows) {
			const id = String(r.id);
			const entry = byId.get(id) ?? {
				id,
				name: String(r.name),
				email: String(r.contact_email).trim().toLowerCase(),
				leaderUserIds: []
			};
			const user = r.user_id == null ? null : String(r.user_id);
			if (user && !entry.leaderUserIds.includes(user)) entry.leaderUserIds.push(user);
			byId.set(id, entry);
		}
		return [...byId.values()];
	},

	async listWebsiteGroupRefs(): Promise<WebsiteGroupRef[]> {
		const rows = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT id, slug, name, type, age_range FROM groups
					WHERE on_website = true AND slug IS NOT NULL
					ORDER BY CASE type WHEN 'meute' THEN 0 ELSE 1 END, name, id`
			)
		);
		return rows.map((r) => ({
			id: String(r.id),
			slug: String(r.slug),
			name: String(r.name),
			type: r.type === 'sippe' ? 'sippe' : 'meute',
			ageRange: r.age_range == null || r.age_range === '' ? null : String(r.age_range)
		}));
	}
};
