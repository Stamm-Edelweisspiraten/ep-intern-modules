/**
 * Stammeswebsite: Spam-Schutz des Kontaktformulars – Lösen im Browser (`website/src/lib/pow.ts`) gegen die
 * Aufgaben des Backends (`messages/contact-pow.ts`) und Lesen der Lösung aus dem Formular (`parsePow`).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createChallenge, verifySolution } from '$modules/messages/contact-pow';
import { solvePow } from '../../../../website/src/lib/pow';
import { POW_FIELD, parsePow } from '../../../../website/src/lib/server/contact';

const sign = (v: string) => createHmac('sha256', 'k').update(v).digest('hex');

describe('solvePow', () => {
	it('findet die Zahl, die das Backend akzeptiert', async () => {
		const t0 = Date.now();
		const c = createChallenge(sign, t0, 1234);
		const answer = await solvePow(c, { chunk: 300 });
		expect(answer).toEqual({
			salt: c.salt,
			challenge: c.challenge,
			number: 1234,
			signature: c.signature
		});
		expect(verifySolution(sign, answer!, t0 + 5_000)).toEqual({ ok: true });
	});

	it('Grenzen: 0 und maxNumber', async () => {
		for (const n of [0, 2000]) {
			const c = { ...createChallenge(sign, Date.now(), n), maxNumber: 2000 };
			expect((await solvePow(c))?.number).toBe(n);
		}
	});

	it('keine Lösung oder abgebrochen → null', async () => {
		const c = { ...createChallenge(sign, Date.now(), 5000), maxNumber: 1000 };
		expect(await solvePow(c)).toBeNull();
		const ac = new AbortController();
		ac.abort();
		expect(await solvePow(createChallenge(sign, Date.now(), 1), { signal: ac.signal })).toBeNull();
	});
});

describe('parsePow', () => {
	const form = (v: string) => {
		const f = new FormData();
		f.set(POW_FIELD, v);
		return f;
	};
	const ok = { salt: 's', challenge: 'c', number: 5, signature: 'x' };

	it('liest eine gültige Lösung', () => {
		expect(parsePow(form(JSON.stringify(ok)))).toEqual(ok);
	});

	it('fehlend, kaputt, falsche Typen, zu lang → null', () => {
		expect(parsePow(new FormData())).toBeNull();
		expect(parsePow(form('{'))).toBeNull();
		expect(parsePow(form(JSON.stringify({ ...ok, number: '5' })))).toBeNull();
		expect(parsePow(form(JSON.stringify({ ...ok, number: -1 })))).toBeNull();
		expect(parsePow(form(JSON.stringify({ ...ok, salt: '' })))).toBeNull();
		expect(parsePow(form(JSON.stringify({ ...ok, signature: 'x'.repeat(500) })))).toBeNull();
	});
});
