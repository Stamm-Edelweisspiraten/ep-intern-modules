/**
 * Endpoints des Posteingangs (`/api/v1/modules/messages/…`): Postfächer, Liste, Detail, gelesen/ungelesen,
 * Papierkorb, Zuordnen, Anhänge, Vorbelegung für Antworten, Abruf/Test (Verwaltung) und die eigenen
 * Benachrichtigungs-Einstellungen. Zugriff je Mail über ihr Postfach (fremd → 404).
 * Feste Pfade vor den Parameter-Pfaden.
 */
import { z } from 'zod';
import { core, defineEndpoint, errors, type AnyApiEndpoint } from '$lib/sdk/server';
import { getMyNotifications, setMyNotification } from './inbox-notify.service';
import {
	assignMail,
	composePrefill,
	downloadAttachment,
	listAssignTargets,
	getInboxMessage,
	listInbox,
	listMailboxes,
	setDeleted,
	setRead
} from './inbox.service';
import { pollInbox, testConnection } from './inbound.service';
import {
	PERM_INBOX_MANAGE,
	PERM_SEND,
	assignInput,
	attachmentParams,
	composeQuery,
	idParams,
	inboxListQuery,
	notificationPrefInput
} from './schemas';

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
		path: '/inbox',
		summary: 'Nachrichten eines Postfachs (Filter: alle, ungelesen, Spam, Papierkorb)',
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
		method: 'GET',
		path: '/me/notifications',
		summary: 'Eigene Benachrichtigungen zum Posteingang (je Postfach und Ereignis)',
		tags,
		permission: PERM_SEND,
		rateLimit: READ_LIMIT,
		handler: ({ ctx }) => getMyNotifications(ctx)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/me/notifications',
		summary: 'Eigene Benachrichtigung ein- oder ausschalten',
		tags,
		permission: PERM_SEND,
		rateLimit: WRITE_LIMIT,
		body: notificationPrefInput,
		handler: ({ ctx, body }) => setMyNotification(ctx, body)
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
