import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	MAX_AGE_MS,
	MIN_FILL_MS,
	POW_MAX_NUMBER,
	contactDedupeKey,
	createChallenge,
	verifySolution
} from '$modules/messages/contact-pow';
import { contactText } from '$modules/messages/contact.service';

const sign = (v: string) => createHmac('sha256', 'test-key').update(v).digest('hex');
const T0 = 1_790_000_000_000;

function solve(c: ReturnType<typeof createChallenge>, number: number) {
	return { salt: c.salt, challenge: c.challenge, number, signature: c.signature };
}

describe('Proof-of-Work des Kontaktformulars', () => {
	it('akzeptiert die richtige Zahl nach der Zeitfalle und vor dem Ablauf', () => {
		const c = createChallenge(sign, T0, 4711);
		expect(c.maxNumber).toBe(POW_MAX_NUMBER);
		expect(c.expiresAt).toBe(new Date(T0 + MAX_AGE_MS).toISOString());
		expect(verifySolution(sign, solve(c, 4711), T0 + MIN_FILL_MS)).toEqual({ ok: true });
		expect(verifySolution(sign, solve(c, 4711), T0 + MAX_AGE_MS)).toEqual({ ok: true });
	});

	it('Zeitfalle und Ablauf', () => {
		const c = createChallenge(sign, T0, 1);
		expect(verifySolution(sign, solve(c, 1), T0 + MIN_FILL_MS - 1)).toEqual({
			ok: false,
			reason: 'too-fast'
		});
		expect(verifySolution(sign, solve(c, 1), T0 + MAX_AGE_MS + 1)).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('falsche Zahl, fremder Schlüssel, manipulierter Zeitstempel → ungültig', () => {
		const c = createChallenge(sign, T0, 10);
		const now = T0 + 10_000;
		const invalid = { ok: false, reason: 'invalid' };
		expect(verifySolution(sign, solve(c, 11), now)).toEqual(invalid);
		expect(verifySolution(sign, solve(c, -1), now)).toEqual(invalid);
		expect(verifySolution(sign, solve(c, POW_MAX_NUMBER + 1), now)).toEqual(invalid);
		expect(verifySolution(sign, { ...solve(c, 10), number: 10.5 }, now)).toEqual(invalid);
		const other = (v: string) => createHmac('sha256', 'anderer').update(v).digest('hex');
		expect(verifySolution(other, solve(c, 10), now)).toEqual(invalid);
		// Zeitstempel im Salt ist signiert: älter machen bricht die Signatur
		const salt = c.salt.replace(/\.\d+$/, `.${T0 - 60_000}`);
		expect(verifySolution(sign, { ...solve(c, 10), salt }, now)).toEqual(invalid);
		expect(verifySolution(sign, { ...solve(c, 10), salt: 'kaputt' }, now)).toEqual(invalid);
	});

	it('jede Aufgabe hat einen eigenen Schlüssel gegen Wiederverwendung', () => {
		const a = createChallenge(sign, T0, 5);
		const b = createChallenge(sign, T0, 5);
		expect(contactDedupeKey(a)).not.toBe(contactDedupeKey(b));
	});

	it('Text der Anfrage enthält Kontakt und Hinweis auf ungeprüfte Angaben', () => {
		const text = contactText({ name: 'Petra', email: 'p@x.de', phone: '', message: 'Hallo' });
		expect(text.startsWith('Hallo\n')).toBe(true);
		expect(text).toContain('Telefon: –');
		expect(text).toContain('nicht geprüft');
	});
});
