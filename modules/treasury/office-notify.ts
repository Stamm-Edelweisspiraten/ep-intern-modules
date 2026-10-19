/**
 * Benachrichtigungen an das Amt „Kasse“ (Vorlage in `module.ts`, Modul `offices` optional).
 * Immer NACH der Transaktion aufrufen; Fehler werden nur geloggt (Abgleich/Endpunkte dürfen nie
 * daran scheitern). Keine Bankdaten (IBAN) in Betreff oder Text.
 */
import { formatEuro } from '$lib/components/layout/money';
import { core, type RequestContext } from '$lib/sdk/server';
import type { OfficeNotification, OfficesService } from '$lib/modules/offices/contract';
import type { AccountingClosedEvent } from './contract';
import { MODULE_ID, PAYABLE_SOURCE_LABELS, type PayableSource } from './schemas';

export const OFFICE_KEY = 'kasse';
export const PAYABLES_LINK = '/modules/treasury?tab=outgoing&view=payables';
export const ACCOUNTINGS_LINK = '/modules/treasury?tab=outgoing&view=accountings';

/** Neu angelegte Auszahlung (ohne Bankdaten) */
export interface CreatedPayableInfo {
	source: PayableSource;
	recipientName: string;
	amountCents: number;
	description: string;
	actionName: string | null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function payableNotification(p: CreatedPayableInfo): OfficeNotification {
	const lines = [
		`Art: ${PAYABLE_SOURCE_LABELS[p.source]}`,
		`Empfänger*in: ${p.recipientName}`,
		`Betrag: ${formatEuro(p.amountCents)}`,
		`Zweck: ${p.description}`
	];
	if (p.actionName) lines.push(`Aktion: ${p.actionName}`);
	return {
		module: MODULE_ID,
		office: OFFICE_KEY,
		event: 'payable-created',
		subject: clip(`Neue Überweisung: ${formatEuro(p.amountCents)} an ${p.recipientName}`, 150),
		text: clip(lines.join('\n'), 4000),
		link: PAYABLES_LINK
	};
}

export function accountingClosedNotification(info: AccountingClosedEvent): OfficeNotification {
	const what =
		info.kind === 'interim'
			? `Zwischenabrechnung Nr. ${info.number ?? '?'}`
			: 'Abrechnung abgeschlossen';
	const text =
		info.kind === 'interim'
			? `Für die Aktion „${info.actionName}“ wurde die Zwischenabrechnung Nr. ${info.number ?? '?'} erstellt. ` +
				'Enthaltene Auslagen stehen in der Kasse zur Auszahlung bereit.'
			: `Die Abrechnung der Aktion „${info.actionName}“ wurde abgeschlossen. ` +
				'Auslagen und Rückzahlungen stehen in der Kasse zur Auszahlung bereit.';
	return {
		module: MODULE_ID,
		office: OFFICE_KEY,
		event: 'accounting-closed',
		subject: clip(`${what}: ${info.actionName}`, 150),
		text: clip(text, 4000),
		link:
			info.kind === 'final'
				? `/modules/treasury/accountings/${encodeURIComponent(info.actionId)}`
				: ACCOUNTINGS_LINK
	};
}

/** Sendet Ereignisse an das Amt „Kasse“; ohne aktives `offices` passiert nichts. Wirft nie. */
export async function notifyKasse(
	ctx: RequestContext | null,
	items: OfficeNotification[]
): Promise<void> {
	if (!items.length) return;
	try {
		const offices = await core.modules.useOptional<OfficesService>('offices', MODULE_ID);
		if (!offices) return;
		await offices.notify(ctx ?? core.auth.systemContext('treasury-sync'), items);
	} catch (e) {
		console.error('[treasury] Benachrichtigung an das Amt „Kasse“ fehlgeschlagen:', e);
	}
}
