import { describe, expect, it } from 'vitest';
import { calculate, nightsBetween } from '$modules/actions/calculation';
import type { CalcItem, CalculateInput } from '$modules/actions/schemas';

const item = (
	category: CalcItem['category'],
	amountCents: number,
	basis: CalcItem['basis'] = 'flat'
): CalcItem => ({
	id: `${category}-${amountCents}-${basis}`,
	category,
	label: 'x',
	amountCents,
	basis
});

const base = (over: Partial<CalculateInput> = {}): CalculateInput => ({
	participants: 10,
	team: 0,
	teamPercent: 0,
	nights: 3,
	items: [],
	bufferPercent: 0,
	subsidyCents: 0,
	...over
});

describe('calculate', () => {
	it('rechnet pro Person und Nacht inklusive Team', () => {
		const r = calculate(
			base({
				participants: 10,
				team: 2,
				nights: 3,
				items: [item('food', 1000, 'per_person_night')]
			})
		);
		expect(r.totalPersons).toBe(12);
		expect(r.payingParticipants).toBe(10);
		expect(r.lines[0]!.totalCents).toBe(1000 * 12 * 3);
		expect(r.subtotalCents).toBe(36000);
		expect(r.perPersonCents).toBe(3600);
	});

	it('Pauschalposten bleiben unverändert', () => {
		const r = calculate(base({ items: [item('materials', 5000)] }));
		expect(r.subtotalCents).toBe(5000);
	});

	it('rundet Programm pro Person auf volle Euro auf', () => {
		const r = calculate(base({ participants: 12, items: [item('program', 10000)] }));
		expect(r.programRawCents).toBe(10000);
		expect(r.programPerPersonCents).toBe(900);
		expect(r.programTotalCents).toBe(10800);
		expect(r.subtotalCents).toBe(10800);
	});

	it('exakt teilbares Programm bleibt gleich', () => {
		const r = calculate(base({ participants: 10, items: [item('program', 10000)] }));
		expect(r.programPerPersonCents).toBe(1000);
		expect(r.programTotalCents).toBe(10000);
	});

	it('berechnet und rundet den Puffer', () => {
		const r = calculate(base({ bufferPercent: 5, items: [item('other', 10010)] }));
		expect(r.bufferCents).toBe(501);
		expect(r.totalCents).toBe(10511);
	});

	it('zieht Zuschuss ab und deckelt ihn auf die Gesamtkosten', () => {
		const a = calculate(base({ items: [item('other', 10000)], subsidyCents: 4000 }));
		expect(a.subsidyCents).toBe(4000);
		expect(a.netCents).toBe(6000);
		const b = calculate(base({ items: [item('other', 10000)], subsidyCents: 99999 }));
		expect(b.subsidyCents).toBe(10000);
		expect(b.netCents).toBe(0);
		expect(b.recommendedPerPersonCents).toBe(0);
	});

	it('liefert ohne Teilnehmende weder NaN noch Infinity', () => {
		const r = calculate(
			base({
				participants: 0,
				team: 3,
				items: [item('program', 5000), item('food', 100, 'per_person_night')]
			})
		);
		expect(r.perPersonCents).toBe(0);
		expect(r.recommendedPerPersonCents).toBe(0);
		expect(r.programTotalCents).toBe(5000);
		for (const v of Object.values(r)) {
			if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
		}
		for (const c of r.byCategory) expect(Number.isFinite(c.share)).toBe(true);
	});

	it('empfiehlt auf volle Euro aufgerundet', () => {
		const r = calculate(base({ participants: 3, items: [item('other', 10000)] }));
		expect(r.perPersonCents).toBeCloseTo(3333.333, 2);
		expect(r.recommendedPerPersonCents).toBe(3400);
	});

	it('Anteile je Kategorie summieren sich zu 1', () => {
		const r = calculate(
			base({
				participants: 12,
				items: [item('food', 20000), item('program', 10000), item('travel', 3000), item('other', 0)]
			})
		);
		expect(r.byCategory.map((c) => c.category)).toEqual(['food', 'travel', 'program']);
		expect(r.byCategory.find((c) => c.category === 'program')?.totalCents).toBe(10800);
		expect(r.byCategory.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 10);
	});

	it('behandelt ungültige Eingaben als 0', () => {
		const r = calculate(
			base({
				participants: Number.NaN,
				team: -3,
				nights: Infinity,
				bufferPercent: Number.NaN,
				subsidyCents: -5,
				items: [item('other', -100), item('food', 500, 'per_person_night')]
			})
		);
		expect(r.subtotalCents).toBe(0);
		expect(r.totalCents).toBe(0);
		expect(r.subsidyCents).toBe(0);
	});
});

