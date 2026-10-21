/**
 * Datenschutz im Modul `actions` (#30):
 *
 * - **Löschfrist Gesundheitsdaten**: Job `actions.purge-health` (täglich) leert `diet`, `allergies`,
 *   `notes`, `health_answers` und gesundheitsbezogene Schlüssel in `answers` (Erkennung wie
 *   `health.ts`) aller Teilnehmenden, deren Aktion seit mehr als `actions.health.retentionDays` Tagen
 *   vorbei ist (Ende, ohne Ende der Start). Standard 90 Tage, `0` = nie löschen.
 * - **Mitglied gelöscht/anonymisiert** (`onMemberDeleted`, ausgelöst von `members`): verknüpfte
 *   Teilnehmende verlieren Name, Kontaktadresse, Gesundheitsdaten, Antworten und alle Verknüpfungen.
 *   Erhalten bleiben Rolle, Geburtsdatum (Alter für Zuschuss/Abrechnung), Gruppe und Quelle.
 * - **Datenauskunft** (`subjectExport`): Teilnahmen der Person (Konto oder Mitglied) im Klartext,
 *   eigene Aktionen und Freigaben.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	core,
	moduleDb,
	type ModuleDefinition,
	type ModuleJob,
	type ModuleSubjectExport,
	rowsOf,
	toIsoOrNull
} from '$lib/sdk/server';
import type { FieldDefinition } from '$lib/forms/types';
import { readHealth, splitAnswers } from './health';
import { MODULE_ID } from './schemas';

export const HEALTH_RETENTION_SETTING = 'actions.health.retentionDays';
export const DEFAULT_HEALTH_RETENTION_DAYS = 90;
/** Platzhalter-Name anonymisierter Teilnehmender */
export const ANONYMIZED_NAME = 'Anonymisiert';

const jsonObject = (v: unknown): Record<string, unknown> => {
	let o = v;
	if (typeof v === 'string') {
		try {
			o = JSON.parse(v);
		} catch {
			return {};
		}
	}
	return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
};

const dateText = (v: unknown): string | null => {
	if (v == null) return null;
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return String(v).slice(0, 10);
};

export const healthRetentionSetting = {
	key: HEALTH_RETENTION_SETTING,
	label: 'Aktionen: Gesundheitsdaten löschen (Tage nach Aktionsende, 0 = nie)',
	description:
		'Ernährung, Allergien, Medikamente/Mitteilungen und gesundheitsbezogene Formularantworten der ' +
		'Teilnehmenden werden so viele Tage nach dem Ende der Aktion automatisch gelöscht (täglicher Job).',
	schema: z.number().int().min(0).max(3650),
	default: DEFAULT_HEALTH_RETENTION_DAYS
};

async function retentionDays(): Promise<number> {
	const v = Number(await core.settings.get(HEALTH_RETENTION_SETTING));
	return Number.isInteger(v) && v >= 0 ? v : DEFAULT_HEALTH_RETENTION_DAYS;
}

/**
 * Gesundheitsdaten abgelaufener Aktionen leeren (idempotent). `days` überschreibt die Einstellung
 * (Tests); `0` = nichts tun.
 */
