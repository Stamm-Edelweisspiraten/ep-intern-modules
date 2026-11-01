import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
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
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { actionsService } from '$modules/actions/service';
import { loadInterimSnapshot } from '$modules/actions/accounting-core';
import type { RequestContext } from '$lib/sdk/types';
import type {
	AccountingEntry,
	AccountingInterim,
	AccountingState,
	EntryFormInput
} from '$modules/actions/schemas';

const BASE = '/modules/actions';
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};

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

const as = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

async function errorOf(res: Response, status: number): Promise<{ code: string; message: string }> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error;
}

const STORAGE = ['actions.storage.read', 'actions.storage.write', 'actions.storage.delete'];
const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	creator: [...BASE_PERMS, 'actions.action.create', ...STORAGE],
	finance: [...BASE_PERMS, 'actions.payout.view', ...STORAGE],
	viewer: [...BASE_PERMS, ...STORAGE],
	allEdit: [...BASE_PERMS, 'actions.action.edit-all', ...STORAGE]
};
const USERS: [string, string][] = [
	['owner', 'creator'],
	['finance', 'finance'],
	['reader', 'viewer'],
	['editor', 'viewer'],
	['stranger', 'viewer'],
	['boss', 'allEdit']
];

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const mdb = () => core.database.forModule('actions');

async function createAction(): Promise<string> {
	const a = await data<{ id: string }>(
		await as('owner', '/actions', {
			method: 'POST',
			json: {
				name: 'Sommerlager',
				description: null,
				location: null,
				startsOn: '2026-07-10',
				startsTime: null,
				endsOn: '2026-07-17',
				endsTime: null
			}
		}),
		201
	);
	return a.id;
}

async function share(id: string, who: string, level: 'read' | 'edit') {
	await data(
		await as('owner', `/actions/${id}/shares/${userIds[who]}`, { method: 'PUT', json: { level } })
	);
}

