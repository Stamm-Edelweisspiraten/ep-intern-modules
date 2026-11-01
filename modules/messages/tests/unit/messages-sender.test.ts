import { describe, expect, it } from 'vitest';
import {
	dedupeAddresses,
	firstGivenName,
	isValidDomain,
	personalAddress,
	slugPart,
	splitFullName
} from '$modules/messages/sender';
import { htmlToText, sanitizeBody } from '$modules/messages/html';
import { formatSender } from '$testing';

describe('Absenderadresse vorname.nachname@domain', () => {
	const domain = 'Pfadfinder.example';

	it('nimmt nur den ersten Vornamen, Bindestrich-Namen bleiben', () => {
		expect(personalAddress({ firstName: 'Anna Maria', lastName: 'Müller', domain })).toBe(
			'anna.mueller@pfadfinder.example'
		);
		expect(personalAddress({ firstName: 'Anna-Lena', lastName: 'Schmidt', domain })).toBe(
			'anna-lena.schmidt@pfadfinder.example'
		);
		expect(firstGivenName('  Jan  Hendrik ')).toBe('Jan');
	});

	it('wandelt Umlaute, ß und Akzente in ASCII', () => {
		expect(slugPart('Jörg')).toBe('joerg');
		expect(slugPart('Weiß')).toBe('weiss');
		expect(slugPart('Zoë Çelik')).toBe('zoe-celik');
		expect(slugPart("O'Brien")).toBe('o-brien');
		expect(slugPart('  ')).toBe('');
	});

	it('mehrteilige Nachnamen werden mit Bindestrich verbunden', () => {
		expect(personalAddress({ firstName: 'Eva', lastName: 'von Berg', domain })).toBe(
			'eva.von-berg@pfadfinder.example'
		);
	});

	it('liefert null bei leerem Namen oder ungültiger Domain', () => {
		expect(personalAddress({ firstName: '', lastName: 'Müller', domain })).toBeNull();
		expect(personalAddress({ firstName: 'Anna', lastName: '', domain })).toBeNull();
		expect(personalAddress({ firstName: 'Anna', lastName: 'Müller', domain: '' })).toBeNull();
		expect(personalAddress({ firstName: 'Anna', lastName: 'Müller', domain: 'a@b.de' })).toBeNull();
		expect(personalAddress({ firstName: '😀', lastName: 'Müller', domain })).toBeNull();
	});

	it('Domain-Prüfung', () => {
		expect(isValidDomain('pfadfinder.de')).toBe(true);
		expect(isValidDomain('mail.stamm-x.example')).toBe(true);
		for (const bad of ['', 'de', 'a..de', '-a.de', 'a.de/pfad', 'a b.de', 'a@b.de']) {
			expect(isValidDomain(bad), bad).toBe(false);
		}
	});

	it('Ganzer Name ohne Mitglied: erstes und letztes Wort', () => {
		expect(splitFullName('Anna Maria Müller')).toEqual({ firstName: 'Anna', lastName: 'Müller' });
		expect(splitFullName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
		expect(splitFullName('  ')).toEqual({ firstName: '', lastName: '' });
	});
});

describe('Empfänger-Deduplizierung', () => {
	it('fasst Adressen ohne Rücksicht auf Groß-/Kleinschreibung zusammen, Reihenfolge bleibt', () => {
		const out = dedupeAddresses([
			{ address: 'A@x.de', n: 1 },
			{ address: 'b@x.de', n: 2 },
			{ address: 'a@X.de ', n: 3 }
		]);
		expect(out.map((o) => o.n)).toEqual([1, 2]);
	});
});

describe('Nachrichtentext bereinigen', () => {
	it('entfernt Skripte, Event-Handler und gefährliche Links, erhält einfache Formatierung', () => {
		const html = sanitizeBody(
			'<p onclick="x()">Hallo <strong>Welt</strong></p><script>alert(1)</script>' +
				'<img src=x onerror=alert(1)><a href="javascript:evil()">böse</a>' +
				'<a href="https://example.org/a?b=1&c=2">gut</a><iframe src="//x"></iframe>'
		);
		expect(html).toContain('<strong>Welt</strong>');
		expect(html).not.toMatch(/script|onclick|onerror|javascript:|<img|<iframe/i);
		expect(html).toContain('href="https://example.org/a?b=1&amp;c=2"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it('Klartext-Fassung: Absätze, Listen, Links', () => {
		const text = htmlToText(
			sanitizeBody(
				'<h2>Titel</h2><p>Erster &amp; zweiter</p><ul><li>Eins</li><li>Zwei</li></ul>' +
					'<p><a href="https://example.org">Zur Seite</a></p>'
			)
		);
		expect(text).toContain('Titel');
		expect(text).toContain('Erster & zweiter');
		expect(text).toContain('• Eins');
		expect(text).toContain('• Zwei');
		expect(text).toContain('Zur Seite (https://example.org)');
		expect(htmlToText('<p> </p>')).toBe('');
	});
});

describe('Absender-Kopfzeile (Header-Injection)', () => {
	it('formatiert Name und Adresse, entfernt Steuerzeichen und Anführungszeichen', () => {
		expect(formatSender('a@b.de', 'Anna "Chefin" <x>')).toBe('"Anna Chefin x" <a@b.de>');
		expect(formatSender('a@b.de')).toBe('a@b.de');
		expect(formatSender('a@b.de', 'Zeile1\r\nBcc: x@y.de')).not.toMatch(/[\r\n]/);
	});

	it('lehnt ungültige Adressen ab', () => {
		for (const bad of ['', 'a@b', 'a b@c.de', 'a@b.de\r\nBcc: x@y.de', '<a@b.de>']) {
			expect(() => formatSender(bad), bad).toThrow();
		}
	});
});
