/** KI-Schreibhilfe in Ämtern: Beschreibung eines Amts und persönliche Beschreibung. */
import type { ModuleAssist } from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';
import { MAX_BIO, MAX_DESCRIPTION } from './schemas';

export const PERM_AI = 'offices.ai.use';

export const officesAssist: ModuleAssist = {
	purposes: {
		'office-description': {
			label: 'Beschreibung eines Amts',
			description:
				'Was das Amt im Stamm macht und wofür man sich an es wendet (erscheint auch auf der Website).',
			format: 'plain',
			maxChars: MAX_DESCRIPTION,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: { name: 'Amt (Formular)' }
		},
		'office-bio': {
			label: 'Persönliche Beschreibung (Ämter)',
			description:
				'Kurze Vorstellung der Person in Ich-Form für die Ämterseite der Website. Nur das, was die Person selbst angibt.',
			format: 'plain',
			maxChars: MAX_BIO,
			tasks: ASSIST_TEXT_TASKS
		}
	}
};
