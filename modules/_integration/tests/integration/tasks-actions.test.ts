/**
 * Modul `tasks` mit `members` und `actions` (aus `modules/tasks/tests/integration/tasks.test.ts` hierher verschoben,
 * seit die Basismodule in atrium-basic-modules liegen): Gruppen-Freigabe über verknüpfte Konten, Board an einer Aktion
 * (`/boards/by-action`, nur mit Bearbeiten-Zugriff, einmal je Aktion) und Vererbung der Aktions-Freigabe.
 * Alles ohne `members`/`actions` prüft atrium-basic-modules `modules/tasks/tests/integration/tasks.test.ts`.
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
import tasksModule from '$modules/tasks/module';
import type { ActionBoardInfo, BoardDetail, BoardList } from '$modules/tasks/schemas';
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
	moduleId = 'tasks'
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
}

const ADDRESS = { street: 'Musterweg 1', postalCode: '28357', city: 'Bremen', stage: 'pfadfinder' };

let group: string;
let boardId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(tasksModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	await enableModule(admin, 'tasks');
	admin = await ctxOf(u!.id);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [
				...membersModule.manifest.permissions,
				...actionsModule.manifest.permissions,
				...tasksModule.manifest.permissions
			]
		})
	).key;

	const base = ['core.api.manage', 'tasks.board.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'tasks.board.create', 'actions.action.view', 'actions.action.create']
	});
	const viewer = await createRole(admin, {
		name: 'Mitmachen',
		permissions: [...base, 'actions.action.view']
	});
	const noTasks = await createRole(admin, {
		name: 'Ohne Aufgaben',
		permissions: ['core.api.manage']
	});
	await addUser('owner', planner);
	await addUser('parent', viewer);
	await addUser('helper', viewer);
	await addUser('stranger', viewer);
	await addUser('outsider', noTasks);

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
	const member = ok<{ id: string }>(
		await call(
			'admin',
			'POST',
			'/members',
			{ firstName: 'Anna', lastName: 'A', birthDate: '2014-03-03', groupIds: [group], ...ADDRESS },
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
});

afterAll(async () => {
	await close?.();
});

describe('Boards', () => {
	it('legt ein Board mit Standardspalten an', async () => {
		const board = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Sommerlager-Vorbereitung',
				color: '#16A34A'
			}),
			201
		);
		boardId = board.id;
		expect(board.columns.map((c) => [c.name, c.isDone])).toEqual([
			['Offen', false],
			['In Arbeit', false],
			['Erledigt', true]
		]);
		expect(board.color).toBe('#16a34a');
		expect(board.access).toEqual({ level: 'edit', isOwner: true, canShare: true });
	});

	it('Gruppen-Freigabe (lesen) gibt verknüpften Konten Zugriff', async () => {
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'group', id: group, level: 'read' }]
			})
		);
		const seen = ok<BoardDetail>(await call('parent', 'GET', `/boards/${boardId}`));
		expect(seen.access.level).toBe('read');
		expect(
			(await call('parent', 'POST', `/boards/${boardId}/tasks`, { title: 'Nicht erlaubt' })).status
		).toBe(403);
		expect((await call('parent', 'PUT', `/boards/${boardId}/shares`, { shares: [] })).status).toBe(
			403
		);
	});
});

describe('Board an einer Aktion', () => {
	let actionId: string;
	let actionBoard: string;

	it('legt ein Board für die Aktion an (nur mit Bearbeiten-Zugriff, einmal)', async () => {
		actionId = ok<{ id: string }>(
			await call(
				'owner',
				'POST',
				'/actions',
				{ name: 'Herbstfahrt', startsOn: '2027-10-01' },
				'actions'
			),
			201
		).id;
		const info = ok<ActionBoardInfo>(await call('owner', 'GET', `/boards/by-action/${actionId}`));
		expect(info).toEqual({ board: null, canCreate: true });
		expect((await call('stranger', 'GET', `/boards/by-action/${actionId}`)).status).toBe(404);
		const board = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', { name: 'Herbstfahrt', actionId }),
			201
		);
		actionBoard = board.id;
		expect(board.action).toEqual({ id: actionId, name: 'Herbstfahrt' });
		expect((await call('owner', 'POST', '/boards', { name: 'Doppelt', actionId })).status).toBe(
			409
		);
		expect((await call('stranger', 'POST', '/boards', { name: 'Fremd', actionId })).status).toBe(
			403
		);
	});

	it('Freigabe der Aktion vererbt sich auf das Board', async () => {
		expect((await call('stranger', 'GET', `/boards/${actionBoard}`)).status).toBe(404);
		ok(
			await call(
				'owner',
				'PUT',
				`/actions/${actionId}/shares`,
				{ shares: [{ type: 'user', id: userIds.stranger, level: 'edit' }] },
				'actions'
			)
		);
		const seen = ok<BoardDetail>(await call('stranger', 'GET', `/boards/${actionBoard}`));
		expect(seen.access).toEqual({ level: 'edit', isOwner: false, canShare: false });
		const list = ok<BoardList>(await call('stranger', 'GET', '/boards'));
		expect(list.items.map((b) => b.id)).toContain(actionBoard);
		const info = ok<ActionBoardInfo>(
			await call('stranger', 'GET', `/boards/by-action/${actionId}`)
		);
		expect(info.board?.id).toBe(actionBoard);
		expect(info.canCreate).toBe(false);
	});
});
