import { describe, expect, it } from 'vitest';
import {
	buildDefaultFormDefinition,
	computeFormStatus,
	formatEuro,
	isPlausibleBirthDate,
	mapStandardAnswers,
	mergeStandardFields,
	normalizeDedupeKey,
	renderDisclaimer,
	safeFilename,
	toCsv,
	toPublicDefinition
} from '$modules/actions/form-support';
import { STANDARD_FORM_KEYS } from '$modules/actions/schemas';

describe('buildDefaultFormDefinition', () => {
	it('enthält alle Standardfelder gesperrt, in fester Reihenfolge', () => {
		const def = buildDefaultFormDefinition({ groupOptions: ['Wölflinge', 'Wölflinge', ' '] });
		expect(def.fields.map((f) => f.key)).toEqual(Object.values(STANDARD_FORM_KEYS));
		expect(def.fields.every((f) => f.locked)).toBe(true);
		const group = def.fields.find((f) => f.key === 'group');
		expect(group).toMatchObject({ type: 'select', allowOther: true });
		expect((group as { options: unknown[] }).options).toHaveLength(1);
		expect(def.fields.find((f) => f.key === 'allergies')?.required).toBe(false);
	});
});

describe('mergeStandardFields', () => {
	it('ergänzt fehlende Felder und erzwingt Typ/locked', () => {
		const def = buildDefaultFormDefinition();
		const tampered = {
			...def,
			fields: def.fields
				.filter((f) => f.key !== 'notes')
				.map((f) => (f.key === 'diet' ? { ...f, type: 'text' as const, locked: false } : f))
		};
		const merged = mergeStandardFields(tampered as never);
		expect(merged.fields.find((f) => f.key === 'notes')?.locked).toBe(true);
		expect(merged.fields.find((f) => f.key === 'diet')?.type).toBe('select');
	});
});

describe('renderDisclaimer', () => {
	const vars = {
		aktion: 'Sommerlager',
		feeCents: 9300,
		kontoinhaber: 'Stamm',
		iban: 'DE00',
		purposeTemplate: '{{aktion}} + Name'
	};
	it('ersetzt Platzhalter, formatiert den Beitrag', () => {
		const out = renderDisclaimer(
			'{{aktion}}: {{beitrag}} an {{kontoinhaber}} ({{verwendungszweck}})',
			vars
		);
		expect(out).toBe('Sommerlager: 93,00\u00a0€ an Stamm (Sommerlager + Name)');
	});
	it('ohne Beitrag Hinweistext, unbekannte Platzhalter leer, kein erneutes Ersetzen', () => {
		expect(renderDisclaimer('{{beitrag}}|{{foo}}|{{bic}}', { ...vars, feeCents: null })).toBe(
			'den noch festzulegenden Beitrag||'
		);
		expect(renderDisclaimer('{{aktion}}', { ...vars, aktion: '{{iban}}' })).toBe('{{iban}}');
	});
	it('formatiert Euro mit Tausenderpunkt', () => {
		// einheitlich über money.ts (Intl, geschütztes Leerzeichen vor „€“, #34)
		expect(formatEuro(123456)).toBe('1.234,56\u00a0€');
		expect(formatEuro(5)).toBe('0,05\u00a0€');
	});
});

describe('normalizeDedupeKey', () => {
	it('normalisiert Groß/Klein und Leerzeichen', () => {
		expect(normalizeDedupeKey('  Max   MUSTER ', '2016-05-04')).toBe('max muster|2016-05-04');
	});
});

describe('toCsv', () => {
	const cols = [
		{ key: 'a', label: 'A' },
		{ key: 'b', label: 'B' }
	];
	it('BOM, Trenner, Escaping und Formelschutz', () => {
		const csv = toCsv(
			[
				{ a: '=1+1', b: 'x;y' },
				{ a: '+49', b: 'sagt "hi"' },
				{ a: '@a', b: '-1' },
				{ a: '\tTab', b: null },
				{ a: 'a\nb', b: 5 }
			],
			cols
		);
		expect(csv.startsWith('\ufeffA;B\r\n')).toBe(true);
		expect(csv).toContain('\'=1+1;"x;y"');
		expect(csv).toContain('\'+49;"sagt ""hi"""');
		expect(csv).toContain("'@a;'-1");
		expect(csv).toContain("'\tTab;");
		expect(csv).toContain('"a\nb";5');
	});
});

describe('Hilfen', () => {
	it('Status', () => {
		const base = { enabled: true, opensAt: null, closesAt: null, maxParticipants: 2 };
		const now = new Date('2026-06-01T12:00:00Z');
		expect(computeFormStatus(base, 1, now)).toBe('open');
		expect(computeFormStatus(base, 2, now)).toBe('full');
		expect(computeFormStatus({ ...base, enabled: false }, 0, now)).toBe('closed');
		expect(computeFormStatus({ ...base, opensAt: '2026-07-01T00:00:00Z' }, 0, now)).toBe(
			'not_open'
		);
		expect(computeFormStatus({ ...base, closesAt: '2026-05-01T00:00:00Z' }, 0, now)).toBe('closed');
	});
	it('Geburtsdatum plausibel', () => {
		expect(isPlausibleBirthDate('2016-05-04', '2026-06-01')).toBe(true);
		expect(isPlausibleBirthDate('2026-06-02', '2026-06-01')).toBe(false);
		expect(isPlausibleBirthDate('1900-01-01', '2026-06-01')).toBe(false);
	});
	it('Antwort-Mapping und öffentliche Definition', () => {
		const def = buildDefaultFormDefinition();
		def.fields.push({ id: 't', key: 't', type: 'text', label: 'T' });
		const m = mapStandardAnswers(def, {
			name: ' Max  M ',
			bremenResident: 'no',
			diet: 'vegan',
			email: 'A@B.de',
			t: 'x',
			privacy: true
		});
		expect(m).toMatchObject({
			name: 'Max M',
			bremenResident: false,
			diet: 'vegan',
			email: 'a@b.de',
			answers: { t: 'x' }
		});
		def.fields[5]!.hidden = true;
		const pub = toPublicDefinition(def, { privacyUrl: 'https://x.test', disclaimer: 'DISC' });
		expect(pub.fields.find((f) => f.key === 'allergies')).toBeUndefined();
		expect(pub.fields.find((f) => f.key === 'privacy')).toMatchObject({ href: 'https://x.test' });
		expect(pub.fields.find((f) => f.key === 'disclaimer')).toMatchObject({ text: 'DISC' });
	});
	it('Dateiname', () => {
		expect(safeFilename('Sommer-Lager 2026 – Süd!', '.csv')).toBe('Sommer-Lager-2026-Sued.csv');
		expect(safeFilename('???', '.csv')).toBe('aktion.csv');
	});
});
