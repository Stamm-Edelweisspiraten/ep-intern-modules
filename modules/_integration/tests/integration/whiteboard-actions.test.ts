/**
 * Whiteboard mit `members` und `actions` (aus `atrium-basic-modules/modules/whiteboard/tests/integration/
 * whiteboard.test.ts` hierher verschoben, dort laufen nur die Fälle ohne diese Module):
 * Gruppen-Freigabe über verknüpfte Mitglieder (lesen, Rechteentzug `revoked`, Hochstufen `access`),
 * mehrere Boards je Aktion mit vererbtem Zugriff (`/boards/by-action`) und Aktions-Karten je Betrachter*in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import whiteboardModule from '$modules/whiteboard/module';
import { closeAllStreamsForTests } from '$modules/whiteboard/live';
import type {
	ActionBoards,
	BoardDetail,
	BoardList,
	LiveEvent,
	OpsResult,
	RefCard
} from '$modules/whiteboard/schemas';
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

async function raw(
	who: string,
	method: string,
	path: string,
	body?: BodyInit,
	json = false,
	moduleId = 'whiteboard',
	signal?: AbortSignal
): Promise<Response> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${moduleId}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body, signal }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'whiteboard'
): Promise<Res<T>> {
	const res = await raw(
		who,
		method,
		path,
		json === undefined ? undefined : JSON.stringify(json),
		json !== undefined,
		moduleId
	);
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function fail(res: Res, status: number, code: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body.error?.code).toBe(code);
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

/** Live-Verbindung öffnen und Ereignisse mitschreiben */
async function openLive(who: string, boardId: string, client: string, since?: number) {
	const ac = new AbortController();
	const res = await raw(
		who,
		'GET',
		`/boards/${boardId}/live?client=${client}${since === undefined ? '' : `&since=${since}`}`,
		undefined,
		false,
		'whiteboard',
		ac.signal
	);
	const events: LiveEvent[] = [];
	let ended = false;
	if (res.status === 200 && res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf('\n\n')) >= 0) {
						const chunk = buf.slice(0, i);
						buf = buf.slice(i + 2);
						for (const line of chunk.split('\n')) {
							if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as LiveEvent);
						}
					}
				}
			} catch {
				// abgebrochen
			}
			ended = true;
		})();
	}
	const waitFor = <T extends LiveEvent['type']>(
		type: T,
		pred: (e: Extract<LiveEvent, { type: T }>) => boolean = () => true
	) =>
		vi.waitFor(
			() => {
				const hit = events.find(
					(e): e is Extract<LiveEvent, { type: T }> =>
						e.type === type && pred(e as Extract<LiveEvent, { type: T }>)
				);
				expect(
					hit,
					`Ereignis ${type} – bisher: ${events.map((e) => e.type).join(',')}`
				).toBeTruthy();
				return hit!;
			},
			{ timeout: 3000 }
		);
	return {
		status: res.status,
		events,
		waitFor,
		isEnded: () => ended,
		close: () => ac.abort()
	};
}

const ADDRESS = { street: 'Musterweg 1', postalCode: '28357', city: 'Bremen', stage: 'pfadfinder' };

function shapeOp(id = crypto.randomUUID(), text = 'Idee', x = 10) {
	return {
		id,
		type: 'shape' as const,
		z: 1,
		data: { kind: 'note', x, y: 20, w: 160, h: 120, text, fill: '#fff59d' }
	};
}

let group: string;
let boardId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(tasksModule);
	registerModule(whiteboardModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'actions', 'tasks', 'whiteboard']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [
				...membersModule.manifest.permissions,
				...actionsModule.manifest.permissions,
				...tasksModule.manifest.permissions,
				...whiteboardModule.manifest.permissions
			]
		})
	).key;

	const base = ['core.api.manage', 'whiteboard.board.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [
			...base,
			'whiteboard.board.create',
			'actions.action.view',
			'actions.action.create',
			'tasks.board.view',
			'tasks.board.create'
		]
	});
	const viewer = await createRole(admin, {
		name: 'Mitmachen',
		permissions: [...base, 'actions.action.view', 'tasks.board.view']
	});
	const without = await createRole(admin, {
		name: 'Ohne Whiteboard',
		permissions: ['core.api.manage']
	});
	await addUser('owner', planner);
	await addUser('parent', viewer);
	await addUser('helper', viewer);
	await addUser('stranger', viewer);
	await addUser('outsider', without);

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
	boardId = ok<BoardDetail>(
		await call('owner', 'POST', '/boards', { name: 'Programmideen' }),
		201
	).id;
});

afterAll(async () => {
	closeAllStreamsForTests();
	await close?.();
});

