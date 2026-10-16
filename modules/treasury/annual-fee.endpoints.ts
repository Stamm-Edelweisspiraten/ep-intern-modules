/** REST-Endpunkte Jahresbeitrag (`/annual-fees…`) */
import { core, type ApiEndpoint, type RequestContext } from '$lib/sdk/server';
import {
	createRun,
	deleteRun,
	getRun,
	listRuns,
	previewMail,
	previewPdf,
	previewRun,
	resendRun,
	scheduleRun,
	sendRun,
	updateRun,
	type AnnualMode
} from './annual-fee.service';
import {
	annualPreviewQuery,
	annualRunInput,
	annualRunUpdate,
	annualScheduleInput,
	idParams,
	type AnnualRunInput,
	type AnnualRunUpdate
} from './schemas';

const TAGS = ['Modul: treasury'];
const VIEW = 'treasury.annual-fee.view';
const MANAGE = 'treasury.annual-fee.manage';
/** Teure Aufrufe (PDF, Versand) begrenzen */
const HEAVY_LIMIT = { limit: 30, windowSec: 60 };

type Id = { id: string };
type PreviewQuery = { mode?: AnnualMode; key?: string };

/** Lesen braucht zusaetzlich das Kassen-Basisrecht (Namen, Betraege, Zahler) */
const requireCashView = (ctx: RequestContext) =>
	core.permissions.require(ctx, 'treasury.cash.view');
/** Versand, Planung und Nachberechnung verschicken Rechnungen */
const requireSend = (ctx: RequestContext) => core.permissions.require(ctx, 'treasury.invoice.send');

export const annualFeeEndpoints = [
	{
		method: 'GET',
		path: '/annual-fees',
		summary: 'Beitragslaeufe (Jahresbeitrag) auflisten',
		tags: TAGS,
		permission: VIEW,
		handler: async ({ ctx }) => {
			await requireCashView(ctx);
			return listRuns();
		}
	},
	{
		method: 'POST',
		path: '/annual-fees',
		summary: 'Beitragslauf fuer ein Jahr anlegen (Stichtag = heute)',
		tags: TAGS,
		permission: MANAGE,
		body: annualRunInput,
		handler: ({ ctx, body }) => createRun(ctx, (body as AnnualRunInput).year)
	},
	{
		method: 'GET',
		path: '/annual-fees/:id',
		summary: 'Beitragslauf',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await requireCashView(ctx);
			return getRun((params as Id).id);
		}
	},
	{
		method: 'PUT',
		path: '/annual-fees/:id',
		summary:
			'Beitragslauf aendern (Frist, Saetze, Texte; nicht nach dem Versand; geplanter Versand wird zurueckgenommen)',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		body: annualRunUpdate,
		handler: ({ ctx, params, body }) => updateRun(ctx, (params as Id).id, body as AnnualRunUpdate)
	},
	{
		method: 'DELETE',
		path: '/annual-fees/:id',
		summary: 'Beitragslauf loeschen (nur Entwurf/geplant)',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await deleteRun(ctx, (params as Id).id);
			return null;
		}
	},
	{
		method: 'GET',
		path: '/annual-fees/:id/preview',
		summary:
			'Vorschau der Rechnungen (mode=run|catch-up; versendet → catch-up; Adressen nur mit invoice.send/edit)',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		query: annualPreviewQuery,
		handler: async ({ ctx, params, query }) => {
			await requireCashView(ctx);
			return previewRun(ctx, (params as Id).id, (query as PreviewQuery).mode);
		}
	},
	{
		method: 'GET',
		path: '/annual-fees/:id/preview.pdf',
		summary: 'PDF-Vorschau einer geplanten Rechnung (nichts wird gespeichert)',
		tags: TAGS,
		permission: VIEW,
		rateLimit: HEAVY_LIMIT,
		params: idParams,
		query: annualPreviewQuery,
		handler: async ({ ctx, params, query }) => {
			await requireCashView(ctx);
			const q = query as PreviewQuery;
			return previewPdf(ctx, (params as Id).id, q.mode, q.key);
		}
	},
	{
		method: 'GET',
		path: '/annual-fees/:id/preview-mail',
		summary: 'Mail-Vorschau einer geplanten Rechnung (Empfaenger nur mit invoice.send/edit)',
		tags: TAGS,
		permission: VIEW,
		params: idParams,
		query: annualPreviewQuery,
		handler: async ({ ctx, params, query }) => {
			await requireCashView(ctx);
			const q = query as PreviewQuery;
			return previewMail(ctx, (params as Id).id, q.mode, q.key);
		}
	},
	{
		method: 'POST',
		path: '/annual-fees/:id/send',
		summary: 'Beitragslauf jetzt versenden (Rechnungen anlegen + Mails mit PDF)',
		tags: TAGS,
		permission: MANAGE,
		rateLimit: HEAVY_LIMIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await requireSend(ctx);
			return sendRun(ctx, (params as Id).id, 'run');
		}
	},
	{
		method: 'POST',
		path: '/annual-fees/:id/resend',
		summary:
			'Versand wiederholen: Rechnungen des Laufs ohne zugestellte Fassung erneut senden (nach Mailfehlern)',
		tags: TAGS,
		permission: MANAGE,
		rateLimit: HEAVY_LIMIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await requireSend(ctx);
			return resendRun(ctx, (params as Id).id);
		}
	},
	{
		method: 'POST',
		path: '/annual-fees/:id/schedule',
		summary: 'Versand planen (Datum ab heute; der stuendliche Job versendet)',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		body: annualScheduleInput,
		handler: async ({ ctx, params, body }) => {
			await requireSend(ctx);
			return scheduleRun(ctx, (params as Id).id, (body as { sendOn: string }).sendOn);
		}
	},
	{
		method: 'POST',
		path: '/annual-fees/:id/unschedule',
		summary: 'Geplanten Versand zuruecknehmen (wieder Entwurf)',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await requireSend(ctx);
			return scheduleRun(ctx, (params as Id).id, null);
		}
	},
	{
		method: 'POST',
		path: '/annual-fees/:id/catch-up',
		summary: 'Nachberechnung: noch nicht abgerechnete Mitglieder des Jahres (nach dem Versand)',
		tags: TAGS,
		permission: MANAGE,
		rateLimit: HEAVY_LIMIT,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await requireSend(ctx);
			return sendRun(ctx, (params as Id).id, 'catch-up');
		}
	}
] as ApiEndpoint[];
