/**
 * Endpoints des Posteingangs (`/api/v1/modules/messages/…`): Postfächer, Liste, Detail, gelesen/ungelesen,
 * Papierkorb, Ordner (anlegen, umbenennen, verschieben, löschen, Mails einsortieren), Sammelaktionen,
 * Zuordnen, Anhänge, Vorbelegung für Antworten, Abruf/Test (Verwaltung) und die eigenen
 * Benachrichtigungs-Einstellungen. Zugriff je Mail über ihr Postfach (fremd → 404).
 * Feste Pfade vor den Parameter-Pfaden.
 */
import { z } from 'zod';
import { core, defineEndpoint, errors, type AnyApiEndpoint } from '$lib/sdk/server';
import {
	assignMail,
	composePrefill,
	downloadAttachment,
	listAssignTargets,
	listMailboxSent,
	getInboxMessage,
	listInbox,
	listMailboxes,
	setDeleted,
	setRead
} from './inbox.service';
import { pollInbox, testConnection } from './inbound.service';
import { createSenderRule, deleteSenderRule, listSenderRules, markSpam } from './spam.service';
import {
	bulkAction,
	createFolder,
	deleteFolder,
	folderDetails,
	moveMails,
	updateFolder
} from './folders.service';
import {
	PERM_INBOX_MANAGE,
	PERM_SEND,
	assignInput,
	attachmentParams,
	bulkInput,
	composeQuery,
	detailsQuery,
	folderCreateInput,
	folderUpdateInput,
	idParams,
	inboxListQuery,
	mailboxSentQuery,
	moveMailsInput,
	senderRuleInput,
	spamMarkInput
} from './schemas';

const folderParams = z.object({ id: z.uuid() });

const tags = ['Modul: messages'];
const READ_LIMIT = { limit: 240, windowSec: 60 };
const WRITE_LIMIT = { limit: 120, windowSec: 60 };

export const inboxEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/mailboxes',
		summary: 'Postfächer der angemeldeten Person mit Zahl ungelesener Nachrichten',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		handler: ({ ctx }) => listMailboxes(ctx)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/mailboxes/all',
		summary: 'Alle Postfächer als Ziel für das Zuordnen nicht zugeordneter Mails',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: READ_LIMIT,
		handler: () => listAssignTargets()
	}),
	defineEndpoint({
		method: 'GET',
		path: '/mailboxes/details',
		summary: 'Details zu einem Postfach oder Ordner (Anzahl, Ungelesene, Größe, Zugriff)',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		query: detailsQuery,
		handler: ({ ctx, query }) => folderDetails(ctx, query)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/mailboxes/sent',
		summary:
			'Von der Adresse eines Postfachs gesendete Nachrichten (gemeinsame Postfächer: von allen)',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		query: mailboxSentQuery,
		handler: ({ ctx, query }) => listMailboxSent(ctx, query)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/inbox',
		summary: 'Nachrichten eines Postfachs bzw. Ordners (Filter: alle, ungelesen, Spam, Papierkorb)',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		query: inboxListQuery,
		handler: ({ ctx, query }) => listInbox(ctx, query)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/poll',
		summary: 'Catch-all-Postfach jetzt abrufen',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: { limit: 10, windowSec: 60 },
		handler: ({ ctx }) => pollInbox(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/test',
		summary: 'IMAP-Verbindung prüfen (Anmeldung, Ordner), ohne etwas zu verändern',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: { limit: 10, windowSec: 60 },
		handler: async ({ ctx }) => {
			// Zugangsdaten sind Einstellungen – testen darf, wer sie auch ändern darf
			if (!core.permissions.has(ctx, 'messages.settings.manage')) {
				throw errors.forbidden('Berechtigung fehlt: messages.settings.manage');
			}
			return testConnection();
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/folders',
		summary: 'Ordner in einem Postfach anlegen (gemeinsam für alle mit Zugriff auf das Postfach)',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		body: folderCreateInput,
		handler: ({ ctx, body }) => createFolder(ctx, body)
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/folders/:id',
		summary: 'Ordner umbenennen oder in einen anderen Ordner desselben Postfachs verschieben',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		params: folderParams,
		body: folderUpdateInput,
		handler: ({ ctx, params, body }) => updateFolder(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/folders/:id',
		summary: 'Ordner samt Unterordnern löschen; die Nachrichten gehen zurück in den Posteingang',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		params: folderParams,
		handler: ({ ctx, params }) => deleteFolder(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/move',
		summary:
			'Nachrichten in einen Ordner (oder `null` = Posteingang) desselben Postfachs verschieben',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		body: moveMailsInput,
		handler: ({ ctx, body }) => moveMails(ctx, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/bulk',
		summary: 'Markierte Nachrichten: gelesen, ungelesen, Papierkorb oder wiederherstellen',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		body: bulkInput,
		handler: ({ ctx, body }) => bulkAction(ctx, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/spam',
		summary:
			'Markierte Nachrichten als Spam bzw. kein Spam; mit `remember` kommt der Absender auf die Sperr- bzw. Vertrauensliste',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		body: spamMarkInput,
		handler: ({ ctx, body }) => markSpam(ctx, body)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/spam/rules',
		summary: 'Sperr- und Vertrauensliste des Posteingangs (gilt für alle Postfächer)',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: READ_LIMIT,
		handler: ({ ctx }) => listSenderRules(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/spam/rules',
		summary: 'Adresse oder Domain sperren bzw. als vertrauenswürdig eintragen',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		body: senderRuleInput,
		handler: ({ ctx, body }) => createSenderRule(ctx, body)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/spam/rules/:id',
		summary: 'Eintrag der Sperr- bzw. Vertrauensliste löschen',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		params: folderParams,
		handler: ({ ctx, params }) => deleteSenderRule(ctx, params.id)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/inbox/:id',
		summary:
			'Nachricht mit Inhalt (bereinigt), Anhängen, Antworten und Verlauf; markiert als gelesen',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => getInboxMessage(ctx, params.id)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/inbox/:id/compose',
		summary: 'Vorbelegung für Antworten, Allen antworten oder Weiterleiten',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		params: idParams,
		query: composeQuery,
		handler: ({ ctx, params, query }) => composePrefill(ctx, params.id, query.mode)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/:id/read',
		summary: 'Als gelesen markieren',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => setRead(ctx, params.id, true)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/:id/unread',
		summary: 'Als ungelesen markieren',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => setRead(ctx, params.id, false)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/:id/restore',
		summary: 'Aus dem Papierkorb wiederherstellen',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => setDeleted(ctx, params.id, false)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/inbox/:id/assign',
		summary: 'Nicht zugeordnete Nachricht einem Postfach zuordnen',
		tags,
		permission: PERM_INBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		body: assignInput,
		handler: ({ ctx, params, body }) => assignMail(ctx, params.id, body.mailbox)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/inbox/:id',
		summary: 'In den Papierkorb (gemeinsame Postfächer: für alle)',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => setDeleted(ctx, params.id, true)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/inbox/:id/attachments/:attachmentId',
		summary: 'Anhang herunterladen (`inline=1`: Bilder/PDF/Text im Browser ansehen)',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		params: attachmentParams,
		query: z.object({ inline: z.enum(['0', '1']).default('0') }),
		handler: ({ ctx, params, query }) =>
			downloadAttachment(ctx, params.id, params.attachmentId, query.inline === '1')
	})
];
