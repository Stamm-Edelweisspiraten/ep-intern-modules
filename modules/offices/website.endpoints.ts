/**
 * Website-Endpoints (API-Key der Stammeswebsite mit Scope `offices.website.read`).
 * Nur öffentliche Felder: Ämter, Amt-Adressen, Namen, Beschreibung und „seit“ der aktiven
 * Inhaber*innen – keine Benutzer-Mails, keine Rollen, keine Zeitstempel.
 * Personen erscheinen NUR mit ausdrücklicher Zustimmung (`holder_profiles.show_on_website`,
 * Opt-in im Profil, Standard aus); ohne Zustimmung fehlen sie ganz (auch kein Profilbild).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	type AnyApiEndpoint
} from '$lib/sdk/server';
import { loadOffices, mdb, rowsOf, usersByIds } from './load';
import { userIdParams, type WebsiteOffice } from './schemas';

const tags = ['Modul: offices'];
const AVATAR_BASE = '/api/v1/modules/offices/website/offices/holders';

const KEY_HINT =
	'Der API-Key gehört nur auf den Server der Website (nie in den Browser ausliefern); ' +
	'Profilbilder mit demselben Key über `avatarPath` laden und auf der Website zwischenspeichern.';

export const websiteEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/website/offices',
		summary: 'Ämter für die Stammeswebsite (API-Key mit Scope offices.website.read)',
		description:
			'Liefert alle Ämter in der festgelegten Reihenfolge mit Beschreibung, E-Mail-Adressen des ' +
			'Amts und den aktiven Inhaber*innen (Name, persönliche Beschreibung, „seit“, ' +
			'`avatarPath` oder `null`). Es erscheinen nur Personen, die der Anzeige auf der Website ' +
			'im Profil zugestimmt haben (Opt-in); ohne Zustimmung hat das Amt keine Einträge in ' +
			'`holders`. Deaktivierte Konten erscheinen nicht. Keine Benutzer-Mails, ' +
			'Rollen oder Zeitstempel. ' +
			KEY_HINT,
		tags,
		permission: 'offices.website.read',
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async ({ ctx }): Promise<WebsiteOffice[]> => {
			const data = await mdb().transaction((tx) => loadOffices(tx));
			const users = await usersByIds(
				ctx,
				data.offices.flatMap((o) =>
					o.holders.map((h) => h.userId).filter((id) => data.websiteOptIn.has(id))
				)
			);
			return data.offices.map((o) => ({
				id: o.id,
				name: o.name,
				description: o.description,
				position: o.position,
				emails: o.emails.map((e) => ({ label: e.label, email: e.email })),
				holders: o.holders.flatMap((h) => {
					// Ohne Opt-in weder Name noch Bild noch Beschreibung (#27)
					if (!data.websiteOptIn.has(h.userId)) return [];
					const u = users.get(h.userId);
					if (!u) return [];
					return [
						{
							id: h.userId,
							name: u.name,
							bio: data.bios.get(h.userId) ?? null,
							since: h.since,
							avatarPath: u.image ? `${AVATAR_BASE}/${encodeURIComponent(h.userId)}/avatar` : null
						}
					];
				})
			}));
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/website/offices/holders/:userId/avatar',
		summary: 'Profilbild einer Amtsinhaberin / eines Amtsinhabers für die Stammeswebsite',
		description:
			'Liefert das Bild roh (Content-Type des Bilds). 404, wenn die Person aktuell kein Amt hat, ' +
			'der Anzeige auf der Website nicht zugestimmt hat, deaktiviert ist oder kein Profilbild ' +
			'hinterlegt hat. ' +
			KEY_HINT,
		tags,
		permission: 'offices.website.read',
		params: userIdParams,
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ params }) => {
			const [holder] = await mdb().transaction((tx) =>
				rowsOf(
					tx,
					sql`SELECT 1 AS ok FROM office_holders h
						JOIN holder_profiles p ON p.user_id = h.user_id AND p.show_on_website = true
						WHERE h.user_id = ${params.userId} LIMIT 1`
				)
			);
			if (!holder) throw errors.notFound('Profilbild nicht gefunden');
			const avatar = await core.users.readAvatar(params.userId);
			if (!avatar) throw errors.notFound('Profilbild nicht gefunden');
			return new Response(avatar.data as BodyInit, {
				status: 200,
				headers: {
					'content-type': avatar.contentType,
					'content-length': String(avatar.data.byteLength),
					'cache-control': 'private, max-age=300',
					'x-content-type-options': 'nosniff',
					'content-disposition': 'inline'
				}
			});
		}
	})
];
