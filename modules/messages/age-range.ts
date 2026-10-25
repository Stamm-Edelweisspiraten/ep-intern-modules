/**
 * Altersangaben der Gruppen (Freitext auf der Website, z. B. „6 bis 10 Jahre“, „ab 15 Jahren“, „11–14“) lesen
 * und die passende Gruppe für ein Alter finden – für Probestunden-Anfragen.
 *
 * Rein, ohne Importe: `website/src/lib/age-range.ts` ist eine **Kopie** (die Website importiert nichts aus `src/`),
 * `tests/unit/messages-trial.test.ts` hält beide gleich.
 */

export interface AgeRange {
	/** kleinstes Alter (einschließlich) oder `null` = ohne Untergrenze */
	min: number | null;
	/** größtes Alter (einschließlich) oder `null` = ohne Obergrenze */
	max: number | null;
}

/** Freitext → Altersbereich; `null`, wenn keine Zahl erkennbar ist */
export function parseAgeRange(text: string | null | undefined): AgeRange | null {
	const t = String(text ?? '')
		.toLowerCase()
		.replace(/\s+/g, ' ');
	const span = /(\d{1,2})\s*(?:bis|-|–|—|und)\s*(\d{1,2})/.exec(t);
	if (span) {
		const a = Number(span[1]);
		const b = Number(span[2]);
		return { min: Math.min(a, b), max: Math.max(a, b) };
	}
	const from = /(?:ab|über|ueber)\s*(\d{1,2})/.exec(t) ?? /(\d{1,2})\s*\+/.exec(t);
	if (from) return { min: Number(from[1]), max: null };
	const to = /(?:bis|unter)\s*(\d{1,2})/.exec(t);
	if (to) return { min: null, max: Number(to[1]) - (/unter/.test(t) ? 1 : 0) };
	const one = /(\d{1,2})/.exec(t);
	if (one) return { min: Number(one[1]), max: Number(one[1]) };
	return null;
}

/** Abstand des Alters zum Bereich in Jahren (0 = passt) */
export function ageDistance(range: AgeRange, age: number): number {
	if (range.min != null && age < range.min) return range.min - age;
	if (range.max != null && age > range.max) return age - range.max;
	return 0;
}

/**
 * Gruppen, die zum Alter passen (Reihenfolge der Eingabe bleibt). Passt keine genau, die nächstgelegene(n),
 * `exact: false`. Gruppen ohne lesbare Altersangabe zählen nie.
 */
export function groupsForAge<T extends { ageRange: string | null }>(
	groups: T[],
	age: number
): { groups: T[]; exact: boolean } {
	const scored = groups
		.map((g) => ({ g, range: parseAgeRange(g.ageRange) }))
		.filter((x): x is { g: T; range: AgeRange } => x.range !== null)
		.map((x) => ({ g: x.g, d: ageDistance(x.range, age) }));
	if (!scored.length || !Number.isFinite(age)) return { groups: [], exact: false };
	const best = Math.min(...scored.map((x) => x.d));
	return { groups: scored.filter((x) => x.d === best).map((x) => x.g), exact: best === 0 };
}
