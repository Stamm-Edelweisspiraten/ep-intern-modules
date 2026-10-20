/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

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
			'Teilnehmende in Aktionen bleiben erhalten, verlieren aber den Bezug zum Mitglied.',
		tables: [
			'member_mail_prefs',
			'member_link_codes',
			'member_user_links',
			'group_leaders',
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

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(sql`DELETE FROM member_user_links WHERE user_id <> ${keepUserId}`);
};
