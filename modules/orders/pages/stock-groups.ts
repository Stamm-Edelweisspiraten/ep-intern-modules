/**
 * Lager-Ansicht: Varianten eines Artikels zu einer Gruppe zusammenfassen (Summen je Artikel),
 * filtern und seitenweise anzeigen. Rein, ohne Svelte – für Unit-Tests.
 */
import type { StockRow } from '../schemas';

export interface StockGroup {
	articleId: string;
	articleTitle: string;
	articleActive: boolean;
	/** Sichtbare Varianten (nach Filter), Reihenfolge wie vom Server */
	variants: StockRow[];
	/** Anzahl aller Varianten des Artikels (ohne Filter) */
	variantCount: number;
	stock: number;
	minStock: number;
	demand: number;
	inTransit: number;
	deficit: number;
	/** Varianten mit Bestand unter Mindestbestand */
	lowCount: number;
	/** Nachbestelllink, wenn alle Varianten denselben haben, sonst `null` */
	reorderUrl: string | null;
	/** Artikel mit Größen (mehr als eine Variante oder eine benannte Größe) */
	hasSizes: boolean;
}

export interface StockFilter {
	search?: string;
	onlyDeficit?: boolean;
}

/** Gruppiert die Zeilen je Artikel (Reihenfolge des ersten Auftretens) und wendet den Filter an. */
export function groupStockRows(rows: readonly StockRow[], filter: StockFilter = {}): StockGroup[] {
	const q = (filter.search ?? '').trim().toLowerCase();
	const byArticle = new Map<string, StockRow[]>();
	for (const r of rows) {
		const list = byArticle.get(r.articleId);
		if (list) list.push(r);
		else byArticle.set(r.articleId, [r]);
	}
	const groups: StockGroup[] = [];
	for (const [articleId, all] of byArticle) {
		const first = all[0]!;
		const titleHit = !q || first.articleTitle.toLowerCase().includes(q);
		const variants = all.filter(
			(r) =>
				(!filter.onlyDeficit || r.deficit > 0) &&
				(titleHit || r.variantLabel.toLowerCase().includes(q))
		);
		if (!variants.length) continue;
		const urls = new Set(all.map((r) => r.reorderUrl ?? ''));
		groups.push({
			articleId,
			articleTitle: first.articleTitle,
			articleActive: first.articleActive,
			variants,
			variantCount: all.length,
			stock: sum(all, 'stock'),
			minStock: sum(all, 'minStock'),
			demand: sum(all, 'demand'),
			inTransit: sum(all, 'inTransit'),
			deficit: sum(all, 'deficit'),
			lowCount: all.filter((r) => r.stock < r.minStock).length,
			reorderUrl: urls.size === 1 ? first.reorderUrl : null,
			hasSizes: all.length > 1 || first.variantLabel !== ''
		});
	}
	return groups;
}

function sum(
	rows: readonly StockRow[],
	key: 'stock' | 'minStock' | 'demand' | 'inTransit' | 'deficit'
) {
	return rows.reduce((s, r) => s + r[key], 0);
}

/** Seite (ab 1) auf den gültigen Bereich begrenzen und den Ausschnitt liefern. */
export function paginate<T>(
	items: readonly T[],
	page: number,
	pageSize: number
): { items: T[]; page: number; pages: number; from: number; to: number } {
	const pages = Math.max(1, Math.ceil(items.length / pageSize));
	const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
	const start = (p - 1) * pageSize;
	const slice = items.slice(start, start + pageSize);
	return {
		items: slice,
		page: p,
		pages,
		from: slice.length ? start + 1 : 0,
		to: start + slice.length
	};
}
