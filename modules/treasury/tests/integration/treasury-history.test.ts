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
import { listAudit } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type { HistoryEntry } from '$modules/treasury/history-labels';
import type { Account, InvoiceDetail, Payable, Transaction } from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let keyNoReport = '';
let giro = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}, apiKey = key) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${apiKey}`);
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
const T = (path: string, init: Parameters<typeof api>[1] = {}, apiKey = key) =>
	api(`/modules/treasury${path}`, init, apiKey);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

const history = async (kind: string, id: string, apiKey = key) =>
	(await data<{ items: HistoryEntry[] }>(await T(`/history?kind=${kind}&id=${id}`, {}, apiKey)))
		.items;

async function newInvoice(amountCents = 6000) {
	return data<InvoiceDetail>(
		await T('/invoices', {
			method: 'POST',
			json: {
				recipientName: 'Familie Schmidt',
				recipientEmail: 'schmidt@example.test',
				issuedOn: '2026-06-01',
				dueOn: '2026-06-15',
				lines: [{ description: 'Beitrag', amountCents }]
			}
		}),
		201
	);
}

async function newTransaction(amountCents: number, extra: Record<string, unknown> = {}) {
	return data<Transaction>(
		await T('/transactions', {
			method: 'POST',
			json: { accountId: giro, bookedOn: '2026-06-02', amountCents, purpose: 'Beitrag', ...extra }
		}),
		201
	);
}

const allocate = (txId: string, allocations: unknown[]) =>
	T(`/transactions/${txId}/allocations`, {
		method: 'PUT',
		json: { allocations, notify: false }
	});

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
	setTodayForTests('2026-06-01');
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	// Kasse ohne Berichtsrecht → kein Verlauf
	const perms = [...admin.permissions].filter(
		(p) => /^(treasury|actions)\./.test(p) && p !== 'treasury.report.view'
	);
	const role = await createRole(admin, {
		name: 'Ohne Bericht',
		permissions: ['core.api.manage', ...perms]
	});
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = (await contextForUser(id))!.ctx;
	keyNoReport = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;

	giro = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Audit-Filter target', () => {
	it('findet exakt nach Ziel-ID und kennt mehrere Ziele', async () => {
		const a = await newInvoice();
		const b = await newInvoice();
		const one = await listAudit({ target: a.id });
		expect(one.rows.length).toBeGreaterThan(0);
		expect(one.rows.every((r) => r.target === a.id)).toBe(true);
		const both = await listAudit({ targets: [a.id, b.id] });
		expect(new Set(both.rows.map((r) => r.target))).toEqual(new Set([a.id, b.id]));
		// Teil-ID trifft nicht (kein ILIKE)
		expect((await listAudit({ target: a.id.slice(0, 8) })).rows).toHaveLength(0);
		// leere Liste findet nichts (statt alles)
		expect((await listAudit({ targets: [] })).rows).toHaveLength(0);
	});
});

describe('Verlauf (GET /history)', () => {
	it('zeigt Rechnung und zugeordnete Buchung – ohne personenbezogene Daten', async () => {
		const inv = await newInvoice(6000);
		const t = await newTransaction(6000, { counterparty: 'Peter Schmidt' });
		await data(await allocate(t.id, [{ lineId: inv.lines[0]!.id, amountCents: 6000 }]));

		const items = await history('invoice', inv.id);
		expect(items.map((i) => i.action)).toContain('treasury.invoice.created');
		// Einträge der zugeordneten Buchung gehören mit in den Verlauf (als „related“)
		expect(items.filter((i) => i.related).map((i) => i.action)).toContain(
			'treasury.transaction.allocated'
		);
		expect(items.find((i) => i.action === 'treasury.invoice.created')!.label).toBe(
			'Rechnung angelegt'
		);
		// neueste zuerst
		const times = items.map((i) => Date.parse(i.at));
		expect(times).toEqual([...times].sort((x, y) => y - x));
		// keine Namen/Mails/IBAN
		expect(JSON.stringify(items)).not.toMatch(/Schmidt|@|DE\d{2}/);
	});

	it('Buchung: Zuordnung aufheben steht als „Zuordnung aufgehoben“ im Verlauf', async () => {
		const inv = await newInvoice(3000);
		const t = await newTransaction(3000, { purpose: 'x' });
		await data(await allocate(t.id, [{ lineId: inv.lines[0]!.id, amountCents: 3000 }]));
		await data(await allocate(t.id, []));
		const labels = (await history('transaction', t.id)).map((i) => i.label);
		expect(labels).toContain('Zuordnung aufgehoben');
		expect(labels).toContain('Buchung angelegt');
	});

	it('Rückgängig-Wege: Storno ↔ Reaktivieren, Zuordnung wiederherstellen', async () => {
		const inv = await newInvoice(2000);
		await data(
			await T(`/invoices/${inv.id}/cancel`, { method: 'POST', json: { reason: null } }),
			201
		);
		const back = await data<InvoiceDetail>(
			await T(`/invoices/${inv.id}/reactivate`, { method: 'POST', json: {} }),
			201
		);
		expect(back.status).not.toBe('cancelled');
		expect((await history('invoice', inv.id)).map((i) => i.action)).toEqual(
			expect.arrayContaining(['treasury.invoice.cancelled', 'treasury.invoice.reactivated'])
		);

		// Zuordnung: zuordnen, dann wie „Rückgängig“ die (leere) vorherige Liste zurückspielen
		const t = await newTransaction(2000, { purpose: 'y' });
		await data(await allocate(t.id, [{ lineId: inv.lines[0]!.id, amountCents: 2000 }]));
		await data(await allocate(t.id, []));
		const after = await data<Transaction>(await T(`/transactions/${t.id}`));
		expect(after.allocations).toHaveLength(0);
	});

	it('Auszahlung: Verlauf mit Storno und Wiederaufnahme', async () => {
		const p = await data<Payable>(
			await T('/payables', {
				method: 'POST',
				json: {
					recipientName: 'Jugendherberge',
					description: 'Anzahlung',
					amountCents: 10000,
					dueOn: '2026-06-20'
				}
			}),
			201
		);
		await data(
			await T(`/payables/${p.id}/cancel`, { method: 'POST', json: { cancelled: true } }),
			201
		);
		await data(
			await T(`/payables/${p.id}/cancel`, { method: 'POST', json: { cancelled: false } }),
			201
		);
		expect((await history('payable', p.id)).map((i) => i.label)).toEqual(
			expect.arrayContaining([
				'Auszahlung angelegt',
				'Auszahlung storniert',
				'Auszahlung wieder aufgenommen'
			])
		);
	});

	it('Rechte und Fehler', async () => {
		const inv = await newInvoice();
		// ohne treasury.report.view → 403
		expect((await T(`/history?kind=invoice&id=${inv.id}`, {}, keyNoReport)).status).toBe(403);
		// unbekannte ID → 404, ungültige Art/ID → 422
		expect((await T('/history?kind=invoice&id=gibt-es-nicht')).status).toBe(404);
		expect((await T(`/history?kind=member&id=${inv.id}`)).status).toBe(422);
		expect((await T('/history?kind=invoice&id=a%20b')).status).toBe(422);
		// Art und ID müssen zusammenpassen: Rechnungs-ID als Buchung → 404
		expect((await T(`/history?kind=transaction&id=${inv.id}`)).status).toBe(404);
	});
});
