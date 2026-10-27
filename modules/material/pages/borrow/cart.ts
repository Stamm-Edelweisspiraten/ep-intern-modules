/**
 * Merkliste beim Ausleihen (rein, ohne Svelte): Artikel mit Menge und Zelte (Zelttyp × Anzahl).
 * Ein Zelt wird beim Reservieren in seine Teile als Artikel-Zeilen aufgelöst; gleiche Artikel aus
 * mehreren Zelten und direkt gewählte werden zusammengezählt.
 */
import { addDays } from '$lib/sdk/dates';
import type {
	ArticleKind,
	CatalogArticle,
	CatalogTemplate,
	LineAvailability,
	ReservationLineInput
} from '../../schemas';

export interface CartArticle {
	articleId: string;
	name: string;
	unitLabel: string;
	kind: ArticleKind;
	quantity: number;
}

export interface CartTentPart {
	articleId: string;
	articleName: string;
	quantity: number;
}

export interface CartTent {
	templateId: string;
	name: string;
	count: number;
	parts: CartTentPart[];
}

export interface Cart {
	articles: CartArticle[];
	tents: CartTent[];
}

export const MAX_CART_QUANTITY = 100_000;

export const emptyCart = (): Cart => ({ articles: [], tents: [] });

const whole = (n: number): number =>
	Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), MAX_CART_QUANTITY) : 0;

/** Menge eines Artikels setzen (0 entfernt ihn); neue Artikel kommen ans Ende */
export function setArticleQuantity(
	cart: Cart,
	article: Pick<CatalogArticle, 'id' | 'name' | 'unitLabel' | 'kind'>,
	quantity: number
): Cart {
	const q = whole(quantity);
	const exists = cart.articles.some((a) => a.articleId === article.id);
	let articles: CartArticle[];
	if (q === 0) articles = cart.articles.filter((a) => a.articleId !== article.id);
	else if (exists)
		articles = cart.articles.map((a) => (a.articleId === article.id ? { ...a, quantity: q } : a));
	else
		articles = [
			...cart.articles,
			{
				articleId: article.id,
				name: article.name,
				unitLabel: article.unitLabel,
				kind: article.kind,
				quantity: q
			}
		];
	return { ...cart, articles };
}

/** Anzahl eines Zelttyps setzen (0 entfernt ihn) */
export function setTentCount(
	cart: Cart,
	template: Pick<CatalogTemplate, 'id' | 'name' | 'parts'>,
	count: number
): Cart {
	const c = whole(count);
	const exists = cart.tents.some((t) => t.templateId === template.id);
	let tents: CartTent[];
	if (c === 0) tents = cart.tents.filter((t) => t.templateId !== template.id);
	else if (exists)
		tents = cart.tents.map((t) => (t.templateId === template.id ? { ...t, count: c } : t));
	else
		tents = [
			...cart.tents,
			{
				templateId: template.id,
				name: template.name,
				count: c,
				parts: template.parts.map((p) => ({ ...p }))
			}
		];
	return { ...cart, tents };
}

export const articleQuantity = (cart: Cart, articleId: string): number =>
	cart.articles.find((a) => a.articleId === articleId)?.quantity ?? 0;

export const tentCount = (cart: Cart, templateId: string): number =>
	cart.tents.find((t) => t.templateId === templateId)?.count ?? 0;

/** Wie viele Stück eines Artikels die Zelte belegen (optional ohne einen Zelttyp) */
export function usedByTents(cart: Cart, articleId: string, exceptTemplateId?: string): number {
	let sum = 0;
	for (const t of cart.tents) {
		if (t.templateId === exceptTemplateId) continue;
		for (const p of t.parts) if (p.articleId === articleId) sum += p.quantity * t.count;
	}
	return sum;
}

/** Gesamtmenge je Artikel (Zelt-Teile + direkt gewählte) */
export function articleTotals(cart: Cart): Map<string, number> {
	const out = new Map<string, number>();
	for (const t of cart.tents)
		for (const p of t.parts)
			out.set(p.articleId, (out.get(p.articleId) ?? 0) + p.quantity * t.count);
	for (const a of cart.articles) out.set(a.articleId, (out.get(a.articleId) ?? 0) + a.quantity);
	return out;
}

/**
 * Positionen für `POST /reservations` bzw. `/availability`: je Artikel eine Zeile (zusammengezählt),
 * Zelt-Teile zuerst in Zelt-Reihenfolge, danach direkt gewählte Artikel.
 */
export function cartLines(cart: Cart): (ReservationLineInput & { kind: 'article' })[] {
	return [...articleTotals(cart)]
		.filter(([, q]) => q > 0)
		.map(([articleId, quantity]) => ({ kind: 'article' as const, articleId, quantity }));
}

/** Höchstmenge für den Stepper eines Artikels: frei minus das, was Zelte schon belegen */
export function maxArticleQuantity(cart: Cart, articleId: string, free: number): number {
	return Math.max(0, whole(free) - usedByTents(cart, articleId));
}

/**
 * Höchstzahl für den Stepper eines Zelttyps: so viele, wie die freien Teile abzüglich der übrigen
 * Merkliste (andere Zelte + direkt gewählte Artikel) hergeben. `free` = frei je Artikel im Zeitraum.
 * Ohne bekannte freie Menge eines Teils gilt die Angabe des Zelttyps (`template.free`).
 */
export function maxTentCount(
	cart: Cart,
	template: Pick<CatalogTemplate, 'id' | 'parts' | 'free'>,
	free: ReadonlyMap<string, number>
): number {
	let max = whole(template.free);
	for (const p of template.parts) {
		const f = free.get(p.articleId);
		if (f === undefined || p.quantity <= 0) continue;
		const rest =
			whole(f) - usedByTents(cart, p.articleId, template.id) - articleQuantity(cart, p.articleId);
		max = Math.min(max, Math.max(0, Math.floor(rest / p.quantity)));
	}
	return max;
}

