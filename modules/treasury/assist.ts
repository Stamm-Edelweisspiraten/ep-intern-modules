/** KI-Schreibhilfe in der Kasse: nur Vorlagen (Mailtexte), nie einzelne Rechnungen oder Zahler. */
import type { ModuleAssist } from '$lib/sdk/server';
import { ANNUAL_PLACEHOLDERS, MAIL_PLACEHOLDERS } from './schemas';

export const PERM_AI = 'treasury.ai.use';

const TASKS = ['rewrite', 'friendly', 'shorter', 'simple', 'spelling', 'english'] as const;

export const treasuryAssist: ModuleAssist = {
	purposes: {
		'treasury-mail-template': {
			label: 'Vorlage für Mails der Kasse (Bestätigung, Erinnerung, Rechnung)',
			description:
				'Vorlage einer Mail an Eltern bzw. Mitglieder zu Rechnungen und Zahlungen. Höflich, klar, nicht drohend; Beträge, Fristen und Kontodaten stehen nur als Platzhalter.',
			format: 'plain',
			maxChars: 5000,
			letter: true,
			tasks: [...TASKS],
			placeholders: MAIL_PLACEHOLDERS.map(([p]) => p)
		},
		'annual-fee-text': {
			label: 'Text zum Jahresbeitrag (Mail und PDF)',
			description:
				'Erklärt den Jahresbeitrag des Stamms (Stamm, Gau, Landesmark, Bund) verständlich; Beträge nur als Platzhalter.',
			format: 'plain',
			maxChars: 5000,
			letter: true,
			tasks: [...TASKS],
			placeholders: ANNUAL_PLACEHOLDERS.map(([p]) => p)
		}
	}
};
