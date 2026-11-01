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
import type { Participant } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';

const BASE = '/modules/actions';
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
async function errorOf(res: Response, status: number): Promise<string> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}

async function ctxOf(userId: string): Promise<RequestContext> {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const PERMS = [
	'core.api.manage',
	'actions.action.view',
	'actions.action.create',
	'actions.action.delete'
];

let actionId: string;
let otherActionId: string;
const pids: string[] = [];
let foreignPid: string;

const bulk = (who: string, json: unknown, action = actionId) =>
	as(who, `/actions/${action}/participants`, { method: 'PATCH', json });
const list = async (who = 'owner') =>
	data<Participant[]>(await as(who, `/actions/${actionId}/participants`));

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
	let admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf(u!.id);
	const roleId = await createRole(admin, { name: 'role-actions', permissions: PERMS });
	for (const name of ['owner', 'reader', 'stranger']) {
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: PERMS })).key;
	}

	const mkAction = async (name: string) =>
		(
			await data<{ id: string }>(
				await as('owner', '/actions', {
					method: 'POST',
					json: { name, startsOn: '2026-07-10', endsOn: '2026-07-17' }
				}),
				201
			)
		).id;
	actionId = await mkAction('Sommerfahrt');
	otherActionId = await mkAction('Herbstfahrt');

	const people = [
		{ name: 'Anna Bremen', birthDate: '2015-03-01', bremenResident: true },
		{ name: 'Ben Umland', birthDate: '2014-05-01', bremenResident: false },
		{ name: 'Clara Ohne', birthDate: null, bremenResident: null }
	];
	for (const p of people) {
		const created = await data<Participant>(
			await as('owner', `/actions/${actionId}/participants`, { method: 'POST', json: p }),
			201
		);
		pids.push(created.id);
	}
	foreignPid = (
		await data<Participant>(
			await as('owner', `/actions/${otherActionId}/participants`, {
				method: 'POST',
				json: { name: 'Fremde Person' }
			}),
			201
		)
	).id;
	await data(
		await as('owner', `/actions/${actionId}/shares/${userIds.reader}`, {
			method: 'PUT',
			json: { level: 'read' }
		})
	);
});

describe('PATCH /actions/:id/participants (Mehrfachbearbeitung)', () => {
	it('setzt die Zuschussberechtigung für mehrere Personen', async () => {
		const res = await data<{ updated: number }>(
			await bulk('owner', { ids: [pids[0]!, pids[1]!], subsidyEligible: false })
		);
		expect(res.updated).toBe(2);
		const byId = new Map((await list()).map((p) => [p.id, p]));
		expect(byId.get(pids[0]!)!.subsidyEligible).toBe(false);
		expect(byId.get(pids[0]!)!.subsidyEffective).toBe(false);
		expect(byId.get(pids[1]!)!.subsidyEligible).toBe(false);
		expect(byId.get(pids[2]!)!.subsidyEligible).toBeNull();
	});

	it('setzt "berechtigt" (Wohnort egal) und zurück auf automatisch', async () => {
		await data(await bulk('owner', { ids: [pids[1]!], subsidyEligible: true }));
		let ben = (await list()).find((p) => p.id === pids[1])!;
		expect(ben.subsidyEligible).toBe(true);
		expect(ben.subsidyEffective).toBe(true);

		const res = await data<{ updated: number }>(
			await bulk('owner', { ids: [pids[0]!, pids[1]!], subsidyEligible: null })
		);
		expect(res.updated).toBe(2);
		const all = await list();
		const anna = all.find((p) => p.id === pids[0])!;
		ben = all.find((p) => p.id === pids[1])!;
		expect(anna.subsidyEligible).toBeNull();
		expect(anna.subsidyEffective).toBe(true); // Bremen, 11 Jahre
		expect(ben.subsidyEligible).toBeNull();
		expect(ben.subsidyEffective).toBe(false); // nicht aus Bremen
	});

	it('ändert die Rolle; doppelte IDs zählen einmal', async () => {
		const res = await data<{ updated: number }>(
			await bulk('owner', { ids: [pids[2]!, pids[2]!, pids[1]!], role: 'team' })
		);
		expect(res.updated).toBe(2);
		const all = await list();
		expect(all.find((p) => p.id === pids[2])!.role).toBe('team');
		expect(all.find((p) => p.id === pids[1])!.role).toBe('team');
		expect(all.find((p) => p.id === pids[0])!.role).toBe('participant');
		await data(await bulk('owner', { ids: [pids[1]!, pids[2]!], role: 'participant' }));
	});

	it('kann Rolle und Zuschuss gleichzeitig setzen', async () => {
		await data(await bulk('owner', { ids: [pids[0]!], role: 'team', subsidyEligible: false }));
		const anna = (await list()).find((p) => p.id === pids[0])!;
		expect(anna.role).toBe('team');
		expect(anna.subsidyEligible).toBe(false);
		await data(
			await bulk('owner', { ids: [pids[0]!], role: 'participant', subsidyEligible: null })
		);
	});

	it('Person einer anderen Aktion → 404, nichts geändert', async () => {
		expect(
			await errorOf(await bulk('owner', { ids: [pids[0]!, foreignPid], role: 'team' }), 404)
		).toBe('not_found');
		expect((await list()).find((p) => p.id === pids[0])!.role).toBe('participant');
		expect(
			await errorOf(await bulk('owner', { ids: [crypto.randomUUID()], role: 'team' }), 404)
		).toBe('not_found');
	});

	it('fremde Aktion → 404, Lesende → 403', async () => {
		expect(await errorOf(await bulk('stranger', { ids: [pids[0]!], role: 'team' }), 404)).toBe(
			'not_found'
		);
		expect(await errorOf(await bulk('reader', { ids: [pids[0]!], role: 'team' }), 403)).toBe(
			'forbidden'
		);
	});

	it('Validierung: leere/zu viele IDs, kein Feld, unbekannte Felder → 422', async () => {
		expect(await errorOf(await bulk('owner', { ids: [], role: 'team' }), 422)).toBe(
			'validation_failed'
		);
		const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
		expect(await errorOf(await bulk('owner', { ids: tooMany, role: 'team' }), 422)).toBe(
			'validation_failed'
		);
		expect(await errorOf(await bulk('owner', { ids: [pids[0]!] }), 422)).toBe('validation_failed');
		expect(
			await errorOf(await bulk('owner', { ids: [pids[0]!], role: 'team', name: 'X' }), 422)
		).toBe('validation_failed');
		expect(await errorOf(await bulk('owner', { ids: ['kaputt'], role: 'team' }), 422)).toBe(
			'validation_failed'
		);
	});

	it('schreibt Audit-Einträge ohne Namen', async () => {
		const { rows } = await listAudit({ action: 'actions.participant.bulk' });
		expect(rows.length).toBeGreaterThanOrEqual(4);
		for (const r of rows) {
			expect(r.action).toBe('actions.participant.bulk_updated');
			const text = JSON.stringify(r.metadata);
			for (const name of ['Anna', 'Ben', 'Clara', 'Fremde']) expect(text).not.toContain(name);
			expect(text).not.toContain('2015-03-01');
		}
		const meta = rows.map((r) => r.metadata as Record<string, unknown>);
		expect(meta.some((m) => m.count === 2 && (m.fields as string[]).includes('role'))).toBe(true);
	});
});
