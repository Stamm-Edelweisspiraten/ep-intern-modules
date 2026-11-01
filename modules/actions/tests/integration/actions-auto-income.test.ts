import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';
import type {
	AccountingState,
	CalculationSuggestions,
	EntryFormInput,
	Participant
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

const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	creator: [...BASE_PERMS, 'actions.action.create'],
	viewer: BASE_PERMS
};
const USERS: [string, string][] = [
	['owner', 'creator'],
	['reader', 'viewer'],
	['stranger', 'viewer']
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
const addEntry = async (id: string, body: EntryFormInput) =>
	data<unknown>(
		await as('owner', `/actions/${id}/accounting/entries`, { method: 'POST', json: body }),
		201
	);
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
});

afterAll(() => setPdfRendererForTests(undefined));

interface PersonBody {
	name: string;
	birthDate: string | null;
	bremenResident: boolean | null;
	role?: 'participant' | 'team';
	juleica?: boolean;
	subsidyEligible?: boolean | null;
}

const addPerson = async (id: string, body: PersonBody) =>
	data<Participant>(
		await as('owner', `/actions/${id}/participants`, { method: 'POST', json: body }),
		201
	);

const calc = {
	participants: 4,
	team: 1,
	teamPercent: 0,
	nights: 7,
	bufferPercent: 0,
	includeSubsidy: true,
	lodgingType: 'external',
	konfi: false,
	freizeitType: 'kids',
	bremenChildren: 0,
	bremenYouth: 0,
	teamWithJuleica: 0,
	teamWithoutJuleica: 0,
	teamYouth: 0,
	checklist: {},
	items: [{ id: 'a', category: 'food', label: 'Essen', amountCents: 1000, basis: 'flat' }]
};

/** Aktion 10.-17.07.2026 (7 Nächte), Liste, Beitrag 100 EUR / Team 50 EUR, Kalkulation inkl. Zuschuss. */
async function setup(opts: { subsidy?: boolean } = {}) {
	const id = await createAction();
	await addPerson(id, { name: 'Anna', birthDate: '2018-05-01', bremenResident: true });
	await addPerson(id, {
		name: 'Ben',
		birthDate: '2010-01-01',
		bremenResident: false,
		subsidyEligible: true
	});
	await addPerson(id, {
		name: 'Cleo',
		birthDate: '2012-03-03',
		bremenResident: true,
		subsidyEligible: false
	});
	await addPerson(id, { name: 'Dora', birthDate: '2015-01-01', bremenResident: null });
	await addPerson(id, {
		name: 'Teo',
		birthDate: '1999-01-01',
		bremenResident: true,
		role: 'team',
		juleica: true
	});
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE actions SET fee_cents = 10000, team_fee_cents = 5000, fee_applied_at = now() WHERE id = ${id}`
		);
	});
	await data(
		await as('owner', `/actions/${id}/calculation`, {
			method: 'PUT',
			json: { ...calc, includeSubsidy: opts.subsidy ?? true }
		})
	);
	return id;
}

// Zuschuss: Kind 1 (Anna) x 7 x 15,00 + Jugend inkl. Team 2 (Ben, Teo) x 7 x 16,00 = 105,00 + 224,00
const SUBSIDY = 32900;
// Beiträge: 4 Teilnehmende x 100,00 + 1 Team x 50,00
const CONTRIB = 45000;

describe('Zuschussberechtigung je Person', () => {
	it('liefert Override und effektiven Wert; fehlendes Feld lässt den Override unverändert', async () => {
		const id = await setup();
		const list = await data<Participant[]>(await as('owner', `/actions/${id}/participants`));
		const by = Object.fromEntries(list.map((p) => [p.name, p]));
		expect(by.Anna).toMatchObject({ subsidyEligible: null, subsidyEffective: true });
		expect(by.Ben).toMatchObject({ subsidyEligible: true, subsidyEffective: true });
		expect(by.Cleo).toMatchObject({ subsidyEligible: false, subsidyEffective: false });
		expect(by.Dora).toMatchObject({ subsidyEligible: null, subsidyEffective: false });

		const put = (pid: string, json: Record<string, unknown>) =>
			as('owner', `/actions/${id}/participants/${pid}`, { method: 'PUT', json });
		const base = { name: 'Dora', birthDate: '2015-01-01', bremenResident: null };
		let p = await data<Participant>(await put(by.Dora!.id, { ...base, subsidyEligible: true }));
		expect(p).toMatchObject({ subsidyEligible: true, subsidyEffective: true });
		p = await data<Participant>(await put(by.Dora!.id, { ...base, name: 'Dora B.' }));
		expect(p.subsidyEligible).toBe(true);
		p = await data<Participant>(await put(by.Dora!.id, { ...base, subsidyEligible: null }));
		expect(p).toMatchObject({ subsidyEligible: null, subsidyEffective: false });
		// Override ohne Geburtsdatum: Alter nicht bestimmbar -> nicht berechtigt
		p = await data<Participant>(
			await put(by.Dora!.id, { name: 'Dora', birthDate: null, subsidyEligible: true })
		);
		expect(p.subsidyEffective).toBe(false);
	});

	it('validiert und prüft Zugriff', async () => {
		const id = await setup();
		const [first] = await data<Participant[]>(await as('owner', `/actions/${id}/participants`));
		const url = `/actions/${id}/participants/${first!.id}`;
		const body = { name: 'X', birthDate: null, bremenResident: null };
		const put = (who: string, subsidyEligible: unknown) =>
			as(who, url, { method: 'PUT', json: { ...body, subsidyEligible } });
		expect((await put('owner', 'ja')).status).toBe(422);
		expect((await put('stranger', true)).status).toBe(404);
		await data(
			await as('owner', `/actions/${id}/shares/${userIds.reader}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		expect((await put('reader', true)).status).toBe(403);
	});

	it('Vorschläge nutzen den Override', async () => {
		const id = await setup();
		const s = await data<CalculationSuggestions>(
			await as('owner', `/actions/${id}/calculation/suggestions`)
		);
		expect(s).toMatchObject({
			participants: 4,
			team: 1,
			children: 1,
			youth: 1,
			teamYouth: 1,
			teamWithJuleica: 1,
			teamWithoutJuleica: 0
		});
		expect(s.incomplete.map((i) => i.name)).toEqual(['Dora']);
	});
});

