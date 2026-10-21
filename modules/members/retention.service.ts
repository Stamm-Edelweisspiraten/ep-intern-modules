/**
 * Löschfrist nach Austritt (#30): ehemalige Mitglieder, deren Austritt länger als
 * `members.retention.exitYears` Jahre zurückliegt, werden als **Vorschlag** gelistet und nur auf
 * ausdrücklichen Wunsch (Recht `members.member.delete`) anonymisiert – kein automatischer Job.
 *
 * Anonymisieren: Name → „Anonymisiert“, Geburtsdatum → 1. Januar des Geburtsjahrs (Altersstatistik),
 * Pfadfindername, Anschrift, Zusatzfelder (auch Gesundheitsangaben), Einwilligungen samt Nachweis,
 * Telefone, E-Mails, Gruppen, Leitungen, Konto-Verknüpfungen, Verknüpfungscodes, Mail-Einstellungen
 * und Dokumente werden gelöscht. Erhalten bleiben Stand, Ein-/Austritt, Zweitmitgliedschaft und
 * Beitragsebenen. Danach räumen andere Module per `onMemberDeleted` auf (z. B. `actions`).
 */
import { sql } from 'drizzle-orm';
import { core, moduleDb, type RequestContext, rowsOf, type Tx } from '$lib/sdk/server';
import { syncLeaderGrantsAfterChange } from './leader.service';
import { removeMemberFiles } from './members.service';
import { MODULE_ID } from './schemas';

export const RETENTION_SETTING = 'members.retention.exitYears';
export const DEFAULT_RETENTION_YEARS = 3;
export const ANONYMIZED_FIRST_NAME = 'Anonymisiert';
export const MAX_RETENTION_LIST = 500;

export interface RetentionCandidate {
	id: string;
	firstName: string;
	lastName: string;
	/** JJJJ-MM-TT */
	exitDate: string;
}

export interface RetentionList {
	years: number;
	/** Austritt vor diesem Datum (JJJJ-MM-TT) */
	cutoff: string;
	items: RetentionCandidate[];
	total: number;
}

export interface AnonymizeResult {
	affected: number;
	skipped: { id: string; name: string; reason: string }[];
}

export async function retentionYears(): Promise<number> {
	const v = Number(await core.settings.get(RETENTION_SETTING));
	return Number.isInteger(v) && v >= 1 ? v : DEFAULT_RETENTION_YEARS;
}

/** Bedingung „Austritt älter als N Jahre, noch nicht anonymisiert“ */
const dueSql = (years: number) =>
	sql`m.exit_date IS NOT NULL AND m.exit_date < (CURRENT_DATE - make_interval(years => ${years}::int))::date
		AND m.anonymized_at IS NULL`;

