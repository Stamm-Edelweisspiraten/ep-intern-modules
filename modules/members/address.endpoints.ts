import { defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import { placesForPostalCode, suggestAddresses } from './address.service';
import { addressPlacesQuery, addressSuggestQuery } from './schemas';

const tags = ['Mitglieder'];

export const addressEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/address/suggest',
		summary: 'Adressvorschläge (Straße, Hausnummer, PLZ, Ort) zu einem Suchtext',
		tags,
		permission: 'members.member.edit',
		query: addressSuggestQuery,
		rateLimit: { limit: 90, windowSec: 60 },
		handler: ({ query }) => suggestAddresses(query.q)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/address/places',
		summary: 'Orte zu einer deutschen Postleitzahl',
		tags,
		permission: 'members.member.edit',
		query: addressPlacesQuery,
		handler: ({ query }) => ({ items: placesForPostalCode(query.postalCode) })
	})
] as unknown as ApiEndpoint[];
