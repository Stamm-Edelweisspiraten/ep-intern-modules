/**
 * Reine Datumsanzeige für Termin-Verweise (`EventRef`) in de-DE, ohne Abhängigkeiten.
 * `events/format.ts` braucht Uhrzeiten und gehört zu einem anderen Modul – daher hier kompakt:
 * - „12.07.2026“ (ein Tag)
 * - „12.–19.07.2026“ (gleicher Monat)
 * - „28.07.–02.08.2026“ (gleiches Jahr)
 * - „30.12.2026–02.01.2027“ (über den Jahreswechsel)
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `JJJJ-MM-TT` → „TT.MM.JJJJ“; ungültig → Eingabe unverändert */
export function formatRefDate(iso: string): string {
	const m = ISO.exec(iso);
	return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function formatRefRange(e: { startsOn: string; endsOn: string | null }): string {
	const s = ISO.exec(e.startsOn);
	const en = e.endsOn ? ISO.exec(e.endsOn) : null;
	if (!s) return e.startsOn;
	if (!en || e.endsOn === e.startsOn) return formatRefDate(e.startsOn);
	const [, sy, sm, sd] = s;
	const [, ey, em, ed] = en;
	if (sy === ey && sm === em) return `${sd}.–${ed}.${em}.${ey}`;
	if (sy === ey) return `${sd}.${sm}.–${ed}.${em}.${ey}`;
	return `${formatRefDate(e.startsOn)}–${formatRefDate(e.endsOn!)}`;
}
