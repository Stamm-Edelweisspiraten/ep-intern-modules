import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { LINK_CODE_TTL_DAYS, ageFromBirthDate } from './schemas';

/** Reine Hilfen für die Konto-Verknüpfung (ohne Datenbank/Core, gut testbar). */

/** 6 Ziffern, führende Nullen erlaubt (kryptografisch zufällig). */
export function generateLinkCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 32 Hex-Zeichen, Kennung im Link/QR. */
export function generateLinkToken(): string {
	return randomBytes(16).toString('hex');
}

/** `123456` → `123 456` (Anzeige im Brief). */
export function formatLinkCode(code: string): string {
	return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function linkExpiry(now: Date = new Date()): Date {
	return new Date(now.getTime() + LINK_CODE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Zeitkonstanter Vergleich zweier Codes. */
export function codesMatch(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

const MAX_LINES = 6;
const MAX_LINE = 60;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function clip(line: string): string {
	const t = line.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
	return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

/** Ab diesem Alter wird das Mitglied selbst angeschrieben (nicht mehr „Eltern von …“). */
export const ADULT_AGE = 18;

export function isAdult(birthDate: string, today: Date = new Date()): boolean {
	const age = ageFromBirthDate(birthDate, today);
	return age !== null && age >= ADULT_AGE;
}

/** Ländername auf Deutsch (z. B. `AT` → „Österreich“), sonst der Code. */
export function countryName(code: string): string {
	try {
		return new Intl.DisplayNames('de', { type: 'region' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/**
 * Adressfeld-Zeilen für den Brief: „Eltern von Vorname Nachname“ bei Minderjährigen, bei Volljährigen
 * der Name selbst; dann Straße, „PLZ Ort“ und – außerhalb Deutschlands – das Land
 * (max. 6 Zeilen à 60 Zeichen, leere Zeilen entfallen, Steuerzeichen werden entfernt).
 */
export function recipientLines(
	member: {
		firstName: string;
		lastName: string;
		birthDate: string;
		street: string;
		postalCode: string;
		city: string;
		country: string;
	},
	today: Date = new Date()
): string[] {
	const name = `${member.firstName} ${member.lastName}`;
	const head = clip(isAdult(member.birthDate, today) ? name : `Eltern von ${name}`);
	const rest = [
		...member.street.split(/\r?\n/),
		`${member.postalCode} ${member.city}`,
		member.country && member.country !== 'DE' ? countryName(member.country).toUpperCase() : ''
	]
		.map(clip)
		.filter(Boolean);
	return [head, ...rest].slice(0, MAX_LINES);
}

export function linkUrl(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, '')}/p/members/verknuepfen/${token}`;
}
