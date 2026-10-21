/**
 * Gruppenleitung: Konten, deren **eigenes** Mitglied (Verknüpfung mit `is_self`, nur von der
 * Verwaltung gesetzt) eine Gruppe leitet, sehen und bearbeiten die Mitglieder dieser Gruppen.
 *
 * - Bereich (`ledGroupIds`) wird bei jedem Aufruf frisch aus der Datenbank bestimmt: Austritt,
 *   Leitungswechsel oder gelöste Verknüpfung wirken sofort.
 * - Die Rechte `members.led-member.*` kommen über die automatische Rolle „Gruppenleitung“
 *   (`core.roles.replaceModuleGrants`, Core-Tabelle `user_role_grant`, nur bei aktivem Modul).
 *   `syncLeaderGrants` nach jeder relevanten Änderung und stündlich per Job.
 * - Eltern (Verknüpfung ohne `is_self`) bekommen nie Leitungsrechte.
 * Core-Aufrufe nie innerhalb einer Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	errors,
	inList,
	moduleDb,
	type RequestContext,
	rowsOf,
	type Tx
} from '$lib/sdk/server';
import { todayBerlin } from '$lib/sdk/dates';
import { LEADER_ROLE_NAME, MODULE_ID } from './schemas';

/** Mitglied zählt als Leitung: nicht ausgetreten, nicht anonymisiert */
const activeLeader = (alias: string) => {
	const a = sql.raw(alias);
	return sql`${a}.anonymized_at IS NULL AND (${a}.exit_date IS NULL OR ${a}.exit_date > ${todayBerlin()}::date)`;
};

/** Gruppen, die das Konto über sein eigenes, aktives Mitglied leitet (sortiert, ohne Konto leer) */
export async function ledGroupIds(ctx: RequestContext): Promise<string[]> {
	if (!ctx.userId) return [];
	const userId = ctx.userId;
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT DISTINCT gl.group_id FROM member_user_links l
				JOIN group_leaders gl ON gl.member_id = l.member_id
				JOIN members m ON m.id = l.member_id
				WHERE l.user_id = ${userId} AND l.is_self AND ${activeLeader('m')}
				ORDER BY gl.group_id`
		)
	);
	return rows.map((r) => String(r.group_id));
}

/** SQL-Bedingung: Mitglied `alias` gehört zu einer der Gruppen (leere Liste → nie) */
export function inScopeSql(alias: string, scope: readonly string[]) {
	const a = sql.raw(alias);
	return sql`EXISTS (SELECT 1 FROM member_groups sg WHERE sg.member_id = ${a}.id
		AND sg.group_id IN (${inList([...scope])}))`;
}

/** Mitglied außerhalb der geleiteten Gruppen → 404 (Existenz nicht verraten) */
export async function assertMemberInScope(
	tx: Tx,
	memberId: string,
	scope: readonly string[]
): Promise<void> {
	const found = await rowsOf(
		tx,
		sql`SELECT 1 FROM members m WHERE m.id = ${memberId} AND ${inScopeSql('m', scope)}`
	);
	if (!found.length) throw errors.notFound('Mitglied nicht gefunden');
}

/** Alle Verleihungen der Rolle „Gruppenleitung“ neu setzen; Rückgabe = Anzahl der Konten */
export async function syncLeaderGrants(): Promise<{ users: number }> {
	const roleId = await core.roles.defaultRoleId(LEADER_ROLE_NAME);
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT DISTINCT l.user_id FROM member_user_links l
				JOIN group_leaders gl ON gl.member_id = l.member_id
				JOIN members m ON m.id = l.member_id
				WHERE l.is_self AND ${activeLeader('m')}
				ORDER BY l.user_id`
		)
	);
	const users = rows.map((r) => String(r.user_id));
	await core.roles.replaceModuleGrants(
		MODULE_ID,
		roleId ? users.map((userId) => ({ userId, roleIds: [roleId] })) : []
	);
	return { users: roleId ? users.length : 0 };
}

/** Abgleich nach einer Änderung: Fehler nur protokollieren, der stündliche Job gleicht nach */
export async function syncLeaderGrantsAfterChange(ctx?: RequestContext): Promise<void> {
	await bestEffort('members.leader-grants.sync', () => syncLeaderGrants(), { ctx });
}

/**
 * Schutz vor Rechteausweitung: Wer bewirkt, dass ein Konto die Rolle „Gruppenleitung“ erhält, braucht
 * alle Rechte dieser Rolle selbst (403). `memberIds` = Mitglieder, die neu Leitung werden
 * (`becomesLeader`) bzw. deren Konto neu als eigenes markiert wird (`becomesSelf`). Nur nötig, wenn
 * dadurch tatsächlich ein Konto die Rolle bekommt. Vor der Transaktion aufrufen.
 */
export async function assertCanGrantLeader(
	ctx: RequestContext,
	memberIds: readonly string[],
	reason: 'becomesLeader' | 'becomesSelf'
): Promise<void> {
	if (!memberIds.length) return;
	const roleId = await core.roles.defaultRoleId(LEADER_ROLE_NAME);
	if (!roleId) return;
	const ids = inList([...memberIds]);
	const affected = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			reason === 'becomesLeader'
				? sql`SELECT 1 FROM member_user_links l JOIN members m ON m.id = l.member_id
					WHERE l.member_id IN (${ids}) AND l.is_self AND ${activeLeader('m')} LIMIT 1`
				: sql`SELECT 1 FROM group_leaders gl JOIN members m ON m.id = gl.member_id
					WHERE gl.member_id IN (${ids}) AND ${activeLeader('m')} LIMIT 1`
		)
	);
	if (affected.length) await core.roles.assertCanGrant(ctx, [roleId]);
}
