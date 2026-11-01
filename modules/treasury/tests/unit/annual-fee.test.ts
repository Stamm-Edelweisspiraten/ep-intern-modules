import { describe, expect, it } from 'vitest';
import {
	annualInvoiceDueOn,
	annualRef,
	defaultAnnualDueOn,
	isBillable,
	isMemberInYear,
	isMemberOn,
	joinNames,
	levelsFor,
	planAnnualInvoices,
	type AnnualMember
} from '$modules/treasury/annual-fee';
import { DEFAULT_FEE_RATES, FEE_LEVELS } from '$modules/treasury/schemas';

const m = (over: Partial<AnnualMember> & { id: string }): AnnualMember => ({
	firstName: over.id,
	lastName: 'Muster',
	emails: [],
	entryDate: null,
	exitDate: null,
	secondaryMember: false,
	feeLevels: [...FEE_LEVELS],
	...over
});

describe('Mitgliedschaft', () => {
	it('am Stichtag: Eintritt <= Tag, Austritt > Tag', () => {
		expect(isMemberOn(m({ id: 'a' }), '2026-10-16')).toBe(true);
		expect(isMemberOn(m({ id: 'a', entryDate: '2026-10-16' }), '2026-10-16')).toBe(true);
		expect(isMemberOn(m({ id: 'a', entryDate: '2026-10-17' }), '2026-10-16')).toBe(false);
		expect(isMemberOn(m({ id: 'a', exitDate: '2026-10-16' }), '2026-10-16')).toBe(false);
		expect(isMemberOn(m({ id: 'a', exitDate: '2026-10-17' }), '2026-10-16')).toBe(true);
	});
	it('im Jahr', () => {
		expect(isMemberInYear(m({ id: 'a', entryDate: '2027-12-31' }), 2027)).toBe(true);
		expect(isMemberInYear(m({ id: 'a', entryDate: '2028-01-01' }), 2027)).toBe(false);
		expect(isMemberInYear(m({ id: 'a', exitDate: '2027-01-01' }), 2027)).toBe(false);
		expect(isMemberInYear(m({ id: 'a', exitDate: '2027-01-02' }), 2027)).toBe(true);
	});
});

describe('isBillable', () => {
	it('Lauf: Stichtag vor dem Jahr, Austritt bis 01.01. → kein Beitrag', () => {
		const st = '2026-10-16';
		expect(isBillable(m({ id: 'a', exitDate: '2026-12-31' }), 2027, st, 'run')).toBe(false);
		expect(isBillable(m({ id: 'a', exitDate: '2027-01-01' }), 2027, st, 'run')).toBe(false);
		expect(isBillable(m({ id: 'a', exitDate: '2027-01-02' }), 2027, st, 'run')).toBe(true);
		expect(isBillable(m({ id: 'a' }), 2027, st, 'run')).toBe(true);
	});
	it('Lauf: Stichtag nach dem Jahr, Eintritt erst danach → kein Beitrag', () => {
		expect(isBillable(m({ id: 'a', entryDate: '2026-03-01' }), 2025, '2026-10-16', 'run')).toBe(
			false
		);
		expect(isBillable(m({ id: 'a', entryDate: '2025-12-31' }), 2025, '2026-10-16', 'run')).toBe(
			true
		);
	});
	it('Nachberechnung: vor/am Stichtag ausgetreten → nicht nachträglich', () => {
		const st = '2027-02-10';
		expect(isBillable(m({ id: 'a', exitDate: '2027-02-01' }), 2027, st, 'catch-up')).toBe(false);
		expect(isBillable(m({ id: 'a', exitDate: '2027-02-10' }), 2027, st, 'catch-up')).toBe(false);
		// nach dem Stichtag eingetreten und wieder ausgetreten → zahlt
		expect(
			isBillable(
				m({ id: 'a', entryDate: '2027-03-01', exitDate: '2027-06-01' }),
				2027,
				st,
				'catch-up'
			)
		).toBe(true);
		expect(isBillable(m({ id: 'a', entryDate: '2028-01-01' }), 2027, st, 'catch-up')).toBe(false);
	});
});

