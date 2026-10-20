/**
 * Reine Hilfen der Adress-Autovervollständigung (Server und Oberfläche, ohne Server-Imports).
 */

/**
 * „Am Wall 12a“ → `{ name: 'Am Wall', number: '12a' }`. Erkennt auch „12 a“, „12-14“, „12/1“.
 * Ohne Hausnummer bleibt `number` leer.
 */
export function splitHouseNumber(q: string): { name: string; number: string } {
	const t = q.trim().replace(/\s+/g, ' ');
	const m = /^(.*\D)\s+(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d+\s?[a-zA-Z]?)?)$/.exec(t);
	if (!m) return { name: t, number: '' };
	return { name: m[1]!.trim().replace(/[,\s]+$/, ''), number: m[2]!.replace(/\s+/g, '') };
}

/**
 * Suchname fürs Straßenverzeichnis: dort heißt es „…str.“ – „straße“, „strasse“ und angefangene
 * Formen („stra“, „straß“, „strass“) werden zu „str“ (passt als Teilwort). „Strand“ bleibt.
 */
export function directoryName(name: string): string {
	return (
		name
			// Kein `\b`: „ß“ zählt in JS-Regex nicht als Wortzeichen
			.replace(/stra(?:ß|ss?)?e?\.?(?![a-zäöüß])/gi, 'str')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * Passt ein Straßenname (ggf. mit Nummer) noch zur getippten Straße? „Heerstraße“ = „Heerstr.“,
 * ohne Groß-/Kleinschreibung, als Teilwort (wie das Straßenverzeichnis sucht).
 */
export function matchesStreetName(street: string, typedName: string): boolean {
	const want = directoryName(typedName).toLowerCase();
	return !want || directoryName(street).toLowerCase().includes(want);
}

/**
 * Hausnummer in einem Vorschlag tauschen (`street` = Straße + alte Nummer): für Weitertippen der
 * Nummer ohne neue Anfrage. Ohne alte Nummer wird die neue angehängt.
 */
export function withHouseNumber(street: string, oldNumber: string, newNumber: string): string {
	const base =
		oldNumber && street.endsWith(` ${oldNumber}`) ? street.slice(0, -oldNumber.length - 1) : street;
	return newNumber ? `${base} ${newNumber}` : base;
}
