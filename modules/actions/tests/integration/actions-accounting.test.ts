import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage, fakeObjects } from '$testing';
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
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';
import type {
	AccountingEntry,
	AccountingState,
	CalculationDto,
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

const STORAGE = ['actions.storage.read', 'actions.storage.write', 'actions.storage.delete'];
const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	creator: [...BASE_PERMS, 'actions.action.create', ...STORAGE],
	finance: [...BASE_PERMS, 'actions.action.create', 'actions.payout.view', ...STORAGE],
	viewer: [...BASE_PERMS, ...STORAGE]
};
const USERS: [string, string][] = [
	['owner', 'creator'],
	['finance', 'finance'],
	['reader', 'viewer'],
	['editor', 'viewer'],
	['stranger', 'viewer']
];

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function createAction(who = 'owner'): Promise<string> {
	const a = await data<{ id: string }>(
		await as(who, '/actions', {
			method: 'POST',
			json: {
				name: 'Fahrt',
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

async function share(id: string, who: string, level: 'read' | 'edit', owner = 'owner') {
	await data(
		await as(owner, `/actions/${id}/shares/${userIds[who]}`, { method: 'PUT', json: { level } })
	);
}

const mdb = () => core.database.forModule('actions');

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

async function closeSql(actionId: string, closed: boolean) {
	await mdb().transaction(async (tx) => {
		if (closed) {
			await tx.execute(
				sql`INSERT INTO action_accounting (action_id, closed_at, closed_by)
					VALUES (${actionId}, now(), ${userIds.owner})
					ON CONFLICT (action_id) DO UPDATE SET closed_at = now(), closed_by = ${userIds.owner}`
			);
		} else {
			await tx.execute(sql`DELETE FROM action_accounting WHERE action_id = ${actionId}`);
		}
	});
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
	category: 'contributions',
	description: 'Beiträge',
	amountCents: 20000,
	entryDate: '2026-07-01',
	paidBy: 'club',
	payeeId: null,
	...over
});

const entriesPath = (id: string) => `/actions/${id}/accounting/entries`;
const addEntry = async (id: string, body: EntryFormInput, who = 'owner') =>
	data<AccountingEntry>(await as(who, entriesPath(id), { method: 'POST', json: body }), 201);
const state = async (id: string, who = 'owner') =>
	data<AccountingState>(await as(who, `/actions/${id}/accounting`));

/** Gültige Magic Bytes (der Upload prüft den Inhalt gegen den Typ). */
const PDF = '%PDF-1.4 x';
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x41, 0x54, 0x41
]);

function uploadForm(content: BlobPart, name: string, type: string): FormData {
	const fd = new FormData();
	fd.set('file', new File([content], name, { type }));
	return fd;
}
const uploadReceipt = (id: string, entryId: string, form: FormData, who = 'owner') =>
	as(who, `${entriesPath(id)}/${entryId}/receipt`, { method: 'POST', body: form });

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

afterAll(() => uninstallFakeStorage());

describe('Abrechnung: Zustand', () => {
	it('ist ohne Buchungen leer und ohne Plan', async () => {
		const id = await createAction();
		const s = await state(id);
		expect(s.closed).toBeNull();
		expect(s.entries).toEqual([]);
		expect(s.plan).toBeNull();
		expect(s.summary.incomeCents).toBe(0);
		expect(s.summary.expenseCents).toBe(0);
		expect(s.summary.balanceCents).toBe(0);
		expect(s.summary.missingReceipts).toBe(0);
		expect(s.payees).toBeNull();
		expect(s.canViewPayouts).toBe(false);
	});

	it('liefert 404 ohne Zugriff und bei unbekannter Aktion', async () => {
		const id = await createAction();
		expect((await as('stranger', `/actions/${id}/accounting`)).status).toBe(404);
		expect((await as('owner', `/actions/${crypto.randomUUID()}/accounting`)).status).toBe(404);
		expect(
			(await as('stranger', entriesPath(id), { method: 'POST', json: expense() })).status
		).toBe(404);
	});

	it('berechnet den Plan aus der gespeicherten Kalkulation', async () => {
		const id = await createAction();
		const calc = await data<CalculationDto>(
			await as('owner', `/actions/${id}/calculation`, {
				method: 'PUT',
				json: {
					participants: 12,
					team: 2,
					teamPercent: 0,
					nights: 5,
					bufferPercent: 0,
					includeSubsidy: false,
					lodgingType: 'external',
					konfi: false,
					freizeitType: 'kids',
					bremenChildren: 0,
					bremenYouth: 0,
					teamWithJuleica: 0,
					teamWithoutJuleica: 0,
					teamYouth: 0,
					checklist: {},
					items: [
						{ id: 'a', category: 'program', label: 'Programm', amountCents: 10000, basis: 'flat' },
						{
							id: 'b',
							category: 'food',
							label: 'Essen',
							amountCents: 1000,
							basis: 'per_person_night'
						}
					]
				}
			})
		);
		const s = await state(id);
		expect(s.plan).not.toBeNull();
		expect(s.plan!.totalExpenseCents).toBe(calc.result.totalCents);
		expect(s.plan!.subsidyCents).toBe(0);
		expect(s.plan!.expenseByCategory.program).toBe(calc.result.programTotalCents);
		expect(s.plan!.contributionsCents).toBe(
			calc.result.recommendedPerPersonCents * 12 + calc.result.recommendedTeamPerPersonCents * 2
		);
		// Soll/Ist
		await addEntry(id, expense({ category: 'food', amountCents: 3000 }));
		const s2 = await state(id);
		const food = s2.summary.byCategory.find((c) => c.category === 'food');
		expect(food?.actualCents).toBe(3000);
		expect(food?.plannedCents).toBe(s2.plan!.expenseByCategory.food ?? null);

		// übernommener Beitrag ersetzt den Empfehlungswert
		await data(await as('owner', `/actions/${id}/calculation/apply`, { method: 'POST' }), 201);
		const s3 = await state(id);
		expect(s3.plan!.contributionsCents).toBe(s.plan!.contributionsCents);
	});
});

describe('Lagerbeiträge an übergeordnete Ebenen', () => {
	it('gelten in Kalkulation, Plan und Abrechnung je Ebene', async () => {
		const id = await createAction();
		const calc = await data<CalculationDto>(
			await as('owner', `/actions/${id}/calculation`, {
				method: 'PUT',
				json: {
					participants: 10,
					team: 2,
					teamPercent: 0,
					nights: 3,
					bufferPercent: 0,
					includeSubsidy: false,
					lodgingType: 'external',
					konfi: false,
					freizeitType: 'kids',
					bremenChildren: 0,
					bremenYouth: 0,
					teamWithJuleica: 0,
					teamWithoutJuleica: 0,
					teamYouth: 0,
					checklist: {},
					items: [
						{
							id: 'b',
							category: 'camp_fee_bund',
							label: 'Bundeslager',
							amountCents: 2500,
							basis: 'per_person'
						},
						{
							id: 'g',
							category: 'camp_fee_gau',
							label: 'Gaulager',
							amountCents: 5000,
							basis: 'flat'
						}
					]
				}
			})
		);
		// 25 € × 12 Personen (Team zählt mit) + 50 € pauschal
		expect(calc.result.totalCents).toBe(30000 + 5000);
		expect(calc.settings.items.map((i) => i.category)).toEqual(['camp_fee_bund', 'camp_fee_gau']);
		expect(calc.result.byCategory.map((c) => c.category)).toEqual([
			'camp_fee_gau',
			'camp_fee_bund'
		]);

		const s = await state(id);
		expect(s.plan!.expenseByCategory.camp_fee_bund).toBe(30000);
		expect(s.plan!.expenseByCategory.camp_fee_gau).toBe(5000);

		const e = await addEntry(
			id,
			expense({ category: 'camp_fee_bund', description: 'Lagerbeitrag', amountCents: 27500 })
		);
		expect(e.category).toBe('camp_fee_bund');
		const s2 = await state(id);
		const bund = s2.summary.byCategory.find((c) => c.category === 'camp_fee_bund');
		expect(bund).toMatchObject({ type: 'expense', plannedCents: 30000, actualCents: 27500 });
		const gau = s2.summary.byCategory.find((c) => c.category === 'camp_fee_gau');
		expect(gau).toMatchObject({ plannedCents: 5000, actualCents: 0 });
	});
});

describe('Abrechnung: Buchungen', () => {
	it('legt Einnahmen und Ausgaben an, summiert und zählt fehlende Belege', async () => {
		const id = await createAction();
		const inc = await addEntry(id, income());
		const exp = await addEntry(id, expense({ amountCents: 4500 }));
		expect(inc.type).toBe('income');
		expect(exp.receipt).toBeNull();
		expect(exp.entryDate).toBe('2026-07-12');
		const s = await state(id);
		expect(s.entries).toHaveLength(2);
		expect(s.summary.incomeCents).toBe(20000);
		expect(s.summary.expenseCents).toBe(4500);
		expect(s.summary.balanceCents).toBe(15500);
		expect(s.summary.missingReceipts).toBe(1);
	});

	it('ändert und löscht Buchungen', async () => {
		const id = await createAction();
		const e = await addEntry(id, expense());
		const upd = await data<AccountingEntry>(
			await as('owner', `${entriesPath(id)}/${e.id}`, {
				method: 'PUT',
				json: expense({ amountCents: 7777, description: 'Neu', category: 'materials' })
			})
		);
		expect(upd.amountCents).toBe(7777);
		expect(upd.category).toBe('materials');
		const del = await data<{ id: string }>(
			await as('owner', `${entriesPath(id)}/${e.id}`, { method: 'DELETE' })
		);
		expect(del.id).toBe(e.id);
		expect((await state(id)).entries).toEqual([]);
		expect((await as('owner', `${entriesPath(id)}/${e.id}`, { method: 'DELETE' })).status).toBe(
			404
		);
	});

	it('validiert die Regeln (422)', async () => {
		const id = await createAction();
		const other = await createAction();
		const foreignPayee = await addPayee(other);
		const post = async (json: unknown) =>
			(await as('owner', entriesPath(id), { method: 'POST', json })).status;
		expect(await post(expense({ amountCents: 0 }))).toBe(422);
		expect(await post(expense({ category: 'contributions' }))).toBe(422);
		expect(await post(income({ category: 'food' }))).toBe(422);
		expect(await post(expense({ paidBy: 'person', payeeId: null }))).toBe(422);
		expect(await post(expense({ paidBy: 'club', payeeId: crypto.randomUUID() }))).toBe(422);
		expect(await post(income({ paidBy: 'person', payeeId: crypto.randomUUID() }))).toBe(422);
		expect(await post(expense({ paidBy: 'person', payeeId: foreignPayee }))).toBe(422);
		expect(await post(expense({ entryDate: '2099-01-01' }))).toBe(422);
		expect(await post(expense({ entryDate: 'gestern' }))).toBe(422);
	});

	it('read-only Freigabe darf nicht ändern (403), lesen aber', async () => {
		const id = await createAction();
		await share(id, 'reader', 'read');
		await share(id, 'editor', 'edit');
		const e = await addEntry(id, expense());
		expect((await as('reader', entriesPath(id), { method: 'POST', json: expense() })).status).toBe(
			403
		);
		expect((await as('reader', `${entriesPath(id)}/${e.id}`, { method: 'DELETE' })).status).toBe(
			403
		);
		expect((await state(id, 'reader')).entries).toHaveLength(1);
		const byEditor = await addEntry(id, expense({ description: 'vom Editor' }), 'editor');
		expect(byEditor.description).toBe('vom Editor');
	});

	it('schützt ausgezahlte Auslagen und setzt Person -> Stamm zurück', async () => {
		const id = await createAction();
		const payee = await addPayee(id);
		const e = await addEntry(id, expense({ paidBy: 'person', payeeId: payee }));
		expect(e.payee?.name).toBe('Max Muster');

		const toClub = await data<AccountingEntry>(
			await as('owner', `${entriesPath(id)}/${e.id}`, { method: 'PUT', json: expense() })
		);
		expect(toClub.payee).toBeNull();
		expect(toClub.reimbursedAt).toBeNull();

		const e2 = await addEntry(id, expense({ paidBy: 'person', payeeId: payee }));
		await mdb().transaction(async (tx) => {
			await tx.execute(
				sql`UPDATE accounting_entries SET reimbursed_at = now() WHERE id = ${e2.id}`
			);
		});
		const put = await as('owner', `${entriesPath(id)}/${e2.id}`, {
			method: 'PUT',
			json: expense({ paidBy: 'person', payeeId: payee })
		});
		expect(put.status).toBe(409);
		expect((await as('owner', `${entriesPath(id)}/${e2.id}`, { method: 'DELETE' })).status).toBe(
			409
		);
	});
});

describe('Abrechnung: Empfänger und Berechtigung', () => {
	it('zeigt Empfänger nur mit actions.payout.view, IBAN maskiert', async () => {
		const id = await createAction('finance');
		const payee = await addPayee(id);
		await addEntry(id, expense({ paidBy: 'person', payeeId: payee, amountCents: 1234 }), 'finance');
		await share(id, 'editor', 'edit', 'finance');

		const withRight = await state(id, 'finance');
		expect(withRight.canViewPayouts).toBe(true);
		expect(withRight.payees).toHaveLength(1);
		const p = withRight.payees![0]!;
		expect(p.name).toBe('Max Muster');
		expect(p.bic).toBe('GENODEF1TST');
		expect(p.openCents).toBe(1234);
		expect(p.openEntries).toBe(1);
		expect(p.ibanMasked).toContain('••••');
		expect(p.ibanMasked!.endsWith('3456 78')).toBe(true);
		expect(withRight.summary.openReimbursementCents).toBe(1234);

		const without = await state(id, 'editor');
		expect(without.canViewPayouts).toBe(false);
		expect(without.payees).toBeNull();
		expect(JSON.stringify(without)).not.toContain('GENODEF1TST');
	});
});

describe('Abrechnung: Belege', () => {
	it('lädt hoch, ersetzt, lädt herunter und entfernt', async () => {
		const id = await createAction();
		const e = await addEntry(id, expense());
		const before = fakeObjects.size;

		const up = await data<{ name: string; contentType: string }>(
			await uploadReceipt(id, e.id, uploadForm('%PDF-1', 'Rechnung Müller.pdf', 'application/pdf')),
			201
		);
		expect(up).toEqual({ name: 'Rechnung Müller.pdf', contentType: 'application/pdf' });
		expect(fakeObjects.size).toBe(before + 1);
		expect((await state(id)).summary.missingReceipts).toBe(0);
		expect((await state(id)).entries[0]!.receipt?.name).toBe('Rechnung Müller.pdf');

		// ersetzen: altes Objekt wird entfernt
		await data(await uploadReceipt(id, e.id, uploadForm(PNG, 'foto.png', 'image/png')), 201);
		expect(fakeObjects.size).toBe(before + 1);

		const dl = await as('owner', `${entriesPath(id)}/${e.id}/receipt`);
		expect(dl.status).toBe(200);
		expect(dl.headers.get('content-type')).toBe('image/png');
		expect(dl.headers.get('cache-control')).toBe('private, no-store');
		expect(dl.headers.get('content-disposition')).toContain("filename*=UTF-8''foto.png");
		expect(dl.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
		expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG);

		const del = await data<{ id: string }>(
			await as('owner', `${entriesPath(id)}/${e.id}/receipt`, { method: 'DELETE' })
		);
		expect(del.id).toBe(e.id);
		expect(fakeObjects.size).toBe(before);
		expect((await as('owner', `${entriesPath(id)}/${e.id}/receipt`)).status).toBe(404);
		expect(
			(await as('owner', `${entriesPath(id)}/${e.id}/receipt`, { method: 'DELETE' })).status
		).toBe(404);
	});

	it('prüft Typ, Größe, leere Dateien und Einnahmen', async () => {
		const id = await createAction();
		const e = await addEntry(id, expense());
		const inc = await addEntry(id, income());
		// einheitliche Upload-Regel (#33): Typ/leer/fehlend → 422, zu groß → 413
		expect((await uploadReceipt(id, e.id, uploadForm('x', 'a.txt', 'text/plain'))).status).toBe(
			422
		);
		expect((await uploadReceipt(id, e.id, uploadForm('', 'a.pdf', 'application/pdf'))).status).toBe(
			422
		);
		// Inhalt passt nicht zum Typ (Magic Bytes)
		expect(
			(await uploadReceipt(id, e.id, uploadForm('x', 'a.pdf', 'application/pdf'))).status
		).toBe(422);
		expect((await uploadReceipt(id, e.id, uploadForm(PDF, 'a.png', 'image/png'))).status).toBe(422);
		const big = new Uint8Array(10 * 1024 * 1024 + 1);
		expect(
			(await uploadReceipt(id, e.id, uploadForm(big, 'big.pdf', 'application/pdf'))).status
		).toBe(413);
		expect(
			(await uploadReceipt(id, inc.id, uploadForm(PDF, 'a.pdf', 'application/pdf'))).status
		).toBe(400);
		expect(
			(
				await as('owner', `${entriesPath(id)}/${e.id}/receipt`, {
					method: 'POST',
					body: new FormData()
				})
			).status
		).toBe(422);
	});

	it('entfernt den Beleg beim Löschen der Buchung', async () => {
		const id = await createAction();
		const e = await addEntry(id, expense());
		const before = fakeObjects.size;
		await data(await uploadReceipt(id, e.id, uploadForm(PDF, 'a.pdf', 'application/pdf')), 201);
		expect(fakeObjects.size).toBe(before + 1);
		await data(await as('owner', `${entriesPath(id)}/${e.id}`, { method: 'DELETE' }));
		expect(fakeObjects.size).toBe(before);
	});

	it('verweigert Fremden und read-only den Upload', async () => {
		const id = await createAction();
		await share(id, 'reader', 'read');
		const e = await addEntry(id, expense());
		expect(
			(await uploadReceipt(id, e.id, uploadForm(PDF, 'a.pdf', 'application/pdf'), 'stranger'))
				.status
		).toBe(404);
		expect(
			(await uploadReceipt(id, e.id, uploadForm(PDF, 'a.pdf', 'application/pdf'), 'reader')).status
		).toBe(403);
	});
});

describe('Abrechnung: Sperre nach Abschluss', () => {
	it('liefert 409 auf alle Änderungen und zeigt den Abschluss', async () => {
		const id = await createAction();
		const e = await addEntry(id, expense());
		await data(await uploadReceipt(id, e.id, uploadForm(PDF, 'a.pdf', 'application/pdf')), 201);
		await closeSql(id, true);

		const s = await state(id);
		expect(s.closed?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(s.closed?.by?.userId).toBe(userIds.owner);
		expect(s.closed?.by?.name).toBe('Owner Test');

		const p = `${entriesPath(id)}/${e.id}`;
		expect((await as('owner', entriesPath(id), { method: 'POST', json: expense() })).status).toBe(
			409
		);
		expect((await as('owner', p, { method: 'PUT', json: expense() })).status).toBe(409);
		expect((await as('owner', p, { method: 'DELETE' })).status).toBe(409);
		expect(
			(await uploadReceipt(id, e.id, uploadForm(PDF, 'b.pdf', 'application/pdf'))).status
		).toBe(409);
		expect((await as('owner', `${p}/receipt`, { method: 'DELETE' })).status).toBe(409);
		// Lesen und Download bleiben möglich
		expect((await as('owner', `${p}/receipt`)).status).toBe(200);

		await closeSql(id, false);
		await data(await as('owner', p, { method: 'PUT', json: expense({ amountCents: 1 }) }));
	});
});

describe('Abrechnung: Audit', () => {
	it('protokolliert ohne Beschreibung und Namen', async () => {
		const { rows } = await listAudit({ action: 'actions.accounting.' });
		const actions = rows.map((r) => r.action);
		for (const a of [
			'actions.accounting.entry_created',
			'actions.accounting.entry_updated',
			'actions.accounting.entry_deleted',
			'actions.accounting.receipt_uploaded',
			'actions.accounting.receipt_deleted'
		]) {
			expect(actions).toContain(a);
		}
		const serialized = JSON.stringify(rows.map((r) => r.metadata));
		expect(serialized).not.toContain('Einkauf');
		expect(serialized).not.toContain('Müller');
		expect(serialized).not.toContain('Max Muster');
		expect(serialized).not.toContain('example.test');
	});
});
