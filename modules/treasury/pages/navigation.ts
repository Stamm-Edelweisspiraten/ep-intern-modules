// Aufbau der Kassen-Seite: wenige Bereiche nach Aufgaben, darin Unteransichten.
// Alte Tab-Namen (Links, Aufgaben der Übersicht, `?tab=payers`) werden hierüber umgeleitet.

export const SECTIONS = ['overview', 'income', 'outgoing', 'transactions', 'reports'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
	overview: 'Übersicht',
	income: 'Eingänge',
	outgoing: 'Ausgänge',
	transactions: 'Buchungen',
	reports: 'Berichte'
};

export const INCOME_VIEWS = ['open', 'invoices', 'families', 'annual'] as const;
export type IncomeView = (typeof INCOME_VIEWS)[number];
export const INCOME_VIEW_LABELS: Record<IncomeView, string> = {
	open: 'Offene Posten',
	invoices: 'Rechnungen',
	families: 'Familien',
	annual: 'Jahresbeitrag'
};

export const OUTGOING_VIEWS = ['payables', 'accountings'] as const;
export type OutgoingView = (typeof OUTGOING_VIEWS)[number];
export const OUTGOING_VIEW_LABELS: Record<OutgoingView, string> = {
	payables: 'Auszahlungen',
	accountings: 'Abrechnungen'
};

export interface TreasuryLocation {
	section: Section;
	/** Unteransicht in „Eingänge“/„Ausgänge“, sonst null */
	view: IncomeView | OutgoingView | null;
}

const LEGACY: Record<string, TreasuryLocation> = {
	open: { section: 'income', view: 'open' },
	invoices: { section: 'income', view: 'invoices' },
	annual: { section: 'income', view: 'annual' },
	payers: { section: 'income', view: 'families' },
	families: { section: 'income', view: 'families' },
	payables: { section: 'outgoing', view: 'payables' },
	accountings: { section: 'outgoing', view: 'accountings' }
};

/**
 * Bereich + Unteransicht aus `?tab=` und `?view=`. Akzeptiert auch alte Tab-Namen
 * (`open`, `invoices`, `annual`, `payers`, `payables`, `accountings`) als `tab`.
 */
export function resolveLocation(tab: string | null, view?: string | null): TreasuryLocation {
	if (tab && LEGACY[tab]) return LEGACY[tab];
	if (tab === 'income') {
		const v = (INCOME_VIEWS as readonly string[]).includes(view ?? '') ? view : 'open';
		return { section: 'income', view: v as IncomeView };
	}
	if (tab === 'outgoing') {
		const v = (OUTGOING_VIEWS as readonly string[]).includes(view ?? '') ? view : 'payables';
		return { section: 'outgoing', view: v as OutgoingView };
	}
	if (tab && (SECTIONS as readonly string[]).includes(tab)) {
		return { section: tab as Section, view: null };
	}
	return { section: 'overview', view: null };
}

/** Verweis auf eine Familie (Zahler) oder ein einzelnes Mitglied ohne Zahler */
export type FamilyRef = { payerId: string } | { memberId: string };

/** Rechte der Kassen-Seite (wird als `perm` an alle Bereiche gereicht) */
export interface TreasuryPerm {
	editTx: boolean;
	deleteTx: boolean;
	editInvoice: boolean;
	deleteInvoice: boolean;
	send: boolean;
	report: boolean;
	accounts: boolean;
	settings: boolean;
	upload: boolean;
	payable: boolean;
	bank: boolean;
}
