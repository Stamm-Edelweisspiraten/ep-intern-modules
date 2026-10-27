/**
 * Startpunkte für neue Etikett-Layouts. Die Elemente sind für die Etikettgröße des vorgeschlagenen Formats
 * gestaltet; bei anderem Format rechnet `starterLayout` sie über `scaleLayout` um.
 */
import type { LabelElement, LabelLayout } from '$lib/sdk/labels';
import type { LabelTarget } from '../../schemas';
import { newElementId, scaleLayout } from './designer';

type Draft = LabelElement extends infer E
	? E extends LabelElement
		? Omit<E, 'id'>
		: never
	: never;

export interface LabelStarter {
	id: string;
	name: string;
	description: string;
	target: LabelTarget;
	/** Vorgeschlagenes Format (Vorgabe-Schlüssel) */
	formatKey: string;
	/** Größe, für die `elements` gestaltet sind */
	widthMm: number;
	heightMm: number;
	elements: Draft[];
}

const text = (
	x: number,
	y: number,
	w: number,
	h: number,
	value: string,
	opts: Partial<{
		size: number;
		bold: boolean;
		align: 'left' | 'center' | 'right';
		valign: 'top' | 'middle' | 'bottom';
		lines: number;
	}> = {}
): Draft => ({
	type: 'text',
	x,
	y,
	w,
	h,
	text: value,
	fontSizePt: opts.size ?? 10,
	bold: opts.bold ?? false,
	align: opts.align ?? 'left',
	valign: opts.valign ?? 'top',
	maxLines: opts.lines ?? 1
});

const qr = (x: number, y: number, side: number, value = '{url}'): Draft => ({
	type: 'barcode',
	x,
	y,
	w: side,
	h: side,
	symbology: 'qrcode',
	value
});

