import { describe, expect, it } from 'vitest';
import {
	buildDefaultFormDefinition,
	identityValues,
	isBremenCity,
	memberUpdates,
	mergeStandardFields,
	prefillValues,
	withoutIdentityFields,
	type MemberForRegistration
} from '$modules/actions/form-support';
import { STANDARD_FORM_KEYS as K } from '$modules/actions/schemas';
import { formDefinitionSchema, validateFormValues } from '$lib/forms';

const member: MemberForRegistration = {
	firstName: 'Kind',
	lastName: 'Muster',
	birthDate: '2016-05-04',
	groups: [{ name: 'Wölflinge' }, { name: 'Sippe Wolf' }],
	email: null,
	city: 'Bremen',
	country: 'DE',
	custom: { ernaehrung: 'vegan', allergien: 'Pollen', zecken: true }
};

describe('Bremen-Wohnort aus dem Mitglied', () => {
	it('erkennt Bremen und Bremerhaven, sonst nein; ohne Ort unbekannt', () => {
		expect(isBremenCity('Bremen', 'DE')).toBe(true);
		expect(isBremenCity(' bremerhaven ', 'DE')).toBe(true);
		expect(isBremenCity('Freie Hansestadt Bremen', 'DE')).toBe(true);
		expect(isBremenCity('Hamburg', 'DE')).toBe(false);
		expect(isBremenCity('Bremen', 'AT')).toBe(false);
		expect(isBremenCity('Bremervörde', 'DE')).toBe(false);
		expect(isBremenCity('  ', 'DE')).toBeNull();
	});
});

describe('Stammdaten aus dem Mitglied', () => {
	it('setzt Name, Gruppen, Geburtsdatum, Bremen und E-Mail (Konto-Mail als Rückfall)', () => {
		const v = identityValues(member, 'eltern@example.test');
		expect(v).toEqual({
			[K.name]: 'Kind Muster',
			[K.group]: 'Wölflinge, Sippe Wolf',
			[K.birthDate]: '2016-05-04',
			[K.bremenResident]: 'yes',
			[K.email]: 'eltern@example.test'
		});
		expect(identityValues({ ...member, email: 'kind@example.test' }, 'x@y.z')[K.email]).toBe(
			'kind@example.test'
		);
		expect(identityValues({ ...member, groups: [] }, null)[K.group]).toBeNull();
	});

	it('entfernt die Stammdatenfelder aus der Definition, behält den Rest', () => {
		const def = buildDefaultFormDefinition();
		const keys = withoutIdentityFields(def).fields.map((f) => f.key);
		for (const k of [K.name, K.group, K.birthDate, K.bremenResident, K.email]) {
			expect(keys).not.toContain(k);
		}
		expect(keys).toEqual(expect.arrayContaining([K.diet, K.allergies, K.notes, K.privacy]));
		// Pflichtfelder (Name, E-Mail …) blockieren die Validierung ohne Stammdaten nicht mehr
		const ok = validateFormValues(withoutIdentityFields(def), {
			[K.diet]: 'vegan',
			[K.allergies]: '',
			[K.notes]: '',
			[K.privacy]: true,
			[K.disclaimer]: true
		});
		expect(ok.ok).toBe(true);
	});
});

describe('Bindung an Mitglieds-Zusatzfelder (memberKey)', () => {
	it('Standardfelder Ernährung/Allergien sind gebunden – auch nach dem Zusammenführen', () => {
		const def = buildDefaultFormDefinition();
		const find = (d: typeof def, key: string) => d.fields.find((f) => f.key === key)!;
		expect(find(def, K.diet).memberKey).toBe('ernaehrung');
		expect(find(def, K.allergies).memberKey).toBe('allergien');
		const stripped = {
			...def,
			fields: def.fields.map((f) => ({ ...f, memberKey: undefined }))
		};
		const merged = mergeStandardFields(stripped);
		expect(find(merged, K.diet).memberKey).toBe('ernaehrung');
		expect(find(merged, K.allergies).memberKey).toBe('allergien');
	});

	it('Schema akzeptiert gültige memberKey, lehnt ungültige ab', () => {
		const field = {
			id: 'a',
			key: 'mf_zecken',
			type: 'boolean',
			label: 'Zecken',
			memberKey: 'zecken'
		};
		expect(formDefinitionSchema.safeParse({ version: 1, fields: [field] }).success).toBe(true);
		const bad = { ...field, memberKey: '1; DROP' };
		expect(formDefinitionSchema.safeParse({ version: 1, fields: [bad] }).success).toBe(false);
	});

	it('Vorbelegung und Rückschreiben arbeiten über den memberKey', () => {
		const def = buildDefaultFormDefinition();
		def.fields.push({
			id: 'z',
			key: 'mf_zecken',
			type: 'boolean',
			label: 'Zecken',
			memberKey: 'zecken'
		});
		const pre = prefillValues(def, member.custom);
		expect(pre).toEqual({
			[K.diet]: 'vegan',
			[K.allergies]: 'Pollen',
			mf_zecken: true
		});
		expect(prefillValues(def, {})).toEqual({
			[K.diet]: null,
			[K.allergies]: null,
			mf_zecken: null
		});
		expect(
			memberUpdates(def, { [K.diet]: 'meat', [K.allergies]: '', mf_zecken: false, [K.notes]: 'x' })
		).toEqual({ ernaehrung: 'meat', allergien: '', zecken: false });
		// ausgeblendete oder fehlende Felder werden nicht zurückgeschrieben
		def.fields.find((f) => f.key === 'mf_zecken')!.hidden = true;
		expect(memberUpdates(def, { mf_zecken: true })).toEqual({});
	});
});
