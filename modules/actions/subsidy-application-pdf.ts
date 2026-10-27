import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatDateDe } from '$lib/sdk/dates';
import { formatCents } from '$lib/components/layout/money';
import type { SubsidyApplicationForm } from './schemas';

/**
 * Befüllt das Original-Formular „Antrag und Abrechnung – Zuschüsse für Freizeiten und Fahrten“
 * (Landesjugendpfarramt der BEK, 2 Seiten, ohne Formularfelder) per Text-Overlay.
 * Je Antrag werden beide Seiten der Vorlage kopiert. Die €-Spalte („vom Landesjugendpfarramt
 * auszufüllen“), Unterschriften und „Bremen, den“ bleiben leer.
 *
 * Koordinaten in PDF-Punkten (Ursprung unten links), aus den Linien der Vorlage ausgemessen.
 */
export interface ApplicationHeader {
	freizeitArt: string;
	parish: string;
	startsOn: string;
	endsOn: string | null;
	location: string;
	topic: string;
	inclusion: boolean;
	bank: { holder: string; name: string; iban: string; bic: string };
}

interface Field {
	x: number;
	/** Grundlinie */
	y: number;
	width: number;
}

const LINE_GAP = 2.5;
const at = (x: number, line: number, width: number): Field => ({ x, y: line + LINE_GAP, width });

const PAGE1 = {
	art: at(141.5, 722.7, 88),
	parish: at(277.5, 722.7, 224),
	from: at(96.5, 701.2, 44),
	to: at(186.5, 701.2, 44),
	location: at(277.5, 701.2, 224),
	topic: at(141.5, 680.2, 360),
	female: at(96.5, 637.5, 405),
	male: at(96.5, 615.8, 360),
	inclusionBox: { x: 377, y: 532.5, size: 12.5 },
	childCount: at(96.5, 467.2, 44),
	childNights: at(231.5, 467.2, 44),
	youthCount: at(96.5, 440.2, 44),
	youthNights: at(231.5, 440.2, 44),
	/** „Wir bitten um Überweisung auf unser Konto:“ */
	holder: at(201.5, 296.3, 160),
	/** „bei der“ */
	bankName: at(96.5, 275.2, 270),
	iban: at(96.5, 253.8, 134),
	bic: at(277.5, 253.8, 89)
};

const LIST_LINES = [
	678.5, 660.0, 641.7, 623.2, 604.8, 586.5, 568.2, 549.8, 531.5, 513.2, 494.8, 476.5, 458.2, 439.7,
	421.2, 402.8, 384.5, 366.2, 347.8, 329.5
];
const PAGE2 = {
	childX: 96.5,
	youthX: 367.5,
	listWidth: 134,
	/** Grundlinien der Taschengeld-Zeilen (wie „__Nächte“ der Vorlage) */
	allowanceRows: [208.9, 187.8, 166.7, 145.6, 124.3],
	allowanceName: { x: 53, width: 132 },
	juleicaBox: { x: 257.5, size: 9 },
	nights: { x: 278.5, width: 8 },
	rate: { x: 328.5, width: 25 },
	total: { x: 373, width: 26 }
};

const INK = rgb(0.05, 0.1, 0.45);
const MAX_SIZE = 9;
const MIN_SIZE = 6;

/** Zeichen, die die Standardschrift (WinAnsi) nicht kennt, ersetzen statt abzubrechen. */
function encodable(font: PDFFont, text: string): string {
	const set = new Set(font.getCharacterSet());
	return Array.from(text.normalize('NFC').replace(/\s+/g, ' ').trim())
		.map((ch) => (set.has(ch.codePointAt(0)!) ? ch : '?'))
		.join('');
}

/** Text in die Feldbreite setzen: erst verkleinern, dann mit „…“ kürzen. */
function draw(page: PDFPage, font: PDFFont, raw: string, f: Field, maxSize = MAX_SIZE): void {
	let text = encodable(font, raw);
	if (!text) return;
	let size = maxSize;
	while (size > MIN_SIZE && font.widthOfTextAtSize(text, size) > f.width) size -= 0.5;
	if (font.widthOfTextAtSize(text, size) > f.width) {
		while (text.length > 1 && font.widthOfTextAtSize(`${text}…`, size) > f.width) {
			text = text.slice(0, -1);
		}
		text = `${text.trimEnd()}…`;
	}
	page.drawText(text, { x: f.x, y: f.y, size, font, color: INK });
}

