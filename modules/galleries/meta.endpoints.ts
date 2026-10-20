/**
 * Hilfs-Endpoints für die Galerie-UI: Freigabe-Kandidaten, Terminsuche, Stammesname.
 * Alle Core-/Modul-Dienste außerhalb von Transaktionen (PGlite).
 */
import { defineEndpoint, searchPrincipals, type ApiEndpoint } from '$lib/sdk/server';
import { eventsService } from './files';
import { everyoneLabel } from './galleries.service';
import { MODULE_ID, eventSearchQuery, principalSearchQuery, type EventRef } from './schemas';

const TAGS = ['Modul: galleries'];
export const metaEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Kandidaten suchen (Stamm, Gruppen, Rollen, Benutzer*innen, Mitglieder)',
		tags: TAGS,
		permission: 'galleries.gallery.view',
		query: principalSearchQuery,
		handler: async ({ ctx, query }) =>
			searchPrincipals(ctx, MODULE_ID, query.search, { everyoneLabel: await everyoneLabel() })
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
] as unknown as ApiEndpoint[];
