/**
 * Modul `actions` – Freigabe an Principals (Migration 0022): Gruppe (verknüpfte Konten der Mitglieder),
 * Rolle, Stamm, Mitglied; PUT ersetzt alle Freigaben, Prüfung der Ziele (422), nur Eigentümer*in teilt,
 * `/principals` nur für Teilende, Liste/Detail-Zugriff. Upgrade-Test in `module-data-migrations.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import type { ActionShares, ActionSummary } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; details?: unknown } };
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'actions'
): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${moduleId}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function addUser(who: string, roleId: string) {
	const id = await createUser(admin, {
		name: `Person ${who}`,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	userIds[who] = id;
	const ctx = await ctxOf(id);
	keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
	return id;
}

const ADDRESS = {
	street: 'Musterweg 1',
	postalCode: '28357',
	city: 'Bremen',
	stage: 'pfadfinder'
};

let group: string;
let member: string;
let roleShared: string;
let actionId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
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
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...membersModule.manifest.permissions, ...actionsModule.manifest.permissions]
		})
	).key;

	const base = ['core.api.manage', 'actions.action.view'];
	const ownerRole = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'actions.action.create', 'members.member.view']
	});
	const viewRole = await createRole(admin, { name: 'Lesende', permissions: base });
	roleShared = await createRole(admin, { name: 'Team Fahrt', permissions: base });
	await addUser('owner', ownerRole);
	await addUser('parent', viewRole); // Konto eines Gruppenmitglieds
	await addUser('teamer', roleShared);
	await addUser('stranger', viewRole);

	const leader = ok<{ id: string }>(
		await call(
			'admin',
			'POST',
			'/members',
			{ firstName: 'Lea', lastName: 'Leitung', birthDate: '2000-01-01', ...ADDRESS },
			'members'
		),
		201
	).id;
	group = ok<{ id: string }>(
		await call(
			'admin',
			'POST',
			'/groups',
			{ name: 'Sippe Falke', type: 'sippe', leaderIds: [leader] },
			'members'
		),
		201
	).id;
	member = ok<{ id: string }>(
		await call(
			'admin',
			'POST',
			'/members',
			{
				firstName: 'Anna',
				lastName: 'Albrecht',
				birthDate: '2014-03-03',
				groupIds: [group],
				...ADDRESS
			},
			'members'
		),
		201
	).id;
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation)
				VALUES (${member}, ${userIds.parent!}, 'Mutter')`
		);
	});

	actionId = ok<ActionSummary>(
		await call('owner', 'POST', '/actions', { name: 'Sommerlager', startsOn: '2027-07-01' }),
		201
	).id;
});

afterAll(async () => {
	await close?.();
});

describe('Freigabe an Principals', () => {
	it('ohne Freigabe kein Zugriff', async () => {
		expect((await call('parent', 'GET', `/actions/${actionId}`)).status).toBe(404);
		expect((await call('teamer', 'GET', `/actions/${actionId}`)).status).toBe(404);
	});

	it('Gruppe (lesen) und Rolle (bearbeiten) geben Zugriff', async () => {
		const res = ok<ActionShares>(
			await call('owner', 'PUT', `/actions/${actionId}/shares`, {
				shares: [
					{ type: 'group', id: group, level: 'read' },
					{ type: 'role', id: roleShared, level: 'edit' }
				]
			})
		);
		expect(res.shares.map((s) => [s.type, s.name, s.level]).sort()).toEqual([
			['group', 'Sippe Falke', 'read'],
			['role', 'Team Fahrt', 'edit']
		]);

		const asParent = ok<ActionSummary>(await call('parent', 'GET', `/actions/${actionId}`));
		expect(asParent.access).toEqual({ level: 'read', isOwner: false, canShare: false });
		expect(
			(await call('parent', 'PUT', `/actions/${actionId}`, { name: 'X', startsOn: '2027-07-01' }))
				.status
		).toBe(403);

		const asTeamer = ok<ActionSummary>(await call('teamer', 'GET', `/actions/${actionId}`));
		expect(asTeamer.access.level).toBe('edit');
		const list = ok<{ items: ActionSummary[] }>(await call('teamer', 'GET', '/actions'));
		expect(list.items.find((a) => a.id === actionId)?.access.level).toBe('edit');

		expect((await call('stranger', 'GET', `/actions/${actionId}`)).status).toBe(404);
		const strangerList = ok<{ items: ActionSummary[] }>(await call('stranger', 'GET', '/actions'));
		expect(strangerList.items.some((a) => a.id === actionId)).toBe(false);
	});

	it('Bearbeitende dürfen Freigaben nicht ändern', async () => {
		expect(
			(await call('teamer', 'PUT', `/actions/${actionId}/shares`, { shares: [] })).status
		).toBe(403);
	});

	it('Stamm-Freigabe gilt für alle mit Basisrecht', async () => {
		ok(
			await call('owner', 'PUT', `/actions/${actionId}/shares`, {
				shares: [{ type: 'everyone', id: '*', level: 'read' }]
			})
		);
		expect((await call('stranger', 'GET', `/actions/${actionId}`)).status).toBe(200);
		expect((await call('teamer', 'GET', `/actions/${actionId}`)).status).toBe(200);
	});

	it('Mitglieds-Freigabe gilt für verknüpfte Konten; PUT ersetzt alles', async () => {
		ok(
			await call('owner', 'PUT', `/actions/${actionId}/shares`, {
				shares: [{ type: 'member', id: member, level: 'edit' }]
			})
		);
		expect(
			ok<ActionSummary>(await call('parent', 'GET', `/actions/${actionId}`)).access.level
		).toBe('edit');
		expect((await call('stranger', 'GET', `/actions/${actionId}`)).status).toBe(404);
		expect((await call('teamer', 'GET', `/actions/${actionId}`)).status).toBe(404);
	});

	it('prüft Ziele: unbekannt, doppelt, Eigentümer*in, everyone ohne *', async () => {
		const put = (shares: unknown[]) =>
			call('owner', 'PUT', `/actions/${actionId}/shares`, { shares });
		expect(
			(await put([{ type: 'group', id: '00000000-0000-4000-8000-000000000000', level: 'read' }]))
				.status
		).toBe(422);
		expect(
			(
				await put([
					{ type: 'group', id: group, level: 'read' },
					{ type: 'group', id: group, level: 'edit' }
				])
			).status
		).toBe(422);
		expect((await put([{ type: 'user', id: userIds.owner, level: 'read' }])).status).toBe(422);
		expect((await put([{ type: 'everyone', id: 'x', level: 'read' }])).status).toBe(422);
	});

	it('/principals nur für Teilende, findet Gruppen', async () => {
		const found = ok<{ type: string; id: string }[]>(
			await call('owner', 'GET', '/principals?search=Falke')
		);
		expect(found.some((p) => p.type === 'group' && p.id === group)).toBe(true);
		expect((await call('stranger', 'GET', '/principals?search=Falke')).status).toBe(403);
	});

	it('Benutzer-Kurzform bleibt erhalten und ergänzt die Liste', async () => {
		ok(
			await call('owner', 'PUT', `/actions/${actionId}/shares`, {
				shares: [{ type: 'group', id: group, level: 'read' }]
			})
		);
		ok(
			await call('owner', 'PUT', `/actions/${actionId}/shares/${userIds.stranger}`, {
				level: 'edit'
			})
		);
		const shares = ok<ActionShares>(await call('owner', 'GET', `/actions/${actionId}/shares`));
		expect(shares.shares.map((s) => `${s.type}:${s.userId}`).sort()).toEqual(
			[`group:${group}`, `user:${userIds.stranger}`].sort()
		);
		ok(await call('stranger', 'DELETE', `/actions/${actionId}/shares/${userIds.stranger}`));
		expect((await call('stranger', 'GET', `/actions/${actionId}`)).status).toBe(404);
	});
});