export async function purgeExpiredHealthData(days?: number): Promise<{ cleared: number }> {
	const keep = days ?? (await retentionDays());
	if (!keep) return { cleared: 0 };
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT p.id, p.diet, p.allergies, p.notes, p.health_answers, p.answers, f.definition
				FROM action_participants p
				JOIN actions a ON a.id = p.action_id
				LEFT JOIN action_forms f ON f.action_id = p.action_id
				WHERE COALESCE(a.ends_on, a.starts_on) < CURRENT_DATE - ${keep}::int
					AND (p.diet IS NOT NULL OR p.allergies IS NOT NULL OR p.notes IS NOT NULL
						OR p.health_answers IS NOT NULL OR p.answers <> '{}'::jsonb)
				FOR UPDATE OF p`
		);
		let cleared = 0;
		for (const r of rows) {
			const fields = jsonObject(r.definition).fields;
			const answers = jsonObject(r.answers);
			const { plain, health } = splitAnswers(
				answers,
				Array.isArray(fields) ? (fields as FieldDefinition[]) : []
			);
			const hasHealth =
				r.diet != null ||
				r.allergies != null ||
				r.notes != null ||
				r.health_answers != null ||
				Object.keys(health).length > 0;
			if (!hasHealth) continue;
			await tx.execute(
				sql`UPDATE action_participants SET diet = NULL, allergies = NULL, notes = NULL,
						health_answers = NULL, answers = ${JSON.stringify(plain)}::jsonb, updated_at = now()
					WHERE id = ${String(r.id)}`
			);
			cleared++;
		}
		return { cleared };
	});
}

export const purgeHealthJob: ModuleJob = {
	id: 'purge-health',
	summary: 'Gesundheitsdaten der Teilnehmenden nach Ablauf der Frist löschen',
	schedule: 'daily',
	run: async () => {
		const { cleared } = await purgeExpiredHealthData();
		return `Gesundheitsdaten von ${cleared} Teilnehmenden gelöscht`;
	}
};

/** Verknüpfte Teilnehmende gelöschter/anonymisierter Mitglieder anonymisieren */
export const onMemberDeleted: ModuleDefinition['onMemberDeleted'] = async (tx, { memberIds }) => {
	if (!memberIds.length) return;
	const list = sql.join(
		memberIds.map((id) => sql`${id}`),
		sql`, `
	);
	await tx.execute(
		sql`UPDATE action_participants SET name = ${ANONYMIZED_NAME}, contact_email = NULL,
				diet = NULL, allergies = NULL, notes = NULL, health_answers = NULL,
				answers = '{}'::jsonb, dedupe_key = NULL, member_id = NULL, user_id = NULL,
				updated_at = now()
			WHERE member_id IN (${list})`
	);
};

/** Datenauskunft: Teilnahmen (über Konto oder Mitglied), eigene Aktionen, Freigaben */
export const subjectExport: ModuleSubjectExport = {
	run: async ({ userId, memberIds }) => {
		if (!userId && !memberIds.length) return null;
		return moduleDb(MODULE_ID).transaction(async (tx) => {
			const conds = [];
			if (userId) conds.push(sql`p.user_id = ${userId}`);
			if (memberIds.length)
				conds.push(
					sql`p.member_id IN (${sql.join(
						memberIds.map((id) => sql`${id}`),
						sql`, `
					)})`
				);
			const participants = await rowsOf(
				tx,
				sql`SELECT p.*, a.name AS action_name, a.starts_on AS action_starts_on,
						a.ends_on AS action_ends_on
					FROM action_participants p JOIN actions a ON a.id = p.action_id
					WHERE ${sql.join(conds, sql` OR `)}
					ORDER BY a.starts_on, p.created_at`
			);
			const owned = userId
				? await rowsOf(
						tx,
						sql`SELECT id, name, starts_on, ends_on, created_at FROM actions
							WHERE owner_id = ${userId} ORDER BY starts_on`
					)
				: [];
			const shares = userId
				? await rowsOf(
						tx,
						sql`SELECT s.action_id, a.name, s.level FROM action_shares s
							JOIN actions a ON a.id = s.action_id WHERE s.user_id = ${userId}`
					)
				: [];
			if (!participants.length && !owned.length && !shares.length) return null;
			return {
				participations: participants.map((p) => {
					const h = readHealth(p);
					return {
						action: {
							id: String(p.action_id),
							name: String(p.action_name),
							startsOn: dateText(p.action_starts_on),
							endsOn: dateText(p.action_ends_on)
						},
						participantId: String(p.id),
						name: String(p.name),
						birthDate: dateText(p.birth_date),
						role: String(p.role),
						group: p.group_label ?? null,
						contactEmail: p.contact_email ?? null,
						bremenResident: p.bremen_resident ?? null,
						juleica: Boolean(p.juleica),
						diet: h.diet,
						allergies: h.allergies,
						notes: h.notes,
						answers: h.answers,
						source: String(p.source),
						memberId: p.member_id ?? null,
						consentAcceptedAt: toIsoOrNull(p.consent_accepted_at),
						createdAt: toIsoOrNull(p.created_at),
						updatedAt: toIsoOrNull(p.updated_at)
					};
				}),
				ownedActions: owned.map((a) => ({
					id: String(a.id),
					name: String(a.name),
					startsOn: dateText(a.starts_on),
					endsOn: dateText(a.ends_on),
					createdAt: toIsoOrNull(a.created_at)
				})),
				sharedWithMe: shares.map((s) => ({
					actionId: String(s.action_id),
					name: String(s.name),
					level: String(s.level)
				}))
			};
		});
	}
};
