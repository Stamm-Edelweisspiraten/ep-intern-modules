/** KI-Schreibhilfe im Modul Nachrichten: Textstellen und Kontext „eingegangene Mail“ (Antwortentwurf). */
import { isCoreError, type ModuleAssist, type RequestContext } from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';
import { loadInboxRow } from './inbox.service';
import { MAX_BODY_HTML, MAX_SUBJECT, PERM_SEND } from './schemas';

/** Zitierten Verlauf abschneiden („> …“, „Am … schrieb …“, „-----Original Message-----“) */
export function withoutQuotedHistory(text: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	for (const line of lines) {
		if (/^\s*(Am |On ).{4,200}(schrieb|wrote).{0,120}:\s*$/i.test(line)) break;
		if (/^\s*-{2,}\s*(Original|Ursprüngliche)/i.test(line)) break;
		if (/^\s*>/.test(line)) continue;
		out.push(line);
	}
	return out.join('\n').trim();
}

/**
 * Eingegangene Mail als Kontext für einen Antwortentwurf: nur mit Zugriff aufs Postfach (sonst 404),
 * ohne Absender und ohne zitierten Verlauf. Der Core schickt sie nur mit `core.ai.assist.allowInbox`
 * und maskiert Adressen, Telefonnummern und IBANs.
 */
async function inboxContext(ctx: RequestContext, id: string) {
	if (!ctx.permissions.has(PERM_SEND)) return null;
	try {
		const { row } = await loadInboxRow(ctx, id);
		const body = withoutQuotedHistory(String(row.body_text ?? ''));
		return {
			facts: { 'Betreff der eingegangenen Mail': String(row.subject ?? '').slice(0, 200) },
			document: body || '(leer)'
		};
	} catch (e) {
		if (isCoreError(e) && e.code === 'not_found') return null;
		throw e;
	}
}

export const messagesAssist: ModuleAssist = {
	purposes: {
		mail: {
			label: 'E-Mail an Mitglieder, Eltern oder Gruppen',
			description:
				'Rundmail des Stamms, meist an Eltern von Kindern und Jugendlichen oder an Leitungen. Klar gegliedert, wichtige Angaben (Datum, Uhrzeit, Ort, Frist) gut auffindbar.',
			format: 'rich',
			maxChars: MAX_BODY_HTML,
			letter: true,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ['actions:action']
		},
		'inbox-reply': {
			label: 'Antwort auf eine eingegangene Mail',
			description:
				'Antwort des Stamms auf eine Mail (z. B. von Eltern). Geht auf die Fragen der Mail ein, sagt nichts zu, was nicht in den Stichpunkten steht.',
			format: 'rich',
			maxChars: MAX_BODY_HTML,
			letter: true,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ['messages:inbox-message']
		},
		'mail-subject': {
			label: 'Betreff einer E-Mail',
			description: 'Kurzer, konkreter Betreff ohne Großbuchstaben-Wörter und ohne Ausrufezeichen.',
			format: 'plain',
			maxChars: MAX_SUBJECT,
			tasks: ['subject'],
			contexts: ['actions:action']
		}
	},
	contexts: { 'inbox-message': inboxContext }
};
