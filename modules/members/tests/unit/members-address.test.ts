import { describe, expect, it } from 'vitest';
import { memberInput } from '$modules/members/schemas';
import {
	directoryName,
	normalizeStreet,
	placesForPostalCode,
	splitHouseNumber,
	toSuggestion
} from '$modules/members/address.service';
import { matchesStreetName, withHouseNumber } from '$modules/members/address-utils';
import { countryOptions } from '$modules/members/pages/countries';

const base = {
	firstName: 'Max',
	lastName: 'Muster',
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '28357',
	city: 'Bremen',
	stage: 'pfadfinder'
};

describe('Anschrift im Mitglied', () => {
	it('Land ist standardmäßig Deutschland, Kürzel wird groß geschrieben', () => {
		expect(memberInput.parse(base).country).toBe('DE');
		expect(memberInput.parse({ ...base, country: 'at', postalCode: '1010' }).country).toBe('AT');
	});

	it('deutsche PLZ hat genau 5 Ziffern, Ausland freier', () => {
		expect(memberInput.safeParse({ ...base, postalCode: '2835' }).success).toBe(false);
		expect(memberInput.safeParse({ ...base, postalCode: '28 357' }).success).toBe(false);
		expect(memberInput.safeParse({ ...base, country: 'GB', postalCode: 'SW1A 1AA' }).success).toBe(
			true
		);
		expect(memberInput.safeParse({ ...base, country: 'AT', postalCode: '<x>' }).success).toBe(
			false
		);
	});

	it('Straße, PLZ, Ort sind Pflicht; ungültiges Land wird abgelehnt', () => {
		for (const k of ['street', 'postalCode', 'city']) {
			expect(memberInput.safeParse({ ...base, [k]: '  ' }).success, k).toBe(false);
		}
		expect(memberInput.safeParse({ ...base, country: 'Deutschland' }).success).toBe(false);
	});
});

describe('Photon → Adressvorschlag', () => {
	it('baut Straße + Nr., PLZ, Ort, Land', () => {
		expect(
			toSuggestion({
				street: 'Rockwinkler Heerstraße',
				housenumber: '140',
				postcode: '28355',
				city: 'Bremen',
				countrycode: 'DE'
			})
		).toEqual({
			label: 'Rockwinkler Heerstraße 140, 28355 Bremen',
			street: 'Rockwinkler Heerstraße 140',
			postalCode: '28355',
			city: 'Bremen',
			country: 'DE',
			source: 'photon'
		});
	});

	it('Straßentreffer ohne Hausnummer; Ort aus town/village', () => {
		const s = toSuggestion({
			name: 'Hauptstraße',
			osm_key: 'highway',
			postcode: '37308',
			village: 'Krombach',
			countrycode: 'de'
		});
		expect(s?.street).toBe('Hauptstraße');
		expect(s?.city).toBe('Krombach');
		expect(s?.country).toBe('DE');
	});

	it('verwirft Treffer ohne Straße oder ohne PLZ und Ort', () => {
		expect(toSuggestion({ name: 'Bremen', osm_key: 'place', postcode: '28195' })).toBeNull();
		expect(toSuggestion({ street: 'Weg', countrycode: 'DE' })).toBeNull();
		expect(toSuggestion({ street: 'Weg', city: 'X', countrycode: 'Deutschland' })).toBeNull();
	});
});

describe('PLZ → Ort (offline)', () => {
	it('kennt gängige Postleitzahlen', () => {
		expect(placesForPostalCode('28207')).toContain('Bremen');
		expect(placesForPostalCode('10115')).toContain('Berlin');
		expect(placesForPostalCode('80331')).toContain('München');
		expect(placesForPostalCode('00000')).toEqual([]);
	});
});

describe('Länderliste', () => {
	it('Deutschland zuerst, unbekannte Codes werden ergänzt', () => {
		const o = countryOptions('BS');
		expect(o[0]).toEqual({ value: 'DE', label: 'Deutschland' });
		expect(o.some((c) => c.value === 'BS')).toBe(true);
		expect(o.some((c) => c.value === 'AT' && c.label === 'Österreich')).toBe(true);
	});
});

describe('Hausnummer und Straßennamen', () => {
	it('trennt die Hausnummer ab', () => {
		expect(splitHouseNumber('Am Wall 12a')).toEqual({ name: 'Am Wall', number: '12a' });
		expect(splitHouseNumber('Am Wall 12 a')).toEqual({ name: 'Am Wall', number: '12a' });
		expect(splitHouseNumber('Hauptstr. 12-14')).toEqual({ name: 'Hauptstr.', number: '12-14' });
		expect(splitHouseNumber('Weg 3/1')).toEqual({ name: 'Weg', number: '3/1' });
		expect(splitHouseNumber('Schwachhauser')).toEqual({ name: 'Schwachhauser', number: '' });
		// Zahl im Straßennamen bleibt, wenn keine Hausnummer folgt
		expect(splitHouseNumber('Straße des 17. Juni')).toEqual({
			name: 'Straße des 17. Juni',
			number: ''
		});
	});

	it('vergleicht „Straße“ und „Str.“ gleich', () => {
		expect(normalizeStreet('Rockwinkler Heerstraße 140')).toBe('rockwinkler heerstr. 140');
		expect(normalizeStreet('Rockwinkler  Heerstr. 140')).toBe('rockwinkler heerstr. 140');
	});
});

describe('Suchname fürs Straßenverzeichnis', () => {
	it('kürzt „straße“/„strasse“ auf „str“', () => {
		expect(directoryName('Schwachhauser Heerstraße')).toBe('Schwachhauser Heerstr');
		expect(directoryName('Hauptstrasse')).toBe('Hauptstr');
		expect(directoryName('Rockwinkler  Heerstr.')).toBe('Rockwinkler Heerstr.');
		expect(directoryName('Straße des 17. Juni')).toBe('str des 17. Juni');
	});
});

describe('Weitertippen ohne neue Anfrage', () => {
	it('formt angefangene „straße“ ebenfalls um, „Strand“ bleibt', () => {
		expect(directoryName('Schwachhauser Heerstra')).toBe('Schwachhauser Heerstr');
		expect(directoryName('Schwachhauser Heerstraß')).toBe('Schwachhauser Heerstr');
		expect(directoryName('Hauptstrass')).toBe('Hauptstr');
		expect(directoryName('Am Strand')).toBe('Am Strand');
	});

	it('tauscht die Hausnummer im Vorschlag', () => {
		expect(withHouseNumber('Am Wall 1', '1', '12')).toBe('Am Wall 12');
		expect(withHouseNumber('Am Wall', '', '12a')).toBe('Am Wall 12a');
		expect(withHouseNumber('Am Wall 12', '12', '')).toBe('Am Wall');
		// Straße endet zufällig nicht auf die alte Nummer → nur anhängen
		expect(withHouseNumber('Weg 17', '3', '4')).toBe('Weg 17 4');
	});
});

describe('Veraltete Vorschläge', () => {
	it('prüft, ob ein Vorschlag noch zur getippten Straße passt', () => {
		expect(matchesStreetName('Schwachhauser Heerstr. 12', 'Schwachhauser Heerstraße')).toBe(true);
		expect(matchesStreetName('Am Walberberg 12', 'Am Wall')).toBe(false);
		expect(matchesStreetName('Am Wall 12', 'am wall')).toBe(true);
		expect(matchesStreetName('Aderkirchweg 3', 'Kirchweg')).toBe(true);
	});
});
