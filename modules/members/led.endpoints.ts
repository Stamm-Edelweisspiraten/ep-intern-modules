/**
 * Endpunkte für Gruppenleitungen (`/led/…`): dieselben Daten wie die Mitgliederverwaltung, aber nur für
 * Mitglieder der Gruppen, die das Konto über sein eigenes Mitglied leitet (`ledGroupIds`, frisch je
 * Aufruf). Fremde Mitglieder/Gruppen → 404. Gruppenzuordnung und Mitgliedschaftsdaten bleiben gesperrt,
 * Anlegen/Löschen/Verknüpfungen gibt es hier nicht.
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	inList,
	moduleDb,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import { placesForPostalCode, suggestAddresses } from './address.service';
import { deleteDocument, downloadDocument, uploadDocument } from './documents.endpoints';
import { listFieldDefs } from './fields.service';
import { ledGroupOverview } from './dashboard';
import { inScopeSql, ledGroupIds } from './leader.service';
import { getMember, listMemberIds, listMembers, updateMember } from './members.service';
import { buildGroupSheets, buildMemberSheets, getMemberCatalog } from './sheets.service';
import {
	LED_EDIT,
	LED_EXPORT,
	LED_VIEW,
	MODULE_ID,
	addressPlacesQuery,
	addressSuggestQuery,
	documentParams,
	groupSheetsInput,
	idParams,
	memberInput,
	memberIdsQuery,
	memberListQuery,
	memberSheetsInput,
	type DocumentKind,
	type GroupRef,
	type GroupType
} from './schemas';

const tags = ['Mitglieder (Gruppenleitung)'];

const pdfResponse = (r: { buffer: Uint8Array; fileName: string }) =>
	new Response(Buffer.from(r.buffer), {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="${r.fileName}"`,
			'cache-control': 'private, no-store'
		}
	});

/** Ändern setzt das Ansehen voraus (wie `members.own.*`) */
async function scopeForEdit(ctx: RequestContext): Promise<string[]> {
	await core.permissions.require(ctx, LED_VIEW);
	return ledGroupIds(ctx);
}

async function ledGroups(scope: readonly string[]): Promise<GroupRef[]> {
	if (!scope.length) return [];
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, name, type, color FROM groups WHERE id IN (${inList([...scope])})
				ORDER BY name, id`
		)
	);
	return rows.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		type: r.type as GroupType,
		color: r.color == null ? null : String(r.color)
	}));
}

/** Alle IDs müssen Mitglieder der geleiteten Gruppen sein, sonst 404 (nichts wird erzeugt) */
async function assertMembersInScope(ids: string[], scope: readonly string[]): Promise<void> {
	const found = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT m.id FROM members m WHERE m.id IN (${inList(ids)}) AND ${inScopeSql('m', scope)}`
		)
	);
	if (found.length !== ids.length) throw errors.notFound('Mitglied nicht gefunden');
}

