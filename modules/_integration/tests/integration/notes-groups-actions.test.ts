/**
 * Modul `notes` zusammen mit `members` und `actions` (beide nur optionale Abhängigkeiten von `notes`, das Modul
 * selbst liegt in atrium-basic-modules): Freigabe an eine Gruppe wirkt über ein verknüpftes Mitglied und vererbt
 * sich auf Unterseiten, Gruppen in der Freigabe-Suche, Entzug über die Gruppe beendet Live-Verbindungen, Notizen
 * einer Aktion (Zugriff über die Aktion, `/notes/by-action`, Aktion lösen). Ausgelagert aus
 * `modules/notes/tests/integration/notes.test.ts`, das dort ohne `members`/`actions` läuft.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import notesModule from '$modules/notes/module';
import { hub } from '$modules/notes/live';
import { resetDocsForTests } from '$modules/notes/doc.service';
import type {
	ActionNotes,
	LiveEvent,
	NoteDetail,
	NoteRoots,
	NoteShares
} from '$modules/notes/schemas';
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
	init: { body?: BodyInit; type?: string; signal?: AbortSignal; moduleId?: string } = {}
): Promise<Response> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (init.type) headers.set('content-type', init.type);
	const url = new URL(`${ROOT}/${init.moduleId ?? 'notes'}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body: init.body, signal: init.signal }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'notes'
): Promise<Res<T>> {
	const res = await raw(who, method, path, {
		body: json === undefined ? undefined : JSON.stringify(json),
		type: json === undefined ? undefined : 'application/json',
		moduleId
	});
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
async function openLive(who: string, noteId: string, client: string) {
	const ac = new AbortController();
	const res = await raw(who, 'GET', `/notes/${noteId}/live?client=${client}&awarenessId=7`, {
		signal: ac.signal
	});
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
	return { status: res.status, events, waitFor, isEnded: () => ended, close: () => ac.abort() };
}

const ADDRESS = { street: 'Musterweg 1', postalCode: '28357', city: 'Bremen', stage: 'pfadfinder' };

let group: string;
let rootId: string;
let childId: string;
let grandId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(notesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'actions', 'notes']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [
				...membersModule.manifest.permissions,
				...actionsModule.manifest.permissions,
				...notesModule.manifest.permissions
			]
		})
	).key;

	const base = ['core.api.manage', 'notes.note.view', 'actions.action.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'notes.note.create', 'actions.action.create']
	});
	const viewer = await createRole(admin, { name: 'Mitlesen', permissions: base });
	await addUser('owner', planner);
	await addUser('other', planner);
	await addUser('helper', viewer);
	await addUser('parent', viewer);
	await addUser('stranger', viewer);

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

	rootId = ok<NoteDetail>(await call('owner', 'POST', '/notes', { title: 'Sommerlager' }), 201).id;
	childId = ok<NoteDetail>(
		await call('owner', 'POST', '/notes', { title: 'Programm', parentId: rootId }),
		201
	).id;
	grandId = ok<NoteDetail>(
		await call('owner', 'POST', '/notes', { title: 'Tag 1', parentId: childId }),
		201
	).id;
});

afterEach(() => {
	hub.closeAll();
});

afterAll(async () => {
	hub.closeAll();
	await resetDocsForTests();
	await close?.();
});

describe('Gruppen (members)', () => {
	it('Freigabe an eine Gruppe wirkt über das verknüpfte Mitglied und vererbt sich', async () => {
		fail(await call('parent', 'GET', `/notes/${grandId}`), 404, 'not_found');
		const shares = ok<NoteShares>(
			await call('owner', 'PUT', `/notes/${rootId}/shares`, {
				shares: [
					{ type: 'user', id: userIds.helper, level: 'read' },
					{ type: 'group', id: group, level: 'read' }
				]
			})
		);
		expect(shares.shares).toHaveLength(2);
		const seen = ok<NoteDetail>(await call('parent', 'GET', `/notes/${grandId}`));
		expect(seen.level).toBe('read');
		fail(await call('stranger', 'GET', `/notes/${grandId}`), 404, 'not_found');
	});

	it('geerbte Gruppenfreigabe ist an der Unterseite sichtbar', async () => {
		ok(
			await call('owner', 'PUT', `/notes/${childId}/shares`, {
				shares: [{ type: 'user', id: userIds.helper, level: 'edit' }]
			})
		);
		const shares = ok<NoteShares>(await call('helper', 'GET', `/notes/${grandId}/shares`));
		expect(shares.shares).toEqual([]);
		expect(shares.canManage).toBe(false);
		expect(shares.inherited.map((s) => [s.type, s.fromTitle, s.level]).sort()).toEqual(
			[
				['group', 'Sommerlager', 'read'],
				['user', 'Programm', 'edit'],
				['user', 'Sommerlager', 'read']
			].sort()
		);
	});

	it('Freigabe-Ziele: Gruppen nur für Teilende', async () => {
		fail(await call('stranger', 'GET', '/principals?search=Sippe'), 403, 'forbidden');
		const found = ok<{ type: string; id: string }[]>(
			await call('owner', 'GET', '/principals?search=Sippe')
		);
		expect(found.some((p) => p.type === 'group' && p.id === group)).toBe(true);
	});

	it('Entzug der Freigabe schließt die Verbindung (revoked), Gruppe behält Zugriff', async () => {
		const live = await openLive('helper', grandId, 'client-helper-revoke');
		await live.waitFor('hello', (e) => e.level === 'edit');
		ok(await call('owner', 'PUT', `/notes/${childId}/shares`, { shares: [] }));
		await live.waitFor('access', (e) => e.level === 'read');
		ok(
			await call('owner', 'PUT', `/notes/${rootId}/shares`, {
				shares: [{ type: 'group', id: group, level: 'read' }]
			})
		);
		await live.waitFor('revoked');
		await vi.waitFor(() => expect(live.isEnded()).toBe(true));
		fail(await call('helper', 'GET', `/notes/${grandId}`), 404, 'not_found');
		expect(ok<NoteDetail>(await call('parent', 'GET', `/notes/${grandId}`)).level).toBe('read');
		ok(await call('owner', 'PUT', `/notes/${rootId}/shares`, { shares: [] }));
		fail(await call('parent', 'GET', `/notes/${grandId}`), 404, 'not_found');
	});
});

describe('Aktionen', () => {
	it('Notizen einer Aktion: Zugriff über die Aktion', async () => {
		const actionId = ok<{ id: string }>(
			await call(
				'owner',
				'POST',
				'/actions',
				{ name: 'Herbstfahrt', startsOn: '2027-10-01' },
				'actions'
			),
			201
		).id;
		fail(await call('other', 'POST', '/notes', { title: 'X', actionId }), 422, 'validation_failed');
		const note = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', { title: 'Planung', actionId }),
			201
		);
		expect(note.actionName).toBe('Herbstfahrt');
		fail(await call('stranger', 'GET', `/notes/${note.id}`), 404, 'not_found');
		fail(await call('stranger', 'GET', `/notes/by-action/${actionId}`), 404, 'not_found');
		ok(
			await call(
				'owner',
				'PUT',
				`/actions/${actionId}/shares`,
				{ shares: [{ type: 'user', id: userIds.stranger, level: 'edit' }] },
				'actions'
			)
		);
		const seen = ok<NoteDetail>(await call('stranger', 'GET', `/notes/${note.id}`));
		expect(seen).toMatchObject({ level: 'edit', canShare: false });
		const info = ok<ActionNotes>(await call('stranger', 'GET', `/notes/by-action/${actionId}`));
		expect(info.notes.map((n) => n.id)).toEqual([note.id]);
		expect(info.canCreate).toBe(false);
		const roots = ok<NoteRoots>(await call('stranger', 'GET', '/notes/roots'));
		expect(roots.actions.map((n) => [n.id, n.actionName])).toEqual([[note.id, 'Herbstfahrt']]);
		// Aktion lösen: nur Eigentümer*in
		fail(
			await call('stranger', 'PATCH', `/notes/${note.id}`, { actionId: null }),
			403,
			'forbidden'
		);
		const freed = ok<NoteDetail>(
			await call('owner', 'PATCH', `/notes/${note.id}`, { actionId: null })
		);
		expect(freed.actionId).toBeNull();
		fail(await call('stranger', 'GET', `/notes/${note.id}`), 404, 'not_found');
	});
});
