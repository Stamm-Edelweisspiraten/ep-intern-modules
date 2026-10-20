import { ApiClientError } from '$lib/sdk/client';
import { formatEuro } from '$lib/components/layout/money';
import type { BadgeVariant } from '$lib/components/ui/badge';
import type { InvoiceStatus, InvoiceSummary } from '../schemas';

export const BASE = '/modules/treasury';

export function fmtDate(d: string | null | undefined): string {
	if (!d) return '–';
	const [y, m, day] = d.slice(0, 10).split('-');
	return `${day}.${m}.${y}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
	if (!iso) return '–';
	return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Betrag mit Vorzeichen (Ausgaben negativ) */
export function signedEuro(cents: number): string {
	return cents > 0 ? `+${formatEuro(cents)}` : formatEuro(cents);
}

/** Standardkonto (sonst erstes aktives) für die Vorbelegung */
export function defaultAccountId(accounts: import('../schemas').Account[]): string | null {
	const active = accounts.filter((a) => !a.archived);
	return (active.find((a) => a.isDefault) ?? active[0])?.id ?? null;
}

export const todayIso = (): string =>
	new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());

export function addDaysIso(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

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
	const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
		throw new Error(body?.error?.message ?? 'Datei konnte nicht geladen werden');
	}
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const name =
		/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'datei';
	if (download) {
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
	} else {
		window.open(url, '_blank', 'noopener');
	}
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
}

/** Anzeigetitel einer Buchung; Umbuchungen mit Richtung */
export function transactionTitle(t: import('../schemas').Transaction): string {
	if (t.transferId) {
		const other = t.transferAccountName ?? t.counterparty ?? 'anderes Konto';
		return t.amountCents < 0 ? `Umbuchung nach ${other}` : `Umbuchung von ${other}`;
	}
	return t.counterparty ?? t.purpose ?? 'Buchung';
}
