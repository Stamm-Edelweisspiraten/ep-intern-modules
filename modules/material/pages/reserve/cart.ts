/**
 * Warenkorb zum Reservieren (rein, ohne Svelte): Zeilen nach Typ + Anzahl („3 beliebige Kohtenbahnen“)
 * oder konkrete Artikel („Kohtenbahn K1.1“, „Tampen“ × 5) plus Entwurf der Angaben (Zeitraum, Titel, Zweck).
 * Gespeichert in `sessionStorage` – Bearbeiten einer Reservierung nutzt einen eigenen Schlüssel.
 */
import {
	MAX_QUANTITY,
	MAX_TEXT,
	PURPOSES,
	isRealDate,
	type Catalog,
	type Purpose,
	type Reservation,
	type ReservationLineInput
} from '../../schemas';

export interface TypeCartLine {
	kind: 'type';
	typeId: string;
	name: string;
	thumbUrl: string | null;
	quantity: number;
}

export interface ItemCartLine {
	kind: 'item';
	itemId: string;
	name: string;
	code: string | null;
	thumbUrl: string | null;
	quantity: number;
	/** Anzahl des Artikels (Obergrenze); `null` = noch unbekannt (bis zum Abgleich mit dem Katalog) */
	max: number | null;
}

export type CartLine = TypeCartLine | ItemCartLine;

export interface CartDraft {
	lines: CartLine[];
	from: string;
	to: string;
	title: string;
	purpose: Purpose;
	actionId: string | null;
	groupId: string | null;
	notes: string;
}

export const CART_KEY = 'material.cart.v2';
/** Eigener Schlüssel beim Bearbeiten, damit der normale Entwurf erhalten bleibt */
export const editCartKey = (reservationId: string) => `material.cart.v2.edit.${reservationId}`;

/** Eindeutiger Schlüssel einer Zeile */
export const lineKey = (l: CartLine): string =>
	l.kind === 'type' ? `t:${l.typeId}` : `i:${l.itemId}`;

/** `JJJJ-MM-TT` + Tage (UTC-Rechnung, unabhängig von der Zeitzone) */
export function shiftDate(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Leerer Entwurf: heute bis heute + 2 */
export function emptyDraft(today: string): CartDraft {
	return {
		lines: [],
		from: today,
		to: shiftDate(today, 2),
		title: '',
		purpose: 'other',
		actionId: null,
		groupId: null,
		notes: ''
	};
}

function clampQty(n: unknown, max: number | null = null): number {
	const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1;
	const upper = Math.min(MAX_QUANTITY, max != null && max >= 1 ? max : MAX_QUANTITY);
	return Math.min(upper, Math.max(1, v));
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parseLine(v: unknown): CartLine | null {
	const o = v as Record<string, unknown> | null;
	if (!o || typeof o !== 'object') return null;
	if (o.kind === 'type' && typeof o.typeId === 'string' && o.typeId) {
		return {
			kind: 'type',
			typeId: o.typeId,
			name: str(o.name),
			thumbUrl: strOrNull(o.thumbUrl),
			quantity: clampQty(o.quantity)
		};
	}
	if (o.kind === 'item' && typeof o.itemId === 'string' && o.itemId) {
		const max = typeof o.max === 'number' && Number.isFinite(o.max) ? Math.floor(o.max) : null;
		return {
			kind: 'item',
			itemId: o.itemId,
			name: str(o.name),
			code: strOrNull(o.code),
			thumbUrl: strOrNull(o.thumbUrl),
			quantity: clampQty(o.quantity, max),
			max
		};
	}
	return null;
}

/**
 * Entwurf aus beliebigem JSON (tolerant: Unbrauchbares fällt auf den leeren Entwurf zurück).
 * Ohne `keepDates` rückt ein vergangener Zeitraum auf heute; beim Bearbeiten bleibt er (laufende Reservierung).
 */
export function parseDraft(
	raw: unknown,
	today: string,
	opts: { keepDates?: boolean } = {}
): CartDraft {
	const base = emptyDraft(today);
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== 'object') return base;
	const lines: CartLine[] = [];
	const seen = new Set<string>();
	for (const l of Array.isArray(o.lines) ? o.lines : []) {
		const line = parseLine(l);
		if (line && !seen.has(lineKey(line))) {
			seen.add(lineKey(line));
			lines.push(line);
		}
	}
	let from = typeof o.from === 'string' && isRealDate(o.from) ? o.from : base.from;
	let to = typeof o.to === 'string' && isRealDate(o.to) ? o.to : base.to;
	// Vergangener Entwurf → wieder ab heute
	if (!opts.keepDates) {
		if (to < today) {
			from = base.from;
			to = base.to;
		} else if (from < today) from = today;
	}
	if (to < from) to = from;
	const purpose = (PURPOSES as readonly string[]).includes(o.purpose as string)
		? (o.purpose as Purpose)
		: base.purpose;
	return {
		lines,
		from,
		to,
		title: str(o.title).slice(0, 150),
		purpose,
		actionId: strOrNull(o.actionId),
		groupId: strOrNull(o.groupId),
		notes: str(o.notes).slice(0, MAX_TEXT)
	};
}

/** Entwurf aus `sessionStorage` (`null`, wenn keiner da ist oder der Speicher fehlt) */
export function loadDraft(
	key: string,
	today: string,
	opts: { keepDates?: boolean } = {}
): CartDraft | null {
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) return null;
		return parseDraft(JSON.parse(raw), today, opts);
	} catch {
		return null;
	}
}

export function saveDraft(key: string, draft: CartDraft): void {
	try {
		sessionStorage.setItem(key, JSON.stringify(draft));
	} catch {
		// Speicher nicht verfügbar (privates Fenster o. Ä.) – Entwurf lebt nur im Speicher
	}
}

