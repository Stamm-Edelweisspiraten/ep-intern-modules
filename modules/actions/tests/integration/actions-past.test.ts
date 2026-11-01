import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { getDb, schema } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$lib/sdk/server';
import { eq, sql } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { actionsService } from '$modules/actions/service';
import type { RequestContext } from '$lib/sdk/types';
import type { AccountingPayee, AccountingState, ActionSummary } from '$modules/actions/schemas';

const BASE = '/modules/actions';
const IBAN = 'DE89 3704 0044 0532 0130 00';
const IBAN_PLAIN = 'DE89370400440532013000';

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

const mdb = () => core.database.forModule('actions');

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

describe('Aktion liegt in der Vergangenheit (isPast)', () => {
	it('Standard false; setzen, Liste und Detail; PUT ohne Feld lässt den Wert', async () => {
		const plain = await createAction();
		expect(plain.isPast).toBe(false);
		const past = await createAction({ name: 'Alt', isPast: true });
		expect(past.isPast).toBe(true);

		const detail = await data<ActionSummary>(await as('owner', `/actions/${past.id}`));
		expect(detail.isPast).toBe(true);
		const list = await data<{ items: ActionSummary[] }>(await as('owner', '/actions?limit=200'));
		expect(list.items.find((a) => a.id === past.id)?.isPast).toBe(true);
		expect(list.items.find((a) => a.id === plain.id)?.isPast).toBe(false);

		const body = {
			name: 'Alt 2',
			description: null,
			location: null,
			startsOn: '2026-07-10',
			startsTime: null,
			endsOn: null,
			endsTime: null
		};
		const kept = await data<ActionSummary>(
			await as('owner', `/actions/${past.id}`, { method: 'PUT', json: body })
		);
		expect(kept.isPast).toBe(true);
		expect(kept.name).toBe('Alt 2');
		const off = await data<ActionSummary>(
			await as('owner', `/actions/${past.id}`, { method: 'PUT', json: { ...body, isPast: false } })
		);
		expect(off.isPast).toBe(false);
		const on = await data<ActionSummary>(
			await as('owner', `/actions/${plain.id}`, { method: 'PUT', json: { ...body, isPast: true } })
		);
		expect(on.isPast).toBe(true);
	});

	it('lehnt Nicht-Boolean mit 422 ab; Audit enthält isPast', async () => {
		const res = await as('owner', '/actions', {
			method: 'POST',
			json: {
				name: 'X',
				description: null,
				location: null,
				startsOn: '2026-07-10',
				startsTime: null,
				endsOn: null,
				endsTime: null,
				isPast: 'ja'
			}
		});
		expect(res.status).toBe(422);
		const a = await createAction({ name: 'Audit', isPast: true });
		const audit = (await listAudit({ limit: 200 })).rows.find(
			(e) => e.action === 'actions.action.created' && e.target === a.id
		);
		expect(JSON.stringify(audit?.metadata)).toContain('"isPast":true');
	});

	it('listReceivableSources liefert isPast', async () => {
		const a = await createAction({ name: 'Forderung', isPast: true });
		await mdb().transaction(async (tx) => {
			await tx.execute(
				sql`UPDATE actions SET fee_cents = 1000, fee_applied_at = now() WHERE id = ${a.id}`
			);
		});
		const found = await actionsService.listReceivableSources({ actionIds: [a.id] });
		expect(found).toHaveLength(1);
		expect(found[0]!.isPast).toBe(true);
		await mdb().transaction(async (tx) => {
			await tx.execute(sql`UPDATE actions SET is_past = false WHERE id = ${a.id}`);
		});
		expect((await actionsService.listReceivableSources({ actionIds: [a.id] }))[0]!.isPast).toBe(
			false
		);
	});

	it('Export/Import: Round-Trip mit isPast und altes Archiv ohne Feld', async () => {
		const a = await createAction({ name: 'Archiv', isPast: true });
		const exp = async (id: string) => {
			const res = await as('owner', `/actions/${id}/export`);
			expect(res.status).toBe(200);
			return new Uint8Array(await res.arrayBuffer());
		};
		const imp = async (bytes: Uint8Array) => {
			const fd = new FormData();
			fd.set('file', new File([new Uint8Array(bytes)], 'export.zip', { type: 'application/zip' }));
			return data<{ id: string }>(
				await as('owner', '/actions/import', { method: 'POST', body: fd }),
				201
			);
		};
		const zip1 = await exp(a.id);
		const files = unzipSync(zip1);
		const doc1 = JSON.parse(strFromU8(files['action.json']!));
		expect(doc1.action.isPast).toBe(true);
		const imported = await imp(zip1);
		expect((await data<ActionSummary>(await as('owner', `/actions/${imported.id}`))).isPast).toBe(
			true
		);
		const doc2 = JSON.parse(strFromU8(unzipSync(await exp(imported.id))['action.json']!));
		expect(doc2).toEqual(doc1);

		// altes Archiv: Feld entfernen
		delete doc1.action.isPast;
		const old = zipSync({ ...files, 'action.json': strToU8(JSON.stringify(doc1)) });
		const importedOld = await imp(old);
		expect(
			(await data<ActionSummary>(await as('owner', `/actions/${importedOld.id}`))).isPast
		).toBe(false);
	});
});

