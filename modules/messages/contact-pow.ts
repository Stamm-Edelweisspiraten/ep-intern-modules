/**
 * Spam-Schutz des Website-Kontaktformulars (rein, ohne Core-Importe – getestet in `tests/unit/messages-contact.test.ts`).
 *
 * Proof-of-Work nach dem Muster von ALTCHA, ohne Dritte: Der Server wählt eine Zufallszahl `n ≤ maxNumber` und
 * schickt `challenge = SHA-256(salt + n)` mit einer HMAC-Signatur. Der Browser probiert alle Zahlen durch (im Mittel
 * `maxNumber / 2` Hashes, ~1 s) und sendet `n` mit. Der Server prüft Signatur, Lösung und die **Zeitfalle**: Der
 * Ausstellungszeitpunkt steht im `salt` (signiert) – wer schneller als `MIN_FILL_MS` absendet, ist ein Bot; ältere
 * Aufgaben als `MAX_AGE_MS` verfallen. Wiederverwendung verhindert der Aufrufer (eindeutiger Schlüssel je Aufgabe).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const POW_ALGORITHM = 'SHA-256';
/** Suchraum: im Mittel 50 000 Hashes im Browser (WebCrypto, ~0,5–2 s) */
export const POW_MAX_NUMBER = 100_000;
/** Zeitfalle: so schnell füllt kein Mensch das Formular aus */
export const MIN_FILL_MS = 3_000;
/** Gültigkeit einer Aufgabe (lange Nachrichten brauchen Zeit; die Website holt vorher eine neue) */
export const MAX_AGE_MS = 2 * 60 * 60_000;

export interface PowChallenge {
	algorithm: typeof POW_ALGORITHM;
	/** `<Zufall hex>.<Ausstellungszeitpunkt ms>` */
	salt: string;
	challenge: string;
	maxNumber: number;
	signature: string;
	expiresAt: string;
}

export interface PowSolution {
	salt: string;
	challenge: string;
	number: number;
	signature: string;
}

export type PowCheck = { ok: true } | { ok: false; reason: 'invalid' | 'too-fast' | 'expired' };

/** Signatur (HMAC mit Modulschlüssel, vom Aufrufer gestellt) */
export type Signer = (value: string) => string;

const SALT_RE = /^[0-9a-f]{24}\.(\d{13})$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const signed = (salt: string, challenge: string) => `contact-pow:${salt}:${challenge}`;

function sameText(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function createChallenge(sign: Signer, now = Date.now(), number?: number): PowChallenge {
	const salt = `${randomBytes(12).toString('hex')}.${now}`;
	const n = number ?? randomInt(0, POW_MAX_NUMBER + 1);
	const challenge = sha256(`${salt}${n}`);
	return {
		algorithm: POW_ALGORITHM,
		salt,
		challenge,
		maxNumber: POW_MAX_NUMBER,
		signature: sign(signed(salt, challenge)),
		expiresAt: new Date(now + MAX_AGE_MS).toISOString()
	};
}

export function verifySolution(sign: Signer, s: PowSolution, now = Date.now()): PowCheck {
	const m = SALT_RE.exec(s.salt);
	if (!m || !HEX64_RE.test(s.challenge)) return { ok: false, reason: 'invalid' };
	if (!Number.isInteger(s.number) || s.number < 0 || s.number > POW_MAX_NUMBER) {
		return { ok: false, reason: 'invalid' };
	}
	if (!sameText(sign(signed(s.salt, s.challenge)), s.signature))
		return { ok: false, reason: 'invalid' };
	if (sha256(`${s.salt}${s.number}`) !== s.challenge) return { ok: false, reason: 'invalid' };
	const issuedAt = Number(m[1]);
	// Zeitstempel ist signiert; eine Aufgabe „aus der Zukunft“ gibt es nur bei Uhrensprüngen
	if (now - issuedAt < MIN_FILL_MS) return { ok: false, reason: 'too-fast' };
	if (now - issuedAt > MAX_AGE_MS) return { ok: false, reason: 'expired' };
	return { ok: true };
}

/** Schlüssel gegen Wiederverwendung (eine Aufgabe = eine Anfrage) */
export const contactDedupeKey = (s: Pick<PowSolution, 'challenge'>) => `contact:${s.challenge}`;
