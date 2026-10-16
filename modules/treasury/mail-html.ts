/**
 * HTML-Bausteine fuer Kassen-Mails (rein): Postentabelle, Zahlungskasten und das Rendern der
 * (vom Nutzer pflegbaren) Textvorlage nach HTML. Ein Absatz, der nur aus `{posten}`, `{zahlung}`
 * oder `{kontodaten}` besteht, wird durch den passenden HTML-Block ersetzt; alles andere wird escaped.
 */
import { formatEuro } from '$lib/components/layout/money';
import { formatIban } from './iban';
import type { BankData } from './logic';

const FONT = "Calibri, Carlito, 'Segoe UI', Helvetica, Arial, sans-serif";

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export interface MailItem {
	/** z. B. Rechnungsnummer */
	ref: string;
	label: string;
	cents: number;
}

export function itemsTable(items: MailItem[], totalLabel: string, totalCents: number): string {
	const cell = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;';
	const rows = items
		.map(
			(i) => `<tr>
<td style="${cell}color:#6b7280;white-space:nowrap;">${escapeHtml(i.ref)}</td>
<td style="${cell}">${escapeHtml(i.label)}</td>
<td style="${cell}text-align:right;white-space:nowrap;">${escapeHtml(formatEuro(i.cents))}</td>
</tr>`
		)
		.join('');
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;font-family:${FONT};font-size:14px;">
<tbody>${rows}
<tr><td></td><td style="padding:10px;font-weight:700;">${escapeHtml(totalLabel)}</td>
<td style="padding:10px;font-weight:700;text-align:right;white-space:nowrap;">${escapeHtml(formatEuro(totalCents))}</td></tr>
</tbody></table>`;
}

export function hasBankData(b: BankData): boolean {
	return !!(b.iban && b.holder);
}

/** Zahlungskasten: Empfaenger, IBAN, BIC, Bank, Betrag, Faelligkeit, Verwendungszweck */
export function paymentBox(p: {
	bank: BankData;
	amountCents: number;
	purpose: string;
	dueOn?: string | null;
}): string {
	const rows: [string, string][] = hasBankData(p.bank)
		? [
				['Empfänger', p.bank.holder],
				['IBAN', formatIban(p.bank.iban)],
				...(p.bank.bic ? ([['BIC', p.bank.bic]] as [string, string][]) : []),
				...(p.bank.name ? ([['Bank', p.bank.name]] as [string, string][]) : []),
				['Betrag', formatEuro(p.amountCents)],
				...(p.dueOn ? ([['Bitte bis', p.dueOn]] as [string, string][]) : []),
				['Verwendungszweck', p.purpose]
			]
		: [
				['Betrag', formatEuro(p.amountCents)],
				['Verwendungszweck', p.purpose],
				['Kontodaten', 'bitte bei der Kasse erfragen']
			];
	const body = rows
		.map(
			([k, v]) => `<tr>
<td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
<td style="padding:4px 0;font-weight:${k === 'IBAN' || k === 'Verwendungszweck' || k === 'Betrag' ? 700 : 400};">${escapeHtml(v)}</td>
</tr>`
		)
		.join('');
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;margin:0 0 16px;background:#f3f4f6;border-radius:8px;font-family:${FONT};font-size:14px;">
<tr><td style="padding:14px 16px;">
<div style="font-weight:700;margin:0 0 6px;">Zahlungsinformationen</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${body}</table>
</td></tr></table>`;
}

export function paymentText(p: {
	bank: BankData;
	amountCents: number;
	purpose: string;
	dueOn?: string | null;
}): string {
	if (!hasBankData(p.bank)) {
		return `Betrag: ${formatEuro(p.amountCents)}\nVerwendungszweck: ${p.purpose}\nKontodaten bitte bei der Kasse erfragen.`;
	}
	return [
		`Empfänger: ${p.bank.holder}`,
		`IBAN: ${formatIban(p.bank.iban)}`,
		p.bank.bic && `BIC: ${p.bank.bic}`,
		p.bank.name && `Bank: ${p.bank.name}`,
		`Betrag: ${formatEuro(p.amountCents)}`,
		p.dueOn && `Bitte bis: ${p.dueOn}`,
		`Verwendungszweck: ${p.purpose}`
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Rendert eine Textvorlage nach HTML. `blocks` ersetzt ganze Absaetze (z. B. `{posten}`) durch HTML,
 * `vars` werden escaped eingesetzt. Unbekannte Platzhalter bleiben stehen.
 */
export function templateToHtml(
	tpl: string,
	vars: Record<string, string>,
	blocks: Record<string, string>
): string {
	return tpl
		.replace(/\r\n?/g, '\n')
		.trim()
		.split(/\n{2,}/)
		.map((para) => {
			const only = /^\s*\{([a-z]+)\}\s*$/.exec(para);
			if (only && blocks[only[1]!] !== undefined) return blocks[only[1]!];
			const text = escapeHtml(para).replace(/\{([a-z]+)\}/g, (m, k: string) =>
				vars[k] !== undefined ? escapeHtml(vars[k]!) : m
			);
			return `<p style="margin:0 0 16px;">${text.replace(/\n/g, '<br/>')}</p>`;
		})
		.join('');
}