async function addPayee(actionId: string, name = 'Max Muster'): Promise<string> {
	const id = crypto.randomUUID();
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO accounting_payees (id, action_id, name, iban_enc, iban_last4, bic)
				VALUES (${id}, ${actionId}, ${name}, 'enc', '345678', 'GENODEF1TST')`
		);
	});
	return id;
}

const expense = (over: Partial<EntryFormInput> = {}): EntryFormInput => ({
	type: 'expense',
	category: 'food',
	description: 'Einkauf',
	amountCents: 5000,
	entryDate: '2026-07-12',
	paidBy: 'club',
	payeeId: null,
	...over
});
const income = (over: Partial<EntryFormInput> = {}): EntryFormInput => ({
	type: 'income',
	category: 'misc',
	description: 'Spende',
	amountCents: 20000,
	entryDate: '2026-07-01',
	paidBy: 'club',
	payeeId: null,
	...over
});

const acc = (id: string) => `/actions/${id}/accounting`;
const addEntry = async (id: string, body: EntryFormInput) =>
	data<AccountingEntry>(
		await as('owner', `${acc(id)}/entries`, { method: 'POST', json: body }),
		201
	);
const state = async (id: string, who = 'owner') => data<AccountingState>(await as(who, acc(id)));
const createInterim = (id: string, json: unknown = {}, who = 'owner') =>
	as(who, `${acc(id)}/interims`, { method: 'POST', json });
const revert = (id: string, interimId: string, who = 'owner', force = false) =>
	as(who, `${acc(id)}/interims/${interimId}${force ? '?force=true' : ''}`, { method: 'DELETE' });
const reimbursedAtOf = async (entryId: string): Promise<unknown> =>
	mdb().transaction(async (tx) => {
		const r = await tx.execute(
			sql`SELECT reimbursed_at FROM accounting_entries WHERE id = ${entryId}`
		);
		return (r as unknown as { rows: { reimbursed_at: unknown }[] }).rows[0]!.reimbursed_at;
	});

const PDF = '%PDF-1.4 beleg';
function receiptForm(): FormData {
	const fd = new FormData();
	fd.set('file', new File([PDF], 'beleg.pdf', { type: 'application/pdf' }));
	return fd;
}
const uploadReceipt = (id: string, entryId: string) =>
	as('owner', `${acc(id)}/entries/${entryId}/receipt`, { method: 'POST', body: receiptForm() });

const reimbursementsOf = async (actionId: string) =>
	(await actionsService.listReimbursements()).filter((r) => r.actionId === actionId);

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

	const roleIds: Record<string, string> = {};
	for (const [name, perms] of Object.entries(ROLES)) {
		roleIds[name] = await createRole(admin, { name: `role-${name}`, permissions: perms });
	}
	for (const [name, role] of USERS) {
		userIds[name] = await createUser(admin, {
			name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: [...ROLES[role]!] })).key;
	}
	await installFakeStorage(admin);
});

afterAll(() => {
	uninstallFakeStorage();
	setPdfRendererForTests(undefined);
});

const interims = async (id: string, who = 'owner') =>
	data<AccountingInterim[]>(await as(who, `${acc(id)}/interims`));
const putEntry = (id: string, entryId: string, body: EntryFormInput) =>
	as('owner', `${acc(id)}/entries/${entryId}`, { method: 'PUT', json: body });
const close = (id: string, acceptMissingReceipts = false) =>
	as('owner', `${acc(id)}/close`, { method: 'POST', json: { acceptMissingReceipts } });
const snapshotOf = (actionId: string, interimId: string) =>
	mdb().transaction((tx) => loadInterimSnapshot(tx, actionId, interimId));

describe('Zwischenabrechnung: unabhängige Abbilder', () => {
	it('friert den gesamten Stand ein, sperrt keine Buchungen und bleibt bei Rücknahmen unverändert', async () => {
		const id = await createAction();
		const payee = await addPayee(id);
		const club = await addEntry(id, expense({ description: 'Lebensmittel Rewe' }));
		await data(await uploadReceipt(id, club.id), 201);
		await addEntry(
			id,
			expense({ paidBy: 'person', payeeId: payee, amountCents: 1250, category: 'materials' })
		);
		await addEntry(id, income());

		// Belegprüfung über alle Ausgaben
		const missing = await errorOf(await createInterim(id), 409);
		expect(missing.code).toBe('conflict');
		expect(missing.message).toContain('1 Ausgabe hat keinen Beleg');

		const za1 = await data<AccountingInterim>(
			await createInterim(id, { acceptMissingReceipts: true, note: 'Vorschuss' }),
			201
		);
		expect(za1).toMatchObject({
			number: 1,
			note: 'Vorschuss',
			entryCount: 3,
			incomeCents: 20000,
			expenseCents: 6250,
			reimbursementCents: 1250,
			openReimbursementCents: 1250,
			canRevert: true,
			revertWarnings: [],
			paidReimbursementCents: 0
		});
		expect(za1.createdBy?.name).toBe('Owner Test');

		// Keine Sperre: Buchung ändern, Beleg tauschen, neue Buchung
		const upd = await data<AccountingEntry>(
			await putEntry(id, club.id, expense({ description: 'Lebensmittel Rewe', amountCents: 7000 }))
		);
		expect(upd.amountCents).toBe(7000);
		expect(upd.interim ?? null).toBeNull();
		await data(await uploadReceipt(id, club.id), 201);
		await addEntry(id, income({ amountCents: 5000, description: 'Kuchenverkauf' }));

		const za2 = await data<AccountingInterim>(
			await createInterim(id, { acceptMissingReceipts: true }),
			201
		);
		expect(za2).toMatchObject({
			number: 2,
			entryCount: 4,
			incomeCents: 25000,
			expenseCents: 8250,
			reimbursementCents: 1250
		});
		let list = await interims(id);
		expect(list.map((i) => [i.number, i.entryCount, i.incomeCents, i.expenseCents])).toEqual([
			[1, 3, 20000, 6250],
			[2, 4, 25000, 8250]
		]);

		// Abbild: Buchungen, Summen, Personen ohne Bankdaten, Belege
		const { interim, snapshot } = await snapshotOf(id, za1.id);
		expect(interim).toMatchObject({ id: za1.id, number: 1, note: 'Vorschuss' });
		expect(interim.createdBy).toBe(userIds.owner);
		expect(snapshot.entries.find((e) => e.id === club.id)!.amountCents).toBe(5000);
		expect(snapshot.summary.expenseCents).toBe(6250);
		expect(snapshot.payees).toEqual([
			{ id: payee, name: 'Max Muster', openCents: 1250, reimbursedCents: 0 }
		]);
		expect(snapshot.receiptEntryIds).toEqual([club.id]);
		expect(JSON.stringify(snapshot)).not.toContain('GENODEF1TST');
		const two = await snapshotOf(id, za2.id);
		expect(two.snapshot.entries).toHaveLength(4);
		expect(two.snapshot.entries.find((e) => e.id === club.id)!.amountCents).toBe(7000);

		// ZA 1 zurücknehmen: ZA 2 unverändert, Buchungen unverändert
		await data(await revert(id, za1.id));
		list = await interims(id);
		expect(list.map((i) => [i.number, i.entryCount, i.incomeCents, i.expenseCents])).toEqual([
			[2, 4, 25000, 8250]
		]);
		expect((await state(id)).entries).toHaveLength(4);
		const ref = (await actionsService.listInterims({ actionIds: [id] }))[0]!;
		expect(ref).toMatchObject({ id: za2.id, number: 2, incomeCents: 25000, expenseCents: 8250 });

		// Nummer = max + 1
		const za3 = await data<AccountingInterim>(
			await createInterim(id, { acceptMissingReceipts: true }),
			201
		);
		expect(za3.number).toBe(3);
	});

	it('verweigert ZA ohne Buchungen und bei abgeschlossener Abrechnung', async () => {
		const id = await createAction();
		expect((await errorOf(await createInterim(id), 409)).message).toContain('keine Buchungen');
		await addEntry(id, income());
		await data(await close(id), 201);
		expect((await errorOf(await createInterim(id), 409)).message).toContain('abgeschlossen');
	});

	it('zählt beim Abschluss fehlende Belege auch von Buchungen in einer ZA', async () => {
		const id = await createAction();
		await addEntry(id, expense());
		await data(await createInterim(id, { acceptMissingReceipts: true }), 201);
		expect((await errorOf(await close(id), 409)).message).toContain('1 Ausgabe hat keinen Beleg');
		await data(await close(id, true), 201);
	});
});

describe('Zwischenabrechnung: Freigabe in der Kasse', () => {
	it('gibt Auslagen frei, solange eine ZA sie enthält oder abgeschlossen ist', async () => {
		const id = await createAction();
		const payee = await addPayee(id);
		const a1 = await addEntry(
			id,
			expense({ paidBy: 'person', payeeId: payee, amountCents: 1250, category: 'materials' })
		);
		await data(await uploadReceipt(id, a1.id), 201);
		expect(await reimbursementsOf(id)).toEqual([]);

		const za1 = await data<AccountingInterim>(await createInterim(id), 201);
		let rows = await reimbursementsOf(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			payeeId: payee,
			name: 'Max Muster',
			totalCents: 1250,
			openCents: 1250,
			interimId: null,
			interimNumber: null
		});

		// Einzige ZA zurück -> nicht mehr freigegeben
		await data(await revert(id, za1.id));
		expect(await reimbursementsOf(id)).toEqual([]);

		const zaA = await data<AccountingInterim>(await createInterim(id), 201);
		const zaB = await data<AccountingInterim>(await createInterim(id), 201);
		// Neue Auslage außerhalb jeder ZA: nicht freigegeben
		const a2 = await addEntry(
			id,
			expense({ paidBy: 'person', payeeId: payee, amountCents: 800, category: 'materials' })
		);
		await data(await uploadReceipt(id, a2.id), 201);
		rows = await reimbursementsOf(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ totalCents: 1250, openCents: 1250 });

		// Alt-Schlüssel einer ZA: kein Effekt
		expect(await actionsService.markReimbursed(id, payee, true, zaA.id)).toBe(0);
		expect(await actionsService.listReimbursementReceipts(id, payee, zaA.id)).toEqual([]);
		const receipts = await actionsService.listReimbursementReceipts(id, payee, null);
		expect(receipts.map((r) => r.entryId)).toEqual([a1.id]);

		// Kasse zahlt: nur die freigegebene Auslage
		expect(await actionsService.markReimbursed(id, payee, true, null)).toBe(1);
		expect(await reimbursedAtOf(a1.id)).not.toBeNull();
		expect(await reimbursedAtOf(a2.id)).toBeNull();

		// Erstattete Auslage ist noch in ZA B enthalten -> ZA A ohne Warnung
		let list = await interims(id);
		expect(list.find((i) => i.id === zaA.id)!.revertWarnings).toEqual([]);
		await data(await revert(id, zaA.id));

		// Jetzt nur noch in ZA B -> Warnung paid
		list = await interims(id);
		const b = list.find((i) => i.id === zaB.id)!;
		expect(b.revertWarnings).toEqual(['paid']);
		expect(b.paidReimbursementCents).toBe(1250);
		expect(b.openReimbursementCents).toBe(0);
		const conflict = await errorOf(await revert(id, zaB.id), 409);
		expect(conflict.message).toContain('Bestätigung erforderlich');
		await data(await revert(id, zaB.id, 'owner', true));
		expect(await reimbursedAtOf(a1.id)).not.toBeNull();
		expect(await interims(id)).toEqual([]);
		// erstattet, aber nicht mehr freigegeben -> keine Zeile
		expect(await reimbursementsOf(id)).toEqual([]);

		// Abschluss gibt alle Auslagen frei
		await data(await close(id), 201);
		rows = await reimbursementsOf(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ totalCents: 2050, openCents: 800, interimId: null });
		expect(
			(await actionsService.listReimbursementReceipts(id, payee)).map((r) => r.entryId).sort()
		).toEqual([a1.id, a2.id].sort());
	});

	it('nimmt bei abgeschlossener Abrechnung ohne Warnung zurück', async () => {
		const id = await createAction();
		const payee = await addPayee(id);
		const a = await addEntry(
			id,
			expense({ paidBy: 'person', payeeId: payee, amountCents: 900, category: 'materials' })
		);
		const za = await data<AccountingInterim>(
			await createInterim(id, { acceptMissingReceipts: true }),
			201
		);
		expect(await actionsService.markReimbursed(id, payee, true, null)).toBe(1);
		expect((await interims(id))[0]!.revertWarnings).toEqual(['paid']);
		await data(await close(id, true), 201);
		expect((await interims(id))[0]!.revertWarnings).toEqual([]);
		await data(await revert(id, za.id));
		expect(await reimbursedAtOf(a.id)).not.toBeNull();
		expect(await reimbursementsOf(id)).toHaveLength(1);
	});
});

describe('Zwischenabrechnung: Rechte, Altdaten, Audit', () => {
	it('prüft Rechte: Freigabe edit legt an, nimmt aber nicht zurück', async () => {
		const id = await createAction();
		await share(id, 'editor', 'edit');
		await share(id, 'reader', 'read');
		await addEntry(id, income());

		expect((await errorOf(await createInterim(id, {}, 'reader'), 403)).code).toBe('forbidden');
		expect((await errorOf(await createInterim(id, {}, 'stranger'), 404)).code).toBe('not_found');
		const za = await data<AccountingInterim>(await createInterim(id, {}, 'editor'), 201);
		expect(za.canRevert).toBe(false);

		expect((await interims(id, 'reader')).map((i) => i.canRevert)).toEqual([false]);
		expect((await interims(id, 'boss')).map((i) => i.canRevert)).toEqual([true]);
		expect((await errorOf(await as('stranger', `${acc(id)}/interims`), 404)).code).toBe(
			'not_found'
		);

		expect((await errorOf(await revert(id, za.id, 'editor'), 403)).code).toBe('forbidden');
		expect((await errorOf(await revert(id, za.id, 'reader'), 403)).code).toBe('forbidden');
		expect((await errorOf(await revert(id, za.id, 'stranger'), 404)).code).toBe('not_found');
		expect((await errorOf(await revert(id, crypto.randomUUID()), 404)).code).toBe('not_found');
		await data(await revert(id, za.id, 'boss'));
		expect(await interims(id)).toEqual([]);
	});

	it('baut das Abbild für Altdaten ohne Snapshot live aus den Zuordnungen', async () => {
		const id = await createAction();
		const payee = await addPayee(id);
		await addEntry(id, income());
		await addEntry(
			id,
			expense({ paidBy: 'person', payeeId: payee, amountCents: 700, category: 'materials' })
		);
		const za = await data<AccountingInterim>(
			await createInterim(id, { acceptMissingReceipts: true }),
			201
		);
		await addEntry(id, income({ amountCents: 1000 }));
		await mdb().transaction(async (tx) => {
			await tx.execute(sql`UPDATE accounting_interims SET snapshot = NULL WHERE id = ${za.id}`);
		});

		const [legacy] = await interims(id);
		expect(legacy).toMatchObject({
			id: za.id,
			entryCount: 2,
			incomeCents: 20000,
			expenseCents: 700,
			reimbursementCents: 700
		});
		const { snapshot } = await snapshotOf(id, za.id);
		expect(snapshot.entries).toHaveLength(2);
		expect(snapshot.payees).toEqual([
			{ id: payee, name: 'Max Muster', openCents: 700, reimbursedCents: 0 }
		]);
		expect(snapshot.takenAt).toBe(za.createdAt);
		const ref = (await actionsService.listInterims({ actionIds: [id] }))[0]!;
		expect(ref.incomeCents).toBe(20000);
		await expect(snapshotOf(id, crypto.randomUUID())).rejects.toMatchObject({
			code: 'not_found'
		});
		expect(await reimbursementsOf(id)).toHaveLength(1);
	});

	it('protokolliert ohne personenbezogene Daten', async () => {
		const { rows } = await listAudit({ action: 'actions.accounting.interim' });
		const names = rows.map((r) => r.action);
		expect(names).toContain('actions.accounting.interim_created');
		expect(names).toContain('actions.accounting.interim_reverted');
		const created = rows.find((r) => r.action === 'actions.accounting.interim_created')!;
		expect(created.metadata).toMatchObject({
			number: expect.any(Number),
			entryCount: expect.any(Number)
		});
		const forced = rows.find(
			(r) =>
				r.action === 'actions.accounting.interim_reverted' &&
				(r.metadata as { forced?: boolean }).forced === true
		);
		expect(forced?.metadata).toMatchObject({ paid: true });
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toContain('Max Muster');
		expect(text).not.toContain('345678');
		expect(text).not.toContain('GENODEF1TST');
		expect(text).not.toContain('Vorschuss');
	});
});
