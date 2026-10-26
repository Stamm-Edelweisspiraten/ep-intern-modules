import { ApiClientError } from '$lib/sdk/client';
import { formatEuro } from '$lib/components/layout/money';
import { addDays, formatDateDe, formatDateTimeDe, todayBerlin } from '$lib/sdk/dates';
import type { BadgeVariant } from '$lib/components/ui/badge';
import type { InvoiceStatus, InvoiceSummary } from '../schemas';

export const BASE = '/modules/treasury';

export const fmtDate = (d: string | null | undefined): string => formatDateDe(d, '–');

export const fmtDateTime = (iso: string | null | undefined): string => formatDateTimeDe(iso, '–');

/** Betrag mit Vorzeichen (Ausgaben negativ) */
export function signedEuro(cents: number): string {
	return cents > 0 ? `+${formatEuro(cents)}` : formatEuro(cents);
}

/** Standardkonto (sonst erstes aktives) für die Vorbelegung */
export function defaultAccountId(accounts: import('../schemas').Account[]): string | null {
	const active = accounts.filter((a) => !a.archived);
	return (active.find((a) => a.isDefault) ?? active[0])?.id ?? null;
}

/** Heute in Europe/Berlin (`YYYY-MM-DD`) */
export const todayIso = (): string => todayBerlin();

export const addDaysIso = addDays;

/** Feldfehler aus Server-Details (Zod-Issues als Liste oder `{ issues }`) */
export function fieldErrorsFrom(details: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const list = Array.isArray(details)
		? details
		: (details as { issues?: unknown[] } | null)?.issues;
	if (Array.isArray(list)) {
		for (const i of list as { path?: (string | number)[]; message?: string }[]) {
			const key = (i.path ?? []).map(String).join('.');
			if (i.message && !out[key]) out[key] = i.message;
			const top = String(i.path?.[0] ?? '');
			if (top && i.message && !out[top]) out[top] = i.message;
		}
	}
	return out;
}

/** Zod-Issues (Client-Validierung) in Feldfehler */
export function issuesToErrors(issues: { path: PropertyKey[]; message: string }[]) {
	const out: Record<string, string> = {};
	for (const i of issues) {
		const key = i.path.map(String).join('.');
		if (!out[key]) out[key] = i.message;
		const top = String(i.path[0] ?? '');
		if (top && !out[top]) out[top] = i.message;
	}
	return out;
}

export const errorMessage = (e: unknown, fallback: string) =>
	e instanceof ApiClientError ? e.message : fallback;

export function statusVariant(s: Pick<InvoiceSummary, 'status' | 'overdue'>): BadgeVariant {
	if (s.status === 'cancelled') return 'outline';
	if (s.overdue) return 'destructive';
	if (s.status === 'paid') return 'secondary';
	return 'default';
}

export function statusText(s: Pick<InvoiceSummary, 'status' | 'overdue' | 'daysOverdue'>): string {
	const labels: Record<InvoiceStatus, string> = {
		open: 'Offen',
		partial: 'Teilweise bezahlt',
		paid: 'Bezahlt',
		cancelled: 'Storniert'
	};
	if (s.overdue) return `Überfällig (${s.daysOverdue} ${s.daysOverdue === 1 ? 'Tag' : 'Tage'})`;
	return labels[s.status];
}

/** Datei herunterladen/öffnen über die API (Session-Cookie) */
export async function openApiFile(path: string, download = false): Promise<void> {
	// Fenster synchron im Klick öffnen: nach dem fetch blockieren Handy-Browser (iOS Safari,
	// Android-Chrome) das Popup, die PDF-Ansicht blieb dann stumm aus.
	const win = download ? null : window.open('', '_blank');
	try {
		const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			throw new Error(body?.error?.message ?? 'Datei konnte nicht geladen werden');
		}
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const name =
			/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'datei';
		if (win && !win.closed) {
			win.opener = null;
			win.location.href = url;
		} else {
			const a = document.createElement('a');
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
		}
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch (e) {
		win?.close();
		throw e;
	}
}

export interface TreasuryPerms {
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

/** Gemeinsame Stammdaten, die die Kassenseite an ihre Tabs weitergibt */
export interface SharedData {
	accounts: import('../schemas').Account[];
	categories: import('../schemas').Category[];
	actions: { id: string; name: string }[];
	members: { id: string; name: string; emails: string[] }[];
	payers: import('../schemas').Payer[];
	perm: TreasuryPerms;
	/** steigt nach jeder Änderung – Tabs laden dann neu */
	version: number;
	/** Handy: Listen + Blätter; Tablet: Liste | Details; Desktop: Tabellen (unverändert) */
	layout?: import('$lib/components/layout').DeviceLayout;
}

/** Anzeigetitel einer Buchung; Umbuchungen mit Richtung */
export function transactionTitle(t: import('../schemas').Transaction): string {
	if (t.transferId) {
		const other = t.transferAccountName ?? t.counterparty ?? 'anderes Konto';
		return t.amountCents < 0 ? `Umbuchung nach ${other}` : `Umbuchung von ${other}`;
	}
	return t.counterparty ?? t.purpose ?? 'Buchung';
}