export const LABEL_STARTERS: LabelStarter[] = [
	{
		id: 'box-large',
		name: 'Kiste groß (QR + Name + Inhalt)',
		description: 'Großes Etikett für Kisten: QR-Code zum Scannen, Name, Code und Inhaltsliste.',
		target: 'unit',
		formatKey: 'zweckform-3427',
		widthMm: 105,
		heightMm: 74,
		elements: [
			qr(5, 5, 36),
			text(45, 5, 55, 16, '{name}', { size: 18, bold: true, lines: 2 }),
			text(45, 22, 55, 6, '{code}', { size: 10 }),
			text(45, 29, 55, 10, '{location}', { size: 9, lines: 2 }),
			{ type: 'line', x: 5, y: 44, w: 95, h: 1, stroke: 0.3, orientation: 'horizontal' },
			text(5, 46, 95, 17, 'Inhalt: {contents}', { size: 10, lines: 4 }),
			{ type: 'image', x: 5, y: 64, w: 7, h: 7, logo: 'lilie' },
			text(14, 65, 86, 5, '{org}', { size: 8, valign: 'middle' })
		]
	},
	{
		id: 'shelf-article',
		name: 'Regalfach / Artikel (QR + Name + Lagerorte)',
		description:
			'Für Regalfächer und Mengenartikel wie Tassen oder Heringe: Name groß, Kategorie, Lagerorte, QR-Code und Code.',
		target: 'article',
		formatKey: 'avery-l7159',
		widthMm: 63.5,
		heightMm: 33.9,
		elements: [
			qr(2, 3, 27),
			{ type: 'line', x: 29.5, y: 3, w: 1, h: 27.9, stroke: 0.3, orientation: 'vertical' },
			text(31.5, 2, 30, 10, '{name}', { size: 13, bold: true, lines: 2 }),
			text(31.5, 12.5, 30, 4.5, '{category}', { size: 8 }),
			text(31.5, 17.5, 30, 8.5, '{locations}', { size: 7, lines: 2 }),
			text(31.5, 27, 30, 4.5, '{code}', { size: 8, bold: true, valign: 'bottom' })
		]
	},
	{
		id: 'box-small',
		name: 'Kiste klein (QR + Name + Inhalt)',
		description:
			'Kleines Kisten-Etikett für A4-Bögen (24 je Seite): QR-Code, Name, Code, Inhalt und Wappen in Schwarz-Weiß.',
		target: 'unit',
		formatKey: 'avery-l7159',
		widthMm: 63.5,
		heightMm: 33.9,
		elements: [
			qr(2, 3, 27),
			text(31.5, 2, 30, 9, '{name}', { size: 12, bold: true, lines: 2 }),
			text(31.5, 11.5, 30, 4.5, '{code}', { size: 8 }),
			text(31.5, 16.5, 30, 10, '{contents}', { size: 7, lines: 3 }),
			{ type: 'image', x: 31.5, y: 27.5, w: 5, h: 5, logo: 'wappen', monochrome: true },
			text(37.5, 27.5, 24, 5, '{org}', { size: 6, valign: 'middle' })
		]
	},
	{
		id: 'tent-small',
		name: 'Zeltbahn klein (Code 128 + Name)',
		description: 'Schmales Etikett für Zeltbahnen und Stangen mit Strichcode für den Handscanner.',
		target: 'unit',
		formatKey: 'brother-62x29',
		widthMm: 62,
		heightMm: 29,
		elements: [
			text(2, 1.5, 58, 7, '{name}', { size: 12, bold: true, align: 'center', valign: 'middle' }),
			{ type: 'barcode', x: 3, y: 9.5, w: 56, h: 13, symbology: 'code128', value: '{code}' },
			text(2, 23, 58, 4.5, '{code}', { size: 8, align: 'center', valign: 'middle' })
		]
	},
	{
		id: 'location',
		name: 'Lagerort (QR + Pfad)',
		description: 'Für Regale und Fächer: QR-Code, Name groß, voller Pfad klein.',
		target: 'location',
		formatKey: 'zweckform-3474',
		widthMm: 70,
		heightMm: 37,
		elements: [
			qr(3, 3, 31),
			text(37, 3, 31, 12, '{name}', { size: 14, bold: true, lines: 2 }),
			text(37, 16, 31, 12, '{path}', { size: 8, lines: 3 }),
			text(37, 29, 31, 5, '{code}', { size: 8, valign: 'bottom' })
		]
	},
	{
		id: 'set',
		name: 'Set / Zelt (QR + Name + Teile)',
		description: 'Für Zeltsäcke: QR-Code, Name des Sets, Typ und Teileliste.',
		target: 'set',
		formatKey: 'zweckform-3474',
		widthMm: 70,
		heightMm: 37,
		elements: [
			qr(3, 3, 31),
			text(37, 3, 31, 9, '{name}', { size: 14, bold: true }),
			text(37, 12, 31, 5, '{template} · {code}', { size: 8 }),
			text(37, 18, 31, 16, '{parts}', { size: 8, lines: 4 })
		]
	},
	{
		id: 'blank',
		name: 'Leer-Code (QR + Code)',
		description: 'Kleine Etiketten mit vorab vergebenen Codes – erst später einem Stück zuordnen.',
		target: 'blank',
		formatKey: 'avery-l7651',
		widthMm: 38.1,
		heightMm: 21.2,
		elements: [
			qr(1.5, 1.6, 18),
			text(21, 2, 16, 9, '{code}', { size: 9, bold: true, lines: 2 }),
			text(21, 12, 16, 7.5, '{org}', { size: 6, lines: 2, valign: 'bottom' })
		]
	},
	{
		id: 'empty',
		name: 'Leeres Layout',
		description: 'Ohne Elemente – Ziel und Format frei wählen.',
		target: 'unit',
		formatKey: 'zweckform-3474',
		widthMm: 70,
		heightMm: 37,
		elements: []
	}
];

/** Layout eines Startpunkts für die Etikettgröße `width` × `height` (mm) mit neuen IDs */
export function starterLayout(starter: LabelStarter, width: number, height: number): LabelLayout {
	const base: LabelLayout = {
		widthMm: starter.widthMm,
		heightMm: starter.heightMm,
		elements: starter.elements.map((e) => ({ ...e, id: newElementId() }) as LabelElement)
	};
	return width === starter.widthMm && height === starter.heightMm
		? base
		: scaleLayout(base, width, height);
}
