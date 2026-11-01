import { beforeAll, describe, expect, it } from 'vitest';
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
import { eq } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';
import type {
	ActionSummary,
	CalculationDto,
	CalculationSuggestions,
	CalculationInput
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
	['editor', 'viewer'],
	['stranger', 'viewer']
];

let actionId: string;

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function createAction(over: Record<string, unknown> = {}): Promise<string> {
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
				endsTime: null,
				...over
			}
		}),
		201
	);
	return a.id;
}

function calcBody(over: Partial<CalculationInput> = {}): CalculationInput {
	return {
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
			{ id: 'b', category: 'food', label: 'Essen', amountCents: 1000, basis: 'per_person_night' }
		],
		...over
	};
}

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
	actionId = await createAction();
	for (const [who, level] of [
		['reader', 'read'],
		['editor', 'edit']
	] as const) {
		await data(
			await as('owner', `/actions/${actionId}/shares/${userIds[who]}`, {
				method: 'PUT',
				json: { level }
			})
		);
	}
});

describe('Kalkulation: Standardwerte', () => {
	it('liefert ohne Speicherung Standardposten und Nächte aus den Aktionsdaten', async () => {
		const c = await data<CalculationDto>(await as('owner', `/actions/${actionId}/calculation`));
		expect(c.persisted).toBe(false);
		expect(c.updatedAt).toBeNull();
		expect(c.settings.items).toHaveLength(8);
		expect(c.settings.nights).toBe(7);
		expect(c.subsidy).toBeNull();
		expect(c.result.totalCents).toBe(0);
	});

	it('liefert 404 bei unbekannter Aktion', async () => {
		const id = crypto.randomUUID();
		expect((await as('owner', `/actions/${id}/calculation`)).status).toBe(404);
		expect((await as('owner', `/actions/${id}/calculation/suggestions`)).status).toBe(404);
		expect(
			(await as('owner', `/actions/${id}/calculation`, { method: 'PUT', json: calcBody() })).status
		).toBe(404);
	});
});

describe('Kalkulation: Speichern', () => {
	it('PUT/GET-Roundtrip inkl. Programm-Aufrundung', async () => {
		const saved = await data<CalculationDto>(
			await as('owner', `/actions/${actionId}/calculation`, { method: 'PUT', json: calcBody() })
		);
		expect(saved.persisted).toBe(true);
		expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// 100 EUR / 12 Teilnehmende = 8,33 -> 9 EUR je Person
		expect(saved.result.programPerPersonCents).toBe(900);
		expect(saved.result.programTotalCents).toBe(10800);
		// Essen: 10 EUR x 14 Personen x 5 Nächte = 700 EUR
		expect(saved.result.totalCents).toBe(10800 + 70000);

		const got = await data<CalculationDto>(await as('owner', `/actions/${actionId}/calculation`));
		expect(got.persisted).toBe(true);
		expect(got.settings.participants).toBe(12);
		expect(got.settings.team).toBe(2);
		expect(got.settings.items.map((i) => i.label)).toEqual(['Programm', 'Essen']);
		expect(got.result.totalCents).toBe(saved.result.totalCents);
	});

	it('ersetzt die Posten statt sie zu verdoppeln und filtert Checklisten-Schlüssel', async () => {
		const put = async () =>
			data<CalculationDto>(
				await as('owner', `/actions/${actionId}/calculation`, {
					method: 'PUT',
					json: calcBody({ checklist: { application: true, bogus: true } })
				})
			);
		await put();
		const second = await put();
		expect(second.settings.items).toHaveLength(2);
		expect(second.settings.checklist).toEqual({ application: true });
	});

	it('berechnet den Zuschuss und zieht ihn ab', async () => {
		const c = await data<CalculationDto>(
			await as('owner', `/actions/${actionId}/calculation`, {
				method: 'PUT',
				json: calcBody({ includeSubsidy: true, bremenChildren: 10, nights: 3 })
			})
		);
		expect(c.subsidy).not.toBeNull();
		expect(c.subsidy!.subsidyCents).toBeGreaterThan(0);
		expect(c.result.subsidyCents).toBe(c.subsidy!.subsidyCents);
		expect(c.result.netCents).toBe(c.result.totalCents - c.subsidy!.subsidyCents);
	});
});