export const ledEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/led/groups',
		summary: 'Gruppen, die ich leite',
		tags,
		permission: LED_VIEW,
		handler: async ({ ctx }) => ledGroups(await ledGroupIds(ctx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/overview',
		summary:
			'Übersicht der geleiteten Gruppen (Mitgliederzahl, Gruppenstunde, Geburtstage der nächsten 14 Tage)',
		tags,
		permission: LED_VIEW,
		rateLimit: { limit: 60, windowSec: 60 },
		handler: ({ ctx }) => ledGroupOverview(ctx)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/fields',
		summary: 'Zusatzfelder der Mitglieder (für die Gruppenleitung)',
		tags,
		permission: LED_VIEW,
		handler: async () => ({ fields: await listFieldDefs() })
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/members/sheet-columns',
		summary: 'Spalten und Voreinstellungen der Mitglieder-Listen (PDF, Gruppenleitung)',
		tags,
		permission: LED_EXPORT,
		handler: async () => getMemberCatalog()
	}),
	defineEndpoint({
		method: 'POST',
		path: '/led/members/sheets.pdf',
		summary: 'Mitgliedsdaten von Mitgliedern meiner Gruppen als PDF (inkl. Gesundheitsangaben)',
		tags,
		permission: LED_EXPORT,
		body: memberSheetsInput,
		handler: async ({ ctx, body }) => {
			const scope = await scopeForEdit(ctx);
			await assertMembersInScope(body.ids, scope);
			return pdfResponse(await buildMemberSheets(ctx, body.ids, body.selection));
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/led/groups/sheets.pdf',
		summary: 'Mitgliedsdaten meiner Gruppen als PDF (Seite je Gruppe)',
		tags,
		permission: LED_EXPORT,
		body: groupSheetsInput,
		handler: async ({ ctx, body }) => {
			const scope = await scopeForEdit(ctx);
			if (body.groupIds.some((g) => !scope.includes(g))) {
				throw errors.notFound('Gruppe nicht gefunden');
			}
			return pdfResponse(await buildGroupSheets(ctx, body.groupIds, body.selection));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/members',
		summary: 'Mitglieder meiner Gruppen auflisten',
		tags,
		permission: LED_VIEW,
		query: memberListQuery,
		handler: async ({ ctx, query }) => listMembers(query, await ledGroupIds(ctx))
	}),
	// fester Pfad vor `/led/members/:id`
	defineEndpoint({
		method: 'GET',
		path: '/led/members/ids',
		summary: 'IDs und Namen aller Treffer eines Filters in meinen Gruppen',
		tags,
		permission: LED_VIEW,
		query: memberIdsQuery,
		rateLimit: { limit: 60, windowSec: 60 },
		handler: async ({ ctx, query }) => listMemberIds(query, await ledGroupIds(ctx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/members/:id',
		summary: 'Mitglied meiner Gruppen abrufen',
		tags,
		permission: LED_VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => getMember(params.id, await ledGroupIds(ctx))
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/led/members/:id',
		summary: 'Mitglied meiner Gruppen bearbeiten (ohne Gruppen und Mitgliedschaftsdaten)',
		description:
			'Gruppenzuordnung, Eintritt, Austritt, Zweitmitglied und Beitragsebenen bleiben unverändert, auch wenn sie mitgeschickt werden.',
		tags,
		permission: LED_EDIT,
		params: idParams,
		body: memberInput,
		handler: async ({ ctx, params, body }) =>
			updateMember(ctx, params.id, body, { scope: await scopeForEdit(ctx) })
	}),
	defineEndpoint({
		method: 'POST',
		path: '/led/members/:id/documents/:kind',
		summary: 'Dokument eines Mitglieds meiner Gruppen hochladen (multipart, Feld "file")',
		tags,
		permission: LED_EDIT,
		params: documentParams,
		handler: async ({ ctx, params, request }) =>
			uploadDocument(ctx, request, params.id, params.kind as DocumentKind, await scopeForEdit(ctx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/members/:id/documents/:kind',
		summary: 'Dokument eines Mitglieds meiner Gruppen herunterladen',
		tags,
		permission: LED_VIEW,
		params: documentParams,
		handler: async ({ ctx, params }) =>
			downloadDocument(ctx, params.id, params.kind as DocumentKind, await ledGroupIds(ctx))
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/led/members/:id/documents/:kind',
		summary: 'Dokument eines Mitglieds meiner Gruppen löschen',
		tags,
		permission: LED_EDIT,
		params: documentParams,
		handler: async ({ ctx, params }) =>
			deleteDocument(ctx, params.id, params.kind as DocumentKind, await scopeForEdit(ctx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/address/suggest',
		summary: 'Adressvorschläge beim Bearbeiten (Gruppenleitung)',
		tags,
		permission: LED_EDIT,
		query: addressSuggestQuery,
		rateLimit: { limit: 180, windowSec: 60 },
		handler: ({ query }) =>
			// Ohne Mitglieder-Anschriften: sonst wären Adressen außerhalb der eigenen Gruppen sichtbar
			suggestAddresses(query.q, {
				postalCode: query.postalCode,
				country: query.country,
				includeMembers: false
			})
	}),
	defineEndpoint({
		method: 'GET',
		path: '/led/address/places',
		summary: 'Orte zu einer deutschen Postleitzahl (Gruppenleitung)',
		tags,
		permission: LED_EDIT,
		query: addressPlacesQuery,
		handler: ({ query }) => ({ items: placesForPostalCode(query.postalCode) })
	})
];
