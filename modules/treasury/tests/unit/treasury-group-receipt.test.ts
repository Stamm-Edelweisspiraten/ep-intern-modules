import { describe, expect, it } from 'vitest';
import { groupBy } from '$modules/treasury/logic';
import { detectContentType } from '$lib/sdk/server/file-response';

// Belegprüfung zentral über `detectContentType` (vorher eigene Kopie `detectReceiptType`, #33)
const detectReceiptType = detectContentType;

describe('groupBy', () => {
	it('gruppiert per Schlüssel und behält die Reihenfolge', () => {
		const m = groupBy(
			[
				{ k: 'a', v: 1 },
				{ k: 'b', v: 2 },
				{ k: 'a', v: 3 }
			],
			(x) => x.k
		);
		expect([...m.keys()]).toEqual(['a', 'b']);
		expect(m.get('a')!.map((x) => x.v)).toEqual([1, 3]);
		expect(groupBy([], () => 'x').size).toBe(0);
	});
});

describe('detectReceiptType', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	it('erkennt PDF, PNG, JPEG, WebP am Inhalt', () => {
		expect(detectReceiptType(enc('%PDF-1.7'))).toBe('application/pdf');
		expect(
			detectReceiptType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		).toBe('image/png');
		expect(detectReceiptType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(detectReceiptType(enc('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
	});
	it('lehnt anderes ab (HTML, leer, zu kurz)', () => {
		expect(detectReceiptType(enc('<html><script>'))).toBeNull();
		expect(detectReceiptType(new Uint8Array())).toBeNull();
		expect(detectReceiptType(enc('%PD'))).toBeNull();
	});
});
