import { describe, expect, it } from 'vitest';
import { VARIANT_COLUMN, VARIANT_SPECS, variantPath } from '$modules/galleries/files';
import { IMAGE_VARIANTS } from '$modules/galleries/schemas';

describe('galleries files (reine Teile)', () => {
	it('VARIANT_SPECS entspricht IMAGE_VARIANTS in gleicher Reihenfolge', () => {
		expect(VARIANT_SPECS.map((s) => s.name)).toEqual([...IMAGE_VARIANTS]);
	});

	it('Kantenlängen: thumb < web, full unbegrenzt', () => {
		const [thumb, web, full] = VARIANT_SPECS;
		expect(thumb!.maxEdge).toBeLessThan(web!.maxEdge!);
		expect(full!.maxEdge).toBeNull();
	});

	it('variantPath', () => {
		expect(variantPath('g1', 'i1', 'thumb', 'webp')).toBe('g1/i1-thumb.webp');
		expect(variantPath('g1', 'i1', 'full', 'jpg')).toBe('g1/i1-full.jpg');
	});

	it('VARIANT_COLUMN für jede Variante', () => {
		expect(Object.keys(VARIANT_COLUMN).sort()).toEqual([...IMAGE_VARIANTS].sort());
		for (const v of IMAGE_VARIANTS) expect(VARIANT_COLUMN[v]).toBe(`${v}_path`);
	});
});
