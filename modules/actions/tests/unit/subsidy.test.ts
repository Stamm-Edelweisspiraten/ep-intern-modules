import { describe, expect, it } from 'vitest';
import { computeSubsidy } from '$modules/actions/subsidy';
import type { SubsidyInput } from '$modules/actions/schemas';

const base = (over: Partial<SubsidyInput> = {}): SubsidyInput => ({
	nights: 3,
	lodgingType: 'external',
	konfi: false,
	freizeitType: 'kids',
	children: 10,
	youth: 5,
	teamYouth: 0,
	teamWithJuleica: 0,
	teamWithoutJuleica: 0,
	...over
});

describe('computeSubsidy extern', () => {
	it('3 Nächte: 13/14 Euro', () => {
		const r = computeSubsidy(base());
		expect(r.lines[0]).toMatchObject({
			key: 'children',
			count: 10,
			nights: 3,
			rateCents: 1300,
			totalCents: 39000
		});
		expect(r.lines[1]).toMatchObject({
			key: 'youth',
			count: 5,
			rateCents: 1400,
			totalCents: 21000
		});
		expect(r.subsidyCents).toBe(60000);
	});
	it('4 und 14 Nächte: 15/16 Euro', () => {
		const a = computeSubsidy(base({ nights: 4 }));
		expect(a.lines[0]!.rateCents).toBe(1500);
		expect(a.lines[1]!.rateCents).toBe(1600);
		expect(a.subsidyCents).toBe(4 * (10 * 1500 + 5 * 1600));
		const b = computeSubsidy(base({ nights: 14 }));
		expect(b.cappedNights).toBe(14);
		expect(b.subsidyCents).toBe(14 * (10 * 1500 + 5 * 1600));
		expect(b.warnings).toEqual([]);
	});
	it('15 Nächte werden bei 14 gedeckelt', () => {
		const r = computeSubsidy(base({ nights: 15 }));
		expect(r.cappedNights).toBe(14);
		expect(r.lines[0]!.nights).toBe(14);
		expect(r.subsidyCents).toBe(14 * (10 * 1500 + 5 * 1600));
		expect(r.warnings).toContain('Nur die ersten 14 Nächte sind zuschussfähig.');
	});
	it('Konfi bleibt bei 13/14', () => {
		const r = computeSubsidy(base({ nights: 5, konfi: true }));
		expect(r.lines[0]!.rateCents).toBe(1300);
		expect(r.lines[1]!.rateCents).toBe(1400);
		expect(r.warnings).toContain('Konfi-Fahrten erhalten nicht den erhöhten Satz für 4–14 Nächte.');
	});
	it('Konfi mit 3 Nächten ohne Warnung', () => {
		expect(computeSubsidy(base({ konfi: true })).warnings).toEqual([]);
	});
});

describe('computeSubsidy Gemeinderäume', () => {
	it('2 Nächte: kein Zuschuss, Warnung', () => {
		const r = computeSubsidy(base({ nights: 2, lodgingType: 'parish_rooms' }));
		expect(r.subsidyCents).toBe(0);
		expect(r.warnings).toContain(
			'Übernachtungen in Gemeinderäumen werden erst ab drei Nächten bezuschusst.'
		);
	});
	it('3 Nächte: 3/4 Euro', () => {
		const r = computeSubsidy(base({ nights: 3, lodgingType: 'parish_rooms' }));
		expect(r.subsidyCents).toBe(3 * (10 * 300 + 5 * 400));
	});
	it('5 Nächte: kein Langzeit-Satz', () => {
		const r = computeSubsidy(base({ nights: 5, lodgingType: 'parish_rooms' }));
		expect(r.lines[0]!.rateCents).toBe(300);
		expect(r.lines[1]!.rateCents).toBe(400);
		expect(r.subsidyCents).toBe(5 * (10 * 300 + 5 * 400));
	});
	it('Taschengeld auch bei 2 Nächten', () => {
		const r = computeSubsidy(base({ nights: 2, lodgingType: 'parish_rooms', teamWithJuleica: 2 }));
		expect(r.subsidyCents).toBe(0);
		expect(r.allowance.totalCents).toBe(2 * 1500 * 2);
	});
});

