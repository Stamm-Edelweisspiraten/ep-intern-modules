import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
	codesMatch,
	countryName,
	formatLinkCode,
	generateLinkCode,
	generateLinkToken,
	isAdult,
	linkExpiry,
	linkUrl,
	recipientLines
} from '$modules/members/link';
import { linkClaimInput, linkLettersInput, linkRegisterInput } from '$modules/members/schemas';
import { mergePdfs } from '$testing';
import { renderBlocks } from '$testing';

const PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Verknüpfungscode', () => {
	it('hat immer 6 Ziffern (auch mit führenden Nullen)', () => {
		for (let i = 0; i < 500; i++) expect(generateLinkCode()).toMatch(/^\d{6}$/);
		expect(formatLinkCode('012345')).toBe('012 345');
	});

	it('Token: 32 Hex, verschieden', () => {
		const a = generateLinkToken();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(generateLinkToken()).not.toBe(a);
	});

	it('läuft nach 90 Tagen ab', () => {
		const now = new Date('2026-01-01T00:00:00Z');
		expect(linkExpiry(now).toISOString()).toBe('2026-04-01T00:00:00.000Z');
	});

	it('vergleicht Codes exakt', () => {
		expect(codesMatch('123456', '123456')).toBe(true);
		expect(codesMatch('123456', '123457')).toBe(false);
		expect(codesMatch('123456', '12345')).toBe(false);
	});

	it('Link ohne doppelte Schrägstriche', () => {
		expect(linkUrl('https://x.test/', 'abc')).toBe('https://x.test/p/members/verknuepfen/abc');
	});
});

describe('Adressfeld-Zeilen', () => {
	const today = new Date('2026-10-16T12:00:00Z');
	const base = {
		firstName: 'Max',
		lastName: 'Muster',
		birthDate: '2012-05-17',
		street: 'Musterweg 1',
		postalCode: '28357',
		city: 'Bremen',
		country: 'DE'
	};

	it('Minderjährige: „Eltern von …“ plus Straße und „PLZ Ort“', () => {
		expect(recipientLines(base, today)).toEqual([
			'Eltern von Max Muster',
			'Musterweg 1',
			'28357 Bremen'
		]);
	});

	it('Volljährige werden selbst angeschrieben (ab genau 18 Jahren)', () => {
		expect(recipientLines({ ...base, birthDate: '2007-07-04' }, today)[0]).toBe('Max Muster');
		expect(recipientLines({ ...base, birthDate: '2008-10-16' }, today)[0]).toBe('Max Muster');
		expect(recipientLines({ ...base, birthDate: '2008-10-17' }, today)[0]).toBe(
			'Eltern von Max Muster'
		);
		expect(isAdult('2008-10-16', today)).toBe(true);
		expect(isAdult('2008-10-17', today)).toBe(false);
		expect(isAdult('kaputt', today)).toBe(false);
	});

	it('Ausland: Land als letzte Zeile in Großbuchstaben', () => {
		const lines = recipientLines(
			{ ...base, country: 'AT', postalCode: '1010', city: 'Wien' },
			today
		);
		expect(lines.slice(-2)).toEqual(['1010 Wien', 'ÖSTERREICH']);
		expect(countryName('CH')).toBe('Schweiz');
	});

	it('höchstens 6 Zeilen à 60 Zeichen, Steuerzeichen entfernt', () => {
		const long = recipientLines(
			{
				...base,
				firstName: 'A'.repeat(80),
				street: Array.from({ length: 10 }, (_, i) => `Zeile ${i}`).join('\n')
			},
			today
		);
		expect(long).toHaveLength(6);
		for (const l of long) expect(l.length).toBeLessThanOrEqual(60);
		expect(recipientLines({ ...base, street: 'Weg\u0000 1' }, today)[1]).toBe('Weg 1');
	});
});

describe('Eingabe-Schemas', () => {
	it('Code: Leerzeichen/Bindestrich erlaubt, genau 6 Ziffern', () => {
		expect(linkClaimInput.parse({ code: '123 456' }).code).toBe('123456');
		expect(linkClaimInput.safeParse({ code: '12345' }).success).toBe(false);
		expect(linkClaimInput.safeParse({ code: 'abcdef' }).success).toBe(false);
		expect(linkClaimInput.safeParse({ code: '123456', extra: 1 }).success).toBe(false);
	});

	it('Registrierung: Passwort mindestens 12 Zeichen, E-Mail klein', () => {
		const ok = linkRegisterInput.parse({
			code: '123456',
			name: 'Eva',
			email: 'EVA@Example.Test',
			password: 'x'.repeat(12)
		});
		expect(ok.email).toBe('eva@example.test');
		expect(
			linkRegisterInput.safeParse({
				code: '123456',
				name: 'Eva',
				email: 'e@x.test',
				password: 'kurz'
			}).success
		).toBe(false);
	});

	it('Sammelbriefe: 1–100 eindeutige IDs', () => {
		const id = crypto.randomUUID();
		expect(linkLettersInput.parse({ ids: [id, id] }).ids).toEqual([id]);
		expect(linkLettersInput.safeParse({ ids: [] }).success).toBe(false);
		const many = Array.from({ length: 101 }, () => crypto.randomUUID());
		expect(linkLettersInput.safeParse({ ids: many }).success).toBe(false);
	});
});

describe('PDF-Bildblock und Zusammenführen', () => {
	it('rendert PNG-Bilder mit Breite in mm', () => {
		const html = renderBlocks([{ type: 'image', dataUrl: PNG, widthMm: 42, alt: 'QR <x>' }]);
		expect(html).toContain(`src="${PNG}"`);
		expect(html).toContain('width:42mm');
		expect(html).toContain('alt="QR &lt;x&gt;"');
	});

	it('lehnt fremde URLs, SVG und unsinnige Breiten ab', () => {
		const bad =
			(dataUrl: string, widthMm = 40) =>
			() =>
				renderBlocks([{ type: 'image', dataUrl, widthMm }]);
		expect(bad('https://evil.test/x.png')).toThrow();
		expect(bad('data:image/svg+xml;base64,PHN2Zz4=')).toThrow();
		expect(bad('data:image/png;base64,AAAA" onerror="x')).toThrow();
		expect(bad(PNG, 0)).toThrow();
		expect(bad(PNG, 500)).toThrow();
	});

	it('merge fügt die Seiten in Reihenfolge zusammen', async () => {
		const make = async (pages: number) => {
			const d = await PDFDocument.create();
			for (let i = 0; i < pages; i++) d.addPage([200, 300]);
			return d.save();
		};
		const out = await mergePdfs([await make(1), await make(2), await make(1)]);
		expect((await PDFDocument.load(out)).getPageCount()).toBe(4);
		await expect(mergePdfs([])).rejects.toThrow();
	});
});
