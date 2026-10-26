/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql, type SQL } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea, Tx } from '$lib/sdk/server';

/**
 * Hinweis Dokumente: Einwilligung/Anmeldebogen liegen als Spalten an `members` und im Storage unter
 * `<memberId>/…` (Gruppenbilder unter `groups/…`). Sie lassen sich weder per Tabelle noch per Präfix
 * getrennt löschen – daher gibt es (noch) keinen eigenen Bereich „Dokumente“; `all` räumt sie mit ab.
 */
export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Mitglieder und Gruppen',
		description:
			'Löscht alle Mitglieder, Gruppen, Kontakte, Zusatzfelder, Konto-Verknüpfungen und Mail-Einstellungen ' +
			'sowie alle hochgeladenen Dokumente und Gruppenbilder. Die vordefinierten Zusatzfelder werden neu angelegt. ' +
			'Nicht mitgelöscht werden Teilnehmende in Aktionen, Bestellungen, Gruppen-Zuordnungen von Terminen und ' +
			'Freigaben an Gruppen oder Mitglieder (Termine, Dateien, Galerien): Sie bleiben erhalten, ihr Verweis zeigt ' +
			'danach ins Leere und erscheint als „Unbekannt“.',
		tables: [
			'member_mail_prefs',
			'member_link_codes',
			'member_user_links',
			'group_leaders',
			'group_leader_users',
			'member_groups',
			'member_phones',
			'member_emails',
			'members',
			'groups',
			'member_field_defs'
		],
		storagePrefixes: 'all',
		rebuild: true,
		implies: [
			{
				area: 'treasury:payers',
				reason: 'Zahler*innen sind über ihre Kinder mit Mitgliedern verknüpft.'
			},
			{
				area: 'treasury:annual',
				reason: 'Jahresbeiträge werden je Mitglied berechnet und abgerechnet.'
			}
		]
	},
	{
		id: 'links',
		label: 'Konto-Verknüpfungen',
		description:
			'Löscht alle Verknüpfungen zwischen Benutzerkonten und Mitgliedern sowie alle Verknüpfungscodes ' +
			'(Briefe werden ungültig). Mitglieder und Benutzer bleiben erhalten.',
		tables: ['member_user_links', 'member_link_codes']
	}
];

/**
 * Konto-Verknüpfungen und Gruppenleitungen per Konto lösen; `match` erzeugt die Bedingung für
 * `user_id` – gemeinsam genutzt von `resetUsers` (alle außer einer Person) und `onUserDeleted`
 * (eine Person, `user-deleted.ts`).
 */
export async function unlinkUsers(tx: Tx, match: (col: SQL) => SQL): Promise<void> {
	await tx.execute(sql`DELETE FROM member_user_links WHERE ${match(sql.raw('user_id'))}`);
	await tx.execute(sql`DELETE FROM group_leader_users WHERE ${match(sql.raw('user_id'))}`);
}

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await unlinkUsers(tx, (col) => sql`${col} <> ${keepUserId}`);
};
