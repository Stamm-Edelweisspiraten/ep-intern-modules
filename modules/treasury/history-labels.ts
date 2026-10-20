/**
 * Verlauf (Historie) einer Rechnung, Buchung oder Auszahlung: Klartext zu Audit-Aktionen (rein, ohne Server-Importe).
 * Die Ausgabe enthält nie Namen, E-Mail-Adressen oder IBAN – nur Aktion, Zeit, Akteur und ggf. einen Betrag.
 */

export const HISTORY_KINDS = ['invoice', 'transaction', 'payable'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryEntry {
	id: string;
	/** ISO-Zeitstempel */
	at: string;
	/** Audit-Aktion, z. B. `treasury.invoice.cancelled` */
	action: string;
	/** Klartext, deutsch */
	label: string;
	/** Anzeigename des Akteurs (Benutzer/API-Key/System) */
	actor: string;
	/** Gehört zu einer verknüpften Buchung (nicht zur Rechnung selbst) */
	related: boolean;
}

const LABELS: Record<string, string> = {
	'treasury.invoice.created': 'Rechnung angelegt',
	'treasury.invoice.updated': 'Rechnung geändert',
	'treasury.invoice.deleted': 'Rechnung gelöscht',
	'treasury.invoice.cancelled': 'Rechnung storniert',
	'treasury.invoice.reactivated': 'Stornierung zurückgenommen',
	'treasury.invoice.line_updated': 'Ermäßigung geändert',
	'treasury.invoice.marked_paid': 'Zahlung erfasst',
	'treasury.transaction.created': 'Buchung angelegt',
	'treasury.transaction.updated': 'Buchung geändert',
	'treasury.transaction.deleted': 'Buchung gelöscht',
	'treasury.transaction.allocated': 'Zuordnung geändert',
	'treasury.transaction.receipt_uploaded': 'Beleg hochgeladen',
	'treasury.transaction.receipt_deleted': 'Beleg entfernt',
	'treasury.payable.created': 'Auszahlung angelegt',
	'treasury.payable.updated': 'Auszahlung geändert',
	'treasury.payable.cancelled': 'Auszahlung storniert oder wieder aufgenommen',
	'treasury.payable.deleted': 'Auszahlung gelöscht',
	'treasury.payable.paid': 'Auszahlung gebucht',
	'treasury.payable.linked': 'Auszahlung einer Buchung zugeordnet'
};

/** Nur Aktionen, die zu einem Verlauf gehören, werden ausgegeben */
export const HISTORY_ACTIONS = new Set(Object.keys(LABELS));

export function historyLabel(action: string, metadata?: Record<string, unknown> | null): string {
	const base = LABELS[action] ?? action;
	if (
		action === 'treasury.payable.cancelled' &&
		metadata &&
		typeof metadata.cancelled === 'boolean'
	) {
		return metadata.cancelled ? 'Auszahlung storniert' : 'Auszahlung wieder aufgenommen';
	}
	if (action === 'treasury.transaction.allocated' && metadata) {
		const lines = Number(metadata.lines);
		if (Number.isFinite(lines) && lines === 0) return 'Zuordnung aufgehoben';
	}
	return base;
}

/** Sichere Quelle für den Verlauf: ID-Format (UUID oder Standard-ID) */
export const HISTORY_ID = /^[A-Za-z0-9-]{1,64}$/;
