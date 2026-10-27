/**
 * Reine Hilfen für die Ansicht einer Reservierung (Befund-Satz, Fortschritt je Position, relative Tage).
 * Ohne Svelte/DOM – genutzt von `ReservationView` und der Seite „Ausgabe & Rückgabe“.
 */
import { daysBetween, formatDateDe } from '$lib/sdk/dates';
import type { Reservation, ReservationLine } from '../../schemas';

/** „heute“, „morgen“, „in 3 Tagen“, „gestern“, „vor 4 Tagen“ */
export function relativeDay(date: string, today: string): string {
	const d = daysBetween(today, date);
	if (!Number.isFinite(d)) return formatDateDe(date);
	if (d === 0) return 'heute';
	if (d === 1) return 'morgen';
	if (d === -1) return 'gestern';
	return d > 0 ? `in ${d} Tagen` : `vor ${-d} Tagen`;
}

export function lineText(l: ReservationLine): string {
	if (l.kind === 'set') return `Set ${l.name}`;
	return l.name;
}

export interface LineProgress {
	/** Reserviert (Menge bzw. Stücke) */
	planned: number;
	issued: number;
	returned: number;
	unit: string;
}

/** Fortschritt einer Position: ausgegeben/zurück (Mengen über `issuedQty`, Stücke über die Zuordnung) */
export function lineProgress(r: Reservation, l: ReservationLine): LineProgress {
	if (l.articleKind === 'bulk') {
		return {
			planned: l.quantity,
			issued: l.issuedQty,
			returned: l.returnedQty,
			unit: l.unitLabel
		};
	}
	// `assignedCount` zählt ohne Kisteninhalt (Server); Rückgaben ebenso auf die Zeile begrenzen
	const mine = r.assigned.filter((a) => a.lineId === l.id);
	return {
		planned: l.quantity,
		issued: l.assignedCount,
		returned: Math.min(l.assignedCount, mine.filter((a) => a.returnedAt).length),
		unit: l.quantity === 1 ? 'Stück' : 'Stücke'
	};
}

/** Noch draußen: Stücke ohne Rückgabe */
export function outCount(r: Reservation): number {
	return r.assigned.filter((a) => !a.returnedAt).length;
}

/** Mengenartikel teilweise noch draußen */
export function bulkOut(r: Reservation): boolean {
	return r.lines.some((l) => l.articleKind === 'bulk' && l.issuedQty > l.returnedQty);
}

export type FindingTone = 'neutral' | 'warning' | 'destructive';

/** Ein Satz, was mit der Reservierung gerade los ist */
export function reservationFinding(
	r: Reservation,
	today: string
): { text: string; tone: FindingTone } {
	const out = outCount(r);
	const outText =
		out > 0 ? ` ${out === 1 ? 'Ein Stück ist' : `${out} Stücke sind`} noch draußen.` : '';
	switch (r.status) {
		case 'cancelled':
			return { text: 'Storniert – das Material ist wieder frei.', tone: 'neutral' };
		case 'returned':
			return {
				text: r.returnedAt
					? `Vollständig zurück seit ${formatDateDe(r.returnedAt)}.`
					: 'Vollständig zurück.',
				tone: 'neutral'
			};
		case 'issued': {
			if (r.overdue) {
				const days = -daysBetween(today, r.endsOn);
				return {
					text: `Rückgabe überfällig seit ${days === 1 ? 'einem Tag' : `${days} Tagen`} (fällig am ${formatDateDe(r.endsOn)}).${outText}`,
					tone: 'destructive'
				};
			}
			const due = relativeDay(r.endsOn, today);
			return {
				text: `Ausgegeben${r.issuedAt ? ` am ${formatDateDe(r.issuedAt)}` : ''}, zurück bis ${formatDateDe(r.endsOn)} (${due}).${outText}`,
				tone: r.endsOn === today ? 'warning' : 'neutral'
			};
		}
		case 'reserved': {
			const d = daysBetween(today, r.startsOn);
			if (d < 0) {
				return {
					text: `Beginn war am ${formatDateDe(r.startsOn)} – noch nicht ausgegeben.`,
					tone: 'warning'
				};
			}
			return {
				text: `Reserviert, Ausgabe ${d === 0 ? 'heute' : `${relativeDay(r.startsOn, today)} (${formatDateDe(r.startsOn)})`}.`,
				tone: 'neutral'
			};
		}
	}
}
