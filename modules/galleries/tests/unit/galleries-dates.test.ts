/**
 * Modul `galleries` (1.6.0): Zeitraum im Eingabeschema, Sortierhelfer und eindeutige ZIP-Dateinamen.
 */
import { describe, expect, it } from 'bun:test';
import { uniqueNames } from '$modules/galleries/download.endpoints';
import {
	compareGalleries,
	type GallerySortRow,
	gallerySortDate
} from '$modules/galleries/galleries.service';
import { galleryInput } from '$modules/galleries/schemas';

const base = { title: 'Lager', description: null, visibility: 'private', shares: [] };

describe('galleryInput: Zeitraum', () => {
	it('optional, leer → null', () => {
		const v = galleryInput.parse(base);
		expect(v.startsOn).toBeNull();
		expect(v.endsOn).toBeNull();
		const e = galleryInput.parse({ ...base, startsOn: '', endsOn: '' });
		expect(e.startsOn).toBeNull();
		expect(e.endsOn).toBeNull();
	});

	it('nimmt gültige Daten an (Ende = Start erlaubt)', () => {
		const v = galleryInput.parse({ ...base, startsOn: '2026-04-03', endsOn: '2026-04-03' });
		expect(v).toMatchObject({ startsOn: '2026-04-03', endsOn: '2026-04-03' });
	});

	it.each([
		[{ endsOn: '2026-04-03' }, 'endsOn'],
		[{ startsOn: '2026-04-03', endsOn: '2026-04-02' }, 'endsOn'],
		[{ startsOn: '2026-02-29' }, 'startsOn'],
		[{ startsOn: '03.04.2026' }, 'startsOn']
	])('lehnt %j ab (%s)', (over, path) => {
		const r = galleryInput.safeParse({ ...base, ...over });
		expect(r.success).toBe(false);
		expect(r.error!.issues.map((i) => i.path.join('.'))).toContain(path);
	});
});

const row = (over: Partial<GallerySortRow>): GallerySortRow => ({
	id: 'x',
	title: 'T',
	startsOn: null,
	createdOn: '2026-01-01',
	updatedMs: 0,
	eventStarts: [],
	...over
});

describe('Sortierung', () => {
	it('Sortierdatum: eigenes Datum > frühester Termin > Anlagedatum', () => {
		expect(gallerySortDate(row({ startsOn: '2025-01-01', eventStarts: ['2026-05-01'] }))).toBe(
			'2025-01-01'
		);
		expect(gallerySortDate(row({ eventStarts: ['2025-08-01', '2025-06-01'] }))).toBe('2025-06-01');
		expect(gallerySortDate(row({}))).toBe('2026-01-01');
	});

	it('neueste zuerst, Gleichstand: zuletzt geändert, dann Titel', () => {
		const a = row({ id: 'a', startsOn: '2025-01-01' });
		const b = row({ id: 'b', startsOn: '2025-03-01' });
		const c = row({ id: 'c', startsOn: '2025-03-01', updatedMs: 10 });
		const d = row({ id: 'd', startsOn: '2025-03-01', updatedMs: 10, title: 'A' });
		expect([a, b, c, d].sort(compareGalleries).map((r) => r.id)).toEqual(['d', 'c', 'b', 'a']);
	});
});

describe('uniqueNames', () => {
	it('bereinigt und nummeriert Duplikate ohne Groß-/Kleinschreibung', () => {
		expect(uniqueNames(['see.jpg', 'SEE.jpg', 'see.jpg', 'Übung 1.png', '../x.jpg'])).toEqual([
			'see.jpg',
			'SEE (2).jpg',
			'see (3).jpg',
			'Uebung_1.png',
			'x.jpg'
		]);
	});
});
