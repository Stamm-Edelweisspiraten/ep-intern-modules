/** KI-Schreibhilfe im Modul Website: Blog, häufige Fragen, Banner. */
import type { ModuleAssist } from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';
import {
	MAX_BANNER_TEXT,
	MAX_FAQ_ANSWER,
	MAX_POST_BODY,
	MAX_POST_TEASER,
	MAX_POST_TITLE
} from './schemas';

export const PERM_AI = 'website.ai.use';

const PUBLIC =
	'Öffentlich auf der Stammeswebsite: keine Nachnamen von Kindern, keine privaten Details, keine Kontaktdaten von Personen.';

export const websiteAssist: ModuleAssist = {
	purposes: {
		'blog-body': {
			label: 'Blogbeitrag',
			description: `Beitrag im Blog der Stammeswebsite, lebendig erzählt, mit Absätzen und ggf. Zwischenüberschriften. ${PUBLIC}`,
			format: 'rich',
			maxChars: MAX_POST_BODY,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: { title: 'Titel (Formular)' }
		},
		'blog-title': {
			label: 'Titel eines Blogbeitrags',
			description: `Kurzer, neugierig machender Titel. ${PUBLIC}`,
			format: 'plain',
			maxChars: MAX_POST_TITLE,
			tasks: ['title']
		},
		'blog-teaser': {
			label: 'Anreißer eines Blogbeitrags',
			description: `Ein bis zwei Sätze für die Übersicht und Suchmaschinen. ${PUBLIC}`,
			format: 'plain',
			maxChars: MAX_POST_TEASER,
			tasks: ['teaser']
		},
		'faq-answer': {
			label: 'Antwort auf eine häufige Frage',
			description: `Kurze, freundliche Antwort für Eltern und Interessierte. ${PUBLIC}`,
			format: 'rich',
			maxChars: MAX_FAQ_ANSWER,
			tasks: ASSIST_TEXT_TASKS,
			extraKeys: { question: 'Frage (Formular)' }
		},
		banner: {
			label: 'Hinweis-Banner der Website',
			description: `Sehr kurzer Hinweis (ein Satz) in einer Leiste oder einem Kasten. ${PUBLIC}`,
			format: 'plain',
			maxChars: MAX_BANNER_TEXT,
			tasks: ['rewrite', 'friendly', 'shorter', 'spelling', 'english'],
			extraKeys: { title: 'Titel (Formular)' }
		}
	}
};
