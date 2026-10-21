/**
 * Hilfs-Endpoints für die Galerie-UI: Freigabe-Kandidaten, Terminsuche, Stammesname.
 * Alle Core-/Modul-Dienste außerhalb von Transaktionen (PGlite).
 */
import { sql } from 'drizzle-orm';
import {
	defineEndpoint,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	principalMatchSql,
	requireShareCapability,
	searchPrincipals,
	type AnyApiEndpoint
} from '$lib/sdk/server';
import { eventsService } from './files';
import { everyoneLabel } from './galleries.service';
import { MODULE_ID, eventSearchQuery, principalSearchQuery, type EventRef } from './schemas';

const TAGS = ['Modul: galleries'];
export const metaEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Kandidaten suchen (Stamm, Gruppen, Rollen, Benutzer*innen, Mitglieder)',
		description:
			'Nur für Personen, die Galerien teilen können (`galleries.gallery.create`, `edit-all`, Eigentümer*in oder `edit`-Freigabe einer Galerie), sonst 403. Mitglieder nur mit `members.member.view`, E-Mail-Adressen nur mit `core.users.view`.',
		tags: TAGS,
		permission: 'galleries.gallery.view',
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalSearchQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: ['galleries.gallery.create', 'galleries.gallery.edit-all'],
				canShareSql: (userId, keys) =>
					sql`SELECT 1 FROM galleries WHERE owner_id = ${userId}
						UNION ALL
						SELECT 1 FROM gallery_shares s WHERE s.level = 'edit' AND ${principalMatchSql('s', keys)}`
			});
			return searchPrincipals(ctx, MODULE_ID, query.search, {
				everyoneLabel: await everyoneLabel()
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/events',
		summary: 'Termine für die Zuordnung von Bildern suchen (nur für den Aufrufer sichtbare)',
		description: 'Suche im Titel, neueste zuerst. Ohne aktives Modul `events` eine leere Liste.',
		tags: TAGS,
		permission: 'galleries.gallery.view',
		query: eventSearchQuery,
		handler: async ({ ctx, query }) => {
			const service = await eventsService();
			if (!service) return [] as EventRef[];
			const refs = await service.searchEventRefs(ctx, {
				search: query.search || undefined,
				limit: query.limit
			});
			return refs.map((r): EventRef => ({
				id: r.id,
				title: r.title,
				startsOn: r.startsOn,
				endsOn: r.endsOn,
				color: r.color
			}));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/settings/stamm',
		summary: 'Name des Stamms (Anzeige „ganzer Stamm“ in der Freigabe)',
		tags: TAGS,
		permission: 'galleries.gallery.view',
		handler: async () => ({ name: await everyoneLabel() })
	})
];
