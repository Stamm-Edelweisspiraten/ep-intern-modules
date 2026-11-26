/**
 * Autovervollständigung in der Aktions-Oberfläche:
 * - `GET /actions/:id/member-suggestions` – Mitglieder beim manuellen Anlegen von Teilnehmenden
 *   (Bearbeiten-Zugriff + `members.member.view`; Ernährung/Allergien nur mit Gesundheitsrecht).
 * - `GET /bank-suggestions[/:ref]` – Bankverbindungen aus der Kasse (Empfänger, Stamm-Ausgaben);
 *   braucht `actions.payout.view` UND `treasury.bank.view`, Klartext wird auditiert.
 * Dienste von `members`/`treasury` immer AUSSERHALB der Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	moduleDb,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import type { MembersService } from '$modules/members/contract';
import type { TreasuryService } from '$modules/treasury/contract';
import { requireAccess } from './access';
import { isBremenCity } from './form-support';
import { canSeeHealth } from './health';
import {
	type BankSuggestion,
	DIETS,
	type Diet,
	idParams,
	type MemberSuggestion,
	MODULE_ID,
	suggestionQuery
} from './schemas';

const TAGS = ['Modul: actions'];
const SEARCH_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;
const MEMBER_VIEW = 'members.member.view';
const PAYOUT_VIEW = 'actions.payout.view';
const TREASURY_BANK_VIEW = 'treasury.bank.view';

const membersService = () => core.modules.use<MembersService>('members', MODULE_ID);
const treasuryService = () => core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);

/** Darf die Person Kontodaten aus der Kasse übernehmen? */
export function canUseTreasuryBank(ctx: RequestContext): boolean {
	return core.permissions.has(ctx, PAYOUT_VIEW) && core.permissions.has(ctx, TREASURY_BANK_VIEW);
}

function customText(v: unknown, max: number): string | null {
	if (typeof v === 'string') return v.trim().slice(0, max) || null;
	if (Array.isArray(v)) return v.map(String).join(', ').slice(0, max) || null;
	return null;
}

export const suggestionEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/actions/:id/member-suggestions',
		summary: 'Mitglieder als Vorschläge für neue Teilnehmende',
		description:
			'Ab 2 Zeichen (Vor-, Nach-, Pfadname, ohne Ausgetretene), höchstens 10. Braucht Bearbeiten-Zugriff auf die Aktion ' +
			'und `members.member.view` (sonst 403). Ernährung/Allergien nur mit `members.data.export`.',
		tags: TAGS,
		permission: 'actions.action.view',
		rateLimit: SEARCH_RATE_LIMIT,
		params: idParams,
		query: suggestionQuery,
		handler: async ({ ctx, params, query }): Promise<MemberSuggestion[]> => {
			const id = params.id;
			await moduleDb(MODULE_ID).transaction((tx) => requireAccess(tx, ctx, id, 'edit'));
			if (!core.permissions.has(ctx, MEMBER_VIEW)) {
				throw errors.forbidden('Keine Berechtigung, Mitglieder zu sehen');
			}
			if (query.search.length < 2) return [];
			const svc = await membersService();
			const found = await svc.searchMembers({ search: query.search, limit: 10 });
			if (!found.length) return [];
			const sheets = await svc.listMemberSheets(found.map((m) => m.id));
			const ids = sheets.map((s) => s.id);
			const registered = new Set(
				(
					await moduleDb(MODULE_ID).transaction((tx) =>
						rowsOf(
							tx,
							sql`SELECT member_id FROM action_participants WHERE action_id = ${id}
								AND member_id IN (${sql.join(
									ids.map((v) => sql`${v}`),
									sql`, `
								)})`
						)
					)
				).map((r) => String(r.member_id))
			);
			const health = canSeeHealth(ctx);
			return sheets.map((m) => {
				const diet = m.custom.ernaehrung;
				const groups = m.groups.map((g) => g.name).join(', ');
				return {
					id: m.id,
					name: `${m.firstName} ${m.lastName}`.replace(/\s+/g, ' ').trim(),
					groupLabel: groups ? groups.slice(0, 150) : null,
					birthDate: m.birthDate || null,
					bremenResident: isBremenCity(m.city, m.country),
					diet:
						health && typeof diet === 'string' && (DIETS as readonly string[]).includes(diet)
							? (diet as Diet)
							: null,
					allergies: health ? customText(m.custom.allergien, 1000) : null,
					registered: registered.has(m.id)
				};
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/bank-suggestions',
		summary: 'Bankverbindungen aus der Kasse vorschlagen (maskiert)',
		description:
			'Zahler mit IBAN und Empfänger*innen manueller Auszahlungen der Kasse, ab 2 Zeichen. Braucht `actions.payout.view` ' +
			'und `treasury.bank.view` (sonst 403); ohne Kasse leer.',
		tags: TAGS,
		permission: 'actions.action.view',
		rateLimit: SEARCH_RATE_LIMIT,
		query: suggestionQuery,
		handler: async ({ ctx, query }): Promise<BankSuggestion[]> => {
			if (!canUseTreasuryBank(ctx))
				throw errors.forbidden('Keine Berechtigung für Kontodaten der Kasse');
			const svc = await treasuryService();
			if (!svc || query.search.length < 2) return [];
			return svc.searchBankAccounts({ search: query.search, limit: 10 });
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/bank-suggestions/:ref',
		summary: 'Bankverbindung aus der Kasse im Klartext (auditiert)',
		tags: TAGS,
		permission: 'actions.action.view',
		rateLimit: SEARCH_RATE_LIMIT,
		params: z.object({ ref: z.string().min(1).max(120) }),
		handler: async ({ ctx, params }) => {
			if (!canUseTreasuryBank(ctx))
				throw errors.forbidden('Keine Berechtigung für Kontodaten der Kasse');
			const svc = await treasuryService();
			const account = svc ? await svc.bankAccount(params.ref) : null;
			if (!account) throw errors.notFound('Bankverbindung nicht gefunden');
			// Nur der Verweis, keine IBAN/Namen im Audit
			await core.audit.logFromContext(ctx, 'actions.accounting.treasury_iban_viewed', {
				target: params.ref
			});
			return new Response(JSON.stringify({ data: account }), {
				status: 200,
				headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' }
			});
		}
	})
];
