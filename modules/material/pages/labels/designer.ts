/**
 * Reine Rechenlogik des Etiketten-Designers (ohne DOM/Svelte): Einrasten, Verschieben, Größe per Griffen,
 * Mitskalieren beim Formatwechsel, Ebenen-Reihenfolge, neue Elemente und Rückgängig/Wiederholen.
 * Alle Maße in mm, gemessen von der oberen linken Ecke des Etiketts.
 */
import type { LabelElement, LabelElementType, LabelLayout, LabelLogo } from '$lib/sdk/labels';
import { LABEL_FIELDS, type LabelTarget } from '../../schemas';

/** CSS-Pixel je mm (96 dpi) – gleiche Einheit wie die `mm`-Angaben im PDF-HTML */
export const PX_PER_MM = 96 / 25.4;
/** Kleinste Elementgröße (wie `labelLayoutSchema`) */
export const MIN_SIZE_MM = 1;
/** Größte Elementanzahl (wie `labelLayoutSchema`) */
export const MAX_ELEMENTS = 40;

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Bounds {
	width: number;
	height: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Auf 0,01 mm runden (hält das JSON klein, vermeidet 0.30000000000000004) */
export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function clamp(v: number, min: number, max: number): number {
	if (!Number.isFinite(v)) return min;
	return Math.min(Math.max(v, min), Math.max(min, max));
}

/** Auf das Raster `step` einrasten (`step` ≤ 0 = frei, nur runden) */
export function snap(v: number, step: number): number {
	if (!Number.isFinite(v)) return 0;
	if (!(step > 0)) return round2(v);
	return round2(Math.round(v / step) * step);
}

/** Rahmen um `dx`/`dy` verschieben, einrasten und im Etikett halten */
export function moveBox(
	start: Box,
	dx: number,
	dy: number,
	opts: { step: number; bounds?: Bounds }
): Box {
	let x = snap(start.x + dx, opts.step);
	let y = snap(start.y + dy, opts.step);
	if (opts.bounds) {
		x = round2(clamp(x, 0, opts.bounds.width - start.w));
		y = round2(clamp(y, 0, opts.bounds.height - start.h));
	} else {
		x = Math.max(0, x);
		y = Math.max(0, y);
	}
	return { x, y, w: start.w, h: start.h };
}

/**
 * Größe über einen Griff ändern: die gezogenen Kanten rasten ein, die gegenüberliegenden bleiben stehen.
 * Mindestgröße `MIN_SIZE_MM`, Etikettgrenzen werden eingehalten. `keepAspect` (Ecken) hält das Seitenverhältnis.
 */
export function resizeBox(
	start: Box,
	handle: Handle,
	dx: number,
	dy: number,
	opts: { step: number; bounds?: Bounds; keepAspect?: boolean }
): Box {
	const W = opts.bounds?.width ?? Infinity;
	const H = opts.bounds?.height ?? Infinity;
	let left = start.x;
	let top = start.y;
	let right = start.x + start.w;
	let bottom = start.y + start.h;
	const west = handle.includes('w');
	const east = handle.includes('e');
	const north = handle.startsWith('n');
	const south = handle.startsWith('s');

	if (west) left = clamp(snap(left + dx, opts.step), 0, right - MIN_SIZE_MM);
	if (east) right = clamp(snap(right + dx, opts.step), left + MIN_SIZE_MM, W);
	if (north) top = clamp(snap(top + dy, opts.step), 0, bottom - MIN_SIZE_MM);
	if (south) bottom = clamp(snap(bottom + dy, opts.step), top + MIN_SIZE_MM, H);

	const corner = (west || east) && (north || south);
	if (opts.keepAspect && corner && start.w > 0 && start.h > 0) {
		const ratio = start.w / start.h;
		let w = right - left;
		let h = bottom - top;
		// Die stärker veränderte Seite führt
		if (Math.abs(w - start.w) / start.w >= Math.abs(h - start.h) / start.h) h = w / ratio;
		else w = h * ratio;
		// In den verfügbaren Raum ab der festen Ecke einpassen
		const maxW = west ? start.x + start.w : W - start.x;
		const maxH = north ? start.y + start.h : H - start.y;
		const fit = Math.min(1, maxW / w, maxH / h);
		w = Math.max(MIN_SIZE_MM, w * fit);
		h = Math.max(MIN_SIZE_MM, h * fit);
		if (west) left = right - w;
		else right = left + w;
		if (north) top = bottom - h;
		else bottom = top + h;
	}
	return {
		x: round2(left),
		y: round2(top),
		w: round2(right - left),
		h: round2(bottom - top)
	};
}

/** Pfeiltasten: um `step` (mindestens 0,5 mm) verschieben */
export function nudge(box: Box, key: string, step: number, bounds?: Bounds): Box | null {
	const s = step > 0 ? step : 0.5;
	const d: Record<string, [number, number]> = {
		ArrowLeft: [-s, 0],
		ArrowRight: [s, 0],
		ArrowUp: [0, -s],
		ArrowDown: [0, s]
	};
	const v = d[key];
	if (!v) return null;
	// Ohne Einrasten verschieben, damit krumme Positionen schrittweise erhalten bleiben
	return moveBox(box, v[0], v[1], { step: 0, bounds });
}

/**
 * Layout auf eine neue Etikettgröße umrechnen: Positionen/Größen je Achse, Schrift und Linien mit dem
 * kleineren Faktor (bleibt lesbar und proportional).
 */
export function scaleLayout(layout: LabelLayout, width: number, height: number): LabelLayout {
	const sx = layout.widthMm > 0 ? width / layout.widthMm : 1;
	const sy = layout.heightMm > 0 ? height / layout.heightMm : 1;
	const s = Math.min(sx, sy);
	return {
		widthMm: round2(width),
		heightMm: round2(height),
		elements: layout.elements.map((el) => {
			const box = {
				x: round2(el.x * sx),
				y: round2(el.y * sy),
				w: round2(Math.max(MIN_SIZE_MM, el.w * sx)),
				h: round2(Math.max(MIN_SIZE_MM, el.h * sy))
			};
			switch (el.type) {
				case 'text':
					return { ...el, ...box, fontSizePt: round1(clamp(el.fontSizePt * s, 4, 96)) };
				case 'rect':
					return {
						...el,
						...box,
						stroke: round2(clamp(el.stroke * s, 0, 5)),
						radius: round2(clamp(el.radius * s, 0, 50))
					};
				case 'line':
					return { ...el, ...box, stroke: round2(clamp(el.stroke * s, 0.1, 5)) };
				default:
					return { ...el, ...box };
			}
		})
	};
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Elemente, die (teilweise) über den Rand des Etiketts ragen */
export function overflowing(layout: LabelLayout): LabelElement[] {
	const eps = 0.01;
	return layout.elements.filter(
		(el) =>
			el.x < -eps ||
			el.y < -eps ||
			el.x + el.w > layout.widthMm + eps ||
			el.y + el.h > layout.heightMm + eps
	);
}

export type LayerMove = 'front' | 'back' | 'forward' | 'backward';

/** Ebenen-Reihenfolge ändern (spätere Elemente liegen oben) */
export function reorder(elements: LabelElement[], id: string, move: LayerMove): LabelElement[] {
	const i = elements.findIndex((e) => e.id === id);
	if (i < 0) return elements;
	const list = [...elements];
	const [el] = list.splice(i, 1);
	const target =
		move === 'front'
			? list.length
			: move === 'back'
				? 0
				: move === 'forward'
					? Math.min(list.length, i + 1)
					: Math.max(0, i - 1);
	list.splice(target, 0, el!);
	return list;
}

let counter = 0;
/** Kurze, eindeutige Element-ID (≤ 40 Zeichen) */
export function newElementId(): string {
	counter = (counter + 1) % 1_000_000;
	return `el-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Ein neues Element mit sinnvoller Größe, mittig im Etikett */
export function createElement(
	type: LabelElementType,
	layout: Pick<LabelLayout, 'widthMm' | 'heightMm'>,
	opts: {
		target?: LabelTarget;
		logo?: LabelLogo;
		/** Logo in Schwarz-Weiß */
		monochrome?: boolean;
		/** Linie: waagerecht (Standard) oder senkrecht */
		orientation?: 'horizontal' | 'vertical';
	} = {}
): LabelElement {
	const W = layout.widthMm;
	const H = layout.heightMm;
	const center = (w: number, h: number): Box => {
		const bw = round2(clamp(w, MIN_SIZE_MM, W));
		const bh = round2(clamp(h, MIN_SIZE_MM, H));
		return { x: round2((W - bw) / 2), y: round2((H - bh) / 2), w: bw, h: bh };
	};
	const id = newElementId();
	const hasName = (LABEL_FIELDS[opts.target ?? 'item'] ?? []).some((f) => f.key === 'name');
	switch (type) {
		case 'text':
			return {
				id,
				type,
				...center(W * 0.8, Math.min(8, H)),
				text: hasName ? '{name}' : '{code}',
				fontSizePt: 11,
				bold: false,
				align: 'left',
				valign: 'middle',
				maxLines: 1
			};
		case 'barcode': {
			const side = Math.min(W, H) * 0.6;
			return { id, type, ...center(side, side), symbology: 'qrcode', value: '{url}' };
		}
		case 'image': {
			const side = Math.min(W, H) * 0.3;
			const el = { id, type, ...center(side, side), logo: opts.logo ?? 'wappen' } as const;
			return opts.monochrome ? { ...el, monochrome: true } : el;
		}
		case 'rect':
			return { id, type, x: 0, y: 0, w: W, h: H, stroke: 0.3, radius: 1, filled: false };
		case 'line': {
			if (opts.orientation === 'vertical') {
				// Schmal und fast so hoch wie das Etikett (Rand je 2 mm, bei sehr kleinen Etiketten weniger)
				const margin = Math.min(2, H * 0.1);
				return {
					id,
					type,
					...center(MIN_SIZE_MM, H - 2 * margin),
					stroke: 0.3,
					orientation: 'vertical'
				};
			}
			return {
				id,
				type,
				...center(W * 0.8, MIN_SIZE_MM),
				stroke: 0.3,
				orientation: 'horizontal'
			};
		}
	}
}

/** Kopie eines Elements, leicht versetzt */
export function duplicateElement(el: LabelElement, bounds?: Bounds): LabelElement {
	const moved = moveBox(el, 2, 2, { step: 0, bounds });
	return { ...el, ...moved, id: newElementId() };
}

/** Millimeter deutsch mit höchstens zwei Nachkommastellen („63,5“) */
export function formatMm(n: number): string {
	return n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

/** Etikettgröße „63,5 × 33,9 mm“ */
export function formatSize(f: { labelWidthMm: number; labelHeightMm: number }): string {
	return `${formatMm(f.labelWidthMm)} × ${formatMm(f.labelHeightMm)} mm`;
}

/** Beispielwerte eines Ziels für die Vorschau */
export function sampleValues(target: LabelTarget): Record<string, string> {
	return Object.fromEntries((LABEL_FIELDS[target] ?? []).map((f) => [f.key, f.sample]));
}

// --- Rückgängig/Wiederholen ----------------------------------------------------------

export interface History<T> {
	past: T[];
	present: T;
	future: T[];
	/** Zusammenfassen schneller Folgeänderungen desselben Felds (Tippen, Zahlenfelder) */
	lastKey: string | null;
	lastAt: number;
}

export const HISTORY_LIMIT = 100;
/** Änderungen mit gleichem Schlüssel innerhalb dieser Zeit werden ein Schritt */
export const HISTORY_MERGE_MS = 1000;

export function createHistory<T>(present: T): History<T> {
	return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

/** Neuen Zustand aufnehmen; gleicher `mergeKey` kurz hintereinander ersetzt den letzten Schritt */
export function pushHistory<T>(
	h: History<T>,
	next: T,
	mergeKey: string | null = null,
	now = Date.now()
): History<T> {
	if (mergeKey && h.lastKey === mergeKey && now - h.lastAt < HISTORY_MERGE_MS && h.past.length) {
		return { ...h, present: next, future: [], lastAt: now };
	}
	const past = [...h.past, h.present].slice(-HISTORY_LIMIT);
	return { past, present: next, future: [], lastKey: mergeKey, lastAt: now };
}

export function undoHistory<T>(h: History<T>): History<T> {
	if (!h.past.length) return h;
	const prev = h.past[h.past.length - 1]!;
	return {
		past: h.past.slice(0, -1),
		present: prev,
		future: [h.present, ...h.future],
		lastKey: null,
		lastAt: 0
	};
}

export function redoHistory<T>(h: History<T>): History<T> {
	if (!h.future.length) return h;
	const [next, ...rest] = h.future;
	return {
		past: [...h.past, h.present].slice(-HISTORY_LIMIT),
		present: next!,
		future: rest,
		lastKey: null,
		lastAt: 0
	};
}
