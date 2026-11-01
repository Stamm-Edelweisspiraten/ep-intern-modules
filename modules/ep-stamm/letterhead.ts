/**
 * Briefkopf der Christlichen Pfadfinderschaft Deutschlands (Referenz: docs/reference/briefkopf_stamm_adressfeld_page_1.png):
 * Lilie links, dreizeiliger Vereinsname, Wappen rechts, Vereinsnachweis in der Fußzeile. Ersetzt die neutralen
 * Core-Vorlagen `brief`, `briefkopf` und `briefkopf-quer`, solange das Modul aktiv ist.
 */
import {
	CARLITO_STACK,
	createLetterTemplate,
	type LetterGeometry,
	type LetterheadSpec,
	type PdfTemplate
} from '$lib/sdk/server';
import lilieUrl from './assets/lilie.png?inline';
import wappenUrl from './assets/wappen.png?inline';

/** Vereinsnachweis, hochkant genau zwei Zeilen */
export const FOOTER_TEXT_LINES = [
	'Die Christliche Pfadfinderschaft Deutschland ist Mitglied der AEJ (Arbeitsgemeinschaft der Evangelischen Jugend in Deutschland e.V.), anerkannt nach §75 SGB',
	'VIII und in das Vereinsregister Heilbad Heiligenstadt unter Nr. 400532 eingetragen.'
];

const mm = (v: number) => `${v}mm`;

/** Kopf: Lilie, dreizeiliger Vereinsname, Wappen (Maße aus der Core-Geometrie). */
export function stammHead(g: LetterGeometry): string {
	return `<img alt="" src="${lilieUrl}" style="position:absolute;left:${mm(g.mark.x)};top:${mm(g.mark.y)};width:${mm(g.mark.width)};height:${mm(g.mark.height)};" />
<div style="position:absolute;left:${mm(g.title.x)};top:${mm(g.title.y)};font-family:${CARLITO_STACK};font-size:${g.title.sizePt}pt;line-height:${mm(g.title.lineHeight)};color:#000;white-space:nowrap;">Christliche<br/>Pfadfinderschaft<br/>Deutschlands e.V.</div>
<img alt="" src="${wappenUrl}" style="position:absolute;left:${mm(g.emblem.x)};top:${mm(g.emblem.y)};width:${mm(g.emblem.width)};height:${mm(g.emblem.height)};" />`;
}

export const stammLetterhead: LetterheadSpec = {
	top: (geo) => stammHead(geo),
	footerLines: () => FOOTER_TEXT_LINES,
	headDescription: 'Lilie, Vereinsname und Wappen',
	footerDescription: 'Trennlinie und Vereinsnachweis, auf jeder Seite'
};

export const STAMM_TEMPLATES: PdfTemplate[] = [
	createLetterTemplate({
		id: 'brief',
		label: 'Stamm-Brief (mit Adressfeld)',
		description:
			'Briefkopf mit Falzmarken und Adressfeld (84 × 40 mm, Fensterumschlag) sowie Fußzeile auf jeder Seite.',
		source: 'modules/ep-stamm/letterhead.ts',
		withAddress: true,
		letterhead: stammLetterhead
	}),
	createLetterTemplate({
		id: 'briefkopf',
		label: 'Stamm-Briefkopf (ohne Adressfeld)',
		description:
			'Briefkopf mit Lilie, Vereinsname, Wappen und Fußzeile auf jeder Seite; ohne Adressfeld und Falzmarken.',
		source: 'modules/ep-stamm/letterhead.ts',
		withAddress: false,
		letterhead: stammLetterhead
	}),
	createLetterTemplate({
		id: 'briefkopf-quer',
		label: 'Stamm-Briefkopf quer (ohne Adressfeld)',
		description:
			'A4 quer für breite Tabellen und Listen: Lilie, Vereinsname, Wappen und Fußzeile auf jeder Seite; ohne Adressfeld und Falzmarken.',
		source: 'modules/ep-stamm/letterhead.ts',
		withAddress: false,
		orientation: 'landscape',
		letterhead: stammLetterhead
	})
];
