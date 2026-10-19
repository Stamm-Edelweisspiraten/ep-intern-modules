/**
 * Website-Endpoints (API-Key der Stammeswebsite mit Scope `offices.website.read`).
 * Nur öffentliche Felder: Ämter, Amt-Adressen, Namen, Beschreibung und „seit“ der aktiven
 * Inhaber*innen – keine Benutzer-Mails, keine Rollen, keine Zeitstempel.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint } from '$lib/sdk/server';
import { loadOffices, mdb, rowsOf, usersByIds } from './load';
import { userIdParams, type WebsiteOffice } from './schemas';

const tags = ['Modul: offices'];
const AVATAR_BASE = '/api/v1/modules/offices/website/offices/holders';

const KEY_HINT =
	'Der API-Key gehört nur auf den Server der Website (nie in den Browser ausliefern); ' +
	'Profilbilder mit demselben Key über `avatarPath` laden und auf der Website zwischenspeichern.';

export const websiteEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/website/offices',
		summary: 'Ämter für die Stammeswebsite (API-Key mit Scope offices.website.read)',
		description:
			'Liefert alle Ämter in der festgelegten Reihenfolge mit Beschreibung, E-Mail-Adressen des ' +
			'Amts und den aktiven Inhaber*innen (Name, persönliche Beschreibung, „seit“, ' +
			'`avatarPath` oder `null`). Deaktivierte Konten erscheinen nicht. Keine Benutzer-Mails, ' +
			'Rollen oder Zeitstempel. ' +
			KEY_HINT,
		tags,
		permission: 'offices.website.read',
		rateLimit: { limit: 120, windowSec: 60 },
		handler: async ({ ctx }): Promise<WebsiteOffice[]> => {
			const data = await mdb().transaction((tx) => loadOffices(tx));
			const users = await usersByIds(
				ctx,
				data.offices.flatMap((o) => o.holders.map((h) => h.userId))
			);
			return data.offices.map((o) => ({
				id: o.id,
				name: o.name,
				description: o.description,
				position: o.position,
				emails: o.emails.map((e) => ({ label: e.label, email: e.email })),
				holders: o.holders.flatMap((h) => {
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
			'deaktiviert ist oder kein Profilbild hinterlegt hat. ' +
			KEY_HINT,
		tags,
		permission: 'offices.website.read',
		params: userIdParams,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async ({ params }) => {
			const [holder] = await mdb().transaction((tx) =>
				rowsOf(tx, sql`SELECT 1 AS ok FROM office_holders WHERE user_id = ${params.userId} LIMIT 1`)
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
] as unknown as ApiEndpoint[];
