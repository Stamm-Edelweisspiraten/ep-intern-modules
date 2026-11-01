import { describe, expect, it } from 'vitest';
import type { MemberFieldDefinition, MemberSheetData } from '$modules/members/contract';
import {
	LIST_TEMPLATE,
	LIST_TEMPLATE_FALLBACK,
	ageOn,
	composeListBlocks,
	formatDateDe,
	formatFieldValue,
	listTemplateInput
} from '$lib/pdf-lists';
import { buildPresets } from '$lib/pdf-lists';
import {
	MEMBER_HEALTH_FIELD_KEYS,
	buildMemberCatalog,
	emergencyPhone,
	rowFromMember
} from '$modules/members/sheet-columns';
import { MEMBER_HEALTH_FIELD_KEYS as ACTIONS_HEALTH_KEYS } from '$modules/actions/health';

const defs: MemberFieldDefinition[] = [
	{
		key: 'ernaehrung',
		field: {
			id: 'ernaehrung',
			key: 'ernaehrung',
			label: 'Ernährung',
			type: 'select',
			options: [
				{ value: 'meat', label: 'Mit Fleisch' },
				{ value: 'vegan', label: 'Vegan' }
			]
		}
	},
	{
		key: 'allergien',
		field: { id: 'allergien', key: 'allergien', label: 'Allergien', type: 'textarea' }
	},
	{
		key: 'medikamente',
		field: { id: 'medikamente', key: 'medikamente', label: 'Medikamente', type: 'textarea' }
	},
	{
		key: 'schwimmen',
		field: { id: 'schwimmen', key: 'schwimmen', label: 'Schwimmer*in', type: 'boolean' }
	},
	{ key: 'juleica', field: { id: 'juleica', key: 'juleica', label: 'Juleica', type: 'boolean' } }
];

const member = (over: Partial<MemberSheetData> = {}): MemberSheetData => ({
	id: 'm1',
	firstName: 'Lena',
	lastName: 'Müller',
	scoutName: 'Fuchs',
	birthDate: '2012-05-17',
	stage: 'Pfadfinder',
	street: 'Musterweg 1',
	postalCode: '28357',
	city: 'Bremen',
	country: 'DE',
	phones: [
		{ name: 'Mutter', value: '+49 170 1234567' },
		{ name: 'Notfall Oma', value: '0421 99887' }
	],
	emails: [{ name: null, value: 'eltern@example.test' }],
	groups: [{ id: 'g1', name: 'Sippe Falke' }],
	consentSocialMedia: true,
	consentWebsite: false,
	consentPrint: true,
	entryDate: '2020-03-01',
	exitDate: null,
	custom: { ernaehrung: 'vegan', allergien: 'Nüsse\nHaselnuss', schwimmen: false },
	...over
});

describe('Hilfsfunktionen', () => {
	it('formatDateDe / ageOn', () => {
		expect(formatDateDe('2026-03-07')).toBe('07.03.2026');
		expect(formatDateDe(null)).toBe('');
		expect(formatDateDe('kaputt')).toBe('kaputt');
		// Geburtstag am Stichtag zählt, am Tag davor noch nicht
		expect(ageOn('2012-05-17', '2026-05-17')).toBe(14);
		expect(ageOn('2012-05-17', '2026-05-16')).toBe(13);
		expect(ageOn('2030-01-01', '2026-01-01')).toBeNull();
		expect(ageOn('', '2026-01-01')).toBeNull();
	});

	it('formatFieldValue: Auswahl-Beschriftung, Ja/Nein, leer', () => {
		expect(formatFieldValue(defs[0]!.field, 'vegan')).toBe('Vegan');
		expect(formatFieldValue(defs[0]!.field, 'unbekannt')).toBe('unbekannt');
		expect(formatFieldValue(defs[3]!.field, false)).toBe('Nein');
		expect(formatFieldValue(defs[3]!.field, true)).toBe('Ja');
		expect(formatFieldValue(defs[0]!.field, '')).toBe('');
		expect(formatFieldValue(undefined, null)).toBe('');
		expect(formatFieldValue(undefined, ['a', 'b'])).toBe('a, b');
	});

	it('Vorlage: Briefkopf quer, sonst compact in Querformat', () => {
		expect(listTemplateInput([LIST_TEMPLATE, 'compact'])).toEqual({
			template: 'stamm-briefkopf-quer',
			orientation: 'landscape'
		});
		expect(listTemplateInput(['default']).template).toBe(LIST_TEMPLATE_FALLBACK);
	});
});

