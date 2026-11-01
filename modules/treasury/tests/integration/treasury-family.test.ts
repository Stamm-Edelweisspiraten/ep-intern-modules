import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setMailTransportForTests } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type { Account, FamilyAccount, InvoiceDetail, Payer } from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let weakKey = '';

function api(path: string, init: RequestInit & { json?: unknown; token?: string } = {}) {
	const { json, token, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${token ?? key}`);
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
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, init);

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const memberIds: Record<string, string> = {};
let payer: Payer;
let giro = '';
let invLena: InvoiceDetail;
let invJonas: InvoiceDetail;
let invOle: InvoiceDetail;
let paymentId = '';

async function createMember(firstName: string, lastName: string, birthDate: string) {
	const m = await data<{ id: string }>(
		await api('/modules/members/members', {
			method: 'POST',
			json: {
				firstName,
				lastName,
				birthDate,
				street: 'Lindenweg 4',
				postalCode: '28195',
				city: 'Bremen',
				stage: 'woelfling',
				emails: [
					{
						name: 'Eltern',
						value: `familie.${lastName.toLowerCase().replace('ü', 'ue')}@example.test`
					}
				]
			}
		}),
		201
	);
	memberIds[firstName] = m.id;
}

async function createInvoice(name: string, memberId: string, amountCents: number) {
	return data<InvoiceDetail>(
		await T('/invoices', {
			method: 'POST',
			json: {
				recipientName: name,
				issuedOn: '2026-05-01',
				dueOn: '2026-05-20',
				lines: [{ description: `Sommerlager ${name}`, amountCents, memberId }]
			}
		}),
		201
	);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
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
	admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setMailTransportForTests({ sendMail: async () => undefined });
	setTodayForTests('2026-06-01');

	const perms = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const role = await createRole(admin, {
		name: 'Kasse',
		permissions: ['core.api.manage', ...perms]
	});
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = (await contextForUser(id))!.ctx;
	key = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;

	// Schlüssel desselben Benutzers ohne treasury.cash.view
	weakKey = (
		await createApiKey(ctx, {
			name: 'w',
			scopes: [...ctx.permissions].filter((p) => p !== 'treasury.cash.view')
		})
	).key;

	await createMember('Lena', 'Müller', '2015-03-12');
	await createMember('Jonas', 'Müller', '2013-08-02');
	await createMember('Ole', 'Hansen', '2014-01-09');

	giro = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;
	payer = await data<Payer>(
		await T('/payers', {
			method: 'POST',
			json: {
				name: 'Familie Müller',
				email: 'familie.mueller@example.test',
				memberIds: [memberIds.Lena, memberIds.Jonas]
			}
		}),
		201
	);
	invLena = await createInvoice('Lena Müller', memberIds.Lena!, 10000);
	invJonas = await createInvoice('Jonas Müller', memberIds.Jonas!, 8000);
	invOle = await createInvoice('Ole Hansen', memberIds.Ole!, 4000);

	// Sammelzahlung für beide Geschwister (ohne Zahler an der Buchung)
	paymentId = (
		await data<{ id: string }>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: giro,
					bookedOn: '2026-05-10',
					amountCents: 15000,
					counterparty: 'Petra Müller',
					purpose: 'Sommerlager Lena und Jonas',
					notify: false,
					allocations: [
						{ lineId: invLena.lines[0]!.id, amountCents: 10000 },
						{ lineId: invJonas.lines[0]!.id, amountCents: 5000 }
					]
				}
			}),
			201
		)
	).id;
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Familienkonto', () => {
	it('verweigert ohne treasury.cash.view', async () => {
		const res = await T(`/family-account?payerId=${payer.id}`, { token: weakKey });
		expect(res.status).toBe(403);
	});

	it('zeigt Rechnungen, Sammelzahlung und Summen eines Zahlers', async () => {
		const acc = await data<FamilyAccount>(await T(`/family-account?payerId=${payer.id}`));
		expect(acc.payer?.id).toBe(payer.id);
		expect(acc.name).toBe('Familie Müller');
		expect(acc.members.map((m) => m.id).sort()).toEqual([memberIds.Lena, memberIds.Jonas].sort());
		expect(acc.invoices.map((i) => i.id).sort()).toEqual([invLena.id, invJonas.id].sort());
		expect(acc.invoices.find((i) => i.id === invOle.id)).toBeUndefined();
		expect(acc.payments.map((p) => p.id)).toEqual([paymentId]);
		expect(acc.payments[0]!.amountCents).toBe(15000);
		expect(acc.totals).toEqual({
			openCents: 3000,
			overdueCents: 3000,
			paidCents: 15000,
			creditCents: 0,
			payableOpenCents: 0
		});
		expect(acc.payer?.openCents).toBe(3000);
		expect(acc.payables).toEqual([]);
	});

	it('liefert für ein Mitglied des Zahlers dasselbe Familienkonto', async () => {
		const acc = await data<FamilyAccount>(await T(`/family-account?memberId=${memberIds.Jonas}`));
		expect(acc.payer?.id).toBe(payer.id);
		expect(acc.invoices).toHaveLength(2);
		expect(acc.payments).toHaveLength(1);
	});

	it('liefert für ein Mitglied ohne Zahler nur dessen Rechnungen', async () => {
		const acc = await data<FamilyAccount>(await T(`/family-account?memberId=${memberIds.Ole}`));
		expect(acc.payer).toBeNull();
		expect(acc.name).toBe('Ole Hansen');
		expect(acc.members.map((m) => m.id)).toEqual([memberIds.Ole]);
		expect(acc.invoices.map((i) => i.id)).toEqual([invOle.id]);
		expect(acc.payments).toEqual([]);
		expect(acc.totals.openCents).toBe(4000);
	});

	it('antwortet 404 bei unbekannter ID', async () => {
		const unknown = crypto.randomUUID();
		for (const q of [`payerId=${unknown}`, `memberId=${unknown}`]) {
			const res = await T(`/family-account?${q}`);
			expect(res.status).toBe(404);
			expect((await res.json()).error.code).toBe('not_found');
		}
	});

	it('verlangt genau einen Parameter', async () => {
		for (const q of ['', `?payerId=${payer.id}&memberId=${memberIds.Ole}`]) {
			const res = await T(`/family-account${q}`);
			expect([400, 422]).toContain(res.status);
		}
		// Abschließend eine gültige Anfrage: nach einem Validierungsfehler als letzter Anfrage
		// hängt sonst das Schließen der PGlite-Datenbank (nicht abgewartetes Zugriffsprotokoll)
		expect((await T(`/family-account?payerId=${payer.id}`)).status).toBe(200);
	});
});
