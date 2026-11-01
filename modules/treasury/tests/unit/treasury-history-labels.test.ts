import { describe, expect, it } from 'vitest';
import { HISTORY_ACTIONS, HISTORY_ID, historyLabel } from '$modules/treasury/history-labels';

describe('historyLabel', () => {
	it('liefert deutsche Klartexte', () => {
		expect(historyLabel('treasury.invoice.cancelled')).toBe('Rechnung storniert');
		expect(historyLabel('treasury.invoice.reactivated')).toBe('Stornierung zurückgenommen');
	});

	it('unterscheidet Zuordnung ändern und aufheben', () => {
		expect(historyLabel('treasury.transaction.allocated', { lines: 2 })).toBe('Zuordnung geändert');
		expect(historyLabel('treasury.transaction.allocated', { lines: 0 })).toBe(
			'Zuordnung aufgehoben'
		);
		expect(historyLabel('treasury.transaction.allocated', null)).toBe('Zuordnung geändert');
	});

	it('unterscheidet Storno und Wiederaufnahme bei Auszahlungen', () => {
		expect(historyLabel('treasury.payable.cancelled', { cancelled: true })).toBe(
			'Auszahlung storniert'
		);
		expect(historyLabel('treasury.payable.cancelled', { cancelled: false })).toBe(
			'Auszahlung wieder aufgenommen'
		);
	});

	it('fällt für Unbekanntes auf die Aktion zurück und filtert Fremdes', () => {
		expect(historyLabel('x.y.z')).toBe('x.y.z');
		expect(HISTORY_ACTIONS.has('treasury.invoice.created')).toBe(true);
		expect(HISTORY_ACTIONS.has('treasury.report.generated')).toBe(false);
	});

	it('ID-Muster lässt nur sichere Zeichen zu', () => {
		expect(HISTORY_ID.test(crypto.randomUUID())).toBe(true);
		expect(HISTORY_ID.test('a b')).toBe(false);
		expect(HISTORY_ID.test("x'; --")).toBe(false);
		expect(HISTORY_ID.test('a'.repeat(65))).toBe(false);
	});
});
