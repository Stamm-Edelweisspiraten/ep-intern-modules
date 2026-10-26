/**
 * Website-Endpoints (API-Key der Stammeswebsite mit Scope `members.website.read`).
 * Liefern NUR Gruppen mit `on_website = true` und gesetzter Adresse (`slug`) und nur die Felder
 * von `WebsiteGroup`: Leitende ausschließlich mit Vornamen und nur mit Website-Einwilligung – keine
 * Nachnamen, keine Mitglieder-Mails,
 * keine Geburtsdaten, keine Mitgliederzahlen.
 * Core-Aufrufe (Storage) laufen außerhalb der Modul-Transaktion (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	moduleDb,
	resultRows,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { groupSlugParams, type GroupType, type WebsiteGroup } from './schemas';

const MODULE = 'members';
/** Systemkontext für den Storage-Abruf: der Website-Key hat kein `members.storage.read` */
const storageCtx = () => core.auth.systemContext('members-website');

const tags = ['Modul: members'];
const IMAGE_BASE = '/api/v1/modules/members/website/groups';
const NOT_FOUND = 'Gruppe nicht gefunden';
const NO_IMAGE = 'Kein Bild vorhanden';
/** Meuten (jüngere Kinder) vor Sippen */
const TYPE_ORDER: Record<GroupType, number> = { meute: 0, sippe: 1 };

const KEY_HINT =
	'Der API-Key gehört nur auf den Server der Website (nie in den Browser ausliefern); ' +
	'Gruppenbilder mit demselben Key über `imagePath` laden und auf der Website zwischenspeichern.';

const textOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

const GROUP_SELECT = sql`SELECT id, name, type, description, website_description, age_range,
	meeting_place, meeting_weekday, meeting_time, meeting_end_time, color, contact_email, slug,
	(image_path IS NOT NULL) AS has_image, updated_at
	FROM groups`;

/**
 * Vornamen der Leitenden je Gruppe. Nur mit Website-Einwilligung (`consent_website`, #27);
 * ausgetretene Mitglieder (Austritt ≤ heute) entfallen. Direkt leitende Konten (`group_leader_users`)
 * erscheinen nicht – für sie gibt es keine Website-Einwilligung.
 */
async function leadersByGroup(tx: Tx, groupIds: string[]): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	if (!groupIds.length) return map;
	const rows = resultRows(
		await tx.execute(
			sql`SELECT gl.group_id, m.first_name
				FROM group_leaders gl JOIN members m ON m.id = gl.member_id
				WHERE gl.group_id IN (${sql.join(
					groupIds.map((id) => sql`${id}`),
					sql`, `
				)})
					AND (m.exit_date IS NULL OR m.exit_date > CURRENT_DATE)
					AND m.consent_website = true`
		)
	);
	for (const r of rows) {
		const list = map.get(String(r.group_id)) ?? [];
		list.push(String(r.first_name));
		map.set(String(r.group_id), list);
	}
	for (const list of map.values()) list.sort((a, b) => a.localeCompare(b, 'de'));
	return map;
}

function toWebsiteGroup(g: Row, leaders: string[]): WebsiteGroup {
	const slug = String(g.slug);
	const version = new Date(String(g.updated_at)).getTime();
	return {
		id: String(g.id),
		slug,
		name: String(g.name),
		type: g.type as GroupType,
		description: textOrNull(g.website_description) ?? textOrNull(g.description),
		ageRange: textOrNull(g.age_range),
		meetingPlace: textOrNull(g.meeting_place),
		meetingWeekday: g.meeting_weekday == null ? null : Number(g.meeting_weekday),
		meetingTime: textOrNull(g.meeting_time),
		// Ende nur zusammen mit dem Beginn ausliefern
		meetingEndTime: g.meeting_time == null ? null : textOrNull(g.meeting_end_time),
		color: textOrNull(g.color),
		contactEmail: textOrNull(g.contact_email),
		leaders: leaders.map((firstName) => ({ firstName })),
		imagePath: g.has_image ? `${IMAGE_BASE}/${encodeURIComponent(slug)}/image?v=${version}` : null
	};
}

