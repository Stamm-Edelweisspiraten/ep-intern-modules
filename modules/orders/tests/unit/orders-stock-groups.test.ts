import { describe, expect, it } from 'vitest';
import { groupStockRows, paginate } from '$modules/orders/pages/stock-groups';
import type { StockRow } from '$modules/orders/schemas';

function row(p: Partial<StockRow> & { articleId: string; variantId: string }): StockRow {
	return {
		articleTitle: p.articleId,
		variantLabel: '',
		priceCents: 1000,
		stock: 0,
		minStock: 0,
		demand: 0,
		inTransit: 0,
		deficit: 0,
		reorderUrl: null,
		articleActive: true,
		...p
	};
}

const rows: StockRow[] = [
	row({
		articleId: 'kluft',
		articleTitle: 'Kluft',
		variantId: 'k-s',
		variantLabel: 'S',
		stock: 3,
		minStock: 2,
		reorderUrl: 'https://a.example'
	}),
	row({
		articleId: 'kluft',
		articleTitle: 'Kluft',
		variantId: 'k-m',
		variantLabel: 'M',
		stock: 1,
		minStock: 2,
		demand: 2,
		deficit: 3,
		reorderUrl: 'https://a.example'
	}),
	row({
		articleId: 'kluft',
		articleTitle: 'Kluft',
		variantId: 'k-l',
		variantLabel: 'L',
		stock: 5,
		reorderUrl: 'https://a.example'
	}),
	row({ articleId: 'buch', articleTitle: 'Liederbuch', variantId: 'b', stock: 7 }),
	row({
		articleId: 'tuch',
		articleTitle: 'Halstuch',
		variantId: 't-1',
		variantLabel: 'Einheitsgröße',
		stock: 4
	})
];

describe('groupStockRows', () => {
	it('fasst Größen je Artikel zusammen und summiert', () => {
		const g = groupStockRows(rows);
		expect(g.map((x) => x.articleId)).toEqual(['kluft', 'buch', 'tuch']);
		const kluft = g[0]!;
		expect(kluft).toMatchObject({
			variantCount: 3,
			stock: 9,
			minStock: 4,
			demand: 2,
			deficit: 3,
			lowCount: 1,
			hasSizes: true,
			reorderUrl: 'https://a.example'
		});
		expect(g[1]!.hasSizes).toBe(false);
		// Eine benannte Größe zählt als Artikel mit Größen
		expect(g[2]!.hasSizes).toBe(true);
	});

	it('Nachbestelllink nur, wenn alle Größen denselben haben', () => {
		const mixed = [...rows];
		mixed[2] = { ...mixed[2]!, reorderUrl: 'https://b.example' };
		expect(groupStockRows(mixed)[0]!.reorderUrl).toBeNull();
	});

	it('Fehlmengen-Filter zeigt nur betroffene Größen, Summen bleiben vollständig', () => {
		const g = groupStockRows(rows, { onlyDeficit: true });
		expect(g).toHaveLength(1);
		expect(g[0]!.variants.map((v) => v.variantId)).toEqual(['k-m']);
		expect(g[0]!.stock).toBe(9);
	});

	it('Suche nach Titel liefert alle Größen, nach Größe nur die passende', () => {
		expect(groupStockRows(rows, { search: 'klu' })[0]!.variants).toHaveLength(3);
		const bySize = groupStockRows(rows, { search: 'einheit' });
		expect(bySize.map((x) => x.articleId)).toEqual(['tuch']);
		expect(groupStockRows(rows, { search: 'xyz' })).toEqual([]);
	});
});

describe('paginate', () => {
	const items = Array.from({ length: 45 }, (_, i) => i);
	it('liefert Ausschnitt und Bereich', () => {
		expect(paginate(items, 2, 20)).toMatchObject({ page: 2, pages: 3, from: 21, to: 40 });
		expect(paginate(items, 3, 20).items).toEqual([40, 41, 42, 43, 44]);
	});
	it('klemmt ungültige Seiten', () => {
		expect(paginate(items, 99, 20).page).toBe(3);
		expect(paginate(items, 0, 20).page).toBe(1);
		expect(paginate(items, Number.NaN, 20).page).toBe(1);
		expect(paginate([], 1, 20)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 });
	});
});
