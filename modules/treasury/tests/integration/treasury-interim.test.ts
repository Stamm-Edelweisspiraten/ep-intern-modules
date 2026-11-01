import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type { AccountingState } from '$modules/actions/schemas';
import type { Account, Payable, PayableList } from '$modules/treasury/schemas';
import type { ClosedAccountingItem } from '$modules/treasury/closed-accountings';

// Neues Modell: jede Zwischenabrechnung ist ein Abbild des gesamten Stands; Auslagen gehen an die
// Kasse, sobald eine ZA sie enthält oder die Abrechnung abgeschlossen ist – eine Auszahlung je
// (Aktion, Person) mit Schlüssel `reimb:<aktion>:<person>`.

// Gültige Test-IBAN (Prüfsumme korrekt)
const IBAN_PAYEE = 'DE02120300000000202051';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let giro = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${key}`);
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
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, init);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

async function reimbursementPayables(actionId: string): Promise<Payable[]> {
	await data(await T('/sync', { method: 'POST' }), 201);
	return (await data<PayableList>(await T('/payables?status=all'))).items.filter(
		(p) => p.source === 'reimbursement' && p.action?.id === actionId
	);
}

async function sourceRefs(actionId: string): Promise<Map<string, string>> {
	const res = await core.database
		.forModule('treasury')
		.transaction((tx) =>
			tx.execute(
				sql`SELECT id, source_ref FROM payables WHERE action_id = ${actionId} AND source = 'reimbursement'`
			)
		);
	const list = (res as unknown as { rows: { id: string; source_ref: string }[] }).rows;
	return new Map(list.map((r) => [r.id, r.source_ref]));
}

/** Simuliert Altdaten aus dem früheren Modell (Schlüssel je Zwischenabrechnung). */
async function setSourceRef(payableId: string, ref: string): Promise<void> {
	await core.database
		.forModule('treasury')
		.transaction((tx) =>
			tx.execute(sql`UPDATE payables SET source_ref = ${ref} WHERE id = ${payableId}`)
		);
}

async function reimbursedAt(entryId: string): Promise<unknown> {
	const res = await core.database
		.forModule('actions')
		.transaction((tx) =>
			tx.execute(sql`SELECT reimbursed_at FROM accounting_entries WHERE id = ${entryId}`)
		);
	return (res as unknown as { rows: { reimbursed_at: unknown }[] }).rows[0]!.reimbursed_at;
}

async function createAction(name: string): Promise<{ actionId: string; payeeId: string }> {
	const actionId = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name, startsOn: '2026-06-05', endsOn: '2026-06-08' }
			}),
			201
		)
	).id;
	const payeeId = (
		await data<{ id: string }>(
			await A(`/actions/${actionId}/accounting/payees`, {
				method: 'POST',
				json: { name: 'Anna Auslage', iban: IBAN_PAYEE, bic: null, note: null }
			}),
			201
		)
	).id;
	return { actionId, payeeId };
}

async function addExpense(
	actionId: string,
	payeeId: string,
	amountCents: number,
	description: string
): Promise<string> {
	return (
		await data<{ id: string }>(
			await A(`/actions/${actionId}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'food',
					description,
					amountCents,
					entryDate: '2026-05-30',
					paidBy: 'person',
					payeeId
				}
			}),
			201
		)
	).id;
}

/** Legt eine Zwischenabrechnung an und liefert ihre ID (höchste Nummer). */
async function createInterim(actionId: string): Promise<string> {
	await data(
		await A(`/actions/${actionId}/accounting/interims`, {
			method: 'POST',
			json: { acceptMissingReceipts: true }
		}),
		201
	);
	const state = await data<AccountingState>(await A(`/actions/${actionId}/accounting`));
	return [...state.interims!].sort((a, b) => b.number - a.number)[0]!.id;
}