describe('levelsFor', () => {
	it('28.02. voll, 01.03. nur Stamm, Eintritt im Vorjahr voll', () => {
		expect(levelsFor(m({ id: 'a', entryDate: '2027-02-28' }), 2027)).toEqual({
			levels: [...FEE_LEVELS],
			note: null
		});
		expect(levelsFor(m({ id: 'a', entryDate: '2027-03-01' }), 2027)).toEqual({
			levels: ['stamm'],
			note: 'late-entry'
		});
		expect(levelsFor(m({ id: 'a', entryDate: '2026-12-01' }), 2027).levels).toEqual([
			...FEE_LEVELS
		]);
	});
	it('Schaltjahr: 29.02. zählt als nach dem 28.02.', () => {
		expect(levelsFor(m({ id: 'a', entryDate: '2028-02-28' }), 2028).note).toBeNull();
		expect(levelsFor(m({ id: 'a', entryDate: '2028-02-29' }), 2028)).toEqual({
			levels: ['stamm'],
			note: 'late-entry'
		});
	});
	it('Zweitmitglied mit und ohne Stamm', () => {
		expect(
			levelsFor(m({ id: 'a', secondaryMember: true, feeLevels: ['stamm', 'gau'] }), 2027)
		).toEqual({ levels: ['stamm', 'gau'], note: 'secondary' });
		expect(
			levelsFor(
				m({ id: 'a', secondaryMember: true, feeLevels: ['gau'], entryDate: '2027-05-01' }),
				2027
			)
		).toEqual({ levels: [], note: 'late-entry' });
		expect(
			levelsFor(
				m({
					id: 'a',
					secondaryMember: true,
					feeLevels: ['bund', 'stamm'],
					entryDate: '2027-05-01'
				}),
				2027
			)
		).toEqual({ levels: ['stamm'], note: 'late-entry' });
	});
});

