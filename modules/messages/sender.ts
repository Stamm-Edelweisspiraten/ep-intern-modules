/**
 * Reine Logik für Absenderadressen (ohne Server-/Svelte-Imports, in Tests und UI nutzbar).
 *
 * Persönliche Adresse: `vorname.nachname@domain`. Stehen im Vornamen mehrere Namen, zählt nur der erste
 * („Anna Maria“ → „anna“); Bindestrich-Namen bleiben („Anna-Lena“ → „anna-lena“). Umlaute und Akzente
 * werden zu ASCII (ä → ae, ß → ss, é → e), alles Übrige außerhalb `[a-z0-9-]` entfällt.
 */

const REPLACEMENTS: Record<string, string> = {
	ä: 'ae',
	ö: 'oe',
	ü: 'ue',
	ß: 'ss',
	æ: 'ae',
	œ: 'oe',
	ø: 'o',
	å: 'a',
	đ: 'd',
	ł: 'l'
};

/** Kleinbuchstaben, ASCII, nur `[a-z0-9-]`; Leerstring, wenn nichts übrig bleibt */
export function slugPart(value: string): string {
	const lower = value.toLowerCase().replace(/[äöüßæœøåđł]/g, (c) => REPLACEMENTS[c] ?? c);
	return lower
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Erster Vorname (Trennung an Leerzeichen); Bindestrich-Namen bleiben zusammen */
export function firstGivenName(value: string): string {
	return value.trim().split(/\s+/)[0] ?? '';
}

/**
 * Aus einem ganzen Namen („Anna Maria Müller“) Vor- und Nachnamen ableiten, wenn kein Mitglied
 * verknüpft ist: erstes Wort = Vorname, letztes Wort = Nachname (zweite Vornamen entfallen).
 * Genauer wird es mit einem als eigenes Konto verknüpften Mitglied.
 */
export function splitFullName(name: string): { firstName: string; lastName: string } {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return { firstName: parts[0] ?? '', lastName: parts.length > 1 ? parts[parts.length - 1]! : '' };
}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Gültiger Domainname (klein, ohne `@`, ohne Pfad) */
export function isValidDomain(domain: string): boolean {
	return DOMAIN.test(domain);
}

export interface PersonalAddressInput {
	firstName: string;
	lastName: string;
	domain: string;
}

/** `vorname.nachname@domain` oder `null`, wenn Name oder Domain keine gültige Adresse ergeben */
export function personalAddress({
	firstName,
	lastName,
	domain
}: PersonalAddressInput): string | null {
	const host = domain.trim().toLowerCase();
	if (!isValidDomain(host)) return null;
	const first = slugPart(firstGivenName(firstName));
	const last = slugPart(lastName);
	if (!first || !last) return null;
	return `${first}.${last}@${host}`;
}

/** E-Mail-Adresse klein geschrieben und getrimmt (Vergleich/Deduplizierung) */
export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

/** Mehrfach vorkommende Adressen (ohne Rücksicht auf Groß-/Kleinschreibung) zusammenfassen, Reihenfolge bleibt */
export function dedupeAddresses<T extends { address: string }>(items: readonly T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = normalizeAddress(item.address);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