async function pay(payableId: string, amountCents: number, bookedOn = '2026-06-02') {
	return data<Payable>(
		await T(`/payables/${payableId}/pay`, {
			method: 'POST',
			json: { accountId: giro, bookedOn, amountCents }
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
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	setTodayForTests('2026-06-01');
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;
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
	// keine weiteren Anfragen vor close() – sonst hängt PGlite
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Zwischenabrechnung → eine Auszahlung je Person', () => {
	let actionId = '';
	let payeeId = '';
	let entryA = '';
	let entryB = '';
	let interim1 = '';
	let interim2 = '';
	let payableId = '';

	it('ZA 1 gibt Auslage A frei: eine Auszahlung mit Schlüssel reimb:<aktion>:<person>', async () => {
		({ actionId, payeeId } = await createAction('Pfingstlager'));
		entryA = await addExpense(actionId, payeeId, 4250, 'Einkauf');

		// offen und ohne Zwischenabrechnung: noch keine Auszahlung
		expect(await reimbursementPayables(actionId)).toHaveLength(0);

		interim1 = await createInterim(actionId);
		const state = await data<AccountingState>(await A(`/actions/${actionId}/accounting`));
		expect(state.closed).toBeNull();
		expect(state.interims).toHaveLength(1);
		expect(state.interims![0]).toMatchObject({ number: 1, entryCount: 1, expenseCents: 4250 });

		const list = await reimbursementPayables(actionId);
		expect(list).toHaveLength(1);
		payableId = list[0]!.id;
		expect(list[0]).toMatchObject({
			amountCents: 4250,
			openCents: 4250,
			recipientName: 'Anna Auslage',
			description: 'Auslagen Pfingstlager'
		});
		expect((await sourceRefs(actionId)).get(payableId)).toBe(`reimb:${actionId}:${payeeId}`);
	});

	it('Buchungen in einer Zwischenabrechnung bleiben änderbar', async () => {
		const put = await A(`/actions/${actionId}/accounting/entries/${entryA}`, {
			method: 'PUT',
			json: {
				type: 'expense',
				category: 'food',
				description: 'Einkauf (geändert)',
				amountCents: 4250,
				entryDate: '2026-05-30',
				paidBy: 'person',
				payeeId
			}
		});
		expect(put.status).toBe(200);
	});

	it('Zahlung markiert A als erstattet', async () => {
		const paid = await pay(payableId, 4250);
		expect(paid.openCents).toBe(0);
		expect(await reimbursedAt(entryA)).not.toBeNull();
	});

	it('ZA 2 mit Auslage B: dieselbe Auszahlung wächst, A wird nicht doppelt bezahlt', async () => {
		entryB = await addExpense(actionId, payeeId, 1000, 'Nachkauf');
		// ohne Zwischenabrechnung/Abschluss noch nicht freigegeben
		expect(await reimbursementPayables(actionId)).toMatchObject([
			{ id: payableId, amountCents: 4250, openCents: 0 }
		]);

		interim2 = await createInterim(actionId);
		const state = await data<AccountingState>(await A(`/actions/${actionId}/accounting`));
		// jede Zwischenabrechnung ist ein Abbild des gesamten Stands
		expect(state.interims!.find((i) => i.id === interim2)).toMatchObject({
			number: 2,
			entryCount: 2,
			expenseCents: 5250
		});

		const list = await reimbursementPayables(actionId);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: payableId,
			amountCents: 5250,
			paidCents: 4250,
			openCents: 1000,
			cancelledAt: null
		});
		expect(await reimbursedAt(entryA)).not.toBeNull();
		expect(await reimbursedAt(entryB)).toBeNull();

		// erneuter Abgleich ändert nichts (keine Doppelzahlung von A)
		expect((await reimbursementPayables(actionId))[0]).toMatchObject({
			amountCents: 5250,
			openCents: 1000
		});
	});

	it('Rücknahme von ZA 2 zieht den offenen Teil (B) zurück', async () => {
		await data(
			await A(`/actions/${actionId}/accounting/interims/${interim2}?force=true`, {
				method: 'DELETE'
			})
		);
		const list = await reimbursementPayables(actionId);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: payableId,
			amountCents: 4250,
			paidCents: 4250,
			openCents: 0,
			cancelledAt: null
		});
		expect(await reimbursedAt(entryA)).not.toBeNull();
		expect(await reimbursedAt(entryB)).toBeNull();
	});

	it('listet die Aktion in der Kasse als zwischenabgerechnet mit PDF je Zwischenabrechnung', async () => {
		const list = await data<ClosedAccountingItem[]>(await T('/closed-accountings'));
		const item = list.find((c) => c.actionId === actionId)!;
		expect(item).toMatchObject({ status: 'interim', closedAt: null });
		expect(item.interims.map((i) => i.number)).toEqual([1]);
		// Detail gibt es erst nach dem Abschluss
		expect((await T(`/closed-accountings/${actionId}`)).status).toBe(404);

		const pdf = await T(`/closed-accountings/${actionId}/interims/${interim1}/pdf`);
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toBe('application/pdf');
		expect(
			(await T(`/closed-accountings/${actionId}/interims/${crypto.randomUUID()}/pdf`)).status
		).toBe(404);
	});

	it('Abschluss gibt B wieder frei – weiterhin dieselbe Auszahlung', async () => {
		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const list = await reimbursementPayables(actionId);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: payableId, amountCents: 5250, openCents: 1000 });

		await pay(payableId, 1000, '2026-06-10');
		expect(await reimbursedAt(entryB)).not.toBeNull();
		expect(await reimbursementPayables(actionId)).toMatchObject([
			{ id: payableId, paidCents: 5250, openCents: 0 }
		]);

		const closed = (await data<ClosedAccountingItem[]>(await T('/closed-accountings'))).find(
			(c) => c.actionId === actionId
		)!;
		expect(closed.status).toBe('closed');
		expect(closed.interims).toHaveLength(1);
	});
});

