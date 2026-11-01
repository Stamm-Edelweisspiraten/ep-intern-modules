import { describe, expect, it } from 'vitest';
import {
	deriveSubsidyCounts,
	effectiveSubsidyEligible,
	type EligibilityParticipant
} from '$modules/actions/subsidy-eligibility';
import { appliedAutoIncome, computeAutoIncome } from '$modules/actions/auto-income';
import { buildReportBlocks, summarize } from '$modules/actions/accounting';
import type { ReportInput } from '$modules/actions/schemas';

const START = '2026-07-10';
let n = 0;
const person = (over: Partial<EligibilityParticipant> = {}): EligibilityParticipant => ({
	id: `p${n++}`,
	name: `P${n}`,
	role: 'participant',
	birthDate: '2015-01-01',
	bremenResident: true,
	juleica: false,
	subsidyEligible: null,
	...over
});

describe('effectiveSubsidyEligible', () => {
	it('automatisch: Bremen + Alter 0-27', () => {
		expect(effectiveSubsidyEligible(person(), START)).toBe(true);
		expect(effectiveSubsidyEligible(person({ bremenResident: false }), START)).toBe(false);
		expect(effectiveSubsidyEligible(person({ bremenResident: null }), START)).toBe(false);
		expect(effectiveSubsidyEligible(person({ birthDate: null }), START)).toBe(false);
	});
	it('Altersgrenze 27/28 zum Aktionsstart', () => {
		// am Starttag 27 geworden
		expect(effectiveSubsidyEligible(person({ birthDate: '1999-07-10' }), START)).toBe(true);
		// morgen 28 -> heute noch 27
		expect(effectiveSubsidyEligible(person({ birthDate: '1998-07-11' }), START)).toBe(true);
		// am Starttag 28 geworden
		expect(effectiveSubsidyEligible(person({ birthDate: '1998-07-10' }), START)).toBe(false);
		// ab 0 Jahre
		expect(effectiveSubsidyEligible(person({ birthDate: '2026-06-01' }), START)).toBe(true);
	});
	it('Override true: Wohnort egal, aber Alter nötig', () => {
		const p = person({ subsidyEligible: true, bremenResident: false });
		expect(effectiveSubsidyEligible(p, START)).toBe(true);
		expect(effectiveSubsidyEligible({ ...p, birthDate: null }, START)).toBe(false);
		expect(effectiveSubsidyEligible({ ...p, birthDate: '1990-01-01' }, START)).toBe(false);
	});
	it('Override false: nie', () => {
		expect(effectiveSubsidyEligible(person({ subsidyEligible: false }), START)).toBe(false);
	});
});

describe('deriveSubsidyCounts', () => {
	it('zählt Kinder, Jugend, Team und meldet Unvollständiges', () => {
		const c = deriveSubsidyCounts(
			[
				person({ birthDate: '2018-01-01' }), // Kind
				person({ birthDate: '2014-07-11' }), // 11 -> Kind
				person({ birthDate: '2014-07-10' }), // 12 -> Jugend
				person({ bremenResident: false }), // nicht Bremen
				person({ bremenResident: false, subsidyEligible: true }), // Override -> Kind
				person({ subsidyEligible: false }), // ausgeschlossen
				person({ bremenResident: null, birthDate: null }), // unvollständig
				person({ role: 'team', birthDate: '2000-01-01', juleica: true }),
				person({ role: 'team', birthDate: '2000-01-01', bremenResident: false }),
				person({ role: 'team', birthDate: '2000-01-01', subsidyEligible: false }),
				person({ role: 'team', birthDate: '1990-01-01', juleica: true }), // zu alt
				person({ role: 'team', birthDate: '2012-01-01' }) // 14, Team
			],
			START
		);
		expect(c.bremenChildren).toBe(3);
		expect(c.bremenYouth).toBe(1);
		expect(c.teamYouth).toBe(2);
		expect(c.teamWithJuleica).toBe(1);
		// Teamer ohne Juleica: bremen false (zählt, Wohnort egal), 14-jährige; ausgeschlossene nicht
		expect(c.teamWithoutJuleica).toBe(2);
		expect(c.incomplete).toHaveLength(1);
		expect(c.incomplete[0]!.missing).toEqual(['birthDate', 'bremenResident']);
	});
	it('ausgeschlossene Person ist nie unvollständig', () => {
		const c = deriveSubsidyCounts(
			[person({ subsidyEligible: false, birthDate: null, bremenResident: null })],
			START
		);
		expect(c.incomplete).toEqual([]);
	});
});