describe('planAnnualInvoices', () => {
	const payer = { id: 'p1', name: 'Familie Muster', email: 'eltern@example.test' };
	const members = [
		m({ id: 'max', firstName: 'Max', emails: ['max@example.test'] }),
		m({ id: 'lena', firstName: 'Lena', entryDate: '2026-03-01' }),
		m({ id: 'anna', firstName: 'Anna', lastName: 'Albers', exitDate: '2026-10-01' }),
		m({ id: 'neu', firstName: 'Neu', lastName: 'Zander', entryDate: '2026-11-01' }),
		m({ id: 'zweit', firstName: 'Zoe', lastName: 'Berg', secondaryMember: true, feeLevels: [] }),
		m({ id: 'solo', firstName: 'Solo', lastName: 'Albers' })
	];
	const base = {
		members,
		payerOf: new Map([
			['max', payer],
			['lena', payer]
		]),
		year: 2027,
		rates: DEFAULT_FEE_RATES,
		existingRefs: new Set<string>(),
		stichtag: '2026-10-16'
	};

	it('Lauf: Austritt zwischen Stichtag und Jahresbeginn ausgenommen', () => {
		const plan = planAnnualInvoices({
			...base,
			members: [m({ id: 'weg', exitDate: '2026-12-31', emails: ['x@example.test'] })],
			mode: 'run'
		});
		expect(plan.invoices).toEqual([]);
	});

	it('Lauf: eine Sammelrechnung je Zahler, Austritt/Eintritt nach Stichtag ausgenommen, 0 € übersprungen', () => {
		const plan = planAnnualInvoices({ ...base, mode: 'run' });
		expect(plan.invoices.map((i) => i.key)).toEqual(['payer:p1', 'member:solo']);
		const fam = plan.invoices[0]!;
		// 2 × (12 + 8 + 2 + 25) = 94 €
		expect(fam.totalCents).toBe(9400);
		// EIN offener Posten (Summe), die Aufschlüsselung steht in `items`
		expect(fam.lines).toEqual([
			{ memberId: null, description: 'Jahresbeitrag 2027 – Stammesbeitrag', amountCents: 9400 }
		]);
		expect(fam.items).toHaveLength(8);
		expect(fam.members.map((x) => x.name)).toEqual(['Lena Muster', 'Max Muster']);
		expect(fam.emails.sort()).toEqual(['eltern@example.test', 'max@example.test']);
		expect(fam.recipientEmail).toBe('eltern@example.test');
		expect(fam.items[0]!.sourceRef).toBe('annual:2027:lena:stamm');
		expect(fam.items[0]!.description).toBe('Jahresbeitrag 2027 Stamm – Lena Muster');
		// Einzelmitglied: Posten trägt das Mitglied
		expect(plan.invoices[1]!.lines[0]!.memberId).toBe('solo');
		expect(plan.skipped).toEqual([{ memberId: 'zweit', name: 'Zoe Berg' }]);
		expect(plan.withoutEmail).toEqual([{ memberId: 'solo', name: 'Solo Albers' }]);
		expect(plan.totalCents).toBe(9400 + 4700);
		expect(plan.memberCount).toBe(3);
	});

	it('Nachberechnung: nur noch nicht abgerechnete Mitglieder des Jahres, später Eintritt nur Stamm', () => {
		const existing = new Set(
			['max', 'lena', 'solo'].flatMap((id) => FEE_LEVELS.map((l) => annualRef(2027, id, l)))
		);
		const plan = planAnnualInvoices({
			...base,
			members: [...members, m({ id: 'spaet', firstName: 'Paul', entryDate: '2027-05-01' })],
			existingRefs: existing,
			mode: 'catch-up'
		});
		// anna: Austritt 2026-10-01 → nicht im Jahr 2027; neu: Eintritt 2026-11 → voll
		expect(plan.invoices.map((i) => [i.key, i.totalCents])).toEqual([
			['member:neu', 4700],
			['member:spaet', 1200]
		]);
	});

	it('Lauf ist idempotent über existingRefs', () => {
		const first = planAnnualInvoices({ ...base, mode: 'run' });
		const refs = new Set(first.invoices.flatMap((i) => i.items.map((l) => l.sourceRef)));
		expect(planAnnualInvoices({ ...base, mode: 'run', existingRefs: refs }).invoices).toEqual([]);
	});

	it('Ebene mit Satz 0 entfällt', () => {
		const plan = planAnnualInvoices({
			...base,
			rates: { ...DEFAULT_FEE_RATES, bund: 0 },
			mode: 'run'
		});
		expect(plan.invoices[1]!.members[0]!.levels).toEqual(['stamm', 'gau', 'landesmark']);
	});
});

describe('Hilfen', () => {
	it('joinNames und Standardfrist', () => {
		expect(joinNames(['Max'])).toBe('Max');
		expect(joinNames(['Max', 'Lena', 'Tom'])).toBe('Max, Lena und Tom');
		expect(defaultAnnualDueOn(2027, '2026-10-16', 14)).toBe('2027-03-31');
		expect(defaultAnnualDueOn(2027, '2027-04-01', 14)).toBe('2027-04-15');
	});
	it('Rechnungsfrist beim Versand: Laufsfrist, sonst heute + Mindestfrist (Schaltjahr)', () => {
		expect(annualInvoiceDueOn('2027-03-31', '2027-03-31', 14)).toBe('2027-03-31');
		expect(annualInvoiceDueOn('2027-03-31', '2027-04-01', 14)).toBe('2027-04-15');
		expect(annualInvoiceDueOn('2028-02-01', '2028-02-20', 14)).toBe('2028-03-05');
		expect(annualInvoiceDueOn('2027-03-31', '2027-05-02', 0)).toBe('2027-05-02');
		expect(annualInvoiceDueOn('2027-03-31', '2027-05-02', -3)).toBe('2027-05-02');
	});
});