export function clearDraft(key: string): void {
	try {
		sessionStorage.removeItem(key);
	} catch {
		// siehe oben
	}
}

/** Zeile hinzufügen; gleicher Typ/Artikel → Anzahl addieren (Artikel höchstens bis zu seiner Anzahl) */
export function addLine(lines: readonly CartLine[], line: CartLine): CartLine[] {
	const key = lineKey(line);
	const existing = lines.find((l) => lineKey(l) === key);
	if (!existing) {
		const max = line.kind === 'item' ? line.max : null;
		return [...lines, { ...line, quantity: clampQty(line.quantity, max) }];
	}
	return lines.map((l) => {
		if (lineKey(l) !== key) return l;
		const max = l.kind === 'item' ? (line.kind === 'item' ? (line.max ?? l.max) : l.max) : null;
		const merged = { ...l, quantity: clampQty(l.quantity + line.quantity, max) };
		return merged.kind === 'item' ? { ...merged, max } : merged;
	});
}

export function setQuantity(lines: readonly CartLine[], key: string, quantity: number): CartLine[] {
	return lines.map((l) =>
		lineKey(l) === key
			? { ...l, quantity: clampQty(quantity, l.kind === 'item' ? l.max : null) }
			: l
	);
}

export function removeLine(lines: readonly CartLine[], key: string): CartLine[] {
	return lines.filter((l) => lineKey(l) !== key);
}

/** Summe aller Anzahlen */
export function cartCount(lines: readonly CartLine[]): number {
	return lines.reduce((s, l) => s + l.quantity, 0);
}

/**
 * Warenkorb mit dem Katalog abgleichen: Unbekanntes (archiviert, gelöscht) entfernen, Namen, Bilder und
 * Obergrenzen aktualisieren. `removed` enthält die Namen der entfernten Zeilen.
 */
export function reconcileCart(
	lines: readonly CartLine[],
	catalog: Pick<Catalog, 'entries'>
): { lines: CartLine[]; removed: string[]; changed: boolean } {
	const types = new Map<string, { name: string; thumbUrl: string | null }>();
	const items = new Map<
		string,
		{ name: string; code: string | null; thumbUrl: string | null; quantity: number }
	>();
	for (const e of catalog.entries) {
		if (e.kind === 'type') {
			types.set(e.id, { name: e.name, thumbUrl: e.thumbUrl });
			for (const i of e.items) {
				items.set(i.id, { name: i.name, code: i.code, thumbUrl: e.thumbUrl, quantity: i.quantity });
			}
		} else {
			items.set(e.id, { name: e.name, code: e.code, thumbUrl: e.thumbUrl, quantity: e.total });
		}
	}
	const removed: string[] = [];
	let changed = false;
	const next: CartLine[] = [];
	for (const l of lines) {
		if (l.kind === 'type') {
			const hit = types.get(l.typeId);
			if (!hit) {
				removed.push(l.name);
				continue;
			}
			const updated: TypeCartLine = { ...l, name: hit.name, thumbUrl: hit.thumbUrl };
			if (updated.name !== l.name || updated.thumbUrl !== l.thumbUrl) changed = true;
			next.push(updated);
		} else {
			const hit = items.get(l.itemId);
			if (!hit) {
				removed.push(l.name);
				continue;
			}
			const max = Math.max(1, hit.quantity);
			const updated: ItemCartLine = {
				...l,
				name: hit.name,
				code: hit.code,
				thumbUrl: hit.thumbUrl,
				max,
				quantity: clampQty(l.quantity, max)
			};
			if (
				updated.name !== l.name ||
				updated.code !== l.code ||
				updated.thumbUrl !== l.thumbUrl ||
				updated.max !== l.max ||
				updated.quantity !== l.quantity
			)
				changed = true;
			next.push(updated);
		}
	}
	return { lines: next, removed, changed: changed || removed.length > 0 };
}

/** Zeilen für die API */
export function toLines(lines: readonly CartLine[]): ReservationLineInput[] {
	return lines.map((l) =>
		l.kind === 'type'
			? { kind: 'type', typeId: l.typeId, quantity: l.quantity }
			: { kind: 'item', itemId: l.itemId, quantity: l.quantity }
	);
}

/** Bestehende Reservierung als Entwurf (Bearbeiten) */
export function fromReservation(r: Reservation): CartDraft {
	const lines: CartLine[] = [];
	for (const l of r.lines) {
		if (l.kind === 'type' && l.typeId) {
			lines.push({
				kind: 'type',
				typeId: l.typeId,
				name: l.name,
				thumbUrl: l.thumbUrl,
				quantity: clampQty(l.quantity)
			});
		} else if (l.kind === 'item' && l.itemId) {
			lines.push({
				kind: 'item',
				itemId: l.itemId,
				name: l.name,
				code: l.code,
				thumbUrl: l.thumbUrl,
				quantity: clampQty(l.quantity),
				max: null
			});
		}
	}
	return {
		lines,
		from: r.startsOn,
		to: r.endsOn,
		title: r.title,
		purpose: r.purpose,
		actionId: r.actionId,
		groupId: r.groupId,
		notes: r.notes.slice(0, MAX_TEXT)
	};
}

/** Zeilen-Anzahl, die ein konkreter Artikel schon im Warenkorb hat */
export function itemQuantityInCart(lines: readonly CartLine[], itemId: string): number {
	return lines.reduce((s, l) => (l.kind === 'item' && l.itemId === itemId ? s + l.quantity : s), 0);
}

/** Beliebige Anzahl eines Typs im Warenkorb */
export function typeQuantityInCart(lines: readonly CartLine[], typeId: string): number {
	return lines.reduce((s, l) => (l.kind === 'type' && l.typeId === typeId ? s + l.quantity : s), 0);
}