describe('Kalkulation: Validierung', () => {
	const put = (json: unknown) =>
		as('owner', `/actions/${actionId}/calculation`, { method: 'PUT', json });
	const item = (over: Record<string, unknown> = {}) => ({
		id: 'x',
		category: 'other',
		label: 'Posten',
		amountCents: 100,
		basis: 'flat',
		...over
	});

	it('lehnt ungültige Eingaben mit 422 ab', async () => {
		expect((await put(calcBody({ items: [item({ amountCents: -1 })] as never }))).status).toBe(422);
		expect((await put(calcBody({ participants: 1001 }))).status).toBe(422);
		expect((await put(calcBody({ nights: 61 }))).status).toBe(422);
		expect(
			(await put(calcBody({ items: Array.from({ length: 101 }, () => item()) as never }))).status
		).toBe(422);
		expect(
			(await put(calcBody({ items: [item({ category: 'unbekannt' })] as never }))).status
		).toBe(422);
		expect((await put(calcBody({ teamPercent: 101 }))).status).toBe(422);
		expect((await put(calcBody({ teamYouth: 1001 }))).status).toBe(422);
	});
});

describe('Kalkulation: Zugriff', () => {
	it('reader darf lesen, aber nicht speichern', async () => {
		expect((await as('reader', `/actions/${actionId}/calculation`)).status).toBe(200);
		expect((await as('reader', `/actions/${actionId}/calculation/suggestions`)).status).toBe(200);
		const res = await as('reader', `/actions/${actionId}/calculation`, {
			method: 'PUT',
			json: calcBody()
		});
		expect(res.status).toBe(403);
	});

	it('editor darf speichern', async () => {
		const res = await as('editor', `/actions/${actionId}/calculation`, {
			method: 'PUT',
			json: calcBody({ participants: 20 })
		});
		const c = await data<CalculationDto>(res);
		expect(c.settings.participants).toBe(20);
	});

	it('stranger erhält 404 auf alle Endpoints', async () => {
		const p = `/actions/${actionId}/calculation`;
		expect((await as('stranger', p)).status).toBe(404);
		expect((await as('stranger', `${p}/suggestions`)).status).toBe(404);
		expect((await as('stranger', p, { method: 'PUT', json: calcBody() })).status).toBe(404);
	});
});

describe('Kalkulation: Vorschläge', () => {
	it('zählt Teilnehmende nach Alter, Wohnort und Juleica', async () => {
		const id = await createAction({ endsOn: '2026-07-14' });
		const add = async (json: Record<string, unknown>) =>
			data(await as('owner', `/actions/${id}/participants`, { method: 'POST', json }), 201);
		// Alter zum Start 2026-07-10
		await add({ name: 'Kind Bremen', birthDate: '2020-01-01', bremenResident: true });
		await add({ name: 'Kind anderswo', birthDate: '2020-01-01', bremenResident: false });
		await add({ name: 'Jugend Bremen', birthDate: '2010-01-01', bremenResident: true });
		await add({ name: 'Ohne Daten' });
		await add({
			name: 'Team jung J',
			role: 'team',
			juleica: true,
			birthDate: '2005-05-05',
			bremenResident: true
		});
		await add({
			name: 'Team jung',
			role: 'team',
			juleica: false,
			birthDate: '2005-05-05',
			bremenResident: false
		});
		await add({
			name: 'Team alt',
			role: 'team',
			juleica: true,
			birthDate: '1980-01-01',
			bremenResident: true
		});

		const s = await data<CalculationSuggestions>(
			await as('owner', `/actions/${id}/calculation/suggestions`)
		);
		expect(s.participants).toBe(4);
		expect(s.team).toBe(3);
		expect(s.nights).toBe(4);
		expect(s.children).toBe(1);
		expect(s.youth).toBe(1); // nur Teilnehmende
		expect(s.teamYouth).toBe(1); // Team jung J
		expect(s.teamWithJuleica).toBe(1);
		expect(s.teamWithoutJuleica).toBe(1);
		expect(s.incomplete.map((i) => i.name)).toEqual(['Ohne Daten']);
		expect(s.incomplete[0]!.missing).toEqual(['birthDate', 'bremenResident']);
	});
});

