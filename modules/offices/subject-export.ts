/**
 * Datenauskunft (Art. 15/20 DSGVO, `/admin/privacy`): alle personenbezogenen Daten eines Kontos im
 * Modul `offices` – Ämter (Name, „seit“, Position), persönliche Beschreibung, Website-Zustimmung,
 * Benachrichtigungs-Einstellungen und Einträge der Tageszusammenfassung. Nur das Konto (`userId`):
 * Ämter hängen nicht an Mitgliedern. Eigene Transaktion, keine Core-Dienste darin.
 */
import { sql } from 'drizzle-orm';
import type { DataSubject, ModuleSubjectExport } from '$lib/sdk/server';
import { iso, mdb, rowsOf, textOrNull } from './load';

async function run(subject: DataSubject): Promise<Record<string, unknown> | null> {
	const userId = subject.userId;
	if (!userId) return null;
	return mdb().transaction(async (tx) => {
		const offices = await rowsOf(
			tx,
			sql`SELECT o.id, o.name, to_char(h.since, 'YYYY-MM-DD') AS since, h.position, h.created_at
				FROM office_holders h JOIN offices o ON o.id = h.office_id
				WHERE h.user_id = ${userId} ORDER BY o.position, o.name, o.id`
		);
		const [profile] = await rowsOf(
			tx,
			sql`SELECT bio, show_on_website, show_on_website_at, updated_at
				FROM holder_profiles WHERE user_id = ${userId}`
		);
		const prefs = await rowsOf(
			tx,
			sql`SELECT module_id, office_key, event_key, mode, updated_at FROM notification_prefs
				WHERE user_id = ${userId} ORDER BY module_id, office_key, event_key`
		);
		const queue = await rowsOf(
			tx,
			sql`SELECT module_id, office_key, event_key, subject, created_at FROM notification_queue
				WHERE user_id = ${userId} ORDER BY created_at, id`
		);
		if (!offices.length && !profile && !prefs.length && !queue.length) return null;
		return {
			offices: offices.map((r) => ({
				id: String(r.id),
				name: String(r.name),
				since: textOrNull(r.since),
				position: Number(r.position ?? 0),
				assignedAt: iso(r.created_at)
			})),
			profile: profile
				? {
						bio: textOrNull(profile.bio),
						showOnWebsite: profile.show_on_website === true,
						showOnWebsiteChangedAt:
							profile.show_on_website_at == null ? null : iso(profile.show_on_website_at),
						updatedAt: iso(profile.updated_at)
					}
				: null,
			notificationPreferences: prefs.map((r) => ({
				module: String(r.module_id),
				office: String(r.office_key),
				event: String(r.event_key),
				mode: String(r.mode),
				updatedAt: iso(r.updated_at)
			})),
			pendingDigest: queue.map((r) => ({
				module: String(r.module_id),
				office: String(r.office_key),
				event: String(r.event_key),
				subject: String(r.subject),
				createdAt: iso(r.created_at)
			}))
		};
	});
}

export const subjectExport: ModuleSubjectExport = { run };
