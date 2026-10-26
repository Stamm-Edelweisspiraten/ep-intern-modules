/**
 * Zeilenumbruch für Texte in Formen (rein; Messfunktion wird übergeben). Der Editor rendert Text als SVG-`<text>`
 * mit `<tspan>` je Zeile – so sieht der Bild-Export genauso aus wie die Ansicht (kein `foreignObject`).
 */
import type { TextAlign, VAlign } from '../../schemas';

export const FONT_FAMILY =
	"system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const LINE_HEIGHT = 1.25;

export type Measure = (text: string, fontSize: number, bold: boolean, italic: boolean) => number;

/** Schätzung ohne DOM (Tests, Server): mittlere Zeichenbreite */
export const approxMeasure: Measure = (text, fontSize, bold) =>
	text.length * fontSize * (bold ? 0.58 : 0.54);

let canvasMeasure: Measure | null = null;

/** Messung über ein Canvas im Browser (gleiche Schrift wie die Darstellung), sonst Schätzung */
export function browserMeasure(): Measure {
	if (canvasMeasure) return canvasMeasure;
	if (typeof document === 'undefined') return approxMeasure;
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return approxMeasure;
	const cache = new Map<string, number>();
	canvasMeasure = (text, fontSize, bold, italic) => {
		const key = `${fontSize}|${bold ? 1 : 0}|${italic ? 1 : 0}|${text}`;
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		ctx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px ${FONT_FAMILY}`;
		const w = ctx.measureText(text).width;
		if (cache.size > 5000) cache.clear();
		cache.set(key, w);
		return w;
	};
	return canvasMeasure;
}

/** Text in Zeilen umbrechen (Wörter; zu lange Wörter zeichenweise); harte Umbrüche bleiben */
export function wrapText(
	text: string,
	maxWidth: number,
	fontSize: number,
	opts: { bold?: boolean; italic?: boolean; measure?: Measure } = {}
): string[] {
	const measure = opts.measure ?? approxMeasure;
	const bold = !!opts.bold;
	const italic = !!opts.italic;
	const fits = (s: string) => measure(s, fontSize, bold, italic) <= maxWidth;
	const lines: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
		if (!paragraph) {
			lines.push('');
			continue;
		}
		let line = '';
		for (const word of paragraph.split(/(\s+)/)) {
			if (!word) continue;
			const next = line + word;
			if (fits(next) || !line.trim()) {
				if (fits(next)) {
					line = next;
					continue;
				}
				// Wort allein zu lang: zeichenweise teilen
				let chunk = line;
				for (const ch of word) {
					if (fits(chunk + ch) || !chunk) chunk += ch;
					else {
						lines.push(chunk);
						chunk = ch;
					}
				}
				line = chunk;
				continue;
			}
			lines.push(line.trimEnd());
			line = word.trimStart();
			if (!fits(line)) {
				let chunk = '';
				for (const ch of line) {
					if (fits(chunk + ch) || !chunk) chunk += ch;
					else {
						lines.push(chunk);
						chunk = ch;
					}
				}
				line = chunk;
			}
		}
		lines.push(line.trimEnd());
	}
	return lines;
}

export interface TextLayout {
	lines: { text: string; x: number; y: number }[];
	anchor: 'start' | 'middle' | 'end';
	/** Text passt nicht ganz hinein (abgeschnitten) */
	overflow: boolean;
}

/**
 * Zeilen in einem Bereich anordnen. `y` ist die Grundlinie jeder Zeile. Zu viele Zeilen werden abgeschnitten
 * (die letzte sichtbare endet mit „…“).
 */
export function layoutText(
	text: string,
	area: { x: number; y: number; w: number; h: number },
	style: { fontSize: number; align: TextAlign; valign: VAlign; bold?: boolean; italic?: boolean },
	measure?: Measure
): TextLayout {
	const lineHeight = style.fontSize * LINE_HEIGHT;
	let lines = wrapText(text, Math.max(1, area.w), style.fontSize, { ...style, measure });
	const max = Math.max(1, Math.floor(area.h / lineHeight));
	let overflow = false;
	if (lines.length > max) {
		overflow = true;
		lines = lines.slice(0, max);
		const last = lines[max - 1] ?? '';
		lines[max - 1] = `${last.replace(/\s*\S?$/, '')}…`;
	}
	const total = lines.length * lineHeight;
	const top =
		style.valign === 'top'
			? area.y
			: style.valign === 'bottom'
				? area.y + area.h - total
				: area.y + (area.h - total) / 2;
	const x =
		style.align === 'left'
			? area.x
			: style.align === 'right'
				? area.x + area.w
				: area.x + area.w / 2;
	return {
		lines: lines.map((t, i) => ({ text: t, x, y: top + i * lineHeight + style.fontSize * 0.95 })),
		anchor: style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle',
		overflow
	};
}