describe('Auslage bereits erstattet (reimbursed)', () => {
	it('POST setzt reimbursedAt; nicht erstattet bleibt offen', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Anna');
		const r = await data<{ id: string; reimbursedAt: string | null }>(
			await postEntry(a.id, entryBody({ payeeId: p.id, reimbursed: true })),
			201
		);
		expect(r.reimbursedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const open = await data<{ reimbursedAt: string | null }>(
			await postEntry(a.id, entryBody({ payeeId: p.id, amountCents: 700 })),
			201
		);
		expect(open.reimbursedAt).toBeNull();

		const s = await state(a.id);
		const payee = s.payees!.find((x) => x.id === p.id)!;
		expect(payee.openCents).toBe(700);
		expect(payee.reimbursedCents).toBe(1000);
		expect(payee.openEntries).toBe(1);
		expect(s.summary.openReimbursementCents).toBe(700);
		expect(s.summary.expenseCents).toBe(1700);
	});

	it('nur offene Auslagen in payouts.csv, Summen und listReimbursements nach Abschluss', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Berta');
		const q = await newPayee(a.id, 'Clara');
		await data(await postEntry(a.id, entryBody({ payeeId: p.id, reimbursed: true })), 201);
		await data(await postEntry(a.id, entryBody({ payeeId: q.id, reimbursed: true })), 201);
		await data(await postEntry(a.id, entryBody({ payeeId: q.id, amountCents: 300 })), 201);

		const csv = await (await as('owner', `/actions/${a.id}/accounting/payouts.csv`)).text();
		expect(csv).not.toContain('Berta');
		expect(csv).toContain('Clara');
		expect(csv).toContain('3,00');

		await data(
			await as('owner', `/actions/${a.id}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const mine = (await actionsService.listReimbursements()).filter((x) => x.actionId === a.id);
		const berta = mine.find((x) => x.payeeId === p.id)!;
		expect(berta.openCents).toBe(0);
		expect(berta.totalCents).toBe(1000);
		const clara = mine.find((x) => x.payeeId === q.id)!;
		expect(clara.openCents).toBe(300);
		expect(clara.totalCents).toBe(1300);

		let html = '';
		setPdfRendererForTests(async (h) => {
			html = h;
			return new TextEncoder().encode('%PDF-fake');
		});
		expect((await as('owner', `/actions/${a.id}/accounting/report.pdf`)).status).toBe(200);
		expect(html).toContain('Berta');
	});

	it('reimbursed bei Einnahme oder Stamm-Ausgabe: 422 mit Pfad reimbursed', async () => {
		const a = await createAction();
		const bad = [
			entryBody({ type: 'income', category: 'contributions', paidBy: 'club', reimbursed: true }),
			entryBody({ paidBy: 'club', reimbursed: true })
		];
		for (const b of bad) {
			const res = await postEntry(a.id, b);
			const body = await res.json();
			expect(res.status, JSON.stringify(body)).toBe(422);
			expect(JSON.stringify(body)).toContain('reimbursed');
		}
		expect((await state(a.id)).entries).toHaveLength(0);
	});

	it('PUT/DELETE auf erstattete Auslage 409; Rücknahme macht sie editierbar', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Dora');
		const e = await data<{ id: string }>(
			await postEntry(a.id, entryBody({ payeeId: p.id, reimbursed: true })),
			201
		);
		const url = `/actions/${a.id}/accounting/entries/${e.id}`;
		const put = (json: Record<string, unknown>) => as('owner', url, { method: 'PUT', json });
		expect((await put(entryBody({ payeeId: p.id, amountCents: 2000 }))).status).toBe(409);
		expect((await as('owner', url, { method: 'DELETE' })).status).toBe(409);

		await data(
			await as('owner', `/actions/${a.id}/accounting/payees/${p.id}/reimburse`, {
				method: 'DELETE'
			})
		);
		// PUT mit reimbursed:true auf offenem Eintrag: 422 (siehe actions-past-fixes.test.ts)
		const upd = await data<{ amountCents: number; reimbursedAt: string | null }>(
			await put(entryBody({ payeeId: p.id, amountCents: 2000 }))
		);
		expect(upd.amountCents).toBe(2000);
		expect(upd.reimbursedAt).toBeNull();
		await data(await as('owner', url, { method: 'DELETE' }));
	});

	it('Audit ohne personenbezogene Daten', async () => {
		const a = await createAction();
		const p = await newPayee(a.id, 'Emil Geheim');
		const e = await data<{ id: string }>(
			await postEntry(a.id, entryBody({ payeeId: p.id, reimbursed: true })),
			201
		);
		const audit = (await listAudit({ limit: 300 })).rows.find(
			(x) => x.action === 'actions.accounting.entry_created' && x.target === a.id
		);
		const meta = JSON.stringify(audit?.metadata);
		expect(meta).toContain('"reimbursed":true');
		expect(meta).toContain(e.id);
		expect(meta).not.toContain('Emil');
		expect(meta).not.toContain(IBAN_PLAIN);
	});
});
