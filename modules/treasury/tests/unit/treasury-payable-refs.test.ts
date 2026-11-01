import { describe, expect, it } from 'vitest';
import {
	parseReimbursementRef,
	planPayables,
	reimbursementDescription,
	reimbursementRef,
	type PayableDesired
} from '$modules/treasury/logic';

describe('Schlüssel für Auslagen-Auszahlungen', () => {
	it('Schlussabrechnung behält den bisherigen Schlüssel', () => {
		expect(reimbursementRef('a', 'p')).toBe('reimb:a:p');
		expect(reimbursementRef('a', 'p', null)).toBe('reimb:a:p');
		expect(parseReimbursementRef('reimb:a:p')).toEqual({
			actionId: 'a',
			payeeId: 'p',
			interimId: null
		});
	});

	it('Zwischenabrechnung bekommt einen eigenen Schlüssel', () => {
		expect(reimbursementRef('a', 'p', 'z')).toBe('reimb:a:p:z');
		expect(parseReimbursementRef('reimb:a:p:z')).toEqual({
			actionId: 'a',
			payeeId: 'p',
			interimId: 'z'
		});
	});

	it('lehnt fremde oder kaputte Schlüssel ab', () => {
		expect(parseReimbursementRef('expense:a:e')).toBeNull();
		expect(parseReimbursementRef('reimb:a')).toBeNull();
		expect(parseReimbursementRef('reimb:a:p:')).toBeNull();
		expect(parseReimbursementRef('reimb:a:p:z:x')).toBeNull();
		expect(parseReimbursementRef('reimb::p')).toBeNull();
	});

	it('Beschreibung nennt die Zwischenabrechnung', () => {
		expect(reimbursementDescription('Anna', 'Lager')).toBe('Auslagen Lager');
		expect(reimbursementDescription('Anna', 'Lager', 2)).toBe(
			'Auslagen Anna – Lager, Zwischenabrechnung Nr. 2'
		);
		expect(reimbursementDescription('A', 'x'.repeat(300), 1)).toHaveLength(200);
	});

	it('Rücknahme einer Zwischenabrechnung storniert die unbezahlte Auszahlung', () => {
		const want = (ref: string): PayableDesired => ({
			sourceRef: ref,
			source: 'reimbursement',
			actionId: 'a',
			recipientName: 'Anna',
			description: 'Auslagen',
			amountCents: 1000,
			payerId: null,
			memberId: null,
			ibanLast4: null,
			bic: null
		});
		const existing = (id: string, ref: string, paidCents: number) => ({
			id,
			sourceRef: ref,
			amountCents: 1000,
			paidCents,
			description: 'Auslagen',
			recipientName: 'Anna',
			payerId: null,
			cancelled: false,
			autoCancelled: false
		});
		// ZA 1 bezahlt, ZA 2 offen und zurückgenommen, Schluss noch da
		const plan = planPayables(
			[want('reimb:a:p:z1'), want('reimb:a:p')],
			[
				existing('1', 'reimb:a:p:z1', 1000),
				existing('2', 'reimb:a:p:z2', 0),
				existing('3', 'reimb:a:p', 0)
			]
		);
		expect(plan.cancel).toEqual(['2']);
		expect(plan.create).toEqual([]);
		expect(plan.update).toEqual([]);
	});

	it('neues Modell: eine Auszahlung je Person wächst, alte ZA-Auszahlungen werden abgelöst', () => {
		const want = (ref: string, amountCents: number): PayableDesired => ({
			sourceRef: ref,
			source: 'reimbursement',
			actionId: 'a',
			recipientName: 'Anna',
			description: reimbursementDescription('Anna', 'Lager'),
			amountCents,
			payerId: null,
			memberId: null,
			ibanLast4: null,
			bic: null
		});
		const existing = (id: string, ref: string, amountCents: number, paidCents: number) => ({
			id,
			sourceRef: ref,
			amountCents,
			paidCents,
			description: 'Auslagen Lager',
			recipientName: 'Anna',
			payerId: null,
			cancelled: false,
			autoCancelled: false
		});
		// A (1000) bezahlt, B (500) neu freigegeben: gewünscht = bezahlt + offen = 1500
		const grow = planPayables([want('reimb:a:p', 1500)], [existing('1', 'reimb:a:p', 1000, 1000)]);
		expect(grow.update).toEqual([{ id: '1', want: want('reimb:a:p', 1500), amountCents: 1500 }]);
		expect(grow.cancel).toEqual([]);

		// Altdaten: unbezahlte ZA-Auszahlung wird storniert, bezahlte bleibt, neue Auszahlung entsteht
		const migrate = planPayables(
			[want('reimb:a:p', 700)],
			[existing('2', 'reimb:a:p:z1', 700, 0), existing('3', 'reimb:a:p:z0', 300, 300)]
		);
		expect(migrate.cancel).toEqual(['2']);
		expect(migrate.create.map((d) => d.sourceRef)).toEqual(['reimb:a:p']);
	});
});