async function loadWebsiteGroups(tx: Tx, slug?: string): Promise<WebsiteGroup[]> {
	const groups = resultRows(
		await tx.execute(
			slug
				? sql`${GROUP_SELECT} WHERE on_website = true AND slug = ${slug}`
				: sql`${GROUP_SELECT} WHERE on_website = true AND slug IS NOT NULL`
		)
	);
	const leaders = await leadersByGroup(
		tx,
		groups.map((g) => String(g.id))
	);
	return groups
		.map((g) => toWebsiteGroup(g, leaders.get(String(g.id)) ?? []))
		.sort(
			(a, b) =>
				TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
				a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
		);
}

export const websiteEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/website/groups',
		summary: 'Gruppen-Steckbriefe für die Stammeswebsite (API-Key mit Scope members.website.read)',
		description:
			'Liefert alle Gruppen, die auf der Website gezeigt werden sollen (Meuten vor Sippen, dann nach ' +
			'Name): Adresse (`slug`), Typ, Website-Text (sonst interne Beschreibung), Alter, Treffen, ' +
			'Farbe, Kontakt-E-Mail der Gruppe, Leitende nur mit Vornamen (nur mit Website-Einwilligung) und ' +
			'`imagePath` oder `null`. ' +
			'Keine Nachnamen, Mitglieder-Mails, Geburtsdaten oder Mitgliederzahlen. ' +
			KEY_HINT,
		tags,
		permission: 'members.website.read',
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async (): Promise<WebsiteGroup[]> =>
			moduleDb(MODULE).transaction((tx) => loadWebsiteGroups(tx))
	}),

	defineEndpoint({
		method: 'GET',
		path: '/website/groups/:slug',
		summary: 'Gruppen-Steckbrief für die Stammeswebsite',
		description:
			'Eine Gruppe über ihre Adresse (`slug`). 404, wenn es die Adresse nicht gibt oder die Gruppe ' +
			'nicht auf der Website gezeigt wird. ' +
			KEY_HINT,
		tags,
		permission: 'members.website.read',
		params: groupSlugParams,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async ({ params }): Promise<WebsiteGroup> => {
			const [group] = await moduleDb(MODULE).transaction((tx) =>
				loadWebsiteGroups(tx, params.slug)
			);
			if (!group) throw errors.notFound(NOT_FOUND);
			return group;
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/website/groups/:slug/image',
		summary: 'Gruppenbild für die Stammeswebsite',
		description:
			'Liefert das Bild roh (Content-Type wie gespeichert). 404, wenn die Gruppe nicht auf der ' +
			'Website gezeigt wird, kein Bild hat oder kein Speicher eingerichtet ist. ' +
			KEY_HINT,
		tags,
		permission: 'members.website.read',
		params: groupSlugParams,
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ params }) => {
			const ref = await moduleDb(MODULE).transaction(async (tx) => {
				const [r] = resultRows(
					await tx.execute(
						sql`SELECT image_path FROM groups WHERE on_website = true AND slug = ${params.slug}`
					)
				);
				return r;
			});
			if (!ref) throw errors.notFound(NOT_FOUND);
			if (ref.image_path == null) throw errors.notFound(NO_IMAGE);
			let download: Awaited<ReturnType<typeof core.storage.download>>;
			try {
				download = await core.storage.download(storageCtx(), {
					module: MODULE,
					path: String(ref.image_path)
				});
			} catch {
				// Kein Speicher eingerichtet oder Datei fehlt → für die Website schlicht „kein Bild“
				throw errors.notFound(NO_IMAGE);
			}
			const { buffer, file } = download;
			return new Response(buffer as BodyInit, {
				status: 200,
				headers: {
					'content-type': file.contentType,
					'content-length': String(buffer.byteLength),
					'content-disposition': 'inline',
					'cache-control': 'public, max-age=86400',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	})
];
