import { MAX_GROUP_SLUG } from './schemas';

/**
 * Vorschlag für die Website-Adresse einer Gruppe aus ihrem Namen (rein, für UI und Tests):
 * Kleinbuchstaben, ä→ae, ö→oe, ü→ue, ß→ss, übrige Akzente entfernt, alles andere → Bindestrich.
 */
export function slugFromName(name: string): string {
	return name
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/ß/g, 'ss')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_GROUP_SLUG)
		.replace(/-+$/g, '');
}