describe('emergencyPhone', () => {
	it('bevorzugt eine Nummer mit „Notfall“ in der Bezeichnung, sonst die erste', () => {
		expect(emergencyPhone(member().phones)).toBe('Notfall Oma: 0421 99887');
		expect(emergencyPhone([{ name: 'Mutter', value: '123456' }])).toBe('Mutter: 123456');
		expect(emergencyPhone([{ name: null, value: '123456' }])).toBe('123456');
		expect(emergencyPhone([])).toBe('');
	});
});

describe('Katalog', () => {
	const catalog = buildMemberCatalog(defs);
	it('Basisspalten vorn, danach je Zusatzfeld eine Spalte; Gesundheit ist sensibel, Juleica nicht', () => {
		const keys = catalog.columns.map((c) => c.key);
		expect(keys.slice(0, 3)).toEqual(['name', 'scoutName', 'stage']);
		expect(keys.slice(-5)).toEqual([
			'field.ernaehrung',
			'field.allergien',
			'field.medikamente',
			'field.schwimmen',
			'field.juleica'
		]);
		const col = (k: string) => catalog.columns.find((c) => c.key === k)!;
		expect(col('field.allergien')).toMatchObject({ group: 'health', sensitive: true });
		expect(col('field.juleica')).toMatchObject({ group: 'person', sensitive: false });
		expect(col('name').sensitive).toBeUndefined();
	});

	it('Voreinstellungen enthalten nur vorhandene Spalten (deaktivierte Zusatzfelder entfallen)', () => {
		const fahrt = catalog.presets.find((p) => p.id === 'fahrt')!;
		expect(fahrt.keys).toEqual([
			'name',
			'groups',
			'age',
			'emergencyPhone',
			'field.ernaehrung',
			'field.allergien',
			'field.medikamente'
		]);
		const slim = buildMemberCatalog(defs.filter((d) => d.key !== 'medikamente'));
		expect(slim.presets.find((p) => p.id === 'fahrt')!.keys).not.toContain('field.medikamente');
		expect(catalog.presets.map((p) => p.id)).toEqual(['fahrt', 'kontakt', 'gesundheit', 'minimal']);
		expect(buildPresets(catalog.columns, { fahrt: ['notes'] })[0]!.keys).not.toContain('notes');
	});
});

describe('rowFromMember', () => {
	it('füllt alle Katalogspalten fertig formatiert', () => {
		const r = rowFromMember(member(), defs, '2026-10-17');
		expect(r.name).toBe('Lena Müller\n„Fuchs“');
		expect(r.age).toBe('14');
		expect(r.birthDate).toBe('17.05.2012');
		expect(r.address).toBe('Musterweg 1\n28357 Bremen');
		expect(r.phone).toBe('Mutter: +49 170 1234567\nNotfall Oma: 0421 99887');
		expect(r.emergencyPhone).toBe('Notfall Oma: 0421 99887');
		expect(r.email).toBe('eltern@example.test');
		expect(r.groups).toBe('Sippe Falke');
		expect(r.entryDate).toBe('01.03.2020');
		expect(r.consents).toBe('Social Media ja · Website nein · Druck ja');
		expect(r['field.ernaehrung']).toBe('Vegan');
		expect(r['field.allergien']).toBe('Nüsse\nHaselnuss');
		expect(r['field.schwimmen']).toBe('Nein');
		expect(r['field.juleica']).toBe('');
	});

	it('fehlende Angaben bleiben leer, Land außer DE erscheint in der Anschrift', () => {
		const r = rowFromMember(
			member({ phones: [], emails: [], groups: [], entryDate: null, street: '', country: 'AT' }),
			defs,
			'2026-10-17'
		);
		expect(r.emergencyPhone).toBe('');
		expect(r.phone).toBe('');
		expect(r.entryDate).toBe('');
		expect(r.address).toBe('28357 Bremen\nAT');
	});
});