/**
 * Merkliste auf die freien Mengen begrenzen: erst Zelte (in Reihenfolge), dann direkt gewählte
 * Artikel mit dem Rest. Artikel ohne bekannte freie Menge bleiben unverändert.
 */
export function clampCart(cart: Cart, free: ReadonlyMap<string, number>): Cart {
	const rest = new Map<string, number>();
	for (const [id, f] of free) rest.set(id, whole(f));
	const tents: CartTent[] = [];
	for (const t of cart.tents) {
		let count = t.count;
		for (const p of t.parts) {
			const r = rest.get(p.articleId);
			if (r === undefined || p.quantity <= 0) continue;
			count = Math.min(count, Math.floor(r / p.quantity));
		}
		for (const p of t.parts) {
			const r = rest.get(p.articleId);
			if (r !== undefined) rest.set(p.articleId, r - p.quantity * count);
		}
		if (count > 0) tents.push(count === t.count ? t : { ...t, count });
	}
	const articles: CartArticle[] = [];
	for (const a of cart.articles) {
		const r = rest.get(a.articleId);
		const quantity = r === undefined ? a.quantity : Math.min(a.quantity, r);
		if (r !== undefined) rest.set(a.articleId, r - quantity);
		if (quantity > 0) articles.push(quantity === a.quantity ? a : { ...a, quantity });
	}
	return { articles, tents };
}

/** Freie Menge je Artikel aus dem Katalog */
export function freeFromCatalog(articles: readonly CatalogArticle[]): Map<string, number> {
	return new Map(articles.map((a) => [a.id, a.free]));
}

/** Freie Menge je Artikel aus der Verfügbarkeitsprüfung (Zeilen wie `cartLines`) */
export function freeFromAvailability(
	lines: readonly { articleId: string }[],
	result: readonly LineAvailability[]
): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of result) {
		const line = lines[r.index];
		if (line && r.available !== null) out.set(line.articleId, r.available);
	}
	return out;
}

export interface CartProblem {
	message: string;
	available: number | null;
}

/** Probleme der Verfügbarkeitsprüfung je Artikel (nur Zeilen mit `ok: false`) */
export function problemsByArticle(
	lines: readonly { articleId: string }[],
	result: readonly {
		index: number;
		ok?: boolean;
		message: string | null;
		available?: number | null;
	}[]
): Map<string, CartProblem> {
	const out = new Map<string, CartProblem>();
	for (const r of result) {
		const line = lines[r.index];
		if (!line || r.ok === true) continue;
		out.set(line.articleId, {
			message: r.message || 'Im Zeitraum nicht frei',
			available: r.available ?? null
		});
	}
	return out;
}

/** Zahl der Positionen und Gesamtstückzahl (für die Leiste) */
export function cartSummary(cart: Cart): { positions: number; items: number } {
	let items = 0;
	for (const v of articleTotals(cart).values()) items += v;
	return { positions: cart.articles.length + cart.tents.length, items };
}

export const isCartEmpty = (cart: Cart): boolean => !cart.articles.length && !cart.tents.length;

/** Kurztext der Teile: „4 × Kohtenbahn, 1 × Kohtenkreuz“ */
export const partsText = (parts: readonly CartTentPart[]): string =>
	parts.map((p) => `${p.quantity} × ${p.articleName}`).join(', ');

// --- Speicher -------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 500;
const isCount = (v: unknown): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_CART_QUANTITY;

/** Gespeicherte Merkliste robust einlesen (Ungültiges fällt weg) */
export function parseCart(raw: unknown): Cart {
	const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const articles: CartArticle[] = [];
	for (const a of Array.isArray(src.articles) ? src.articles : []) {
		const x = a as Record<string, unknown>;
		if (!isStr(x.articleId) || !isStr(x.name) || !isCount(x.quantity)) continue;
		if (articles.some((y) => y.articleId === x.articleId)) continue;
		articles.push({
			articleId: x.articleId,
			name: x.name,
			unitLabel: isStr(x.unitLabel) ? x.unitLabel : 'Stück',
			kind: x.kind === 'bulk' ? 'bulk' : 'unit',
			quantity: x.quantity
		});
	}
	const tents: CartTent[] = [];
	for (const t of Array.isArray(src.tents) ? src.tents : []) {
		const x = t as Record<string, unknown>;
		if (!isStr(x.templateId) || !isStr(x.name) || !isCount(x.count)) continue;
		if (tents.some((y) => y.templateId === x.templateId)) continue;
		const parts: CartTentPart[] = [];
		for (const p of Array.isArray(x.parts) ? x.parts : []) {
			const y = p as Record<string, unknown>;
			if (isStr(y.articleId) && isStr(y.articleName) && isCount(y.quantity))
				parts.push({ articleId: y.articleId, articleName: y.articleName, quantity: y.quantity });
		}
		if (parts.length) tents.push({ templateId: x.templateId, name: x.name, count: x.count, parts });
	}
	return { articles, tents };
}

// --- Zeitraum -------------------------------------------------------------------

/** Wochentag eines ISO-Datums (0 = Sonntag … 6 = Samstag) */
export function weekday(iso: string): number {
	return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/**
 * Kommendes Wochenende (Samstag–Sonntag) ab `today`: samstags dieses, sonntags das nächste.
 */
export function nextWeekend(today: string): { from: string; to: string } {
	const d = weekday(today);
	const from = addDays(today, (6 - d + 7) % 7);
	return { from, to: addDays(from, 1) };
}

/** Datum `JJJJ-MM-TT` gültig? */
export const isIsoDate = (v: string | null | undefined): v is string =>
	!!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
