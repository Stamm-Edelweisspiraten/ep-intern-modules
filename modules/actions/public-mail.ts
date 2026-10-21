/**
 * Hilfen für öffentliche Formulare (Anmeldelink, Kosten-Link).
 *
 * Obergrenze für Mails aus öffentlichen Formularen (Issue #17): je Aktion, Mail-Art und Kalendertag
 * (Datenbankzeit). Schützt die Absender-Domain davor, dass ein bekannt gewordener Link massenhaft
 * Mails an fremde Adressen auslöst. Zähler in `public_mail_counters` (Migration 0019).
 */
import { sql } from 'drizzle-orm';
import { core, rowsOf, type Tx } from '$lib/sdk/server';

/** Höchstzahl je Aktion und Tag */
export const PUBLIC_MAIL_LIMITS = {
	/** Bitte um Bestätigung (Double-Opt-in) beim Anmeldelink – darüber wird abgelehnt */
	'registration-optin': 100,
	/** Eingangsbestätigung an die einreichende Person beim Kosten-Link – darüber ohne Mail */
	'expense-confirm': 30,
	/** Hinweis an die Eigentümer*in der Aktion beim Kosten-Link – darüber ohne Mail */
	'expense-owner': 30
} as const;
export type PublicMailKind = keyof typeof PUBLIC_MAIL_LIMITS;

/**
 * In einer offenen Transaktion: Zähler für heute erhöhen. `true`, solange das Tageslimit nicht
 * überschritten ist. Wird die Transaktion zurückgerollt, zählt der Versuch nicht.
 */
export async function takeMailQuota(
	tx: Tx,
	actionId: string,
	kind: PublicMailKind
): Promise<boolean> {
	const [r] = await rowsOf(
		tx,
		sql`INSERT INTO public_mail_counters (action_id, kind, day, count)
			VALUES (${actionId}, ${kind}, CURRENT_DATE, 1)
			ON CONFLICT (action_id, kind, day)
			DO UPDATE SET count = public_mail_counters.count + 1
			RETURNING count`
	);
	return Number(r?.count ?? 0) <= PUBLIC_MAIL_LIMITS[kind];
}

/** Globale Datenschutzerklärung (`core.legal.privacyUrl`, Issue #28) oder `null` */
export async function globalPrivacyUrl(): Promise<string | null> {
	try {
		const v = await core.settings.get('core.legal.privacyUrl');
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	} catch {
		return null;
	}
}

/** Alte Zähler löschen (älter als 7 Tage) */
export async function purgeMailCounters(tx: Tx): Promise<void> {
	await tx.execute(sql`DELETE FROM public_mail_counters WHERE day < CURRENT_DATE - 7`);
}
