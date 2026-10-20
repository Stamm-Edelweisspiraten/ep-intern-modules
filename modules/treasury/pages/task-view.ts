/**
 * Texte und Ziele der Kassen-Aufgaben (`Overview.tasks`) – für die Dashboard-Kachel „Aufgaben der Kasse“.
 * Gleiche Formulierungen wie `OverviewTab.svelte` (`taskView`); bei Änderungen beide mitziehen.
 */
import { formatEuro } from '$lib/components/layout/money';
import type { OverviewTask } from '../schemas';
import { fmtDate } from './helpers';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface TaskView {
	title: string;
	hint: string;
	action: string;
	/** Ziel in der Kasse */
	href: string;
}

/** Link auf den Bereich der Kasse (alte Tab-Namen löst `resolveLocation` auf) */
export function taskHref(t: OverviewTask): string {
	if (t.kind === 'bank-missing' || t.tab === null) return '/modules/treasury/settings';
	return `/modules/treasury?tab=${t.tab}`;
}

export function taskView(t: OverviewTask): TaskView {
	const money = t.cents != null ? ` (${formatEuro(t.cents)})` : '';
	const href = taskHref(t);
	switch (t.kind) {
		case 'bank-missing':
			return {
				title: 'Kontodaten fehlen',
				hint: 'Ohne Kontoinhaber und IBAN enthalten Rechnungen, Mails und Bestätigungen keine Zahlungsdaten.',
				action: 'Einstellungen öffnen',
				href
			};
		case 'unallocated':
			return {
				title: `${plural(t.count, 'Einnahme wartet', 'Einnahmen warten')} auf Zuordnung${money}`,
				hint: 'Ordne die Zahlung einer Rechnung zu, damit sie als bezahlt gilt.',
				action: 'Buchungen ansehen',
				href
			};
		case 'overdue':
			return {
				title: `${plural(t.count, 'Rechnung ist', 'Rechnungen sind')} überfällig${money}`,
				hint: 'Erinnerungen laufen automatisch; du kannst auch selbst erinnern.',
				action: 'Offene Posten',
				href
			};
		case 'payables-overdue':
			return {
				title: `${plural(t.count, 'Überweisung ist', 'Überweisungen sind')} überfällig${money}`,
				hint: 'Diese Auszahlungen sollten schnell raus.',
				action: 'Auszahlungen',
				href
			};
		case 'payables-no-iban':
			return {
				title: `${plural(t.count, 'Überweisung hat', 'Überweisungen haben')} keine IBAN${money}`,
				hint: 'Ohne IBAN lässt sich nicht überweisen.',
				action: 'Auszahlungen',
				href
			};
		case 'annual-draft':
			return {
				title: `Beitragslauf ${t.year} ist noch nicht versendet`,
				hint: t.date ? `Zahlungsfrist ${fmtDate(t.date)}.` : 'Sätze prüfen und Rechnungen senden.',
				action: 'Beitragslauf öffnen',
				href
			};
		case 'annual-scheduled':
			return {
				title: `Beitragslauf ${t.year} ist geplant`,
				hint: t.date ? `Versand am ${fmtDate(t.date)}.` : 'Der Versand ist geplant.',
				action: 'Ansehen',
				href
			};
		case 'annual-missing':
			return {
				title: `Für ${t.year} gibt es noch keinen Beitragslauf`,
				hint: 'Lege den Lauf an, wenn die Jahresbeiträge berechnet werden sollen.',
				action: 'Beitragslauf anlegen',
				href
			};
	}
}