describe('calculate Team-Anteil und Basen', () => {
	it('flat / per_person / per_person_night mit Team', () => {
		const r = calculate(
			base({
				participants: 10,
				team: 2,
				nights: 4,
				items: [
					item('other', 1000, 'flat'),
					item('materials', 500, 'per_person'),
					item('food', 100, 'per_person_night')
				]
			})
		);
		expect(r.lines.map((l) => l.totalCents)).toEqual([1000, 6000, 4800]);
	});
	it('per_person ohne Team', () => {
		const r = calculate(base({ items: [item('other', 500, 'per_person')] }));
		expect(r.subtotalCents).toBe(5000);
	});
	it('Kontrollbeispiel: 10 + 2 Team zu 50 %', () => {
		const r = calculate(
			base({ participants: 10, team: 2, teamPercent: 50, items: [item('other', 120000)] })
		);
		expect(r.payingWeight).toBe(11);
		expect(r.perPersonCents).toBeCloseTo(10909.09, 2);
		expect(r.recommendedPerPersonCents).toBe(11000);
		expect(r.teamPerPersonCents).toBeCloseTo(5454.55, 2);
		expect(r.recommendedTeamPerPersonCents).toBe(5500);
	});
	it('Team 0 % und 100 %', () => {
		const items = [item('other', 120000)];
		const a = calculate(base({ participants: 10, team: 2, teamPercent: 0, items }));
		expect(a.payingWeight).toBe(10);
		expect(a.perPersonCents).toBe(12000);
		expect(a.teamPerPersonCents).toBe(0);
		expect(a.recommendedTeamPerPersonCents).toBe(0);
		const b = calculate(base({ participants: 10, team: 2, teamPercent: 100, items }));
		expect(b.payingWeight).toBe(12);
		expect(b.perPersonCents).toBe(10000);
		expect(b.teamPerPersonCents).toBe(10000);
		expect(b.recommendedTeamPerPersonCents).toBe(10000);
	});
	it('team = 0 liefert Team-Beitrag 0', () => {
		const r = calculate(base({ team: 0, teamPercent: 50, items: [item('other', 10000)] }));
		expect(r.teamPerPersonCents).toBe(0);
		expect(r.recommendedTeamPerPersonCents).toBe(0);
		expect(r.payingWeight).toBe(10);
	});
	it('Programm-Aufrundung mit Team-Gewicht', () => {
		const r = calculate(
			base({ participants: 10, team: 2, teamPercent: 50, items: [item('program', 10000)] })
		);
		expect(r.programPerPersonCents).toBe(1000);
		expect(r.programTotalCents).toBe(11000);
	});
	it('klemmt teamPercent auf 0 bis 100', () => {
		const items = [item('other', 12000)];
		const hi = calculate(base({ participants: 10, team: 2, teamPercent: 250, items }));
		expect(hi.payingWeight).toBe(12);
		const lo = calculate(base({ participants: 10, team: 2, teamPercent: -20, items }));
		expect(lo.payingWeight).toBe(10);
		const nan = calculate(base({ participants: 10, team: 2, teamPercent: Number.NaN, items }));
		expect(nan.payingWeight).toBe(10);
	});
});

describe('nightsBetween', () => {
	it('zählt Nächte', () => {
		expect(nightsBetween('2026-07-01', '2026-07-08')).toBe(7);
	});
	it('gleicher Tag ist 0', () => {
		expect(nightsBetween('2026-07-01', '2026-07-01')).toBe(0);
	});
	it('Monatswechsel', () => {
		expect(nightsBetween('2026-01-30', '2026-02-02')).toBe(3);
	});
	it('Schaltjahr', () => {
		expect(nightsBetween('2028-02-28', '2028-03-01')).toBe(2);
		expect(nightsBetween('2026-02-28', '2026-03-01')).toBe(1);
	});
	it('ungültig ergibt null', () => {
		expect(nightsBetween('2026-07-01', null)).toBeNull();
		expect(nightsBetween('2026-07-01', 'quatsch')).toBeNull();
		expect(nightsBetween('2026-07-01', '2026-02-30')).toBeNull();
		expect(nightsBetween('2026-07-05', '2026-07-01')).toBeNull();
	});
});
