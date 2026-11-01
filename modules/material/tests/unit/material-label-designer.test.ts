import { describe, expect, it } from 'vitest';
import { labelLayoutSchema, placeholdersIn, type LabelLayout } from '$lib/sdk/labels';
import { LABEL_FIELDS, LABEL_TARGETS } from '$modules/material/schemas';
import {
	createElement,
	createHistory,
	duplicateElement,
	HISTORY_MERGE_MS,
	moveBox,
	nudge,
	overflowing,
	pushHistory,
	redoHistory,
	reorder,
	resizeBox,
	sampleValues,
	scaleLayout,
	snap,
	undoHistory
} from '$modules/material/pages/labels/designer';
import { LABEL_STARTERS, starterLayout } from '$modules/material/pages/labels/starters';
import { LABEL_FORMAT_PRESETS } from '$lib/sdk/labels';

const bounds = { width: 70, height: 37 };

describe('Etiketten-Designer: Einrasten und Verschieben', () => {
	it('rastet auf 0,5 und 1 mm ein, ohne Raster nur gerundet', () => {
		expect(snap(3.26, 0.5)).toBe(3.5);
		expect(snap(3.24, 0.5)).toBe(3);
		expect(snap(3.5, 1)).toBe(4);
		expect(snap(3.456, 0)).toBe(3.46);
		expect(snap(Number.NaN, 1)).toBe(0);
	});

	it('hält Elemente beim Verschieben im Etikett', () => {
		const box = { x: 10, y: 10, w: 20, h: 10 };
		expect(moveBox(box, 3.3, -1.2, { step: 1, bounds })).toEqual({ x: 13, y: 9, w: 20, h: 10 });
		expect(moveBox(box, 100, 100, { step: 1, bounds })).toEqual({ x: 50, y: 27, w: 20, h: 10 });
		expect(moveBox(box, -100, -100, { step: 0.5, bounds })).toEqual({ x: 0, y: 0, w: 20, h: 10 });
	});

	it('Pfeiltasten verschieben um den Schritt, unbekannte Tasten nicht', () => {
		const box = { x: 10.25, y: 5, w: 5, h: 5 };
		expect(nudge(box, 'ArrowRight', 0.5, bounds)).toEqual({ x: 10.75, y: 5, w: 5, h: 5 });
		expect(nudge(box, 'ArrowUp', 0, bounds)).toEqual({ x: 10.25, y: 4.5, w: 5, h: 5 });
		expect(nudge(box, 'a', 1, bounds)).toBeNull();
	});
});

describe('Etiketten-Designer: Größe per Griffen', () => {
	const box = { x: 10, y: 10, w: 20, h: 10 };

	it('Ost-/Süd-Griff ändern nur Breite/Höhe, Nordwest verschiebt die Ecke', () => {
		expect(resizeBox(box, 'e', 4.2, 0, { step: 1, bounds })).toEqual({
			x: 10,
			y: 10,
			w: 24,
			h: 10
		});
		expect(resizeBox(box, 's', 0, 2.6, { step: 0.5, bounds })).toEqual({
			x: 10,
			y: 10,
			w: 20,
			h: 12.5
		});
		expect(resizeBox(box, 'nw', -3, -2, { step: 1, bounds })).toEqual({ x: 7, y: 8, w: 23, h: 12 });
	});

	it('Mindestgröße 1 mm und Etikettgrenzen', () => {
		expect(resizeBox(box, 'e', -50, 0, { step: 1, bounds }).w).toBe(1);
		expect(resizeBox(box, 'w', 50, 0, { step: 1, bounds })).toMatchObject({ x: 29, w: 1 });
		expect(resizeBox(box, 'se', 100, 100, { step: 1, bounds })).toEqual({
			x: 10,
			y: 10,
			w: 60,
			h: 27
		});
		expect(resizeBox(box, 'nw', -100, -100, { step: 1, bounds })).toEqual({
			x: 0,
			y: 0,
			w: 30,
			h: 20
		});
	});

	it('hält bei Ecken auf Wunsch das Seitenverhältnis (QR-Code)', () => {
		const qr = { x: 2, y: 2, w: 10, h: 10 };
		const r = resizeBox(qr, 'se', 6, 1, { step: 0, bounds, keepAspect: true });
		expect(r.w).toBe(r.h);
		expect(r.w).toBe(16);
		const big = resizeBox(qr, 'se', 100, 100, { step: 0, bounds, keepAspect: true });
		expect(big.w).toBe(big.h);
		expect(big.y + big.h).toBeLessThanOrEqual(37);
	});
});

