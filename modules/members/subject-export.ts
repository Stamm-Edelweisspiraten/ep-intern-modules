/**
 * Datenauskunft (Art. 15/20 DSGVO, Core-Seite `/admin/privacy`): Mitglieder finden, zu einem Konto
 * die verknüpften Mitglieder ergänzen und alle Mitgliedsdaten (Stammdaten, Kontakte, Zusatzfelder
 * inkl. Gesundheitsangaben, Einwilligungen mit Nachweis, Gruppen, Leitungen, Konto-Verknüpfungen,
 * Mail-Einstellungen, Dokumentnamen) als JSON liefern. Dokumentinhalte werden nicht mitgeliefert.
 */
import { sql } from 'drizzle-orm';
import { inList, moduleDb, type ModuleSubjectExport, rowsOf, toIsoOrNull } from '$lib/sdk/server';
import { loadMembersByIds } from './members.service';
import { MODULE_ID } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const subjectExport: ModuleSubjectExport = {
	findSubjects: async (query, limit) =>
		moduleDb(MODULE_ID).transaction(async (tx) => {
			const p = like(query);
			const found = await rowsOf(
				tx,
				sql`SELECT id, first_name, last_name, scout_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
						to_char(exit_date, 'YYYY-MM-DD') AS exit_date
					FROM members
					WHERE anonymized_at IS NULL
						AND (first_name ILIKE ${p} OR last_name ILIKE ${p} OR scout_name ILIKE ${p}
							OR (first_name || ' ' || last_name) ILIKE ${p})
					ORDER BY last_name, first_name, id LIMIT ${limit}`
			);
			return found.map((r) => ({
				label: `${String(r.first_name)} ${String(r.last_name)}`.trim(),
				detail: [
					r.scout_name ? String(r.scout_name) : null,
					`geb. ${String(r.birth_date)}`,
					r.exit_date ? `Austritt ${String(r.exit_date)}` : null
				]
					.filter(Boolean)
					.join(' · '),
				subject: { memberIds: [String(r.id)] }
			}));
		}),

	/** Konto → verknüpfte Mitglieder (z. B. eigene Kinder) gehören zur Auskunft dazu */
	resolve: async ({ userId }) => {
		if (!userId) return {};
		const linked = await moduleDb(MODULE_ID).transaction((tx) =>
			rowsOf(tx, sql`SELECT member_id FROM member_user_links WHERE user_id = ${userId}`)
		);
		return { memberIds: linked.map((r) => String(r.member_id)) };
	},

	run: async ({ userId, memberIds }) => {
		if (!memberIds.length && !userId) return null;
		const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
			const members = memberIds.length ? await loadMembersByIds(tx, memberIds) : [];
			if (!members.length) return null;
			const ids = members.map((m) => m.id);
			const links = await rowsOf(
				tx,
				sql`SELECT member_id, user_id, relation, created_at FROM member_user_links
					WHERE member_id IN (${inList(ids)})`
			);
			const leads = await rowsOf(
				tx,
				sql`SELECT gl.member_id, g.id, g.name FROM group_leaders gl JOIN groups g ON g.id = gl.group_id
					WHERE gl.member_id IN (${inList(ids)})`
			);
			const prefs = await rowsOf(
				tx,
				sql`SELECT member_id, category, enabled, updated_at FROM member_mail_prefs
					WHERE member_id IN (${inList(ids)})`
			);
			return members.map((m) => ({
				...m,
				// Interne Zähler sind keine Personendaten der betroffenen Person
				linkCount: undefined,
				linkedAccounts: links
					.filter((l) => l.member_id === m.id)
					.map((l) => ({
						userId: String(l.user_id),
						relation: l.relation ?? null,
						createdAt: toIsoOrNull(l.created_at),
						isRequester: l.user_id === userId
					})),
				leaderOf: leads
					.filter((l) => l.member_id === m.id)
					.map((l) => ({ id: String(l.id), name: String(l.name) })),
				mailPreferences: prefs
					.filter((p) => p.member_id === m.id)
					.map((p) => ({
						category: String(p.category),
						enabled: Boolean(p.enabled),
						updatedAt: toIsoOrNull(p.updated_at)
					}))
			}));
		});
		return data ? { members: data } : null;
	}
};