describe('computeAutoIncome', () => {
	const base = {
		feeCents: 10000,
		teamFeeCents: 5000,
		payingCount: 3,
		teamCount: 2,
		subsidy: null,
		entries: []
	};
	it('Beiträge: Teilnehmende x Beitrag + Team x Teambeitrag', () => {
		const a = computeAutoIncome(base);
		expect(a.contributions).toEqual({
			cents: 3 * 10000 + 2 * 5000,
			payingCount: 3,
			teamCount: 2,
			feeCents: 10000,
			teamFeeCents: 5000,
			source: 'calculated'
		});
		expect(a.subsidy).toBeNull();
		expect(a.overridden).toEqual([]);
	});
	it('Kasse ersetzt das Soll durch eingegangene Zahlungen (Ist)', () => {
		const treasury = { invoiceCount: 5, dueCents: 40000, paidCents: 25000, openCents: 15000 };
		const a = computeAutoIncome({ ...base, treasury });
		expect(a.contributions).toMatchObject({
			cents: 25000,
			source: 'treasury',
			dueCents: 40000,
			openCents: 15000,
			invoiceCount: 5
		});
		// Ohne Rechnungen in der Kasse bleibt es beim berechneten Soll
		const none = computeAutoIncome({ ...base, treasury: { ...treasury, invoiceCount: 0 } });
		expect(none.contributions).toMatchObject({ cents: 40000, source: 'calculated' });
		// Manuelle Beitragsbuchung überschreibt weiterhin
		const manual = computeAutoIncome({
			...base,
			treasury,
			entries: [{ type: 'income', category: 'contributions' }]
		});
		expect(manual.overridden).toEqual(['contributions']);
	});
	it('ohne Beitrag keine Beitragseinnahmen; NaN/negativ -> 0', () => {
		expect(computeAutoIncome({ ...base, feeCents: null }).contributions).toBeNull();
		expect(computeAutoIncome({ ...base, teamFeeCents: null }).contributions?.cents).toBe(30000);
		expect(computeAutoIncome({ ...base, feeCents: Number.NaN }).contributions?.cents).toBe(10000);
		expect(computeAutoIncome({ ...base, payingCount: -4 }).contributions?.cents).toBe(10000);
	});
	it('Zuschuss aus der Liste: 7 Nächte extern, 1 Kind, 1 Jugend, 1 Teamer 12-27', () => {
		const a = computeAutoIncome({
			...base,
			subsidy: {
				nights: 7,
				lodgingType: 'external',
				konfi: false,
				freizeitType: 'kids',
				startsOn: START,
				participants: [
					person({ birthDate: '2018-01-01' }),
					person({ birthDate: '2010-01-01', bremenResident: false, subsidyEligible: true }),
					person({ role: 'team', birthDate: '2000-01-01' }),
					person({ subsidyEligible: false })
				]
			}
		});
		// 1 x 7 x 15,00 + 2 x 7 x 16,00
		expect(a.subsidy).toEqual({ cents: 10500 + 22400, eligibleCount: 3 });
	});
	it('manuelle Einnahme der Kategorie überschreibt, Ausgaben/andere nicht', () => {
		const sub = {
			nights: 3,
			lodgingType: 'external' as const,
			konfi: false,
			freizeitType: 'kids' as const,
			startsOn: START,
			participants: [person()]
		};
		const none = computeAutoIncome({
			...base,
			subsidy: sub,
			entries: [
				{ type: 'expense', category: 'contributions' },
				{ type: 'income', category: 'misc' }
			]
		});
		expect(none.overridden).toEqual([]);
		const both = computeAutoIncome({
			...base,
			subsidy: sub,
			entries: [
				{ type: 'income', category: 'contributions' },
				{ type: 'income', category: 'subsidy' }
			]
		});
		expect(both.overridden).toEqual(['contributions', 'subsidy']);
		expect(appliedAutoIncome(both)).toEqual({ contributionsCents: 0, subsidyCents: 0 });
		expect(appliedAutoIncome(none).contributionsCents).toBe(40000);
		expect(appliedAutoIncome(null)).toEqual({ contributionsCents: 0, subsidyCents: 0 });
	});
});

describe('summarize und Bericht mit Automatik', () => {
	const auto = {
		contributions: {
			cents: 40000,
			payingCount: 3,
			teamCount: 2,
			feeCents: 10000,
			teamFeeCents: 5000
		},
		subsidy: { cents: 12000, eligibleCount: 2 },
		overridden: [] as ('contributions' | 'subsidy')[]
	};
	const expenseEntry = {
		type: 'expense' as const,
		category: 'food' as const,
		amountCents: 15000,
		paidBy: 'club' as const,
		payeeId: null,
		hasReceipt: true,
		reimbursed: false
	};
	it('addiert Automatik zu Einnahmen, Kategorie-Ist und Saldo', () => {
		const s = summarize([expenseEntry], null, auto);
		expect(s.incomeCents).toBe(52000);
		expect(s.balanceCents).toBe(37000);
		expect(s.byCategory.find((c) => c.category === 'contributions')?.actualCents).toBe(40000);
		expect(s.byCategory.find((c) => c.category === 'subsidy')?.actualCents).toBe(12000);
	});
	it('überschriebene Kategorie zählt nicht doppelt', () => {
		const s = summarize(
			[{ ...expenseEntry, type: 'income', category: 'contributions', amountCents: 5000 }],
			null,
			{ ...auto, overridden: ['contributions'] }
		);
		expect(s.incomeCents).toBe(5000 + 12000);
	});
	it('ohne Automatik unverändert', () => {
		expect(summarize([expenseEntry], null).incomeCents).toBe(0);
	});
	it('Bericht: Automatik-Zeilen nur wenn nicht überschrieben', () => {
		const input = (overridden: ('contributions' | 'subsidy')[]): ReportInput => ({
			actionName: 'Fahrt',
			location: null,
			startsOn: START,
			endsOn: null,
			closedAt: null,
			entries: [],
			summary: summarize([], null, { ...auto, overridden }),
			autoIncome: { ...auto, overridden },
			payees: []
		});
		const text = (i: ReportInput) => JSON.stringify(buildReportBlocks(i)).replace(/\s+/g, ' ');
		const full = text(input([]));
		expect(full).toContain('Automatisch aus Anmeldungen (3 × 100,00 € + 2 × 50,00 €)');
		expect(full).toContain('Zuschuss laut Kalkulation (2 berechtigte Personen)');
		const over = text(input(['contributions', 'subsidy']));
		expect(over).not.toContain('Automatisch aus Anmeldungen');
		expect(over).not.toContain('Zuschuss laut Kalkulation');
	});
});
