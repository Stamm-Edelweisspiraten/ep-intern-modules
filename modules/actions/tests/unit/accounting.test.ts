import { describe, expect, it } from 'vitest';
import { payeeTotals, summarize, toPayoutCsv } from '$modules/actions/accounting';
import type { AccountingPlan, PayoutRow, SummaryEntry } from '$modules/actions/schemas';

const e = (p: Partial<SummaryEntry>): SummaryEntry => ({
	type: 'expense',
	category: 'food',
	amountCents: 1000,
	paidBy: 'club',
	payeeId: null,
	hasReceipt: true,
	reimbursed: false,
	...p
});

const plan: AccountingPlan = {
	contributionsCents: 50000,
	subsidyCents: 10000,
	expenseByCategory: { food: 20000, lodging: 30000 },
	totalExpenseCents: 50000
};

describe('summarize', () => {
	const entries: SummaryEntry[] = [
		e({ type: 'income', category: 'contributions', amountCents: 40000 }),
		e({ type: 'income', category: 'misc', amountCents: 500 }),
		e({ category: 'food', amountCents: 15000, hasReceipt: false }),
		e({ category: 'materials', amountCents: 2500, paidBy: 'person', payeeId: 'p1' }),
		e({
			category: 'food',
			amountCents: 1000,
			paidBy: 'person',
			payeeId: 'p1',
			reimbursed: true
		})
	];

	it('Summen und Saldo', () => {
		const s = summarize(entries, plan);
		expect(s.incomeCents).toBe(40500);
		expect(s.expenseCents).toBe(18500);
		expect(s.balanceCents).toBe(22000);
		expect(s.missingReceipts).toBe(1);
		expect(s.openReimbursementCents).toBe(2500);
	});

	it('Soll/Ist und Reihenfolge', () => {
		const s = summarize(entries, plan);
		expect(s.plannedIncomeCents).toBe(60000);
		expect(s.plannedExpenseCents).toBe(50000);
		expect(s.byCategory.map((c) => c.category)).toEqual([
			'contributions',
			'subsidy',
			'misc',
			'food',
			'lodging',
			'materials'
		]);
		const food = s.byCategory.find((c) => c.category === 'food')!;
		expect(food).toEqual({
			category: 'food',
			type: 'expense',
			plannedCents: 20000,
			actualCents: 16000
		});
		const subsidy = s.byCategory.find((c) => c.category === 'subsidy')!;
		expect(subsidy.actualCents).toBe(0);
		expect(subsidy.plannedCents).toBe(10000);
		expect(s.byCategory.find((c) => c.category === 'misc')!.plannedCents).toBeNull();
		expect(s.byCategory.find((c) => c.category === 'materials')!.plannedCents).toBeNull();
	});

	it('ohne Plan sind Sollwerte null', () => {
		const s = summarize(entries, null);
		expect(s.plannedIncomeCents).toBeNull();
		expect(s.plannedExpenseCents).toBeNull();
		expect(s.byCategory.every((c) => c.plannedCents === null)).toBe(true);
	});

	it('Plan mit nur einem Einnahmewert', () => {
		const s = summarize([], {
			contributionsCents: null,
			subsidyCents: 700,
			expenseByCategory: {},
			totalExpenseCents: null
		});
		expect(s.plannedIncomeCents).toBe(700);
		expect(s.plannedExpenseCents).toBeNull();
	});

	it('leer: alles 0, nie NaN', () => {
		const s = summarize([], null);
		expect(s).toMatchObject({
			incomeCents: 0,
			expenseCents: 0,
			balanceCents: 0,
			missingReceipts: 0,
			openReimbursementCents: 0,
			byCategory: []
		});
	});

	it('Einnahmen ohne Beleg zählen nicht als fehlend', () => {
		const s = summarize([e({ type: 'income', category: 'misc', hasReceipt: false })], null);
		expect(s.missingReceipts).toBe(0);
	});
});

describe('payeeTotals', () => {
	it('gruppiert nur Personen-Auslagen', () => {
		const m = payeeTotals([
			e({ paidBy: 'person', payeeId: 'a', amountCents: 300 }),
			e({ paidBy: 'person', payeeId: 'a', amountCents: 200, reimbursed: true }),
			e({ paidBy: 'person', payeeId: 'b', amountCents: 50 }),
			e({ paidBy: 'club' }),
			e({ type: 'income', category: 'misc' })
		]);
		expect([...m.keys()].sort()).toEqual(['a', 'b']);
		expect(m.get('a')).toEqual({ openCents: 300, reimbursedCents: 200, openEntries: 1 });
		expect(m.get('b')).toEqual({ openCents: 50, reimbursedCents: 0, openEntries: 1 });
	});
});

describe('toPayoutCsv', () => {
	const row = (p: Partial<PayoutRow>): PayoutRow => ({
		payeeId: 'p',
		name: 'Max Muster',
		iban: 'DE89370400440532013000',
		bic: 'COBADEFFXXX',
		amountCents: 123450,
		purpose: 'Auslagen Sommerlager',
		entryCount: 3,
		...p
	});

	it('BOM, Kopfzeile, CRLF, Betragsformat', () => {
		const csv = toPayoutCsv([row({})]);
		expect(csv.startsWith('﻿')).toBe(true);
		const lines = csv.slice(1).split('\r\n');
		expect(lines[0]).toBe('Name;IBAN;BIC;Betrag;Verwendungszweck;Anzahl Belege');
		expect(lines[1]).toBe(
			'Max Muster;DE89370400440532013000;COBADEFFXXX;1234,50;Auslagen Sommerlager;3'
		);
		expect(csv).not.toMatch(/(?<!\r)\n/);
	});

	it('kleine Beträge und fehlende BIC', () => {
		const csv = toPayoutCsv([row({ amountCents: 5, bic: null })]);
		expect(csv).toContain(';;0,05;');
	});

	it('Escaping von Semikolon, Anführungszeichen, Zeilenumbruch', () => {
		const csv = toPayoutCsv([row({ name: 'A; "B"', purpose: 'x\ny' })]);
		expect(csv).toContain('"A; ""B"""');
		expect(csv).toContain('"x\ny"');
	});

	it('Formel-Schutz', () => {
		for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx']) {
			const csv = toPayoutCsv([row({ name: bad })]);
			expect(csv.split('\r\n')[1]!.startsWith(`'${bad}`)).toBe(true);
		}
	});
});