export async function listRetentionCandidates(years?: number): Promise<RetentionList> {
	const y = years ?? (await retentionYears());
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const [c] = await rowsOf(
			tx,
			sql`SELECT to_char((CURRENT_DATE - make_interval(years => ${y}::int))::date, 'YYYY-MM-DD') AS cutoff`
		);
		const [n] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM members m WHERE ${dueSql(y)}`);
		const found = await rowsOf(
			tx,
			sql`SELECT m.id, m.first_name, m.last_name, to_char(m.exit_date, 'YYYY-MM-DD') AS exit_date
				FROM members m WHERE ${dueSql(y)}
				ORDER BY m.exit_date, m.last_name, m.first_name, m.id LIMIT ${MAX_RETENTION_LIST}`
		);
		return {
			years: y,
			cutoff: String(c?.cutoff),
			total: Number(n?.n ?? 0),
			items: found.map((r) => ({
				id: String(r.id),
				firstName: String(r.first_name),
				lastName: String(r.last_name),
				exitDate: String(r.exit_date)
			}))
		};
	});
}

/** Ein Mitglied anonymisieren (in der Transaktion); Rückgabe = Dokumentpfade zum Entfernen */
async function anonymizeInTx(tx: Tx, id: string): Promise<string[]> {
	const [m] = await rowsOf(
		tx,
		sql`SELECT privacy_consent_path, registration_path FROM members WHERE id = ${id} FOR UPDATE`
	);
	await tx.execute(sql`DELETE FROM group_leaders WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_groups WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_phones WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_emails WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_user_links WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_link_codes WHERE member_id = ${id}`);
	await tx.execute(sql`DELETE FROM member_mail_prefs WHERE member_id = ${id}`);
	await tx.execute(
		sql`UPDATE members SET first_name = ${ANONYMIZED_FIRST_NAME}, last_name = '', scout_name = NULL,
				birth_date = make_date(extract(year FROM birth_date)::int, 1, 1),
				street = NULL, postal_code = NULL, city = NULL, address = NULL, custom = '{}'::jsonb,
				consent_social_media = false, consent_social_media_at = NULL, consent_social_media_by = NULL,
				consent_website = false, consent_website_at = NULL, consent_website_by = NULL,
				consent_print = false, consent_print_at = NULL, consent_print_by = NULL,
				privacy_consent_path = NULL, privacy_consent_name = NULL,
				registration_path = NULL, registration_name = NULL,
				anonymized_at = now(), updated_at = now()
			WHERE id = ${id}`
	);
	return [m?.privacy_consent_path, m?.registration_path].filter(
		(p): p is string => typeof p === 'string' && p.length > 0
	);
}

/**
 * Sammel-Anonymisieren. Nur Mitglieder, deren Frist abgelaufen ist; andere (unbekannt, noch nicht
 * fällig, bereits anonymisiert, einzige Leitung einer Gruppe) werden mit Grund übersprungen.
 */
export async function anonymizeMembers(
	ctx: RequestContext,
	ids: string[],
	years?: number
): Promise<AnonymizeResult> {
	const y = years ?? (await retentionYears());
	const unique = [...new Set(ids)];
	const { done, skipped, paths } = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const list = sql.join(
			unique.map((i) => sql`${i}`),
			sql`, `
		);
		const due = new Map(
			(
				await rowsOf(
					tx,
					sql`SELECT m.id, m.first_name, m.last_name FROM members m
						WHERE m.id IN (${list}) AND ${dueSql(y)} ORDER BY m.id FOR UPDATE`
				)
			).map((r) => [String(r.id), `${r.first_name} ${r.last_name}`.trim()])
		);
		const sole = new Map(
			(
				await rowsOf(
					tx,
					sql`SELECT gl.member_id, g.name FROM group_leaders gl JOIN groups g ON g.id = gl.group_id
						WHERE gl.member_id IN (${list})
						AND NOT EXISTS (SELECT 1 FROM group_leaders o
							WHERE o.group_id = gl.group_id AND o.member_id <> gl.member_id)`
				)
			).map((r) => [String(r.member_id), String(r.name)])
		);
		const done: string[] = [];
		const skipped: AnonymizeResult['skipped'] = [];
		const paths: string[] = [];
		for (const id of unique) {
			const name = due.get(id);
			if (name === undefined) {
				skipped.push({ id, name: '', reason: 'Frist nicht abgelaufen oder nicht vorhanden' });
				continue;
			}
			const group = sole.get(id);
			if (group) {
				skipped.push({ id, name, reason: `Einzige Leitung der Gruppe ${group}` });
				continue;
			}
			paths.push(...(await anonymizeInTx(tx, id)));
			done.push(id);
		}
		return { done, skipped, paths };
	});
	await removeMemberFiles(ctx, paths);
	if (done.length) await syncLeaderGrantsAfterChange(ctx);
	const failed = done.length
		? await core.modules.memberDeleted(MODULE_ID, { memberIds: done, reason: 'anonymized' })
		: [];
	await core.audit.logFromContext(ctx, 'members.member.anonymized', {
		metadata: {
			requested: unique.length,
			affected: done.length,
			skipped: skipped.length,
			years: y,
			...(failed.length ? { cleanupFailed: failed } : {})
		}
	});
	return { affected: done.length, skipped };
}
