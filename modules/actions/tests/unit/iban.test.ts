import { describe, expect, it } from 'vitest';
import { ibanLast, isValidIban, maskFromLast, normalizeIban } from '$modules/actions/iban';

describe('isValidIban', () => {
	it.each([
		'DE89 3704 0044 0532 0130 00',
		'AT61 1904 3002 3457 3201',
		'CH93 0076 2011 6238 5295 7',
		'NL91 ABNA 0417 1643 00'
	])('akzeptiert %s', (iban) => {
		expect(isValidIban(iban)).toBe(true);
	});

	it('akzeptiert Kleinbuchstaben und fehlende/zusätzliche Leerzeichen', () => {
		expect(isValidIban('de89370400440532013000')).toBe(true);
		expect(isValidIban('  de89 3704 0044 0532 0130 00 ')).toBe(true);
	});

	it('lehnt falsche Prüfsumme ab', () => {
		expect(isValidIban('DE88 3704 0044 0532 0130 00')).toBe(false);
		expect(isValidIban('DE89 3704 0044 0532 0130 01')).toBe(false);
	});

	it('lehnt falsche Länge ab', () => {
		expect(isValidIban('DE89 3704 0044 0532 0130 0')).toBe(false);
		expect(isValidIban('DE89 3704 0044 0532 0130 000')).toBe(false);
	});

	it('lehnt Müll ab', () => {
		for (const v of ['', 'abc', '1234567890', 'DE', 'DE89!!!!', '%%%%%%%%%%%%%%%%%%%%%%']) {
			expect(isValidIban(v)).toBe(false);
		}
	});
});

describe('normalizeIban', () => {
	it('entfernt Trenner und macht groß', () => {
		expect(normalizeIban(' de89 3704-0044.0532 0130 00 ')).toBe('DE89370400440532013000');
	});
});

describe('Maskierung', () => {
	it('ibanLast: letzte Stellen normalisiert', () => {
		expect(ibanLast('de89 3704 0044 0532 0130 00')).toBe('013000');
		expect(ibanLast('DE89370400440532013000', 4)).toBe('3000');
	});

	it('maskFromLast: null/leer -> null, sonst gruppiert', () => {
		expect(maskFromLast(null)).toBeNull();
		expect(maskFromLast('')).toBeNull();
		expect(maskFromLast('013000')).toBe('•••• •••• •••• •••• 0130 00');
	});
});
