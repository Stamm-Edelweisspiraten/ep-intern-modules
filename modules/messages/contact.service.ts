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
import type { MailboxEntry } from './mailbox.service';
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

/** Ziel einer Website-Anfrage im Posteingang */
export interface WebsiteMailbox {
	key: string;
	name: string;
	address: string;
}

/** Stamm-Postfach, ohne Stamm-Adresse „Nicht zugeordnet“ */
export async function stammMailbox(): Promise<WebsiteMailbox> {
	const org = await core.settings.getMany(['core.organization.email', 'core.organization.name']);
	const address = normalizeAddress(String(org['core.organization.email'] ?? ''));
	const name = String(org['core.organization.name'] ?? '').trim() || 'Stamm';
	return address
		? { key: 'stamm', name, address }
		: { key: UNASSIGNED, name: 'Nicht zugeordnet', address: '' };
}

/** Spam-Schutz prüfen (422 mit `details.pow`) */
export function requirePow(pow: ContactInput['pow']): void {
	const check = verifySolution(sign, pow);
	if (!check.ok)
		throw errors.validation({ pow: POW_MESSAGES[check.reason] }, POW_MESSAGES[check.reason]);
}

/**
 * Anfrage der Website wie eine eingegangene Mail ablegen, Audit schreiben, Berechtigte benachrichtigen.
 * Jede Aufgabe (Proof-of-Work) gilt nur einmal – über alle Postfächer, sonst 409.
 */
export async function storeWebsiteRequest(
	ctx: RequestContext,
	request: {
		mailbox: WebsiteMailbox;
		pow: ContactInput['pow'];
		from: { address: string; name: string };
		subject: string;
		text: string;
		auditAction: string;
		auditMailbox: string;
		directory?: MailboxEntry[];
	}
): Promise<{ id: string }> {
	const { mailbox, from, subject, text } = request;
	const id = crypto.randomUUID();
	const html = textToHtml(text);
	const to = mailbox.address ? [{ address: mailbox.address, name: mailbox.name }] : [];
	const messageId = `<website-contact-${id}@${mailbox.address.split('@')[1] || 'website.invalid'}>`;
	const size = Buffer.byteLength(text, 'utf8');
	const dedupeKey = contactDedupeKey(request.pow);

	const inserted = await mdb().transaction(async (tx) => {
		const used = await rowsOf(
			tx,
			sql`SELECT 1 FROM inbox_messages WHERE dedupe_key = ${dedupeKey} LIMIT 1`
		);
		if (used.length) return false;
		const rows = await rowsOf(
			tx,
			sql`INSERT INTO inbox_messages (id, mailbox_key, mailbox_address, dedupe_key, message_id_header,
					thread_id, from_address, from_name, reply_to, to_list, cc_list, subject, body_html, body_text,
					received_at, size, spam, auto_submitted, auth_result, unassigned_reason, spam_score, spam_reasons,
					spam_source)
				VALUES (${id}, ${mailbox.key}, ${mailbox.address}, ${dedupeKey}, ${messageId},
					${id}, ${from.address}, ${from.name}, ${from.address}, ${JSON.stringify(to)}::jsonb, '[]'::jsonb,
					${subject}, ${html}, ${text}, now(), ${size}, false, false, 'none',
					${mailbox.key === UNASSIGNED ? 'unknown' : null}, 0, '[]'::jsonb, NULL)
				ON CONFLICT (mailbox_key, dedupe_key) DO NOTHING
				RETURNING id`
		);
		return rows.length > 0;
	});
	// Dieselbe Aufgabe zweimal: Wiederholung der Website (Netzaussetzer) oder Wiederverwendung durch einen Bot
	if (!inserted) throw errors.conflict('Diese Anfrage wurde bereits übermittelt.');

	await core.audit.logFromContext(ctx, request.auditAction, {
		target: id,
		metadata: { mailbox: request.auditMailbox }
	});
	await notifyNewMail(
		[
			{
				id,
				mailboxKey: mailbox.key,
				mailboxName: mailbox.name,
				mailboxAddress: mailbox.address,
				from,
				subject,
				text,
				notify: true
			}
		],
		request.directory
	);
	return { id };
}

export async function receiveContact(
	ctx: RequestContext,
	input: ContactInput
): Promise<{ received: true }> {
	requirePow(input.pow);
	const mailbox = await stammMailbox();
	await storeWebsiteRequest(ctx, {
		mailbox,
		pow: input.pow,
		from: { address: input.email, name: input.name },
		subject: CONTACT_SUBJECT,
		text: contactText(input),
		auditAction: 'messages.inbox.contact-received',
		auditMailbox: mailbox.key === UNASSIGNED ? UNASSIGNED : 'stamm'
	});
	return { received: true };
}
