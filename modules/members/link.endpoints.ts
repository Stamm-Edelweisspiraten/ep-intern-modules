import { defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import {
	buildLinkLetters,
	claimLink,
	ensureLinkCode,
	listMemberLinks,
	myMembers,
	publicLinkInfo,
	registerWithLink,
	unlinkUser
} from './link.service';
import {
	idParams,
	linkClaimInput,
	linkLettersInput,
	linkRegisterInput,
	linkTokenParams,
	linkUserParams
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
		summary: 'Verknuepfte Benutzer und Codestatus eines Mitglieds',
		tags,
		permission: 'members.link.view',
		params: idParams,
		handler: ({ ctx, params }) => listMemberLinks(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/:id/link-code',
		summary: 'Neuen Verknuepfungscode erzeugen (alter Link/Code wird ungueltig)',
		tags,
		permission: 'members.link.manage',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const c = await ensureLinkCode(ctx, params.id, { regenerate: true });
			return { expiresAt: c.expiresAt.toISOString() };
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/members/:id/links/:userId',
		summary: 'Verknuepfung eines Benutzers loesen',
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
		summary: 'Verknuepfungsbrief als PDF (QR-Code, Link, Code)',
		tags,
		permission: 'members.link.manage',
		params: idParams,
		handler: async ({ ctx, params }) => pdfResponse(await buildLinkLetters(ctx, [params.id]))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/link-letters.pdf',
		summary: 'Verknuepfungsbriefe mehrerer Mitglieder als ein PDF',
		tags,
		permission: 'members.link.manage',
		body: linkLettersInput,
		handler: async ({ ctx, body }) => pdfResponse(await buildLinkLetters(ctx, body.ids))
	}),

	// Eigene Mitglieder (Basis fuer Eltern-Funktionen anderer Module). Nur mit Anmeldung, daher
	// als „oeffentlicher“ Endpunkt mit Pflicht zur Session im Handler.
	defineEndpoint({
		method: 'GET',
		path: '/my/members',
		summary: 'Mit dem eigenen Konto verknuepfte Mitglieder',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		handler: ({ ctx }) => myMembers(ctx)
	}),

	// Oeffentlicher Ablauf (Link aus dem Brief + Code)
	defineEndpoint({
		method: 'GET',
		path: '/public/link/:token',
		summary: 'Oeffentliche Verknuepfungsseite: Basisinfo zum Link',
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
		summary: 'Angemeldetes Konto per Code mit dem Mitglied verknuepfen',
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
		summary: 'Neues Konto per Code anlegen und mit dem Mitglied verknuepfen',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 5, windowSec: 600 },
		params: linkTokenParams,
		body: linkRegisterInput,
		handler: ({ ctx, params, body }) => registerWithLink(ctx, params.token, body)
	})
] as ApiEndpoint[];
