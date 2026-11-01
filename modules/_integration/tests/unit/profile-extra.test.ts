import { describe, expect, it } from 'vitest';
import { maskEmail } from '$testing';
import { allowedStartPages, resolveStartPage, safeDensity, safeHexColor } from '$testing';
import { invoiceAddresses, type NameMaps, type RawInvoice } from '$modules/treasury/db';

describe('maskEmail: Randfälle', () => {
	it('leer, nur @, mehrere @, Domain ohne Punkt', () => {
		expect(maskEmail('')).toBe('***');
		expect(maskEmail('@')).toBe('***');
		expect(maskEmail('a@b')).toBe('a***@b');
		expect(maskEmail('a@b@c.de')).toBe('a***@c.de');
	});
	it('gibt nie den lokalen Teil preis', () => {
		const out = maskEmail('geheim.name@example.org');
		expect(out).not.toContain('eheim');
		expect(out).toBe('g***@example.org');
	});
});

describe('Startseite/Farbe: Randfälle', () => {
	const nav = ['/modules/members'];
	it('Pfad-Tricks werden abgewiesen', () => {
		for (const bad of [
			'',
			'/',
			'//evil',
			'/dashboard/../admin',
			'/dashboard?x=1',
			'/dashboard#x',
			'/Dashboard',
			'\\\\evil',
			'/modules/members/'
		]) {
			expect(resolveStartPage(bad, nav), bad).toBe('/dashboard');
		}
	});
	it('allowedStartPages enthält immer Dashboard und Profil', () => {
		expect([...allowedStartPages([])].sort()).toEqual(['/dashboard', '/profile']);
	});
	it('safeHexColor: kein Zeilenumbruch am Ende, kein Nicht-String', () => {
		expect(safeHexColor('#aabbcc\n')).toBeNull();
		expect(safeHexColor(123456)).toBeNull();
		expect(safeHexColor(undefined)).toBeNull();
		expect(safeHexColor(['#aabbcc'])).toBeNull();
		expect(safeHexColor('#AABBCC')).toBe('#aabbcc');
	});
	it('safeDensity: nur exakt compact', () => {
		expect(safeDensity('Compact')).toBe('comfortable');
		expect(safeDensity(null)).toBe('comfortable');
		expect(safeDensity('compact')).toBe('compact');
	});
});

describe('invoiceAddresses: Mail-Abwahl', () => {
	const inv = (memberIds: (string | null)[], row: Record<string, unknown> = {}): RawInvoice => ({
		row,
		lines: memberIds.map((m) => ({ member_id: m })),
		annualItems: [],
		reminderLevel: 0,
		lastReminderAt: null,
		lastReminderOn: null
	});
	const names = (
		emails: Record<string, string[]>,
		optOut: Record<string, string[]> = {},
		payers: Record<string, { email: string }> = {}
	) =>
		({
			members: new Map(),
			memberEmails: new Map(Object.entries(emails)),
			memberMailOptOut: new Map(Object.entries(optOut)),
			actions: new Map(),
			payers: new Map(Object.entries(payers))
		}) as unknown as NameMaps;

	it('verbindliche Mail (ohne Kategorie) ignoriert jede Abwahl', () => {
		const n = names({ a: ['A@x.de'] }, { a: ['payment-confirmation', 'action-info'] });
		expect(invoiceAddresses(inv(['a']), n)).toEqual(['a@x.de']);
	});

	it('abgewähltes Mitglied liefert keine Adresse; Rechnungs-/Zahleradresse entfallen bei Totalabwahl', () => {
		const n = names(
			{ a: ['a@x.de'] },
			{ a: ['payment-confirmation'] },
			{ p1: { email: 'payer@x.de' } }
		);
		const i = inv(['a'], { recipient_email: 'rechnung@x.de', payer_id: 'p1' });
		expect(invoiceAddresses(i, n, 'payment-confirmation')).toEqual([]);
		expect(invoiceAddresses(i, n, 'action-info').sort()).toEqual(
			['a@x.de', 'payer@x.de', 'rechnung@x.de'].sort()
		);
	});

	it('Abwahl gilt nur für die jeweilige Kategorie', () => {
		const n = names({ a: ['a@x.de'] }, { a: ['action-info'] });
		expect(invoiceAddresses(inv(['a']), n, 'payment-confirmation')).toEqual(['a@x.de']);
		expect(invoiceAddresses(inv(['a']), n, 'action-info')).toEqual([]);
	});

	it('Geschwister: gemeinsame Adresse bleibt, solange ein Kind nicht abgewählt hat; Rechnungsadresse bleibt', () => {
		const n = names({ a: ['fam@x.de'], b: ['fam@x.de'] }, { a: ['payment-confirmation'] });
		const i = inv(['a', 'b'], { recipient_email: 'Rechnung@x.de' });
		expect(invoiceAddresses(i, n, 'payment-confirmation').sort()).toEqual([
			'fam@x.de',
			'rechnung@x.de'
		]);
	});

	it('beide Geschwister abgewählt -> keine Adresse, auch nicht Rechnungsadresse', () => {
		const n = names(
			{ a: ['fam@x.de'], b: ['fam@x.de'] },
			{ a: ['payment-confirmation'], b: ['payment-confirmation'] }
		);
		const i = inv(['a', 'b'], { recipient_email: 'r@x.de' });
		expect(invoiceAddresses(i, n, 'payment-confirmation')).toEqual([]);
	});

	it('Rechnung ohne Mitglied (manuell): Abwahl nicht anwendbar, Adresse bleibt', () => {
		const n = names({});
		const i = inv([], { recipient_email: 'r@x.de' });
		expect(invoiceAddresses(i, n, 'payment-confirmation')).toEqual(['r@x.de']);
	});

	it('Adressen werden kleingeschrieben und dedupliziert', () => {
		const n = names({ a: ['Fam@X.de'], b: ['fam@x.DE'] });
		expect(invoiceAddresses(inv(['a', 'b'], { recipient_email: 'FAM@x.de' }), n)).toEqual([
			'fam@x.de'
		]);
	});
});