describe('Rücknahme der einzigen Zwischenabrechnung', () => {
	it('storniert die unbezahlte Auszahlung automatisch', async () => {
		const { actionId, payeeId } = await createAction('Herbstfahrt');
		await addExpense(actionId, payeeId, 2000, 'Material');
		const interimId = await createInterim(actionId);
		const [p] = await reimbursementPayables(actionId);
		expect(p).toMatchObject({ openCents: 2000, cancelledAt: null });

		await data(
			await A(`/actions/${actionId}/accounting/interims/${interimId}`, { method: 'DELETE' })
		);
		const after = (await reimbursementPayables(actionId)).find((x) => x.id === p!.id)!;
		expect(after.cancelledAt).not.toBeNull();
		expect(after.openCents).toBe(0);
	});
});

describe('Altdaten mit ZA-Schlüssel', () => {
	it('unbezahlte Alt-Auszahlung wird storniert und durch reimb:<aktion>:<person> ersetzt', async () => {
		const { actionId, payeeId } = await createAction('Altlager');
		await addExpense(actionId, payeeId, 2000, 'Zelt');
		const interimId = await createInterim(actionId);
		const [legacy] = await reimbursementPayables(actionId);
		await setSourceRef(legacy!.id, `reimb:${actionId}:${payeeId}:${interimId}`);

		const list = await reimbursementPayables(actionId);
		expect(list).toHaveLength(2);
		expect(list.find((p) => p.id === legacy!.id)!.cancelledAt).not.toBeNull();
		const refs = await sourceRefs(actionId);
		const fresh = list.find((p) => refs.get(p.id) === `reimb:${actionId}:${payeeId}`)!;
		expect(fresh).toMatchObject({ amountCents: 2000, openCents: 2000, cancelledAt: null });
	});

	it('bezahlte Alt-Auszahlung bleibt, keine neue Auszahlung für erstattete Auslagen', async () => {
		const { actionId, payeeId } = await createAction('Altfahrt');
		const entry = await addExpense(actionId, payeeId, 1500, 'Fahrkarten');
		const interimId = await createInterim(actionId);
		const [p] = await reimbursementPayables(actionId);
		await pay(p!.id, 1500, '2026-06-04');
		expect(await reimbursedAt(entry)).not.toBeNull();
		await setSourceRef(p!.id, `reimb:${actionId}:${payeeId}:${interimId}`);

		expect(await reimbursementPayables(actionId)).toMatchObject([
			{ id: p!.id, paidCents: 1500, openCents: 0, cancelledAt: null }
		]);
		expect(await reimbursedAt(entry)).not.toBeNull();
	});
});
