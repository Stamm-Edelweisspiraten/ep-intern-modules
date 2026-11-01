import { describe, expect, it } from 'vitest';
import { epcPayload } from '$modules/treasury/logic';
import { paymentBox, paymentText, templateToHtml } from '$modules/treasury/mail-html';
import { composeMail } from '$modules/treasury/mail-compose';

const bank = {
	holder: 'VCP Stamm',
	iban: 'DE02120300000000202051',
	bic: 'BYLADEM1001',
	name: 'Testbank'
};

describe('GiroCode (EPC)', () => {
	it('baut die Zeilen nach EPC 002', () => {
		const p = epcPayload({ ...bank, amountCents: 18500, purpose: 'R-2026-0001 Lena Müller' })!;
		expect(p.split('\n')).toEqual([
			'BCD',
			'002',
			'1',
			'SCT',
			'BYLADEM1001',
			'VCP Stamm',
			'DE02120300000000202051',
			'EUR185.00',
			'',
			'',
			'R-2026-0001 Lena Müller'
		]);
	});
	it('ohne IBAN, Empfänger oder Betrag kein Code; lange Texte gekürzt', () => {
		expect(epcPayload({ ...bank, iban: '', amountCents: 100, purpose: 'x' })).toBeNull();
		expect(epcPayload({ ...bank, holder: ' ', amountCents: 100, purpose: 'x' })).toBeNull();
		expect(epcPayload({ ...bank, amountCents: 0, purpose: 'x' })).toBeNull();
		const long = epcPayload({ ...bank, amountCents: 1, purpose: 'a'.repeat(300) })!;
		expect(long.split('\n')[10]).toHaveLength(140);
	});
});

describe('Mail-HTML', () => {
	it('escaped Nutzertexte und ersetzt Blockabsätze', () => {
		const html = templateToHtml(
			'Hallo <b>{name}</b>,\n\n{posten}\n\nGruß',
			{ name: '<script>' },
			{
				posten: '<table id="x"></table>'
			}
		);
		expect(html).toContain('&lt;b&gt;&lt;script&gt;&lt;/b&gt;');
		expect(html).toContain('<table id="x"></table>');
		expect(html).not.toContain('<script>');
	});
	it('Zahlungskasten mit allen Angaben bzw. Hinweis ohne Kontodaten', () => {
		const box = paymentBox({ bank, amountCents: 18500, purpose: 'R-1 Lena', dueOn: '30.06.2026' });
		for (const s of [
			'VCP Stamm',
			'DE02 1203 0000 0000 2020 51',
			'BYLADEM1001',
			'30.06.2026',
			'R-1 Lena'
		]) {
			expect(box).toContain(s);
		}
		expect(paymentText({ bank: { ...bank, iban: '' }, amountCents: 100, purpose: 'X' })).toContain(
			'bei der Kasse erfragen'
		);
	});
	it('composeMail: Bestätigung ohne, Erinnerung mit Zahlungskasten', () => {
		const invoices = [
			{
				number: 'R-1',
				recipientName: 'Lena',
				dueOn: '2026-06-30',
				lines: [{ description: 'Beitrag', cents: 18500 }]
			}
		];
		const paid = composeMail({
			subjectTpl: 'Danke',
			bodyTpl: 'Hallo,\n\n{posten}\n\n{zahlung}',
			invoices,
			bank,
			mode: 'paid'
		});
		expect(paid.html).not.toContain('Zahlungsinformationen');
		const open = composeMail({
			subjectTpl: '{stufe}. Erinnerung',
			bodyTpl: 'Hallo,\n\n{posten}\n\n{zahlung}',
			invoices,
			bank,
			mode: 'open',
			level: 2
		});
		expect(open.subject).toBe('2. Erinnerung');
		expect(open.html).toContain('Zahlungsinformationen');
		expect(open.text).toContain('IBAN: DE02 1203 0000 0000 2020 51');
		expect(open.text).toContain('Verwendungszweck: R-1 Lena');
	});
});
