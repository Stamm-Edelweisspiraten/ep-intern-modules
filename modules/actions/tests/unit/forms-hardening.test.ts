import { describe, expect, it } from 'vitest';
import { formDefinitionSchema } from '$lib/forms/schema';
import type { FieldDefinition, FormDefinition } from '$lib/forms/types';
import {
	MANDATORY_KEYS,
	buildConfirmationMail,
	buildDefaultFormDefinition,
	buildOptInMail,
	mergeStandardFields,
	neutralizeLinks
} from '$modules/actions/form-support';
import { STANDARD_FORM_KEYS as K } from '$modules/actions/schemas';

const field = (def: FormDefinition, key: string) => def.fields.find((f) => f.key === key)!;

describe('Formular-Kennzeichen health/mandatory', () => {
	it('Schema akzeptiert health und mandatory, lehnt falsche Typen ab', () => {
		const def = {
			version: 1,
			fields: [
				{ id: 'a', key: 'impf', type: 'text', label: 'Impfstatus', health: true },
				{ id: 'b', key: 'x', type: 'boolean', label: 'X', mandatory: true }
			]
		};
		expect(formDefinitionSchema.safeParse(def).success).toBe(true);
		const bad = {
			version: 1,
			fields: [{ id: 'a', key: 'k', type: 'text', label: 'K', health: 'ja' }]
		};
		expect(formDefinitionSchema.safeParse(bad).success).toBe(false);
	});
});

describe('mergeStandardFields (Issue #28)', () => {
	it('Datenschutz und Disclaimer bleiben sichtbar und Pflicht, auch wenn der Client anderes schickt', () => {
		const base = buildDefaultFormDefinition();
		const tampered: FormDefinition = {
			...base,
			fields: base.fields.map(
				(f) =>
					(MANDATORY_KEYS.includes(f.key)
						? { ...f, hidden: true, required: false, mandatory: false }
						: f) as FieldDefinition
			)
		};
		const merged = mergeStandardFields(tampered);
		for (const k of [K.privacy, K.disclaimer, K.name, K.email, K.birthDate]) {
			expect(field(merged, k)).toMatchObject({ hidden: false, required: true, mandatory: true });
		}
	});

	it('fehlendes Datenschutzfeld wird ergänzt', () => {
		const base = buildDefaultFormDefinition();
		const merged = mergeStandardFields({
			...base,
			fields: base.fields.filter((f) => f.key !== K.privacy)
		});
		expect(field(merged, K.privacy)).toMatchObject({ type: 'consent', required: true });
	});

	it('übrige Standardfelder bleiben ausblendbar; Gesundheitsfelder tragen health', () => {
		const base = buildDefaultFormDefinition();
		const merged = mergeStandardFields({
			...base,
			fields: base.fields.map((f) => (f.key === K.notes ? { ...f, hidden: true } : f))
		});
		expect(field(merged, K.notes)).toMatchObject({ hidden: true, health: true });
		expect(field(merged, K.diet).health).toBe(true);
		expect(field(merged, K.notes).mandatory).toBeUndefined();
	});

	it('eigene Felder können nicht mandatory werden, health bleibt erhalten', () => {
		const base = buildDefaultFormDefinition();
		const merged = mergeStandardFields({
			...base,
			fields: [
				...base.fields,
				{ id: 'c', key: 'impf', type: 'text', label: 'Impfung', mandatory: true, health: true }
			]
		});
		expect(field(merged, 'impf').mandatory).toBeUndefined();
		expect(field(merged, 'impf').health).toBe(true);
	});
});

describe('Mails öffentlicher Formulare (Issue #17)', () => {
	it('neutralizeLinks entschärft URLs, Domains und Adressen', () => {
		const out = neutralizeLinks(
			'Siehe https://evil.example/x?y=1, www.boese.de oder mail@spam.org'
		);
		expect(out).not.toMatch(/https:\/\//);
		expect(out).not.toContain('www.boese.de');
		expect(out).not.toContain('mail@spam.org');
		expect(out).toContain('evil[.]example');
		// normale Namen bleiben unverändert
		expect(neutralizeLinks('Anna-Lena Müller, z.B. St. Peter')).toBe(
			'Anna-Lena Müller, z.B. St. Peter'
		);
	});

	it('Bitte um Bestätigung enthält nur Aktion, Datum, feste Texte und den Link', () => {
		const mail = buildOptInMail({
			actionName: 'Sommerlager',
			startsOn: '2026-07-10',
			endsOn: '2026-07-17',
			confirmUrl: 'https://intern.example/p/actions/anmeldung-bestaetigen/abc'
		});
		expect(mail.subject).toBe('Bitte Anmeldung bestätigen: Sommerlager');
		expect(mail.text).toContain('10.07.2026 – 17.07.2026');
		expect(mail.text).toContain('https://intern.example/p/actions/anmeldung-bestaetigen/abc');
		expect(mail.text).toContain('7 Tagen');
		expect(mail.html).toContain(
			'href="https://intern.example/p/actions/anmeldung-bestaetigen/abc"'
		);
	});

	it('Anmeldebestätigung neutralisiert Links in Name und Gruppe', () => {
		const mail = buildConfirmationMail({
			actionName: 'Sommerlager',
			name: 'Max http://evil.example',
			groupLabel: 'www.gruppe.example',
			birthDate: '2016-05-04',
			disclaimer: ''
		});
		expect(mail.text).not.toContain('http://evil.example');
		expect(mail.text).not.toContain('www.gruppe.example');
		expect(mail.html).not.toContain('www.gruppe.example');
	});
});
