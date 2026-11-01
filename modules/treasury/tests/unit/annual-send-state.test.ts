/** #24: Lebenszeichen des Hintergrundversands (Jahresbeitrag) */
import { describe, expect, it } from 'vitest';
import { isSending } from '$modules/treasury/annual-fee.service';
import type { AnnualSendResult } from '$modules/treasury/schemas';

const base: AnnualSendResult = {
	invoicesCreated: 3,
	mailsSent: 0,
	mailErrors: 0,
	withoutAddress: 0
};
const now = Date.parse('2026-10-21T10:00:00.000Z');
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

describe('isSending', () => {
	it('ohne Ergebnis oder ohne Flag → false (ältere Ergebnisse)', () => {
		expect(isSending(null, now)).toBe(false);
		expect(isSending(base, now)).toBe(false);
		expect(isSending({ ...base, sending: false, heartbeatAt: ago(0) }, now)).toBe(false);
	});

	it('frisches Lebenszeichen → läuft', () => {
		expect(isSending({ ...base, sending: true, heartbeatAt: ago(1) }, now)).toBe(true);
		expect(isSending({ ...base, sending: true, startedAt: ago(9) }, now)).toBe(true);
	});

	it('kein Fortschritt seit 10 min oder kein Zeitstempel → abgebrochen', () => {
		expect(isSending({ ...base, sending: true, heartbeatAt: ago(10) }, now)).toBe(false);
		expect(isSending({ ...base, sending: true, startedAt: ago(30) }, now)).toBe(false);
		expect(isSending({ ...base, sending: true }, now)).toBe(false);
	});
});