describe('composeListBlocks', () => {
	const catalog = buildMemberCatalog(defs);
	const rows = [
		rowFromMember(member(), defs, '2026-10-17'),
		rowFromMember(member({ id: 'm2', firstName: 'Ben', scoutName: null }), defs, '2026-10-17')
	];

	it('Voreinstellung „Fahrt“ ohne Auswahl: nur diese Spalten, Hinweis „Vertraulich“, eine Tabelle', () => {
		const { blocks, selection, columns } = composeListBlocks({
			catalog,
			sections: [{ title: 'Sippe Falke', rows }],
			generatedOn: '2026-10-17'
		});
		expect(selection.preset).toBe('fahrt');
		// „Medikamente“ hat bei beiden Personen keinen Wert → Spalte entfällt (hideEmpty)
		expect(columns.map((c) => c.label)).toEqual([
			'Name',
			'Gruppe',
			'Alter',
			'Telefon (Notfall/erstes)',
			'Ernährung',
			'Allergien'
		]);
		const table = blocks.find((b) => b.type === 'table')!;
		if (table.type !== 'table') throw new Error('Tabelle erwartet');
		expect(table.rows).toHaveLength(2);
		const text = blocks
			.filter((b) => b.type === 'paragraph')
			.map((b) => (b.type === 'paragraph' ? b.text : ''))
			.join('\n');
		expect(text).toContain('Vertraulich');
		expect(text).toContain('2 Personen · Stand 17.10.2026');
	});

	it('Auswahl: gewählte Spalten in Katalogreihenfolge; Kontaktspalten ohne Gesundheit → kein Hinweis', () => {
		const { blocks, columns } = composeListBlocks({
			catalog,
			selection: { columns: ['email', 'name', 'unbekannt'], hideEmpty: true },
			sections: [{ title: 'Liste', rows }],
			generatedOn: '2026-10-17'
		});
		expect(columns.map((c) => c.key)).toEqual(['name', 'email']);
		const text = JSON.stringify(blocks);
		expect(text).not.toContain('Vertraulich');
	});

	it('leere Spalten entfallen bei hideEmpty, bleiben sonst erhalten', () => {
		const noAllergy = rows.map((r) => ({ ...r, 'field.allergien': '' }));
		const hidden = composeListBlocks({
			catalog,
			selection: { columns: ['name', 'field.allergien'], hideEmpty: true },
			sections: [{ title: 'L', rows: noAllergy }],
			generatedOn: '2026-10-17'
		});
		expect(hidden.columns.map((c) => c.key)).toEqual(['name']);
		const shown = composeListBlocks({
			catalog,
			selection: { columns: ['name', 'field.allergien'], hideEmpty: false },
			sections: [{ title: 'L', rows: noAllergy }],
			generatedOn: '2026-10-17'
		});
		expect(shown.columns.map((c) => c.key)).toEqual(['name', 'field.allergien']);
	});

	it('Seitenumbruch zwischen Abschnitten und „Keine Personen.“ für leere Abschnitte', () => {
		const { blocks } = composeListBlocks({
			catalog,
			sections: [
				{ title: 'Gruppe A', subtitle: 'Sippe', rows },
				{ title: 'Gruppe B', rows: [] }
			],
			generatedOn: '2026-10-17'
		});
		expect(blocks.filter((b) => b.type === 'pageBreak')).toHaveLength(1);
		const text = JSON.stringify(blocks);
		expect(text).toContain('Sippe · 2 Personen');
		expect(text).toContain('Keine Personen.');
	});
});

describe('Gesundheitsfelder', () => {
	it('actions hält dieselbe Liste wie members (Kopie, weil Module einander nicht importieren)', () => {
		expect([...ACTIONS_HEALTH_KEYS]).toEqual([...MEMBER_HEALTH_FIELD_KEYS]);
	});
});
