import { core, defineEndpoint, errors, type ApiEndpoint } from '$lib/sdk/server';
import { buildGroupSheets, buildMemberSheets, getMemberCatalog } from './sheets.service';
import { groupSheetsInput, memberSheetsInput } from './schemas';

const tags = ['Mitglieder'];
const EXPORT = 'members.data.export';

const pdfResponse = (r: { buffer: Uint8Array; fileName: string }) =>
	new Response(Buffer.from(r.buffer), {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="${r.fileName}"`,
			'cache-control': 'private, no-store'
		}
	});

export const sheetEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/members/sheet-columns',
		summary: 'Spalten und Voreinstellungen der Mitglieder-Listen (PDF)',
		tags,
		permission: EXPORT,
		handler: async () => getMemberCatalog()
	}),
	defineEndpoint({
		method: 'POST',
		path: '/members/sheets.pdf',
		summary: 'Mitgliedsdaten ausgewählter Mitglieder als PDF (inkl. Gesundheitsangaben)',
		tags,
		permission: EXPORT,
		body: memberSheetsInput,
		handler: async ({ ctx, body }) => {
			if (!core.permissions.has(ctx, 'members.member.view')) {
				throw errors.forbidden('Keine Berechtigung, Mitglieder zu sehen');
			}
			return pdfResponse(await buildMemberSheets(ctx, body.ids, body.selection));
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/groups/sheets.pdf',
		summary: 'Mitgliedsdaten aller Mitglieder ausgewählter Gruppen als PDF (Seite je Gruppe)',
		tags,
		permission: EXPORT,
		body: groupSheetsInput,
		handler: async ({ ctx, body }) => {
			if (
				!core.permissions.has(ctx, 'members.member.view') ||
				!core.permissions.has(ctx, 'members.group.view')
			) {
				throw errors.forbidden('Keine Berechtigung, Mitglieder und Gruppen zu sehen');
			}
			return pdfResponse(await buildGroupSheets(ctx, body.groupIds, body.selection));
		}
	})
] as ApiEndpoint[];
