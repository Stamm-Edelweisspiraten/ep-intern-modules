/**
 * Reine Logik der Seite „Ausgabe & Rückgabe“: Warteschlangen sortieren, Fälligkeit je Zeile, Befund-Satz.
 * Ohne Svelte/DOM.
 */
import { addDays, daysBetween } from '$lib/sdk/dates';
import type { ReservationListItem } from '../../schemas';

/** Ausgaben, die so viele Tage im Voraus erscheinen */
export const ISSUE_LOOKAHEAD_DAYS = 7;

export type Tone = 'neutral' | 'warning' | 'destructive';

/** Abfrage für „Ausgeben“: reserviert, Beginn bis heute + 7 Tage, noch nicht vorbei */
export function issueQuery(today: string): URLSearchParams {
	return new URLSearchParams({
		status: 'reserved',
		from: today,
		to: addDays(today, ISSUE_LOOKAHEAD_DAYS)
	});
}

/** Ausgaben: Beginn bis heute + 7 Tage, älteste zuerst */
export function sortIssueQueue(list: ReservationListItem[], today: string): ReservationListItem[] {
	const limit = addDays(today, ISSUE_LOOKAHEAD_DAYS);
	return list
		.filter((r) => r.status === 'reserved' && r.startsOn <= limit)
		.sort(
			(a, b) =>
				a.startsOn.localeCompare(b.startsOn) ||
				a.endsOn.localeCompare(b.endsOn) ||
				a.title.localeCompare(b.title, 'de')
		);
}

/** Rückgaben: überfällige zuerst, dann nach Fälligkeit */
export function sortReturnQueue(list: ReservationListItem[]): ReservationListItem[] {
	return list
		.filter((r) => r.status === 'issued')
		.sort(
			(a, b) =>
				Number(b.overdue) - Number(a.overdue) ||
				a.endsOn.localeCompare(b.endsOn) ||
				a.title.localeCompare(b.title, 'de')
		);
}

const days = (n: number) => (n === 1 ? 'einem Tag' : `${n} Tagen`);

/** Fälligkeit einer Zeile („heute“, „in 3 Tagen“, „überfällig seit 2 Tagen“) */
export function dueText(
	kind: 'issue' | 'return',
	r: ReservationListItem,
	today: string
): { text: string; tone: Tone } {
	if (kind === 'issue') {
		const d = daysBetween(today, r.startsOn);
		if (d < 0) return { text: `seit ${-d === 1 ? 'gestern' : `${-d} Tagen`}`, tone: 'warning' };
		if (d === 0) return { text: 'heute', tone: 'warning' };
		if (d === 1) return { text: 'morgen', tone: 'neutral' };
		return { text: `in ${d} Tagen`, tone: 'neutral' };
	}
	const d = daysBetween(today, r.endsOn);
	if (r.overdue || d < 0)
		return { text: `überfällig seit ${days(Math.max(1, -d))}`, tone: 'destructive' };
	if (d === 0) return { text: 'fällig heute', tone: 'warning' };
	if (d === 1) return { text: 'fällig morgen', tone: 'neutral' };
	return { text: `fällig in ${d} Tagen`, tone: 'neutral' };
}

export interface FindingPart {
	text: string;
	tone: Tone;
}

/**
 * Befund-Satz: „Heute 2 Ausgaben, 1 Rückgabe überfällig.“ – als Teile, damit Überfälliges farbig
 * (und in Worten) hervorgehoben werden kann.
 */
export function handoutFinding(
	issues: ReservationListItem[],
	returns: ReservationListItem[],
	today: string
): FindingPart[] {
	const issuesToday = issues.filter((r) => r.startsOn <= today).length;
	const returnsToday = returns.filter((r) => !r.overdue && r.endsOn === today).length;
	const overdue = returns.filter((r) => r.overdue).length;

	const todayParts: string[] = [];
	if (issuesToday) todayParts.push(`${issuesToday} ${issuesToday === 1 ? 'Ausgabe' : 'Ausgaben'}`);
	if (returnsToday)
		todayParts.push(`${returnsToday} ${returnsToday === 1 ? 'Rückgabe' : 'Rückgaben'}`);

	const parts: FindingPart[] = [];
	if (todayParts.length) parts.push({ text: `Heute ${todayParts.join(', ')}`, tone: 'neutral' });
	if (overdue) {
		parts.push({
			text: `${overdue} ${overdue === 1 ? 'Rückgabe' : 'Rückgaben'} überfällig`,
			tone: 'destructive'
		});
	}
	if (!parts.length) {
		const next = issues.find((r) => r.startsOn > today);
		const d = next ? daysBetween(today, next.startsOn) : null;
		return [
			{
				text:
					d === null
						? 'Heute steht nichts an.'
						: `Heute steht nichts an – nächste Ausgabe ${d === 1 ? 'morgen' : `in ${d} Tagen`}.`,
				tone: 'neutral'
			}
		];
	}
	return parts.map((p, i) => (i === parts.length - 1 ? { ...p, text: `${p.text}.` } : p));
}
