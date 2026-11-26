/**
 * Autovervollständigung in Aktionen (`suggestions.endpoints.ts`):
 * - `GET /actions/:id/member-suggestions` + `POST /actions/:id/participants` mit `memberId`
 * - `GET /bank-suggestions[/:ref]` über `TreasuryService.searchBankAccounts` / `bankAccount`
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { core } from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import actionsModule from '$modules/actions/module';
import type { BankSuggestion, MemberSuggestion } from '$modules/actions/schemas';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import {
	bootstrapAdmin,
	contextForUser,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	getDb,
	handleApiRequest,
	listAudit,
	registerCoreApi,
	registerModule,
	schema,
	syncModules,
	useTestDatabase
} from '$testing';

const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let actionId: string;
let kidId: string;
let payerId: string;
let payableId: string;

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}
const A = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, { token: keys[who], ...init });
const M = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys.admin, ...init });
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, { token: keys.admin, ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

const BASE = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	owner: [...BASE, 'actions.action.create', 'members.member.view'],
	health: [...BASE, 'members.member.view', 'members.data.export'],
	nomembers: [...BASE],
	reader: [...BASE, 'members.member.view'],
	bank: [...BASE, 'actions.payout.view', 'treasury.bank.view'],
	payoutonly: [...BASE, 'actions.payout.view']
};

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	for (const [name, perms] of Object.entries(ROLES)) {
		const role = await createRole(admin, { name: `role-${name}`, permissions: perms });
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [role]
		});
		keys[name] = (await createApiKey(await ctxOf(userIds[name]!), { name, scopes: perms })).key;
	}

	kidId = (
		await data<{ id: string }>(
			await M('/members', {
				method: 'POST',
				json: {
					firstName: 'Paula',
					lastName: 'Vorschlag',
					birthDate: '2015-03-02',
					street: 'Musterweg 1',
					postalCode: '28357',
					city: 'Bremen',
					stage: 'woelfling',
					custom: { ernaehrung: 'vegetarian', allergien: 'Nüsse' }
				}
			}),
			201
		)
	).id;

	actionId = (
		await data<{ id: string }>(
			await A('owner', '/actions', {
				method: 'POST',
				json: {
					name: 'Pfingstlager',
					location: 'Wald',
					startsOn: '2026-05-23',
					endsOn: '2026-05-25'
				}
			}),
			201
		)
	).id;
	for (const [who, level] of [
		['health', 'edit'],
		['nomembers', 'edit'],
		['reader', 'read']
	] as const) {
		await data(
			await A('owner', `/actions/${actionId}/shares/${userIds[who]}`, {
				method: 'PUT',
				json: { level }
			})
		);
	}

	payerId = (
		await data<{ id: string }>(
			await T('/payers', {
				method: 'POST',
				json: {
					name: 'Familie Kontoberg',
					accountHolder: 'Karla Kontoberg',
					iban: 'DE89 3704 0044 0532 0130 00',
					bic: 'COBADEFFXXX'
				}
			}),
			201
		)
	).id;
	await data(await T('/payers', { method: 'POST', json: { name: 'Familie Kontolos' } }), 201);
	payableId = (
		await data<{ id: string }>(
			await T('/payables', {
				method: 'POST',
				json: {
					recipientName: 'Kontoberg Zeltverleih',
					description: 'Zeltmiete',
					amountCents: 5000,
					iban: 'DE02 1203 0000 0000 2020 51'
				}
			}),
			201
		)
	).id;
});

describe('GET /actions/:id/member-suggestions', () => {
	const url = (search: string) =>
		`/actions/${actionId}/member-suggestions?search=${encodeURIComponent(search)}`;

	it('liefert Mitglieder mit Stammdaten, Gesundheitsfelder nur mit Recht', async () => {
		const [s] = await data<MemberSuggestion[]>(await A('owner', url('Vorschl')));
		expect(s).toMatchObject({
			id: kidId,
			name: 'Paula Vorschlag',
			birthDate: '2015-03-02',
			bremenResident: true,
			diet: null,
			allergies: null,
			registered: false
		});
		const [h] = await data<MemberSuggestion[]>(await A('health', url('Paula')));
		expect(h).toMatchObject({ id: kidId, diet: 'vegetarian', allergies: 'Nüsse' });
	});

	it('unter 2 Zeichen leer', async () => {
		expect(await data<MemberSuggestion[]>(await A('owner', url('P')))).toEqual([]);
	});

	it('ohne members.member.view → 403, nur Lesezugriff → 403', async () => {
		expect((await A('nomembers', url('Paula'))).status).toBe(403);
		expect((await A('reader', url('Paula'))).status).toBe(403);
	});

	it('Übernahme verknüpft das Mitglied, doppelt → 409, danach `registered`', async () => {
		const body = { name: 'Paula Vorschlag', role: 'participant', memberId: kidId };
		await data(
			await A('owner', `/actions/${actionId}/participants`, { method: 'POST', json: body }),
			201
		);
		const [row] = await core.database.forModule('actions').transaction(async (tx) => {
			const r = (await tx.execute(
				sql`SELECT member_id FROM action_participants WHERE action_id = ${actionId}`
			)) as unknown as { rows: Record<string, unknown>[] };
			return r.rows;
		});
		expect(row?.member_id).toBe(kidId);
		expect(
			(await A('owner', `/actions/${actionId}/participants`, { method: 'POST', json: body })).status
		).toBe(409);
		const [s] = await data<MemberSuggestion[]>(await A('owner', url('Paula')));
		expect(s?.registered).toBe(true);
	});

	it('memberId ohne Recht → 403, unbekannt → 404', async () => {
		const body = (memberId: string) => ({ name: 'X Y', role: 'participant', memberId });
		expect(
			(
				await A('nomembers', `/actions/${actionId}/participants`, {
					method: 'POST',
					json: body(kidId)
				})
			).status
		).toBe(403);
		expect(
			(
				await A('owner', `/actions/${actionId}/participants`, {
					method: 'POST',
					json: body('gibt-es-nicht')
				})
			).status
		).toBe(404);
	});
});

describe('GET /bank-suggestions', () => {
	it('liefert Zahler und Auszahlungs-Empfänger nur maskiert', async () => {
		const res = await A('bank', '/bank-suggestions?search=Kontoberg');
		const text = await res.clone().text();
		const list = await data<BankSuggestion[]>(res);
		expect(list.map((s) => s.ref).sort()).toEqual(
			[`payable:${payableId}`, `payer:${payerId}`].sort()
		);
		expect(list.find((s) => s.kind === 'payer')).toMatchObject({
			name: 'Familie Kontoberg',
			holder: 'Karla Kontoberg',
			bic: 'COBADEFFXXX'
		});
		expect(text).not.toContain('DE89370400440532013000');
		expect(text).not.toContain('3704');
		// Zahler ohne IBAN wird nicht vorgeschlagen
		expect(
			await data<BankSuggestion[]>(await A('bank', '/bank-suggestions?search=Kontolos'))
		).toEqual([]);
	});

	it('ohne treasury.bank.view oder actions.payout.view → 403', async () => {
		expect((await A('payoutonly', '/bank-suggestions?search=Kontoberg')).status).toBe(403);
		expect((await A('owner', '/bank-suggestions?search=Kontoberg')).status).toBe(403);
		expect((await A('payoutonly', `/bank-suggestions/payer:${payerId}`)).status).toBe(403);
	});

	it('Klartext einzeln, no-store, auditiert ohne IBAN', async () => {
		const res = await A('bank', `/bank-suggestions/payer:${payerId}`);
		expect(res.headers.get('cache-control')).toContain('no-store');
		expect(await data(res)).toEqual({
			holder: 'Karla Kontoberg',
			iban: 'DE89 3704 0044 0532 0130 00',
			bic: 'COBADEFFXXX'
		});
		expect(await data(await A('bank', `/bank-suggestions/payable:${payableId}`))).toMatchObject({
			holder: 'Kontoberg Zeltverleih',
			iban: 'DE02 1203 0000 0000 2020 51'
		});
		const ev = (await listAudit({ limit: 100 })).rows.filter(
			(e) => e.action === 'actions.accounting.treasury_iban_viewed'
		);
		expect(ev.map((e) => e.target).sort()).toEqual(
			[`payable:${payableId}`, `payer:${payerId}`].sort()
		);
		expect(JSON.stringify(ev)).not.toContain('DE89');
	});

	it('unbekannter Verweis → 404', async () => {
		expect((await A('bank', '/bank-suggestions/payer:gibt-es-nicht')).status).toBe(404);
		expect((await A('bank', '/bank-suggestions/unsinn')).status).toBe(404);
	});
});
