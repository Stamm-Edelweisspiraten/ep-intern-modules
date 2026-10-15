import type { ActionSummary } from '../schemas';

export function fmtDate(iso: string): string {
	// Zeitstempel (ISO mit Uhrzeit) werden in lokaler Zeit als Datum ausgegeben
	if (iso.includes('T')) {
		const t = new Date(iso);
		if (!Number.isNaN(t.getTime())) return t.toLocaleDateString('de-DE');
	}
	const [y, m, d] = iso.split('-');
	return `${d}.${m}.${y}`;
}

/** "15.10.2026 09:00 – 17.10.2026 18:00 Uhr" */
export function fmtPeriod(
	a: Pick<ActionSummary, 'startsOn' | 'startsTime' | 'endsOn' | 'endsTime'>
): string {
	const start = `${fmtDate(a.startsOn)}${a.startsTime ? ` ${a.startsTime}` : ''}`;
	const end = a.endsOn ? `${fmtDate(a.endsOn)}${a.endsTime ? ` ${a.endsTime}` : ''}` : '';
	const out = end && end !== start ? `${start} – ${end}` : start;
	return a.startsTime || a.endsTime ? `${out} Uhr` : out;
}
