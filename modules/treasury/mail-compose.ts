/** Setzt Kassen-Mails (Text + HTML) aus Vorlage, Rechnungen und Bankdaten zusammen (rein). */
import {
	formatDateDe,
	mailSubject,
	mailVars,
	renderTemplate,
	type BankData,
	type MailInvoice
} from './logic';
import { itemsTable, paymentBox, paymentText, templateToHtml } from './mail-html';

export interface ComposedMail {
	subject: string;
	text: string;
	html: string;
}

export function composeMail(p: {
	subjectTpl: string;
	bodyTpl: string;
	invoices: MailInvoice[];
	bank: BankData;
	/** `paid`: Bestätigung (ohne Zahlungskasten), `open`: Rechnung/Erinnerung */
	mode: 'paid' | 'open';
	level?: number;
	extraVars?: Record<string, string>;
}): ComposedMail {
	const base = mailVars({ invoices: p.invoices, bank: p.bank, level: p.level });
	const totalCents = p.invoices.reduce((s, i) => s + i.lines.reduce((a, l) => a + l.cents, 0), 0);
	const due = p.invoices.map((i) => i.dueOn).sort()[0];
	const pay = {
		bank: p.bank,
		amountCents: totalCents,
		purpose: base.verwendungszweck!,
		dueOn: due ? formatDateDe(due) : null
	};
	const vars = {
		...base,
		zahlung: p.mode === 'paid' ? '' : paymentText(pay),
		...(p.extraVars ?? {})
	};
	const items = p.invoices.flatMap((inv) =>
		inv.lines.map((l) => ({ ref: inv.number, label: l.description, cents: l.cents }))
	);
	const posten = itemsTable(items, p.mode === 'paid' ? 'Bezahlt' : 'Summe', totalCents);
	return {
		subject: mailSubject(p.subjectTpl, vars),
		text: renderTemplate(p.bodyTpl, vars)
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
		html: templateToHtml(p.bodyTpl, vars, {
			posten,
			zahlung: p.mode === 'paid' ? '' : paymentBox(pay),
			kontodaten: paymentBox(pay)
		})
	};
}