describe('Gruppen-Freigabe (members)', () => {
	it('Gruppen-Freigabe (lesen) gibt verknüpften Konten Lesezugriff, aber keine Änderungen', async () => {
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [
					{ type: 'group', id: group, level: 'read' },
					{ type: 'user', id: userIds.helper, level: 'edit' }
				]
			})
		);
		const seen = ok<BoardDetail>(await call('parent', 'GET', `/boards/${boardId}`));
		expect(seen.access.level).toBe('read');
		fail(
			await call('parent', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-parent',
				ops: [shapeOp()]
			}),
			403,
			'forbidden'
		);
		fail(
			await call('parent', 'PUT', `/boards/${boardId}/shares`, { shares: [] }),
			403,
			'forbidden'
		);
		const helper = ok<BoardDetail>(await call('helper', 'GET', `/boards/${boardId}`));
		expect(helper.access).toEqual({ level: 'edit', isOwner: false, canShare: false });
		fail(await call('helper', 'DELETE', `/boards/${boardId}`), 403, 'forbidden');
	});
	it('Rechteentzug schließt die Verbindung (revoked)', async () => {
		const live = await openLive('helper', boardId, 'client-helper-2');
		await live.waitFor('hello');
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'group', id: group, level: 'read' }]
			})
		);
		await live.waitFor('revoked');
		await vi.waitFor(() => expect(live.isEnded()).toBe(true));
		fail(await call('helper', 'GET', `/boards/${boardId}`), 404, 'not_found');
	});

	it('Hochstufen meldet `access` an offene Verbindungen', async () => {
		const live = await openLive('parent', boardId, 'client-parent-2');
		await live.waitFor('hello', (e) => e.level === 'read');
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'group', id: group, level: 'edit' }]
			})
		);
		await live.waitFor('access', (e) => e.level === 'edit');
		live.close();
	});

	it('Gruppen-Freigabe `edit` erlaubt verknüpften Konten Änderungen', async () => {
		const res = ok<OpsResult>(
			await call('parent', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-parent-edit',
				ops: [shapeOp()]
			}),
			201
		);
		expect(res.applied).toHaveLength(1);
	});
});

describe('Aktionen', () => {
	let actionId: string;

	it('mehrere Whiteboards je Aktion; Zugriff der Aktion vererbt sich', async () => {
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
		expect(ok<ActionBoards>(await call('owner', 'GET', `/boards/by-action/${actionId}`))).toEqual({
			boards: [],
			canCreate: true
		});
		fail(await call('stranger', 'GET', `/boards/by-action/${actionId}`), 404, 'not_found');
		const a = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', { name: 'Programm', actionId }),
			201
		);
		const b = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', { name: 'Packliste', actionId }),
			201
		);
		expect(a.actionName).toBe('Herbstfahrt');
		fail(await call('stranger', 'POST', '/boards', { name: 'X', actionId }), 403, 'forbidden');
		fail(await call('stranger', 'GET', `/boards/${a.id}`), 404, 'not_found');

		ok(
			await call(
				'owner',
				'PUT',
				`/actions/${actionId}/shares`,
				{ shares: [{ type: 'user', id: userIds.stranger, level: 'edit' }] },
				'actions'
			)
		);
		const seen = ok<BoardDetail>(await call('stranger', 'GET', `/boards/${a.id}`));
		expect(seen.access).toEqual({ level: 'edit', isOwner: false, canShare: false });
		const info = ok<ActionBoards>(await call('stranger', 'GET', `/boards/by-action/${actionId}`));
		expect(info.boards.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
		expect(info.canCreate).toBe(false);
		const filtered = ok<BoardList>(await call('stranger', 'GET', `/boards?actionId=${actionId}`));
		expect(filtered.total).toBe(2);
	});

	it('Aktions-Karten je Betrachter*in (kein Zugriff → nicht verfügbar)', async () => {
		const found = ok<RefCard[]>(await call('owner', 'GET', '/refs?type=action&search=Herbst'));
		expect(found.map((c) => [c.id, c.title])).toEqual([[actionId, 'Herbstfahrt']]);
		const items = [{ type: 'action', id: actionId }];
		const [mine] = ok<RefCard[]>(await call('owner', 'POST', '/refs/describe', { items }), 201);
		expect(mine).toMatchObject({ available: true, title: 'Herbstfahrt', badge: null });
		expect(mine!.href).toContain('/modules/actions/');
		const [theirs] = ok<RefCard[]>(await call('helper', 'POST', '/refs/describe', { items }), 201);
		expect(theirs).toMatchObject({ available: false, title: 'Aktion nicht verfügbar' });
		expect(JSON.stringify(theirs)).not.toContain('Herbstfahrt');
	});
});
