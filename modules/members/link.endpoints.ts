import { core, defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import type { FormValue } from '$lib/forms';
import { membersService } from './fields.service';
import {
	buildLinkLetters,
	claimLink,
	ensureLinkCode,
	linkUserManually,
	listMemberLinks,
	myFieldDefinitions,
	myMembers,
	publicLinkInfo,
	registerWithLink,
	setMailPref,
	unlinkUser,
	updateLinkedContacts
} from './link.service';
import {
	idParams,
	linkClaimInput,
	linkLettersInput,
	linkManualInput,
	linkRegisterInput,
	linkTokenParams,
	linkUserParams,
	linkUserSearchQuery,
	mailPrefInput,
	myContactsInput,
	myFieldsInput,
	type LinkUserRef
} from './schemas';

const tags = ['Mitglieder'];

const pdfResponse = (r: { buffer: Uint8Array; fileName: string }) =>
	new Response(Buffer.from(r.buffer), {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="${r.fileName}"`,
			'cache-control': 'no-store'
		}
	});

export const linkEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/members/:id/links',
		summary: 'Verknüpfte Benutzer und Codestatus eines Mitglieds',
		tags,
		permission: 'members.link.view',
		params: idParams,
		handler: ({ ctx, params }) => listMemberLinks(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/:id/link-code',
		summary: 'Neuen Verknüpfungscode erzeugen (alter Link/Code wird ungültig)',
		tags,
		permission: 'members.link.manage',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const c = await ensureLinkCode(ctx, params.id, { regenerate: true });
			return { expiresAt: c.expiresAt.toISOString() };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/:id/links',
		summary: 'Benutzerkonto per Hand mit dem Mitglied verknüpfen (ohne Brief/Code)',
		tags,
		permission: 'members.link.manage',
		params: idParams,
		body: linkManualInput,
		handler: ({ ctx, params, body }) => linkUserManually(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/link-users',
		summary: 'Aktive Benutzerkonten zum Verknüpfen suchen (ab 2 Zeichen)',
		tags,
		permission: 'members.link.manage',
		query: linkUserSearchQuery,
		handler: async ({ ctx, query }): Promise<LinkUserRef[]> => {
			if (query.search.length < 2) return [];
			// members.link.manage: Adresse unterscheidet gleichnamige Konten beim Verknüpfen
			const users = await core.users.directory(ctx, {
				search: query.search,
				limit: 30,
				includeEmail: true
			});
			return users.map((u) => ({ id: u.id, name: u.name, email: u.email }));
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/members/:id/links/:userId',
		summary: 'Verknüpfung eines Benutzers lösen',
		tags,
		permission: 'members.link.manage',
		params: linkUserParams,
		handler: async ({ ctx, params }) => {
			await unlinkUser(ctx, params.id, params.userId);
			return null;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/members/:id/link-letter.pdf',
		summary: 'Verknüpfungsbrief als PDF (QR-Code, Link, Code)',
		tags,
		permission: 'members.link.manage',
		params: idParams,
		handler: async ({ ctx, params }) => pdfResponse(await buildLinkLetters(ctx, [params.id]))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/link-letters.pdf',
		summary: 'Verknüpfungsbriefe mehrerer Mitglieder als ein PDF',
		tags,
		permission: 'members.link.manage',
		body: linkLettersInput,
		handler: async ({ ctx, body }) => pdfResponse(await buildLinkLetters(ctx, body.ids))
	}),

	// Eigene Mitglieder (Profil, Eltern-Funktionen). Recht `members.own.view`/`.edit` (Rolle „Mitglied“).
	defineEndpoint({
		method: 'GET',
		path: '/my/members',
		summary: 'Mit dem eigenen Konto verknüpfte Mitglieder (Kontakte, Zusatzfelder, Mail-Abwahlen)',
		tags,
		permission: 'members.own.view',
		rateLimit: { limit: 60, windowSec: 60 },
		handler: ({ ctx }) => myMembers(ctx)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/my/fields',
		summary: 'Aktive Zusatzfelder für die eigenen Mitglieder',
		tags,
		permission: 'members.own.view',
		rateLimit: { limit: 60, windowSec: 60 },
		handler: () => myFieldDefinitions()
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/my/members/:id/fields',
		summary: 'Zusatzfelder eines verknüpften Mitglieds ändern',
		tags,
		permission: 'members.own.edit',
		rateLimit: { limit: 10, windowSec: 600 },
		params: idParams,
		body: myFieldsInput,
		handler: async ({ ctx, params, body }) => {
			await core.permissions.require(ctx, 'members.own.view');
			return {
				changed: await membersService.updateMemberFields(
					ctx,
					params.id,
					body.values as Record<string, FormValue>
				)
			};
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/my/members/:id/contacts',
		summary: 'Telefone und E-Mail-Adressen eines verknüpften Mitglieds ändern',
		tags,
		permission: 'members.own.edit',
		rateLimit: { limit: 10, windowSec: 600 },
		params: idParams,
		body: myContactsInput,
		handler: async ({ ctx, params, body }) => {
			await core.permissions.require(ctx, 'members.own.view');
			return updateLinkedContacts(ctx, params.id, body);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/my/members/:id/mail-prefs',
		summary: 'Abschaltbare Mail-Kategorie eines verknüpften Mitglieds an/aus',
		tags,
		permission: 'members.own.edit',
		rateLimit: { limit: 10, windowSec: 600 },
		params: idParams,
		body: mailPrefInput,
		handler: async ({ ctx, params, body }) => {
			await core.permissions.require(ctx, 'members.own.view');
			return setMailPref(ctx, params.id, body.category, body.enabled, true);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/members/:id/mail-prefs',
		summary: 'Abschaltbare Mail-Kategorie eines Mitglieds an/aus (Verwaltung)',
		tags,
		permission: 'members.member.edit',
		params: idParams,
		body: mailPrefInput,
		handler: ({ ctx, params, body }) =>
			setMailPref(ctx, params.id, body.category, body.enabled, false)
	}),

	// Öffentlicher Ablauf (Link aus dem Brief + Code)
	defineEndpoint({
		method: 'GET',
		path: '/public/link/:token',
		summary: 'Öffentliche Verknüpfungsseite: Basisinfo zum Link',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: linkTokenParams,
		handler: ({ ctx, params }) => publicLinkInfo(ctx, params.token)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/public/link/:token/claim',
		summary: 'Angemeldetes Konto per Code mit dem Mitglied verknüpfen',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 10, windowSec: 600 },
		params: linkTokenParams,
		body: linkClaimInput,
		handler: ({ ctx, params, body }) => claimLink(ctx, params.token, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/public/link/:token/register',
		summary: 'Neues Konto per Code anlegen und mit dem Mitglied verknüpfen',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 5, windowSec: 600 },
		params: linkTokenParams,
		body: linkRegisterInput,
		handler: ({ ctx, params, body }) => registerWithLink(ctx, params.token, body)
	})
] as ApiEndpoint[];
