/**
 * Probestunden: Altersangaben der Gruppen lesen, passende Gruppe wählen; die Website nutzt eine Kopie der Logik.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupAgeRange, groupsForAge, parseAgeRange } from '$modules/messages/age-range';
import * as copy from '../../../../website/src/lib/age-range';
import { pickTrialGroup, trialSubject } from '$modules/messages/trial.service';
import type { WebsiteGroupRef } from '$modules/members/contract';

const groups: WebsiteGroupRef[] = [
	{
		id: '1',
		slug: 'meute',
		name: 'Füchse',
		type: 'meute',
		ageRange: '6 bis 10 Jahre',
		ageMin: 6,
		ageMax: 10
	},
	// Altbestand ohne Zahlen: Zuordnung über den Text
	{
		id: '2',
		slug: 'jung',
		name: 'Löwen',
		type: 'sippe',
		ageRange: '11–14',
		ageMin: null,
		ageMax: null
	},
	{
		id: '3',
		slug: 'alt',
		name: 'Panther',
		type: 'sippe',
		ageRange: 'ab 15 Jahren',
		ageMin: 15,
		ageMax: null
	},
	{
		id: '4',
		slug: 'frei',
		name: 'Ohne',
		type: 'sippe',
		ageRange: 'für alle',
		ageMin: null,
		ageMax: null
	}
];

describe('parseAgeRange', () => {
	it.each([
		['6 bis 10 Jahre', { min: 6, max: 10 }],
		['11–14', { min: 11, max: 14 }],
		['7-10 Jahre', { min: 7, max: 10 }],
		['10 bis 7', { min: 7, max: 10 }],
		['ab 15 Jahren', { min: 15, max: null }],
		['16+', { min: 16, max: null }],
		['bis 10 Jahre', { min: null, max: 10 }],
		['unter 10', { min: null, max: 9 }],
		['12 Jahre', { min: 12, max: 12 }],
		['für alle', null],
		['', null],
		[null, null]
	])('%s', (text, expected) => {
		expect(parseAgeRange(text)).toEqual(expected);
	});
});

describe('groupsForAge', () => {
	it('findet die passende Gruppe an den Grenzen', () => {
		expect(groupsForAge(groups, 6).groups.map((g) => g.slug)).toEqual(['meute']);
		expect(groupsForAge(groups, 10).groups.map((g) => g.slug)).toEqual(['meute']);
		expect(groupsForAge(groups, 11).groups.map((g) => g.slug)).toEqual(['jung']);
		expect(groupsForAge(groups, 30)).toMatchObject({ exact: true });
	});
	it('nimmt sonst die nächstgelegene (nicht exakt)', () => {
		expect(groupsForAge(groups, 4)).toEqual({ groups: [groups[0]], exact: false });
	});
	it('Zahlen gehen vor dem Text', () => {
		const g = { ageRange: '6 bis 10 Jahre', ageMin: 12, ageMax: null };
		expect(groupAgeRange(g)).toEqual({ min: 12, max: null });
		expect(groupsForAge([g], 8)).toEqual({ groups: [g], exact: false });
		expect(groupAgeRange({ ageRange: null, ageMin: null, ageMax: 9 })).toEqual({
			min: null,
			max: 9
		});
	});
	it('ohne lesbare Altersangaben keine Gruppe', () => {
		expect(groupsForAge([groups[3]!], 8)).toEqual({ groups: [], exact: false });
	});
});

describe('pickTrialGroup', () => {
	it('gewählte Gruppe vor dem Alter, unbekannter Slug → nach Alter', () => {
		expect(pickTrialGroup(groups, { groupSlug: 'alt', childAge: 8 })).toEqual({
			group: groups[2],
			chosen: true,
			exact: false
		});
		expect(pickTrialGroup(groups, { groupSlug: 'gibtsnicht', childAge: 12 })).toMatchObject({
			group: groups[1],
			chosen: false,
			exact: true
		});
		expect(pickTrialGroup([groups[3]!], { groupSlug: '', childAge: 8 })).toBeNull();
	});
	it('Betreff', () => {
		expect(trialSubject({ childName: 'Mia', childAge: 8 })).toBe('Probestunde: Mia (8 Jahre)');
	});
});

describe('Kopie auf der Website', () => {
	it('ist identisch', () => {
		const a = readFileSync('modules/messages/age-range.ts', 'utf8').replace(/\r\n/g, '\n');
		const b = readFileSync('website/src/lib/age-range.ts', 'utf8').replace(/\r\n/g, '\n');
		expect(b).toBe(a);
		expect(copy.parseAgeRange('6 bis 10 Jahre')).toEqual({ min: 6, max: 10 });
	});
});