describe('Kalkulation: Beitrag übernehmen', () => {
	const calcPath = (id: string) => `/actions/${id}/calculation`;
	const put = async (id: string, over: Partial<CalculationInput>) =>
		data<CalculationDto>(await as('owner', calcPath(id), { method: 'PUT', json: calcBody(over) }));

	it('verlangt eine gespeicherte Kalkulation (400)', async () => {
		const id = await createAction();
		const res = await as('owner', `${calcPath(id)}/apply`, { method: 'POST' });
		expect(res.status).toBe(400);
	});

	it('verlangt Teilnehmende (422)', async () => {
		const id = await createAction();
		await put(id, { participants: 0 });
		const res = await as('owner', `${calcPath(id)}/apply`, { method: 'POST' });
		expect(res.status).toBe(422);
	});

	it('übernimmt, erkennt Veränderungen und nimmt zurück', async () => {
		const id = await createAction();
		const saved = await put(id, { teamPercent: 50 });
		expect(saved.applied).toBeNull();
		expect(saved.outdated).toBe(false);

		const dto = await data<CalculationDto>(
			await as('owner', `${calcPath(id)}/apply`, { method: 'POST' }),
			201
		);
		expect(dto.applied).not.toBeNull();
		expect(dto.applied!.participantCents).toBe(dto.result.recommendedPerPersonCents);
		expect(dto.applied!.teamCents).toBe(dto.result.recommendedTeamPerPersonCents);
		expect(dto.applied!.appliedBy?.userId).toBe(userIds.owner);
		expect(dto.applied!.appliedBy?.name).toBe('Owner Test');
		expect(dto.outdated).toBe(false);

		const summary = await data<ActionSummary>(await as('owner', `/actions/${id}`));
		expect(summary.fee).not.toBeNull();
		expect(summary.fee!.participantCents).toBe(dto.applied!.participantCents);
		expect(summary.fee!.teamCents).toBe(dto.applied!.teamCents);
		expect(summary.fee!.appliedBy?.userId).toBe(userIds.owner);

		const changed = await put(id, { teamPercent: 50, bufferPercent: 50 });
		expect(changed.applied).not.toBeNull();
		expect(changed.outdated).toBe(true);

		const cleared = await data<CalculationDto>(
			await as('owner', `${calcPath(id)}/apply`, { method: 'DELETE' })
		);
		expect(cleared.applied).toBeNull();
		expect(cleared.outdated).toBe(false);
		const after = await data<ActionSummary>(await as('owner', `/actions/${id}`));
		expect(after.fee).toBeNull();
	});

	it('Zugriff: reader 403, stranger 404', async () => {
		const p = `${calcPath(actionId)}/apply`;
		expect((await as('reader', p, { method: 'POST' })).status).toBe(403);
		expect((await as('reader', p, { method: 'DELETE' })).status).toBe(403);
		expect((await as('stranger', p, { method: 'POST' })).status).toBe(404);
		expect((await as('stranger', p, { method: 'DELETE' })).status).toBe(404);
	});

	it('protokolliert ohne personenbezogene Details', async () => {
		const { rows } = await listAudit({ action: 'actions.fee.' });
		const actions = rows.map((r) => r.action);
		expect(actions).toContain('actions.fee.applied');
		expect(actions).toContain('actions.fee.cleared');
		const serialized = JSON.stringify(rows.map((r) => r.metadata));
		expect(serialized).not.toContain('Owner');
		expect(serialized).not.toContain('example.test');
	});
});

describe('Kalkulation: Audit', () => {
	it('protokolliert ohne Posten-Inhalte', async () => {
		const { rows } = await listAudit({ action: 'actions.calculation.' });
		expect(rows.length).toBeGreaterThan(0);
		const meta = rows.map((r) => r.metadata as Record<string, unknown>);
		expect(meta[0]).toHaveProperty('items');
		const serialized = JSON.stringify(meta);
		expect(serialized).not.toContain('Programm');
		expect(serialized).not.toContain('Essen');
	});
});
