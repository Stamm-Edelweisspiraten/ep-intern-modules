/**
 * Core `embeds` (Einbetten von Modul-Inhalten) mit dem Whiteboard als Anbieterin: Arten, Suche nur über sichtbare
 * Boards, Auflösung je Betrachter*in (fremd/unbekannt/Modul aus → `available: false`), Pfade, Eingabegrenzen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import whiteboardModule from '$modules/whiteboard/module';
import type { EmbedHit, EmbedInfo, EmbedKind } from '$lib/sdk/types/embeds';
import type { RequestContext } from '$lib/sdk/types';

const API = 'http://localhost:5173/api/v1';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;
let boardId: string;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string } };
}

async function call<T>(who: string, method: string, path: string, json?: unknown): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${API}${path}`);
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

async function addUser(who: string, roleIds: string[]) {
	const id = await createUser(admin, {
		name: `Person ${who}`,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds
	});
	userIds[who] = id;
	const ctx = await ctxOf(id);
	keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(whiteboardModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'whiteboard');
	admin = await ctxOf(u!.id);
	const role = await createRole(admin, {
		name: 'Board',
		permissions: ['whiteboard.board.view', 'whiteboard.board.create', 'core.api.manage']
	});
	const plain = await createRole(admin, { name: 'Ohne', permissions: ['core.api.manage'] });
	await addUser('owner', [role]);
	await addUser('stranger', [role]);
	await addUser('nobody', [plain]);
	const res = await call<{ id: string }>('owner', 'POST', '/modules/whiteboard/boards', {
		name: 'Lagerplan Sommer'
	});
	boardId = ok(res, 201).id;
}, 60_000);

afterAll(async () => {
	await close?.();
});

describe('core embeds', () => {
	it('Arten: Whiteboard nur mit Recht', async () => {
		const kinds = ok<EmbedKind[]>(await call('owner', 'GET', '/embeds/kinds'));
		expect(kinds).toEqual([
			{ module: 'whiteboard', kind: 'board', label: 'Whiteboard', icon: 'presentation' }
		]);
		expect(ok<EmbedKind[]>(await call('nobody', 'GET', '/embeds/kinds'))).toEqual([]);
	});

	it('Suche findet nur sichtbare Boards, ab 2 Zeichen', async () => {
		const mine = ok<EmbedHit[]>(await call('owner', 'GET', '/embeds?q=Lagerplan'));
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({
			module: 'whiteboard',
			kind: 'board',
			refId: boardId,
			title: 'Lagerplan Sommer',
			kindLabel: 'Whiteboard',
			icon: 'presentation'
		});
		expect(ok<EmbedHit[]>(await call('stranger', 'GET', '/embeds?q=Lagerplan'))).toEqual([]);
		expect(ok<EmbedHit[]>(await call('owner', 'GET', '/embeds?q=L'))).toEqual([]);
		expect(ok<EmbedHit[]>(await call('nobody', 'GET', '/embeds?q=Lagerplan'))).toEqual([]);
	});

	it('describe: eigene verfügbar mit Pfaden, fremd/unbekannt/falsche Art → nicht verfügbar', async () => {
		const items = [
			{ module: 'whiteboard', kind: 'board', refId: boardId },
			{ module: 'whiteboard', kind: 'board', refId: crypto.randomUUID() },
			{ module: 'whiteboard', kind: 'other', refId: boardId },
			{ module: 'gibtsnicht', kind: 'board', refId: boardId }
		];
		const mine = ok<EmbedInfo[]>(await call('owner', 'POST', '/embeds/describe', { items }), 201);
		expect(mine).toHaveLength(4);
		expect(mine[0]).toMatchObject({
			available: true,
			title: 'Lagerplan Sommer',
			canEdit: true,
			embedPath: `/embed/whiteboard/${boardId}`,
			openHref: `/modules/whiteboard/${boardId}`
		});
		for (const info of mine.slice(1)) {
			expect(info).toMatchObject({
				available: false,
				title: 'Nicht verfügbar',
				embedPath: null,
				openHref: null
			});
		}
		const theirs = ok<EmbedInfo[]>(
			await call('stranger', 'POST', '/embeds/describe', { items: items.slice(0, 1) }),
			201
		);
		expect(theirs[0]).toMatchObject({ available: false, title: 'Nicht verfügbar' });
	});

	it('Freigabe read → verfügbar ohne Bearbeiten', async () => {
		ok(
			await call('owner', 'PUT', `/modules/whiteboard/boards/${boardId}/shares`, {
				shares: [{ type: 'user', id: userIds.stranger, level: 'read' }]
			})
		);
		const [info] = ok<EmbedInfo[]>(
			await call('stranger', 'POST', '/embeds/describe', {
				items: [{ module: 'whiteboard', kind: 'board', refId: boardId }]
			}),
			201
		);
		expect(info).toMatchObject({ available: true, canEdit: false });
	});

	it('core.embeds.describe für Server-Code (Export)', async () => {
		const ctx = await ctxOf(userIds.owner!);
		const [info] = await core.embeds.describe(ctx, [
			{ module: 'whiteboard', kind: 'board', refId: boardId }
		]);
		expect(info?.title).toBe('Lagerplan Sommer');
	});

	it('Eingabe: ungültige Schlüssel und mehr als 200 Einträge → 422', async () => {
		const bad = await call('owner', 'POST', '/embeds/describe', {
			items: [{ module: 'White Board', kind: 'board', refId: boardId }]
		});
		expect(bad.status).toBe(422);
		const many = Array.from({ length: 201 }, () => ({
			module: 'whiteboard',
			kind: 'board',
			refId: boardId
		}));
		expect((await call('owner', 'POST', '/embeds/describe', { items: many })).status).toBe(422);
	});

	it('Modul aus → nicht verfügbar, keine Arten', async () => {
		await disableModule(admin, 'whiteboard');
		const [info] = ok<EmbedInfo[]>(
			await call('owner', 'POST', '/embeds/describe', {
				items: [{ module: 'whiteboard', kind: 'board', refId: boardId }]
			}),
			201
		);
		expect(info).toMatchObject({ available: false, title: 'Nicht verfügbar' });
		expect(ok<EmbedKind[]>(await call('owner', 'GET', '/embeds/kinds'))).toEqual([]);
	});
});