describe('Taschengeld', () => {
	it('Kinderfreizeit: Limit 1 je 5 Personen (Kinder und Jugendliche)', () => {
		// 12 Kinder + 0 Jugendliche = 12 → 2
		const r = computeSubsidy(
			base({ children: 12, youth: 0, teamWithJuleica: 1, teamWithoutJuleica: 3 })
		);
		expect(r.allowance.limit).toBe(2);
		expect(r.allowance.withJuleica).toBe(1);
		expect(r.allowance.withoutJuleica).toBe(1);
		expect(r.allowance.totalCents).toBe((1500 + 1000) * 3);
		expect(r.warnings).toContain(
			'Es sind höchstens 2 Ehrenamtliche zuschussfähig (1 je 5 Personen auf dem Antrag, Team mitgezählt).'
		);
	});
	it('Jugendfreizeit: Limit 1 je 7 Personen, Kinder zählen mit', () => {
		// 20 Kinder + 15 Jugendliche = 35 → 5
		const r = computeSubsidy(
			base({ freizeitType: 'youth', children: 20, youth: 15, teamWithoutJuleica: 6 })
		);
		expect(r.allowance.limit).toBe(5);
		expect(r.allowance.withoutJuleica).toBe(5);
		expect(r.allowance.totalCents).toBe(5 * 1000 * 3);
	});
	it('Team auf der Liste zählt mit, abgerundet', () => {
		// 3 Kinder + 2 Teamer*innen = 5 → genau 1
		const one = computeSubsidy(base({ children: 3, youth: 0, teamYouth: 2, teamWithJuleica: 2 }));
		expect(one.allowance.limit).toBe(1);
		expect(one.allowance.withJuleica).toBe(1);
		expect(one.allowance.totalCents).toBe(1500 * 3);
		// 4 Personen → 0
		const none = computeSubsidy(base({ children: 2, youth: 0, teamYouth: 2, teamWithJuleica: 2 }));
		expect(none.allowance.limit).toBe(0);
		expect(none.allowance.totalCents).toBe(0);
	});
	it('Juleica hat Vorrang', () => {
		const r = computeSubsidy(
			base({ children: 10, youth: 0, teamWithJuleica: 5, teamWithoutJuleica: 5 })
		);
		expect(r.allowance.withJuleica).toBe(2);
		expect(r.allowance.withoutJuleica).toBe(0);
	});
	it('Taschengeld nutzt maximal 14 Nächte', () => {
		const r = computeSubsidy(base({ nights: 20, children: 5, teamWithJuleica: 1 }));
		expect(r.allowance.nights).toBe(14);
		expect(r.allowance.totalCents).toBe(1500 * 14);
	});
});

describe('Teamer*innen aus Bremen', () => {
	it('zählen in der Jugendlichen-Zeile mit', () => {
		const r = computeSubsidy(base({ teamYouth: 3 }));
		expect(r.lines[1]).toMatchObject({
			count: 8,
			label: 'Jugendliche inkl. Teamer*innen (12–27 Jahre)',
			totalCents: 8 * 3 * 1400
		});
		expect(computeSubsidy(base()).lines[1]!.label).toBe('Jugendliche (12–27 Jahre)');
	});
	it('zählen für die Taschengeld-Grenze der Jugendfreizeit', () => {
		const r = computeSubsidy(
			base({ freizeitType: 'youth', children: 0, youth: 10, teamYouth: 4, teamWithoutJuleica: 5 })
		);
		expect(r.allowance.limit).toBe(2);
		expect(r.allowance.withoutJuleica).toBe(2);
	});
	it('keine Warnung wenn nur Teamer*innen', () => {
		const r = computeSubsidy(base({ children: 0, youth: 0, teamYouth: 2 }));
		expect(r.warnings).not.toContain(
			'Keine zuschussfähigen Teilnehmenden aus Bremen/Bremerhaven eingetragen.'
		);
	});
});

describe('Sonderfälle', () => {
	it('0 Nächte: nichts', () => {
		const r = computeSubsidy(base({ nights: 0, teamWithJuleica: 1 }));
		expect(r.subsidyCents).toBe(0);
		expect(r.allowance.totalCents).toBe(0);
		expect(r.cappedNights).toBe(0);
	});
	it('keine Teilnehmenden: Warnung', () => {
		const r = computeSubsidy(base({ children: 0, youth: 0 }));
		expect(r.warnings).toContain(
			'Keine zuschussfähigen Teilnehmenden aus Bremen/Bremerhaven eingetragen.'
		);
		expect(r.subsidyCents).toBe(0);
	});
	it('negative/NaN-Eingaben werden zu 0', () => {
		const r = computeSubsidy(
			base({ nights: Number.NaN, children: -4, youth: Infinity, teamWithJuleica: -1 })
		);
		expect(r.subsidyCents).toBe(0);
		expect(r.cappedNights).toBe(0);
	});
});
