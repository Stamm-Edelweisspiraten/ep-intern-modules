/**
 * Kontaktformular der Stammeswebsite → Posteingang (Stamm-Postfach).
 *
 * Die Website ruft serverseitig mit ihrem API-Key (Scope `messages.website.contact`) auf; Spam-Schutz über
 * Proof-of-Work + Zeitfalle (`contact-pow.ts`). Eine Anfrage wird wie eine eingegangene Mail gespeichert:
 * Absender = eingegebene Adresse (ungeprüft, Hinweis im Text), Antworten/Weiterleiten/Ordner/Spam wie gewohnt.
 * Ohne Stamm-Adresse (`core.organization.email`) landet sie in „Nicht zugeordnet“ (Verwaltung).
 */
import { sql } from 'drizzle-orm';
import { core, errors, moduleDb, rowsOf, type RequestContext } from '$lib/sdk/server';
import {
	contactDedupeKey,
	createChallenge,
	verifySolution,
	type PowChallenge
} from './contact-pow';
import { textToHtml } from './html';
import { notifyNewMail } from './inbox-notify.service';
import { UNASSIGNED } from './mailbox';
import { normalizeAddress } from './sender';
import { MODULE_ID, type ContactInput } from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const sign = (value: string) => core.crypto.forModule(MODULE_ID).hash(value);

export const CONTACT_SUBJECT = 'Kontaktanfrage über die Website';

export function contactChallenge(): PowChallenge {
	return createChallenge(sign);
}

const POW_MESSAGES = {
	invalid:
		'Der Spam-Schutz konnte nicht bestätigt werden. Bitte lade die Seite neu und versuche es erneut.',
	'too-fast': 'Das ging zu schnell. Bitte versuche es in ein paar Sekunden erneut.',
	expired: 'Das Formular war zu lange geöffnet. Bitte lade die Seite neu und versuche es erneut.'
} as const;

/** Text der Anfrage (Klartext; HTML daraus über `textToHtml`) */
export function contactText(
	input: Pick<ContactInput, 'name' | 'email' | 'phone' | 'message'>
): string {
	return [
		input.message,
		'',
		'—',
		`Name: ${input.name}`,
		`E-Mail: ${input.email}`,
		`Telefon: ${input.phone || '–'}`,
		'',
		'Über das Kontaktformular der Website eingegangen. Name und Adresse wurden nicht geprüft.'
	].join('\n');
}

export async function receiveContact(
	ctx: RequestContext,
	input: ContactInput
): Promise<{ received: true }> {
	const check = verifySolution(sign, input.pow);
	if (!check.ok)
		throw errors.validation({ pow: POW_MESSAGES[check.reason] }, POW_MESSAGES[check.reason]);

	const org = await core.settings.getMany(['core.organization.email', 'core.organization.name']);
	const stammMail = normalizeAddress(String(org['core.organization.email'] ?? ''));
	const stammName = String(org['core.organization.name'] ?? '').trim() || 'Stamm';
	const mailboxKey = stammMail ? 'stamm' : UNASSIGNED;
	const mailboxName = stammMail ? stammName : 'Nicht zugeordnet';

	const id = crypto.randomUUID();
	const text = contactText(input);
	const html = textToHtml(text);
	const to = stammMail ? [{ address: stammMail, name: stammName }] : [];
	const messageId = `<website-contact-${id}@${stammMail.split('@')[1] || 'website.invalid'}>`;
	const size = Buffer.byteLength(text, 'utf8');

	const inserted = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`INSERT INTO inbox_messages (id, mailbox_key, mailbox_address, dedupe_key, message_id_header,
					thread_id, from_address, from_name, reply_to, to_list, cc_list, subject, body_html, body_text,
					received_at, size, spam, auto_submitted, auth_result, unassigned_reason, spam_score, spam_reasons,
					spam_source)
				VALUES (${id}, ${mailboxKey}, ${stammMail}, ${contactDedupeKey(input.pow)}, ${messageId},
					${id}, ${input.email}, ${input.name}, ${input.email}, ${JSON.stringify(to)}::jsonb, '[]'::jsonb,
					${CONTACT_SUBJECT}, ${html}, ${text}, now(), ${size}, false, false, 'none',
					${mailboxKey === UNASSIGNED ? 'unknown' : null}, 0, '[]'::jsonb, NULL)
				ON CONFLICT (mailbox_key, dedupe_key) DO NOTHING
				RETURNING id`
		);
		return rows.length > 0;
	});
	// Dieselbe Aufgabe zweimal: Wiederholung der Website (Netzaussetzer) oder Wiederverwendung durch einen Bot
	if (!inserted) throw errors.conflict('Diese Anfrage wurde bereits übermittelt.');

	await core.audit.logFromContext(ctx, 'messages.inbox.contact-received', {
		target: id,
		metadata: { mailbox: mailboxKey === UNASSIGNED ? UNASSIGNED : 'stamm' }
	});
	await notifyNewMail([
		{
			id,
			mailboxKey,
			mailboxName,
			mailboxAddress: stammMail,
			from: { address: input.email, name: input.name },
			subject: CONTACT_SUBJECT,
			text,
			notify: true
		}
	]);
	return { received: true };
}
