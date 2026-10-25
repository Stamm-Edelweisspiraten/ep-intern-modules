/**
 * Website-Endpunkte des Kontaktformulars (API-Key der Stammeswebsite mit Scope `messages.website.contact`).
 * Die Website holt je Formular eine Proof-of-Work-Aufgabe, der Browser löst sie, die Website reicht die Anfrage
 * samt Lösung serverseitig weiter. Der Key gehört nur auf den Server der Website.
 */
import { defineEndpoint, type AnyApiEndpoint } from '$lib/sdk/server';
import { contactChallenge, receiveContact } from './contact.service';
import { PERM_WEBSITE_CONTACT, contactInput, trialInput } from './schemas';
import { receiveTrial } from './trial.service';

const tags = ['Modul: messages'];

export const contactEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/website/contact/challenge',
		summary: 'Spam-Schutz-Aufgabe (Proof-of-Work) für das Kontaktformular der Website',
		description:
			'`challenge = SHA-256(salt + n)` mit `0 ≤ n ≤ maxNumber`; der Browser sucht `n` und sendet es mit der Anfrage. ' +
			'Signiert, gültig bis `expiresAt`, frühestens 3 s nach Ausstellung einlösbar (Zeitfalle), nur einmal verwendbar.',
		tags,
		permission: PERM_WEBSITE_CONTACT,
		rateLimit: { limit: 300, windowSec: 60 },
		handler: () => contactChallenge()
	}),
	defineEndpoint({
		method: 'POST',
		path: '/website/contact',
		summary: 'Kontaktanfrage der Website in den Posteingang (Stamm-Postfach) legen',
		description:
			'Landet im Stamm-Postfach (ohne Stamm-Adresse in „Nicht zugeordnet“) und benachrichtigt die Berechtigten. ' +
			'422 `pow` = Spam-Schutz nicht bestanden (ungültig, zu schnell, abgelaufen), 409 = Aufgabe schon eingelöst.',
		tags,
		permission: PERM_WEBSITE_CONTACT,
		rateLimit: { limit: 60, windowSec: 3600 },
		body: contactInput,
		handler: ({ ctx, body }) => receiveContact(ctx, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/website/trial',
		summary: 'Probestunden-Anfrage der Website in das Postfach der passenden Gruppe legen',
		description:
			'Gruppe = gewählter Website-Slug, sonst passend zum Alter (Altersangabe der Gruppe). Landet im Gruppen-Postfach, ' +
			'wenn dort eine Leitung mit Konto mitliest, sonst im Stamm-Postfach. Spam-Schutz wie `/website/contact` ' +
			'(Aufgabe von `/website/contact/challenge`); 422 `pow`, 409 = Aufgabe schon eingelöst.',
		tags,
		permission: PERM_WEBSITE_CONTACT,
		rateLimit: { limit: 60, windowSec: 3600 },
		body: trialInput,
		handler: ({ ctx, body }) => receiveTrial(ctx, body)
	})
];
