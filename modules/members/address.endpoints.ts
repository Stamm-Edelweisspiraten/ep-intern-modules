import { defineEndpoint, type AnyApiEndpoint } from '$lib/sdk/server';
import { placesForPostalCode, suggestAddresses } from './address.service';
import { addressPlacesQuery, addressSuggestQuery } from './schemas';

const tags = ['Mitglieder'];

export const addressEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/address/suggest',
		summary:
			'Adressvorschläge (Straße, Hausnummer, PLZ, Ort): Mitglieder-Anschriften, Straßenverzeichnis (OpenPLZ), ersatzweise Photon',
		tags,
		permission: 'members.member.edit',
		query: addressSuggestQuery,
		// Die Oberfläche fragt beim Tippen (höchstens alle 250 ms, Hausnummern ohne Anfrage)
		rateLimit: { limit: 180, windowSec: 60 },
		handler: ({ query }) =>
			suggestAddresses(query.q, { postalCode: query.postalCode, country: query.country })
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
];