describe('Etiketten-Designer: Mitskalieren und Ebenen', () => {
	const layout: LabelLayout = {
		widthMm: 70,
		heightMm: 37,
		elements: [
			{
				id: 't',
				type: 'text',
				x: 35,
				y: 10,
				w: 30,
				h: 10,
				text: '{name}',
				fontSizePt: 12,
				bold: true,
				align: 'left',
				valign: 'top',
				maxLines: 2
			},
			{ id: 'r', type: 'rect', x: 0, y: 0, w: 70, h: 37, stroke: 0.4, radius: 2, filled: false },
			{ id: 'b', type: 'barcode', x: 2, y: 2, w: 30, h: 30, symbology: 'qrcode', value: '{url}' }
		]
	};

	it('skaliert Positionen je Achse, Schrift und Linien mit dem kleineren Faktor', () => {
		const s = scaleLayout(layout, 35, 37);
		expect(s.widthMm).toBe(35);
		const t = s.elements[0]!;
		expect(t).toMatchObject({ x: 17.5, y: 10, w: 15, h: 10, fontSizePt: 6 });
		expect(s.elements[1]).toMatchObject({ w: 35, stroke: 0.2, radius: 1 });
		expect(labelLayoutSchema.safeParse(s).success).toBe(true);
		// Schrift nie unter 4 pt
		const tiny = scaleLayout(layout, 7, 3.7);
		expect((tiny.elements[0] as { fontSizePt: number }).fontSizePt).toBe(4);
		expect(tiny.elements.every((e) => e.w >= 1 && e.h >= 1)).toBe(true);
	});

	it('findet überstehende Elemente', () => {
		expect(overflowing(layout)).toEqual([]);
		expect(overflowing({ ...layout, widthMm: 50 }).map((e) => e.id)).toEqual(['t', 'r']);
	});

	it('ändert die Ebenen-Reihenfolge', () => {
		const ids = (els: LabelLayout['elements']) => els.map((e) => e.id).join('');
		expect(ids(reorder(layout.elements, 't', 'front'))).toBe('rbt');
		expect(ids(reorder(layout.elements, 'b', 'back'))).toBe('btr');
		expect(ids(reorder(layout.elements, 't', 'forward'))).toBe('rtb');
		expect(ids(reorder(layout.elements, 't', 'backward'))).toBe('trb');
		expect(ids(reorder(layout.elements, 'x', 'front'))).toBe('trb');
	});

	it('neue Elemente und Kopien sind gültig und liegen im Etikett', () => {
		for (const type of ['text', 'barcode', 'image', 'rect', 'line'] as const) {
			const el = createElement(type, { widthMm: 38.1, heightMm: 21.2 }, { target: 'blank' });
			const next = { widthMm: 38.1, heightMm: 21.2, elements: [el, duplicateElement(el)] };
			expect(labelLayoutSchema.safeParse(next).success, type).toBe(true);
			expect(overflowing({ ...next, elements: [el] })).toEqual([]);
			expect(next.elements[1]!.id).not.toBe(el.id);
		}
		expect(createElement('text', { widthMm: 70, heightMm: 37 }, { target: 'blank' })).toMatchObject(
			{ text: '{code}' }
		);
	});

	it('liefert Beispielwerte je Ziel', () => {
		expect(sampleValues('item').name).toBe('Kohtenbahn K1.1');
		expect(sampleValues('location').name).toBe('Kiste 1');
		expect(sampleValues('blank').name).toBeUndefined();
		expect(sampleValues('blank').code).toBe('M-000200');
	});
});

