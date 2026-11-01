import { describe, expect, it } from 'vitest';
import {
	MIN_REFUND_PER_HEAD_CENTS,
	choiceOf,
	computeManualRefund,
	computeRefund,
	deadlineRunning,
	donationForChoice,
	donationTotals,
	payoutCents,
	refundThresholdOk,
	validateDonation
} from '$modules/actions/refund';

const payer = (id: string, feeCents: number) => ({ id, name: `P${id}`, feeCents });

describe('computeRefund', () => {
	it('gleiche Beiträge: gleicher Betrag, ganze Euro abgerundet', () => {
		// 1000,00 EUR / 3 = 333,33 -> 333 EUR je Person, Rest 1,00 EUR
		const r = computeRefund({
			surplusCents: 100000,
			payers: [payer('a', 20000), payer('b', 20000), payer('c', 20000)]
		});
		expect(r.items.map((i) => i.amountCents)).toEqual([33300, 33300, 33300]);
		expect(r.totalCents).toBe(99900);
		expect(r.remainderCents).toBe(100);
		expect(r.perHeadCents).toBe(33300);
		expect(r.payingCount).toBe(3);
	});

	it('unterschiedliche Beiträge (Team-Prozent): anteilig, abgerundet', () => {
		// Beiträge 200 + 100 = 300; Überschuss 90 EUR -> 60 EUR und 30 EUR
		const r = computeRefund({ surplusCents: 9000, payers: [payer('a', 20000), payer('t', 10000)] });
		expect(r.items.map((i) => i.amountCents)).toEqual([6000, 3000]);
		expect(r.perHeadCents).toBe(6000);
		expect(r.remainderCents).toBe(0);
		// Überschuss 100 EUR: 66,66 -> 66, 33,33 -> 33; Rest 1 EUR
		const r2 = computeRefund({
			surplusCents: 10000,
			payers: [payer('a', 20000), payer('t', 10000)]
		});
		expect(r2.items.map((i) => i.amountCents)).toEqual([6600, 3300]);
		expect(r2.remainderCents).toBe(100);
	});

	it('Beträge unter 1 EUR entfallen', () => {
		const r = computeRefund({ surplusCents: 99, payers: [payer('a', 100)] });
		expect(r.items).toEqual([]);
		expect(r.totalCents).toBe(0);
		expect(r.remainderCents).toBe(99);
		expect(r.perHeadCents).toBe(0);
	});

	it('Überschuss 0/negativ/NaN, keine Zahlenden', () => {
		for (const surplusCents of [0, -500, NaN, Infinity]) {
			const r = computeRefund({ surplusCents, payers: [payer('a', 100)] });
			expect(r.items).toEqual([]);
			expect(r.totalCents).toBe(0);
			expect(r.remainderCents).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(r.remainderCents)).toBe(true);
		}
		const none = computeRefund({ surplusCents: 5000, payers: [payer('a', 0)] });
		expect(none.payingCount).toBe(0);
		expect(none.remainderCents).toBe(5000);
	});

	it('große Zahlen bleiben exakt', () => {
		const r = computeRefund({
			surplusCents: 100000000,
			payers: Array.from({ length: 7 }, (_, i) => payer(String(i), 1234567))
		});
		// 1.000.000 EUR / 7 = 142857,14 -> 142857 EUR
		expect(r.perHeadCents).toBe(14285700);
		expect(r.totalCents).toBe(7 * 14285700);
		expect(r.remainderCents).toBe(100000000 - 7 * 14285700);
	});
});

describe('computeManualRefund', () => {
	it('Überschuss / Anzahl, ganze Euro abgerundet, Rest', () => {
		// 1000,00 EUR / 7 = 142,857 -> 142 EUR je Person; 7 x 142 = 994; Rest 6 EUR
		const r = computeManualRefund({ surplusCents: 100000, count: 7 });
		expect(r.perHeadCents).toBe(14200);
		expect(r.totalCents).toBe(99400);
		expect(r.remainderCents).toBe(600);
		expect(r.count).toBe(7);
	});

	it('ungültige Eingaben ergeben 0', () => {
		for (const [surplusCents, count] of [
			[0, 5],
			[-100, 5],
			[NaN, 5],
			[5000, 0],
			[5000, NaN],
			[5000, -3]
		] as const) {
			const r = computeManualRefund({ surplusCents, count });
			expect(r.perHeadCents).toBe(0);
			expect(r.totalCents).toBe(0);
			expect(Number.isFinite(r.remainderCents)).toBe(true);
		}
	});

	it('Schwelle: genau 5 EUR nicht ok, 5,01 EUR ok', () => {
		expect(MIN_REFUND_PER_HEAD_CENTS).toBe(500);
		expect(refundThresholdOk(500)).toBe(false);
		expect(refundThresholdOk(501)).toBe(true);
		expect(refundThresholdOk(0)).toBe(false);
		expect(refundThresholdOk(NaN)).toBe(false);
		// 50 EUR / 10 = 5 EUR -> nicht ok; 60 EUR / 10 = 6 EUR -> ok
		expect(
			refundThresholdOk(computeManualRefund({ surplusCents: 5000, count: 10 }).perHeadCents)
		).toBe(false);
		expect(
			refundThresholdOk(computeManualRefund({ surplusCents: 6000, count: 10 }).perHeadCents)
		).toBe(true);
	});
});

describe('Spende der Rückzahlung', () => {
	it('validateDonation: 0, ganze Euro, krummer Anteil komplett, zu viel, ungültig', () => {
		expect(validateDonation(16666, 0)).toBeNull();
		expect(validateDonation(16666, 16600)).toBeNull();
		// „alles spenden“ auch bei krummem Anteil
		expect(validateDonation(16666, 16666)).toBeNull();
		expect(validateDonation(16666, 1050)).toMatch(/ganze Euro/);
		expect(validateDonation(16666, 16700)).toMatch(/höher/);
		expect(validateDonation(16666, -100)).toMatch(/ungültig/);
		expect(validateDonation(16666, 1.5)).toMatch(/ungültig/);
	});

	it('donationTotals, payoutCents, choiceOf, donationForChoice', () => {
		const items = [
			{ amountCents: 20000, donatedCents: 0 },
			{ amountCents: 20000, donatedCents: 5000 },
			{ amountCents: 20000, donatedCents: 20000 },
			// Spende über dem Anteil wird gekappt
			{ amountCents: 1000, donatedCents: 3000 }
		];
		expect(donationTotals(items)).toEqual({
			donatedCents: 26000,
			payoutCents: 35000,
			donorCount: 3
		});
		expect(payoutCents({ amountCents: 20000, donatedCents: 5000 })).toBe(15000);
		expect(payoutCents({ amountCents: 1000, donatedCents: 3000 })).toBe(0);
		expect(items.slice(0, 3).map(choiceOf)).toEqual(['payout', 'partial', 'donate']);
		expect(donationForChoice(20000, 'payout', 500)).toBe(0);
		expect(donationForChoice(20000, 'donate')).toBe(20000);
		expect(donationForChoice(20000, 'partial', 7000)).toBe(7000);
		expect(donationForChoice(20000, 'partial', Number.NaN)).toBe(0);
	});
});

describe('deadlineRunning', () => {
	it('läuft bis einschließlich des Fristtags, ohne Frist nie', () => {
		expect(deadlineRunning(null, '2026-06-01')).toBe(false);
		expect(deadlineRunning('2026-06-10', '2026-06-01')).toBe(true);
		expect(deadlineRunning('2026-06-10', '2026-06-10')).toBe(true);
		expect(deadlineRunning('2026-06-10', '2026-06-11')).toBe(false);
	});
});
