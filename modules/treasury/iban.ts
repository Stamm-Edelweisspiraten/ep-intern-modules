/** IBAN-Hilfen der Kasse (rein): Normalisieren, Prüfen (mod 97), Maske aus den letzten Stellen. */

const LENGTHS: Record<string, number> = {
	DE: 22,
	AT: 20,
	CH: 21,
	LI: 21,
	NL: 18,
	BE: 16,
	FR: 27,
	IT: 27,
	ES: 24,
	LU: 20,
	DK: 18,
	PL: 28,
	GB: 22,
	IE: 22,
	PT: 25,
	SE: 24,
	NO: 15,
	FI: 18,
	CZ: 24
};

export function normalizeIban(input: string): string {
	return input.replace(/[\s.-]+/g, '').toUpperCase();
}

/** Format, Länge (bekannte Länder) und Prüfsumme ISO 7064 mod 97-10 */
export function isValidIban(input: string): boolean {
	const iban = normalizeIban(input);
	if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
	const expected = LENGTHS[iban.slice(0, 2)];
	if (expected !== undefined && iban.length !== expected) return false;
	let remainder = 0;
	for (const ch of iban.slice(4) + iban.slice(0, 4)) {
		const value = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
		for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}

export const ibanLast4 = (input: string) => normalizeIban(input).slice(-4);

/** `•••• 2051` – Anzeige ohne Entschlüsselung */
export const maskIban = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : null);

/** Gruppiert in Vierergruppen: `DE02 1203 0000 …` */
export const formatIban = (input: string) =>
	normalizeIban(input)
		.replace(/(.{4})/g, '$1 ')
		.trim();
