import { describe, expect, it } from 'vitest';
import { expiryState, fefoOrder, normalizeBarcode, pickBatches } from '$modules/material/pantry';
import { formatAmount, productInput } from '$modules/material/schemas';

describe('Vorrat (rein)', () => {
	it('normalizeBarcode prüft Länge und Prüfziffer', () => {
		expect(normalizeBarcode(' 4006381333931 ')).toBe('4006381333931');
		expect(normalizeBarcode('4006381333932')).toBeNull();
		expect(normalizeBarcode('036000291452')).toBe('0036000291452');
		expect(normalizeBarcode('96385074')).toBe('96385074');
		expect(normalizeBarcode('04006381333931')).toBe('4006381333931');
		expect(normalizeBarcode('M-000123')).toBeNull();
		expect(normalizeBarcode('12345')).toBeNull();
	});

	it('productInput normalisiert den Strichcode', () => {
		expect(productInput.parse({ name: 'X', barcode: '036000291452' }).barcode).toBe(
			'0036000291452'
		);
		expect(productInput.parse({ name: 'X', barcode: '' }).barcode).toBeNull();
		expect(productInput.safeParse({ name: 'X', barcode: '123' }).success).toBe(false);
	});

	const batches = [
		{ id: 'c', quantity: 2, bestBefore: null, createdAt: '2026-01-01T00:00:00Z' },
		{ id: 'b', quantity: 3, bestBefore: '2026-08-01', createdAt: '2026-01-02T00:00:00Z' },
		{ id: 'a', quantity: 1, bestBefore: '2026-07-01', createdAt: '2026-01-03T00:00:00Z' }
	];

	it('fefoOrder: früheste MHD zuerst, ohne MHD zuletzt', () => {
		expect(fefoOrder(batches).map((b) => b.id)).toEqual(['a', 'b', 'c']);
	});

	it('pickBatches verteilt die Entnahme', () => {
		expect(pickBatches(batches, 3)).toEqual([
			{ batchId: 'a', quantity: 1 },
			{ batchId: 'b', quantity: 2 }
		]);
		expect(pickBatches(batches, 6)).toHaveLength(3);
		expect(pickBatches(batches, 7)).toBeNull();
		expect(pickBatches(batches, 2, 'c')).toEqual([{ batchId: 'c', quantity: 2 }]);
		expect(pickBatches(batches, 3, 'c')).toBeNull();
	});

	it('expiryState', () => {
		expect(expiryState(null, '2026-06-01')).toBe('none');
		expect(expiryState('2026-05-31', '2026-06-01')).toBe('expired');
		expect(expiryState('2026-06-01', '2026-06-01')).toBe('soon');
		expect(expiryState('2026-06-15', '2026-06-01')).toBe('soon');
		expect(expiryState('2026-06-16', '2026-06-01')).toBe('ok');
	});

	it('formatAmount', () => {
		expect(formatAmount(20, 'l')).toBe('20 l');
		expect(formatAmount(3, '')).toBe('3');
	});
});
