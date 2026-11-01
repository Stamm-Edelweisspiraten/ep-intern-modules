/**
 * Logos für Etiketten (Stammes-Wappen und Lilie) als `data:`-URL: farbig und in Schwarz-Weiß (schwarze Flächen und
 * Kontur auf Weiß, für Laser-/Thermodrucker). Der Core zeichnet nur, was das Modul an `core.pdf.labels` übergibt.
 */
import wappen from './assets/label-logos/wappen.png?inline';
import lilie from './assets/label-logos/lilie.png?inline';
import wappenSw from './assets/label-logos/wappen-sw.png?inline';
import lilieSw from './assets/label-logos/lilie-sw.png?inline';

export const MATERIAL_LABEL_LOGOS = ['wappen', 'lilie'] as const;
export type MaterialLabelLogo = (typeof MATERIAL_LABEL_LOGOS)[number];

export const MATERIAL_LABEL_LOGO_LABELS: Readonly<Record<MaterialLabelLogo, string>> = {
	wappen: 'Wappen',
	lilie: 'Lilie'
};

/** Schlüssel wie `logoKey` aus `$lib/sdk/labels` (`<logo>` bzw. `<logo>-sw`) */
export const MATERIAL_LABEL_LOGO_DATA: Record<string, string> = {
	wappen,
	lilie,
	'wappen-sw': wappenSw,
	'lilie-sw': lilieSw
};
