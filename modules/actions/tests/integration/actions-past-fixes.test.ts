import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
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
import { setPdfRendererForTests } from '$testing';
import { eq } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { actionsService } from '$modules/actions/service';
import type { RequestContext } from '$lib/sdk/types';
import type { AccountingPayee, AccountingState, ActionSummary } from '$modules/actions/schemas';

const BASE = '/modules/actions';
const IBAN = 'DE89 3704 0044 0532 0130 00';

let admin: RequestContext;
let ownerKey = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${ownerKey}`);
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

const as = (_who: 'owner', path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, init);

async function data<T>(res: Response, status?: number): Promise<T> {
	const body = await res.json();
	if (status) expect(res.status, JSON.stringify(body)).toBe(status);
	else expect([200, 201], JSON.stringify(body)).toContain(res.status);
	return body.data as T;
}

const PERMS = [
	'core.api.manage',
	'actions.action.view',
	'actions.action.create',
	'actions.payout.view'
];

const ctxOf = async (userId: string) => {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
};

async function createAction(extra: Record<string, unknown> = {}): Promise<ActionSummary> {
	return data<ActionSummary>(
		await as('owner', '/actions', {
			method: 'POST',
			json: {
				name: 'Lager',
				description: null,
				location: 'Wald',
				startsOn: '2026-07-10',
				startsTime: null,
				endsOn: '2026-07-17',
				endsTime: null,
				...extra
			}
		}),
		201
	);
}

async function newPayee(actionId: string, name = 'Anna Auslage'): Promise<AccountingPayee> {
	return data<AccountingPayee>(
		await as('owner', `/actions/${actionId}/accounting/payees`, {
			method: 'POST',
			json: { name, iban: IBAN, bic: 'COBADEFFXXX', note: null }
		}),
		201
	);
}

const entryBody = (over: Record<string, unknown> = {}) => ({
	type: 'expense',
	category: 'food',
	description: 'Einkauf',
	amountCents: 1000,
	entryDate: '2026-07-11',
	paidBy: 'person',
	payeeId: null,
	...over
});

const postEntry = (id: string, body: Record<string, unknown>) =>
	as('owner', `/actions/${id}/accounting/entries`, { method: 'POST', json: body });

const state = async (id: string) =>
	data<AccountingState>(await as('owner', `/actions/${id}/accounting`));

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf(u!.id);
	const roleId = await createRole(admin, { name: 'role-owner', permissions: PERMS });
	const userId = await createUser(admin, {
		name: 'Owner Test',
		email: 'owner@example.test',
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	const ctx = await ctxOf(userId);
	ownerKey = (await createApiKey(ctx, { name: 'key-owner', scopes: [...PERMS] })).key;
});

afterAll(() => setPdfRendererForTests(undefined));

const A = (id: string) => `/actions/${id}/accounting`;
const reopen = async (id: string) => data(await as('owner', `${A(id)}/reopen`, { method: 'POST' }));
const close = async (id: string) =>
	data(
		await as('owner', `${A(id)}/close`, {
			method: 'POST',
			json: { acceptMissingReceipts: true }
		}),
		201
	);
const payeeOf = async (id: string, payeeId: string) =>
	(await state(id)).payees!.find((x) => x.id === payeeId)!;

describe('Vorab erstattete Auslagen und Kassen-Rückname', () => {
	it('markReimbursed(false) lässt vorab erstattete Auslagen erstattet (kein Doppelzahlen)', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Gina');
		const upfront = await data<{ id: string }>(
			await postEntry(a.id, entryBody({ payeeId: p.id, amountCents: 1000, reimbursed: true })),
			201
		);
		await data(await postEntry(a.id, entryBody({ payeeId: p.id, amountCents: 2500 })), 201);
		expect(await payeeOf(a.id, p.id)).toMatchObject({ openCents: 2500, reimbursedCents: 1000 });
		await close(a.id);

		// Kasse zahlt nur die offene Auslage
		expect(await actionsService.markReimbursed(a.id, p.id, true)).toBe(1);
		expect(await payeeOf(a.id, p.id)).toMatchObject({ openCents: 0, reimbursedCents: 3500 });
		// Kassen-Zahlung gelöscht: nur die Kassen-Auszahlung wird wieder offen
		expect(await actionsService.markReimbursed(a.id, p.id, false)).toBe(1);
		expect(await payeeOf(a.id, p.id)).toMatchObject({ openCents: 2500, reimbursedCents: 1000 });
		const list = (await actionsService.listReimbursements()).filter((x) => x.actionId === a.id);
		expect(list.reduce((s, x) => s + x.openCents, 0)).toBe(2500);

		// Ausdrückliche Rücknahme der Person: beide wieder offen und editierbar
		await reopen(a.id);
		await data(await as('owner', `${A(a.id)}/payees/${p.id}/reimburse`, { method: 'DELETE' }));
		expect(await payeeOf(a.id, p.id)).toMatchObject({ openCents: 3500, reimbursedCents: 0 });
		const url = `${A(a.id)}/entries/${upfront.id}`;
		const put = await data<{ amountCents: number }>(
			await as('owner', url, {
				method: 'PUT',
				json: entryBody({ payeeId: p.id, amountCents: 1200 })
			})
		);
		expect(put.amountCents).toBe(1200);
		// danach ist nichts mehr "vorab": Kasse zahlt alles, Rückname setzt alles zurück
		expect(await actionsService.markReimbursed(a.id, p.id, true)).toBe(2);
		expect(await actionsService.markReimbursed(a.id, p.id, false)).toBe(2);
	});

	it('manuelles „als ausgezahlt markieren“ bleibt zurücknehmbar durch markReimbursed(false)', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Hans');
		await data(await postEntry(a.id, entryBody({ payeeId: p.id, amountCents: 700 })), 201);
		await data(await as('owner', `${A(a.id)}/payees/${p.id}/reimburse`, { method: 'POST' }));
		expect(await actionsService.markReimbursed(a.id, p.id, false)).toBe(1);
		expect(await payeeOf(a.id, p.id)).toMatchObject({ openCents: 700, reimbursedCents: 0 });
	});

	it('Export/Import: reimbursedUpfront bleibt erhalten, Round-Trip identisch', async () => {
		const a = await createAction({ name: 'Archiv' });
		const p = await newPayee(a.id, 'Ida');
		await data(
			await postEntry(a.id, entryBody({ payeeId: p.id, amountCents: 1000, reimbursed: true })),
			201
		);
		await data(await postEntry(a.id, entryBody({ payeeId: p.id, amountCents: 2500 })), 201);
		const readDoc = async (id: string) => {
			const res = await as('owner', `/actions/${id}/export`);
			expect(res.status).toBe(200);
			const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
			return JSON.parse(strFromU8(files['action.json']!)) as {
				entries: { reimbursedAt: string | null; reimbursedUpfront?: boolean }[];
			};
		};
		const first = await readDoc(a.id);
		expect(first.entries.filter((e) => e.reimbursedUpfront === true)).toHaveLength(1);
		expect(first.entries.filter((e) => e.reimbursedAt)).toHaveLength(1);
		const res = await as('owner', `/actions/${a.id}/export`);
		const fd = new FormData();
		fd.set(
			'file',
			new File([new Uint8Array(await res.arrayBuffer())], 'export.zip', { type: 'application/zip' })
		);
		const imported = await data<{ id: string }>(
			await as('owner', '/actions/import', { method: 'POST', body: fd }),
			201
		);
		const second = await readDoc(imported.id);
		expect(second.entries).toEqual(first.entries);
		// importierte vorab erstattete Auslage ist weiter geschützt
		const person = (await state(imported.id)).payees![0]!;
		expect(await actionsService.markReimbursed(imported.id, person.id, true)).toBe(1);
		expect(await actionsService.markReimbursed(imported.id, person.id, false)).toBe(1);
		expect(await payeeOf(imported.id, person.id)).toMatchObject({
			openCents: 2500,
			reimbursedCents: 1000
		});
	});
});

describe('reimbursed beim Ändern', () => {
	it('PUT mit reimbursed:true auf offener Auslage: 422 mit Pfad reimbursed; false/fehlend wirkungslos', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Jana');
		const e = await data<{ id: string }>(await postEntry(a.id, entryBody({ payeeId: p.id })), 201);
		const url = `${A(a.id)}/entries/${e.id}`;
		const put = (json: Record<string, unknown>) => as('owner', url, { method: 'PUT', json });
		const bad = await put(entryBody({ payeeId: p.id, reimbursed: true }));
		expect(bad.status).toBe(422);
		const body = await bad.json();
		expect(body.error.code).toBe('validation_failed');
		expect(JSON.stringify(body)).toContain('reimbursed');
		for (const extra of [{ reimbursed: false }, {}]) {
			const ok = await data<{ reimbursedAt: string | null }>(
				await put(entryBody({ payeeId: p.id, amountCents: 1500, ...extra }))
			);
			expect(ok.reimbursedAt).toBeNull();
		}
	});

	it('POST mit reimbursed:true bei geschlossener Abrechnung: 409', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Karl');
		await close(a.id);
		const res = await postEntry(a.id, entryBody({ payeeId: p.id, reimbursed: true }));
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('conflict');
	});
});
