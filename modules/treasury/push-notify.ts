/**
 * Push an die mit den Mitgliedern verknüpften Konten (zusätzlich zu den Mails an die Kontaktadressen,
 * die unverändert bleiben). Typen sind `pushOnly` und standardmäßig aus – wer sie will, schaltet sie im
 * Profil unter „Benachrichtigungen“ ein. Keine IBAN, nur Rechnungsnummer, Betrag und Fälligkeit. Wirft nie.
 */
import { formatEuro } from '$lib/components/layout/money';
import { bestEffort, core, formatDateDe, type NotificationItem } from '$lib/sdk/server';
import { membersService, type RawInvoice } from './db';
import { invoiceTotals, lineOpen } from './logic';
import { MODULE_ID } from './schemas';

export const PUSH_PAYMENT_CONFIRMATION = 'payment-confirmation';
export const PUSH_INVOICE = 'invoice';
export const PUSH_REMINDER = 'reminder';

const num = (v: unknown) => Number(v ?? 0);

/** Mitglieder einer Rechnung (Posten und Jahresbeitrags-Aufschlüsselung) */
function memberIdsOf(inv: RawInvoice): string[] {
	const ids = new Set<string>();
	for (const l of inv.lines) if (l.member_id) ids.add(String(l.member_id));
	for (const a of inv.annualItems) if (a.member_id) ids.add(String(a.member_id));
	return [...ids];
}

function amounts(inv: RawInvoice) {
	return inv.lines.map((l) => ({
		amountCents: num(l.amount_cents),
		waivedCents: num(l.waived_cents),
		paidCents: num(l.paid_cents)
	}));
}

function openCents(inv: RawInvoice): number {
	return amounts(inv).reduce((s, a) => s + lineOpen(a), 0);
}

type Kind = typeof PUSH_PAYMENT_CONFIRMATION | typeof PUSH_INVOICE | typeof PUSH_REMINDER;

function itemFor(kind: Kind, inv: RawInvoice, userIds: string[]): NotificationItem {
	const number = String(inv.row.number);
	const name = String(inv.row.recipient_name);
	const due = formatDateDe(String(inv.row.due_on));
	if (kind === PUSH_PAYMENT_CONFIRMATION) {
		const paid = invoiceTotals(amounts(inv), false).paidCents;
		return {
			type: kind,
			userIds,
			title: `Zahlung eingegangen: Rechnung ${number}`,
			body: `Danke! Die Rechnung ${number} für ${name} ist vollständig bezahlt (${formatEuro(paid)}).`,
			link: '/dashboard'
		};
	}
	if (kind === PUSH_REMINDER) {
		return {
			type: kind,
			userIds,
			title: `Zahlungserinnerung: Rechnung ${number}`,
			body: `Für ${name} sind noch ${formatEuro(openCents(inv))} offen (fällig seit ${due}). Die Zahlungsdaten stehen in der E-Mail.`,
			link: '/dashboard'
		};
	}
	return {
		type: kind,
		userIds,
		title: `Neue Rechnung ${number}`,
		body: `Rechnung für ${name} über ${formatEuro(openCents(inv))}, fällig am ${due}. Die Rechnung kommt per E-Mail.`,
		link: '/dashboard'
	};
}

/** Je Rechnung ein Push an die verknüpften Konten ihrer Mitglieder */
export async function pushToLinkedAccounts(kind: Kind, invoices: RawInvoice[]): Promise<void> {
	if (!invoices.length) return;
	await bestEffort(`treasury.push.${kind}`, async () => {
		const byMember = await (
			await membersService()
		).listLinkedUserIds(invoices.flatMap(memberIdsOf));
		const items: NotificationItem[] = [];
		for (const inv of invoices) {
			const userIds = [...new Set(memberIdsOf(inv).flatMap((m) => byMember[m] ?? []))];
			if (userIds.length) items.push(itemFor(kind, inv, userIds));
		}
		if (items.length) {
			await core.notifications.send(core.auth.systemContext(MODULE_ID), MODULE_ID, items);
		}
	});
}
