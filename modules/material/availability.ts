/**
 * Verfügbarkeit von Material in einem Zeitraum (rein, ohne Server-Imports – auch in der UI nutzbar).
 *
 * Modell: Jede andere Reservierung im Zeitraum belegt je Artikel
 *  - **konkrete Stücke** (Zeilen „Stück“, Stücke eines reservierten Sets, Inhalt reservierter Kisten,
 *    bereits ausgegebene Stücke) und
 *  - eine **Anzahl** ohne feste Stücke (Artikel-Zeilen, z. B. „8 Kohtenbahnen“), abzüglich der dazu schon
 *    zugeteilten Stücke.
 * Gerechnet wird je Kalendertag (Sweep); frei ist das Minimum über alle Tage des Zeitraums.
 */
import { addDays } from '$lib/sdk/dates';

export interface Booking {
	reservationId: string;
	startsOn: string;
	endsOn: string;
	/** Konkret belegte Stücke */
	unitIds: readonly string[];
	/** Je Artikel: angefragte Anzahl ohne feste Stücke (bereits um Zuteilungen gekürzt) */
	counts: ReadonlyMap<string, number>;
}

/** Überlappen sich zwei Zeiträume (inklusive Grenzen)? */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
	return aStart <= bEnd && bStart <= aEnd;
}

/** Alle Kalendertage von `from` bis `to` (inklusive), höchstens `max` */
export function daysOf(from: string, to: string, max = 400): string[] {
	const out: string[] = [];
	for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
	return out;
}

/** Stücke, die im Zeitraum durch andere Reservierungen konkret belegt sind (Stück-ID → Reservierungen) */
export function blockedUnits(
	bookings: readonly Booking[],
	from: string,
	to: string
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const b of bookings) {
		if (!overlaps(b.startsOn, b.endsOn, from, to)) continue;
		for (const id of b.unitIds) {
			const list = out.get(id);
			if (list) {
				if (!list.includes(b.reservationId)) list.push(b.reservationId);
			} else out.set(id, [b.reservationId]);
		}
	}
	return out;
}

/**
 * Freie Stücke eines Artikels (Einzelstücke) im Zeitraum.
 * `usable` = nutzbare Stück-IDs des Artikels; `mine` = eigene konkret gewählte Stücke (zählen nicht als frei).
 */
export function freeUnitCount(
	usable: readonly string[],
	articleId: string,
	bookings: readonly Booking[],
	from: string,
	to: string,
	mine: ReadonlySet<string> = new Set()
): number {
	const usableSet = new Set(usable);
	const relevant = bookings.filter((b) => overlaps(b.startsOn, b.endsOn, from, to));
	if (!relevant.length) return [...usableSet].filter((id) => !mine.has(id)).length;
	let free = Number.POSITIVE_INFINITY;
	for (const day of daysOf(from, to)) {
		const taken = new Set<string>();
		let counted = 0;
		for (const b of relevant) {
			if (!overlaps(b.startsOn, b.endsOn, day, day)) continue;
			for (const id of b.unitIds) if (usableSet.has(id)) taken.add(id);
			counted += b.counts.get(articleId) ?? 0;
		}
		for (const id of mine) if (usableSet.has(id)) taken.add(id);
		free = Math.min(free, usableSet.size - taken.size - counted);
	}
	return Math.max(0, free === Number.POSITIVE_INFINITY ? usableSet.size : free);
}

/** Freie Menge eines Mengenartikels im Zeitraum (Gesamtbestand − Reservierungen je Tag) */
export function freeQuantity(
	total: number,
	articleId: string,
	bookings: readonly Booking[],
	from: string,
	to: string
): number {
	const relevant = bookings.filter((b) => overlaps(b.startsOn, b.endsOn, from, to));
	let free = total;
	for (const day of relevant.length ? daysOf(from, to) : []) {
		let used = 0;
		for (const b of relevant) {
			if (overlaps(b.startsOn, b.endsOn, day, day)) used += b.counts.get(articleId) ?? 0;
		}
		free = Math.min(free, total - used);
	}
	return Math.max(0, free);
}