describe('Etiketten-Designer: Rückgängig/Wiederholen', () => {
	it('nimmt Schritte auf, fasst schnelle Eingaben zusammen und stellt wieder her', () => {
		let h = createHistory(0);
		h = pushHistory(h, 1, null, 1000);
		h = pushHistory(h, 2, 'font', 2000);
		h = pushHistory(h, 3, 'font', 2000 + HISTORY_MERGE_MS - 1);
		expect(h.present).toBe(3);
		expect(h.past).toEqual([0, 1]);
		h = pushHistory(h, 4, 'font', 2000 + HISTORY_MERGE_MS * 3);
		expect(h.past).toEqual([0, 1, 3]);
		h = undoHistory(h);
		h = undoHistory(h);
		expect(h.present).toBe(1);
		h = redoHistory(h);
		expect(h.present).toBe(3);
		h = pushHistory(h, 9, null, 9000);
		expect(h.future).toEqual([]);
		expect(undoHistory(createHistory(5))).toEqual(createHistory(5));
		expect(redoHistory(createHistory(5))).toEqual(createHistory(5));
	});
});

describe('Etiketten: Startlayouts', () => {
	it('alle Startlayouts sind gültig, nutzen Felder ihres Ziels und passen ins Format', () => {
		for (const s of LABEL_STARTERS) {
			const preset = LABEL_FORMAT_PRESETS.find((p) => p.key === s.formatKey);
			expect(preset, s.id).toBeTruthy();
			const layout = starterLayout(s, preset!.format.labelWidthMm, preset!.format.labelHeightMm);
			expect(labelLayoutSchema.safeParse(layout).success, s.id).toBe(true);
			expect(overflowing(layout), s.id).toEqual([]);
		}
	});

	it('Startlayouts nutzen nur die Ziele item/location/blank und deren Platzhalter', () => {
		for (const s of LABEL_STARTERS) {
			expect(LABEL_TARGETS, s.id).toContain(s.target);
			const known = new Set(LABEL_FIELDS[s.target].map((f) => f.key));
			const layout = starterLayout(s, s.widthMm, s.heightMm);
			const used = layout.elements.flatMap((e) =>
				e.type === 'text'
					? placeholdersIn(e.text)
					: e.type === 'barcode'
						? placeholdersIn(e.value)
						: []
			);
			for (const key of used) expect(known.has(key), `${s.id}: {${key}}`).toBe(true);
		}
		for (const t of LABEL_TARGETS) {
			expect(
				LABEL_STARTERS.some((s) => s.target === t),
				t
			).toBe(true);
		}
	});

	it('Regalfach/Artikel und Kiste klein liegen auf Avery L7159, mindestens ein s/w-Logo', () => {
		const shelf = LABEL_STARTERS.find((s) => s.id === 'shelf-item');
		const box = LABEL_STARTERS.find((s) => s.id === 'item-small');
		expect(shelf?.target).toBe('item');
		expect(shelf?.formatKey).toBe('avery-l7159');
		expect(box?.formatKey).toBe('avery-l7159');
		const preset = LABEL_FORMAT_PRESETS.find((p) => p.key === 'avery-l7159')!;
		expect(shelf!.widthMm).toBe(preset.format.labelWidthMm);
		expect(shelf!.heightMm).toBe(preset.format.labelHeightMm);
		const fields = new Set(['name', 'category', 'location', 'url', 'code']);
		const used = shelf!.elements.flatMap((e) =>
			e.type === 'text' ? [e.text] : e.type === 'barcode' ? [e.value] : []
		);
		for (const f of fields) expect(used.join(' ')).toContain(`{${f}}`);
		expect(
			LABEL_STARTERS.some((s) =>
				s.elements.some((e) => e.type === 'image' && e.monochrome === true)
			)
		).toBe(true);
	});
});

describe('Etiketten-Designer: neue Linien und Logos', () => {
	it('senkrechte Linie ist schmal, fast etiketthoch und passt hinein', () => {
		const layout: LabelLayout = { widthMm: 63.5, heightMm: 33.9, elements: [] };
		const el = createElement('line', layout, { orientation: 'vertical' });
		expect(el).toMatchObject({ type: 'line', orientation: 'vertical', w: 1, y: 2, h: 29.9 });
		expect(overflowing({ ...layout, elements: [el] })).toEqual([]);
		const h = createElement('line', layout);
		expect(h).toMatchObject({ orientation: 'horizontal', h: 1 });
	});

	it('Logo in Schwarz-Weiß nur auf Wunsch', () => {
		const layout = { widthMm: 70, heightMm: 37 };
		expect(createElement('image', layout, { logo: 'lilie', monochrome: true })).toMatchObject({
			logo: 'lilie',
			monochrome: true
		});
		expect('monochrome' in createElement('image', layout, { logo: 'wappen' })).toBe(false);
	});
});
