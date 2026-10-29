/** KI-Schreibhilfe in Mitglieder & Gruppen: nur Gruppentexte (keine Texte über Personen). */
import type { ModuleAssist } from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';

export const PERM_AI = 'members.ai.use';

const GROUP_EXTRA = {
	name: 'Gruppenname (Formular)',
	ages: 'Alter (Formular)',
	meeting: 'Gruppenstunde (Formular)'
};

export const membersAssist: ModuleAssist = {
	purposes: {
		'group-description': {
			label: 'Beschreibung einer Gruppe (intern)',
			description: 'Kurze interne Beschreibung einer Pfadfindergruppe (Meute, Sippe, Runde).',
			format: 'plain',
			maxChars: 5000,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: GROUP_EXTRA
		},
		'group-website-text': {
			label: 'Text einer Gruppe für die Website',
			description:
				'Öffentlicher Steckbrief einer Gruppe auf der Stammeswebsite für interessierte Kinder und Eltern: was die Gruppe macht, für welches Alter, wann sie sich trifft. Keine Namen von Kindern.',
			format: 'plain',
			maxChars: 5000,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: GROUP_EXTRA
		}
	}
};
