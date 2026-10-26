/**
 * Verwaltung zusätzlicher Postfächer und Weiterleitungen (`/api/v1/modules/messages/admin/…`), Recht
 * `messages.mailbox.manage`. Feste Pfade vor den Parameter-Pfaden.
 */
import { z } from 'zod';
import { PRINCIPAL_SEARCH_RATE_LIMIT, defineEndpoint, type AnyApiEndpoint } from '$lib/sdk/server';
import {
	createAlias,
	createExtraMailbox,
	deleteAlias,
	deleteExtraMailbox,
	listAliases,
	listExtraMailboxes,
	searchMailboxPrincipals,
	updateExtraMailbox
} from './extra-mailbox.service';
import {
	PERM_MAILBOX_MANAGE,
	aliasInput,
	extraMailboxInput,
	extraMailboxUpdateInput,
	principalSearchQuery
} from './schemas';

const tags = ['Modul: messages'];
const uuidParams = z.object({ id: z.uuid() });
const READ_LIMIT = { limit: 240, windowSec: 60 };
const WRITE_LIMIT = { limit: 60, windowSec: 60 };

export const mailboxAdminEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/admin/mailboxes',
		summary: 'Zusätzliche Postfächer mit Freigaben und Anzahl Mails',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: READ_LIMIT,
		handler: ({ ctx }) => listExtraMailboxes(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/admin/mailboxes',
		summary: 'Zusätzliches Postfach anlegen (Adresse eindeutig, sonst 409)',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		body: extraMailboxInput,
		handler: ({ ctx, body }) => createExtraMailbox(ctx, body)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/admin/principals',
		summary: 'Freigabe-Suche für zusätzliche Postfächer (Gruppen, Mitglieder, Benutzer*innen)',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalSearchQuery,
		handler: ({ ctx, query }) => searchMailboxPrincipals(ctx, query.search)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/admin/aliases',
		summary: 'Weiterleitungen und wählbare Ziel-Postfächer',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: READ_LIMIT,
		handler: () => listAliases()
	}),
	defineEndpoint({
		method: 'POST',
		path: '/admin/aliases',
		summary: 'Weiterleitung anlegen: weitere Adresse in ein bestehendes Postfach einsortieren',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		body: aliasInput,
		handler: ({ ctx, body }) => createAlias(ctx, body)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/admin/aliases/:id',
		summary: 'Weiterleitung löschen',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		params: uuidParams,
		handler: ({ ctx, params }) => deleteAlias(ctx, params.id)
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/admin/mailboxes/:id',
		summary: 'Zusätzliches Postfach ändern (Name, Adresse, Beschreibung, Freigaben)',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		params: uuidParams,
		body: extraMailboxUpdateInput,
		handler: ({ ctx, params, body }) => updateExtraMailbox(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/admin/mailboxes/:id',
		summary: 'Zusätzliches Postfach löschen (Mails wandern nach „Nicht zugeordnet“)',
		tags,
		permission: PERM_MAILBOX_MANAGE,
		rateLimit: WRITE_LIMIT,
		params: uuidParams,
		handler: ({ ctx, params }) => deleteExtraMailbox(ctx, params.id)
	})
];
