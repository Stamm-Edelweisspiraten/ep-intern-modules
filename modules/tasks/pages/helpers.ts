/** Kleine UI-Hilfen der Aufgaben-Seiten (ohne Server-Importe). */
import { ApiClientError } from '$lib/sdk/client';
import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
import { dueState, PRIORITY_LABELS, type Priority } from '../schemas';

export const BASE = '/modules/tasks';

export function errMsg(e: unknown, fallback: string): string {
	return e instanceof ApiClientError && e.message ? e.message : fallback;
}

/** Badge-Variante je Priorität (Farbe nie allein: der Text steht immer dabei) */
export function priorityVariant(p: Priority): 'destructive' | 'warning' | 'secondary' | 'outline' {
	if (p === 'urgent') return 'destructive';
	if (p === 'high') return 'warning';
	if (p === 'medium') return 'secondary';
	return 'outline';
}

export const priorityLabel = (p: Priority) => PRIORITY_LABELS[p];

/** „Heute“, „Morgen“, „Überfällig · 03.05.2027“, sonst Datum */
export function dueLabel(dueOn: string | null, done = false): string {
	if (!dueOn) return '';
	const state = dueState(dueOn, todayBerlin(), done);
	if (state === 'today') return 'Heute fällig';
	if (state === 'overdue') return `Überfällig · ${formatDateDe(dueOn)}`;
	const tomorrow = new Date(`${todayBerlin()}T00:00:00Z`);
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	if (dueOn === tomorrow.toISOString().slice(0, 10)) return 'Morgen fällig';
	return formatDateDe(dueOn);
}

/** Text-Klasse für die Fälligkeit (Status-Tokens) */
export function dueClass(dueOn: string | null, done = false): string {
	const state = dueState(dueOn, todayBerlin(), done);
	if (state === 'overdue') return 'text-destructive';
	if (state === 'today' || state === 'soon') return 'text-warning';
	return 'text-muted-foreground';
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return (
		((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() ||
		'?'
	);
}
