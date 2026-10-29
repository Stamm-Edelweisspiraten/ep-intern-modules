/** KI-Schreibhilfe in Bestellungen: Artikelbeschreibung für den Bestellkatalog. */
import type { ModuleAssist } from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';

export const PERM_AI = 'orders.ai.use';

export const ordersAssist: ModuleAssist = {
	purposes: {
		'article-description': {
			label: 'Beschreibung eines Artikels',
			description:
				'Kurze Beschreibung eines Artikels (Halstuch, Liederbuch, Kluft …) im Bestellkatalog für Mitglieder und Eltern.',
			format: 'plain',
			maxChars: 5000,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: { name: 'Artikel (Formular)', sizes: 'Größen (Formular)' }
		}
	}
};