function cross(page: PDFPage, x: number, y: number, size: number): void {
	const pad = size * 0.2;
	const opts = { thickness: 1, color: INK };
	page.drawLine({
		start: { x: x + pad, y: y + pad },
		end: { x: x + size - pad, y: y + size - pad },
		...opts
	});
	page.drawLine({
		start: { x: x + pad, y: y + size - pad },
		end: { x: x + size - pad, y: y + pad },
		...opts
	});
}

const names = (list: { name: string }[]) => list.map((p) => p.name).join(', ');

export async function fillSubsidyApplicationPdf(
	template: Uint8Array,
	forms: SubsidyApplicationForm[],
	header: ApplicationHeader
): Promise<Uint8Array> {
	const source = await PDFDocument.load(template);
	const doc = await PDFDocument.create();
	doc.setTitle('Antrag und Abrechnung – Zuschüsse für Freizeiten und Fahrten');
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);

	for (const form of forms) {
		const [front, back] = await doc.copyPages(source, [0, 1]);
		doc.addPage(front!);
		doc.addPage(back!);
		const p1 = front!;
		const p2 = back!;

		if (forms.length > 1) {
			const label = `Antrag ${form.number} von ${forms.length}`;
			for (const pg of [p1, p2]) {
				const w = bold.widthOfTextAtSize(label, 9);
				pg.drawText(label, { x: 502.5 - w, y: 812, size: 9, font: bold, color: INK });
			}
		}

		draw(p1, font, header.freizeitArt, PAGE1.art);
		draw(p1, font, header.parish, PAGE1.parish);
		draw(p1, font, formatDateDe(header.startsOn), PAGE1.from);
		draw(p1, font, formatDateDe(header.endsOn ?? header.startsOn), PAGE1.to);
		draw(p1, font, header.location, PAGE1.location);
		draw(p1, font, header.topic, PAGE1.topic);
		draw(p1, font, names(form.femaleLeaders), PAGE1.female);
		draw(p1, font, names(form.maleLeaders), PAGE1.male);
		if (header.inclusion) {
			const b = PAGE1.inclusionBox;
			cross(p1, b.x, b.y, b.size);
		}
		draw(p1, font, String(form.children.length), PAGE1.childCount);
		draw(p1, font, form.children.length ? String(form.nights) : '', PAGE1.childNights);
		draw(p1, font, String(form.youth.length), PAGE1.youthCount);
		draw(p1, font, form.youth.length ? String(form.nights) : '', PAGE1.youthNights);
		draw(p1, font, header.bank.holder, PAGE1.holder);
		draw(p1, font, header.bank.name, PAGE1.bankName);
		draw(p1, font, header.bank.iban, PAGE1.iban);
		draw(p1, font, header.bank.bic, PAGE1.bic);

		form.children.forEach((p, i) => {
			const line = LIST_LINES[i];
			if (line != null) draw(p2, font, p.name, at(PAGE2.childX, line, PAGE2.listWidth));
		});
		form.youth.forEach((p, i) => {
			const line = LIST_LINES[i];
			if (line != null) draw(p2, font, p.name, at(PAGE2.youthX, line, PAGE2.listWidth));
		});
		form.allowance.forEach((a, i) => {
			const y = PAGE2.allowanceRows[i];
			if (y == null) return;
			draw(p2, font, a.name, { ...PAGE2.allowanceName, y }, 8);
			if (a.juleica) cross(p2, PAGE2.juleicaBox.x, y - 3.5, PAGE2.juleicaBox.size);
			draw(p2, font, String(a.nights), { ...PAGE2.nights, y: y + 1 }, 7.5);
			draw(p2, font, formatCents(a.rateCents), { ...PAGE2.rate, y: y + 1 }, 7.5);
			draw(p2, font, formatCents(a.totalCents), { ...PAGE2.total, y: y + 1 }, 7.5);
		});
	}
	return doc.save();
}