describe('Automatische Einnahmen in der Abrechnung', () => {
	it('liefert Beiträge und Zuschuss aus der Teilnehmerliste und zählt sie als Einnahme', async () => {
		const id = await setup();
		const st = await state(id);
		expect(st.autoIncome).toEqual({
			contributions: {
				cents: CONTRIB,
				payingCount: 4,
				teamCount: 1,
				feeCents: 10000,
				teamFeeCents: 5000,
				source: 'calculated'
			},
			subsidy: { cents: SUBSIDY, eligibleCount: 3 },
			overridden: []
		});
		expect(st.summary.incomeCents).toBe(CONTRIB + SUBSIDY);
		expect(st.summary.balanceCents).toBe(CONTRIB + SUBSIDY);
		const actual = Object.fromEntries(
			st.summary.byCategory.map((c) => [c.category, c.actualCents])
		);
		expect(actual.contributions).toBe(CONTRIB);
		expect(actual.subsidy).toBe(SUBSIDY);
		await addEntry(id, expense({ amountCents: 10000 }));
		expect((await state(id)).summary.balanceCents).toBe(CONTRIB + SUBSIDY - 10000);
	});

	it('ohne Zuschuss in der Kalkulation bzw. ohne Beitrag gibt es keine Automatik', async () => {
		const id = await setup({ subsidy: false });
		let st = await state(id);
		expect(st.autoIncome.subsidy).toBeNull();
		expect(st.summary.incomeCents).toBe(CONTRIB);
		await mdb().transaction(async (tx) => {
			await tx.execute(
				sql`UPDATE actions SET fee_cents = NULL, team_fee_cents = NULL WHERE id = ${id}`
			);
		});
		st = await state(id);
		expect(st.autoIncome.contributions).toBeNull();
		expect(st.summary.incomeCents).toBe(0);
	});

	it('manuelle Buchung der Kategorie überschreibt die Automatik', async () => {
		const id = await setup();
		await addEntry(id, income({ amountCents: 1000 }));
		let st = await state(id);
		expect(st.autoIncome.overridden).toEqual(['contributions']);
		expect(st.autoIncome.contributions?.cents).toBe(CONTRIB);
		expect(st.summary.incomeCents).toBe(1000 + SUBSIDY);
		await addEntry(id, income({ category: 'subsidy', amountCents: 500 }));
		st = await state(id);
		expect([...st.autoIncome.overridden].sort()).toEqual(['contributions', 'subsidy']);
		expect(st.summary.incomeCents).toBe(1500);
		await addEntry(id, income({ category: 'misc', amountCents: 100 }));
		expect((await state(id)).summary.incomeCents).toBe(1600);
	});

	it('Rückzahlung rechnet den Überschuss inklusive Automatik', async () => {
		const id = await setup();
		await addEntry(id, expense({ amountCents: 10000 }));
		const r = await data<{ surplusCents: number }>(
			await as('owner', `/actions/${id}/accounting/refund`)
		);
		expect(r.surplusCents).toBe(CONTRIB + SUBSIDY - 10000);
	});

	it('PDF-Bericht zeigt die Automatik-Zeilen', async () => {
		const id = await setup();
		let html = '';
		setPdfRendererForTests(async (h) => {
			html = h;
			return new TextEncoder().encode('%PDF-fake');
		});
		const res = await as('owner', `/actions/${id}/accounting/report.pdf`);
		expect(res.status).toBe(200);
		expect(html).toContain('Automatisch aus Anmeldungen (4 ×');
		expect(html).toContain('1 ×');
		expect(html).toContain('Zuschuss laut Kalkulation (3 berechtigte Personen)');
		expect(html.replace(/\s+/g, ' ')).toContain('779,00 €');
		// überschrieben: keine Automatik-Zeile für Beiträge mehr
		await addEntry(id, income({ amountCents: 1000 }));
		await as('owner', `/actions/${id}/accounting/report.pdf`);
		expect(html).not.toContain('Automatisch aus Anmeldungen');
		expect(html).toContain('Zuschuss laut Kalkulation');
	});
});
