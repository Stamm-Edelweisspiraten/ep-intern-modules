/** IBAN-Hilfen (rein, ohne Abhaengigkeiten): Normalisieren, Pruefen (mod 97), Maskieren. */

/** Laengen gaengiger Laender; unbekannte Laender werden nur auf 15–34 Zeichen geprueft. */
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

/** Entfernt Leerzeichen/Trennzeichen und wandelt in Grossbuchstaben um. */
export function normalizeIban(input: string): string {
	return input.replace(/[\s.-]+/g, '').toUpperCase();
}

/** Prueft Format, Laenge (falls Land bekannt) und Pruefsumme (ISO 7064 mod 97-10). */
export function isValidIban(input: string): boolean {
	const iban = normalizeIban(input);
	if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
	const country = iban.slice(0, 2);
	const expected = LENGTHS[country];
	if (expected !== undefined && iban.length !== expected) return false;
	const rearranged = iban.slice(4) + iban.slice(0, 4);
	let remainder = 0;
	for (const ch of rearranged) {
		const value = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
		for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}

/** `DE75 5206 0410 0506 4394 38` → `DE75 •••• •••• •••• 4394 38` (Land, Pruefziffer, letzte 6 Stellen). */
export function maskIban(input: string): string {
	const iban = normalizeIban(input);
	if (iban.length < 10) return '••••';
	const head = iban.slice(0, 4);
	const tail = iban.slice(-6);
	const hiddenCount = iban.length - head.length - tail.length;
	const hidden = '•'.repeat(hiddenCount);
	const tailGrouped = tail.replace(/(.{4})(.{2})$/, '$1 $2');
	const groups = (hidden.match(/.{1,4}/g) ?? []).join(' ');
	return [head, groups, tailGrouped].filter(Boolean).join(' ');
}

/** Letzte 6 Stellen (fuer die Speicherung neben der verschluesselten IBAN). */
export function ibanLast(input: string, n = 6): string {
	return normalizeIban(input).slice(-n);
}

/** Maskierung aus den gespeicherten letzten Stellen (ohne Entschluesselung). */
export function maskFromLast(last: string | null, total = 22): string | null {
	if (!last) return null;
	const hidden = Math.max(total - 4 - last.length, 0);
	const groups = ('•'.repeat(hidden).match(/.{1,4}/g) ?? []).join(' ');
	return ['••••', groups, last.replace(/(.{4})(.{2})$/, '$1 $2')].filter(Boolean).join(' ');
}
