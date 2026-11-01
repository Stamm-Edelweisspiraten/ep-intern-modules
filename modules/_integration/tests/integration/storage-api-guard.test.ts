/**
 * Issue #3: Die generische Storage-API (`/api/v1/storage/*`) ist nur mit `core.storage.manage`
 * erreichbar. `<modul>.storage.*` öffnet sie nicht – Moduldateien laufen ausschließlich über die
 * Modul-Endpunkte mit Objektprüfung (Freigabe, Eigentum, Abschluss-Sperre).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { fakeFileRows, fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

let admin: RequestContext;
let adminId = '';
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

async function codeOf(res: Response): Promise<{ status: number; code: string | undefined }> {
	const body = await res.json().catch(() => ({}));
	return { status: res.status, code: body?.error?.code };
}

const STORAGE = ['actions.storage.read', 'actions.storage.write', 'actions.storage.delete'];
const PERMS = ['core.api.manage', 'actions.action.view', 'actions.action.create', ...STORAGE];

/** Alle generischen Storage-Aufrufe für einen Modulbereich. */
function genericCalls(path: string) {
	const q = `module=actions&path=${encodeURIComponent(path)}`;
	return {
		list: () => `/storage/files?module=actions`,
		listPrefix: () =>
			`/storage/files?module=actions&prefix=${encodeURIComponent(path.split('/')[0]!)}`,
		downloadUrl: () => `/storage/download-url?${q}`,
		delete: () => `/storage/files?${q}`,
		q
	};
}

async function expectAllForbidden(token: string, path: string) {
	const c = genericCalls(path);
	const results = [
		await api(c.list(), { token }),
		await api(c.listPrefix(), { token }),
		await api(c.downloadUrl(), { token }),
		await api(c.delete(), { token, method: 'DELETE' }),
		await api('/storage/upload-url', {
			token,
			method: 'POST',
			json: { module: 'actions', path, contentType: 'application/pdf', size: 10 }
		}),
		await api(`/storage/files/${crypto.randomUUID()}/confirm`, { token, method: 'POST' })
	];
	for (const r of results) expect(await codeOf(r)).toEqual({ status: 403, code: 'forbidden' });
}

const PDF = '%PDF-1.4 x';
function uploadForm(): FormData {
	const fd = new FormData();
	fd.set('file', new File([PDF], 'beleg.pdf', { type: 'application/pdf' }));
	return fd;
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
	adminId = u!.id;
	admin = (await contextForUser(adminId))!.ctx;
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = (await contextForUser(adminId))!.ctx;

	const roleId = await createRole(admin, { name: 'storage-role', permissions: PERMS });
	for (const name of ['owner', 'stranger']) {
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = (await contextForUser(userIds[name]!))!.ctx;
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: PERMS })).key;
	}
	keys.admin = (
		await createApiKey(admin, { name: 'key-admin', scopes: ['core.storage.manage'] })
	).key;
	keys.adminNoStorage = (
		await createApiKey(admin, { name: 'key-admin-ohne', scopes: ['core.users.view'] })
	).key;
});

afterAll(() => uninstallFakeStorage());

describe('Generische Storage-API ohne konfigurierten Speicher', () => {
	it('verweigert mit 403, bevor der Speicher angesprochen wird (403 vor 503)', async () => {
		await expectAllForbidden(keys.stranger!, 'x/y.pdf');
	});

	it('lässt core.storage.manage bis zum Storage durch (503 unavailable)', async () => {
		const list = await api('/storage/files?module=actions', { token: keys.admin });
		expect(list.status).toBe(200);
		const res = await api('/storage/upload-url', {
			token: keys.admin,
			method: 'POST',
			json: { module: 'actions', path: 'x/y.pdf', contentType: 'application/pdf', size: 10 }
		});
		expect(await codeOf(res)).toEqual({ status: 503, code: 'unavailable' });
	});

	it('API-Key ohne Scope core.storage.manage → 403, auch für Admins', async () => {
		const res = await api('/storage/files?module=actions', { token: keys.adminNoStorage });
		expect(await codeOf(res)).toEqual({ status: 403, code: 'forbidden' });
	});

	it('ohne Anmeldung → 401', async () => {
		const res = await api('/storage/files?module=actions');
		expect(res.status).toBe(401);
	});
});

describe('Generische Storage-API mit Speicher', () => {
	let actionId = '';
	let entryId = '';
	let receiptPath = '';
	const receiptUrl = () =>
		`/modules/actions/actions/${actionId}/accounting/entries/${entryId}/receipt`;

	beforeAll(async () => {
		await installFakeStorage(admin);
		const a = await api('/modules/actions/actions', {
			token: keys.owner,
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
		});
		expect(a.status).toBe(201);
		actionId = (await a.json()).data.id;
		const e = await api(`/modules/actions/actions/${actionId}/accounting/entries`, {
			token: keys.owner,
			method: 'POST',
			json: {
				type: 'expense',
				category: 'food',
				description: 'Einkauf',
				amountCents: 5000,
				entryDate: '2026-07-12',
				paidBy: 'club',
				payeeId: null
			}
		});
		expect(e.status).toBe(201);
		entryId = (await e.json()).data.id;
		const up = await api(receiptUrl(), { token: keys.owner, method: 'POST', body: uploadForm() });
		expect(up.status).toBe(201);
		const row = [...fakeFileRows.values()].find((r) => r.moduleId === 'actions');
		receiptPath = row!.path;
		expect(receiptPath.startsWith(`${actionId}/`)).toBe(true);
	});

	it('Fremde mit actions.storage.* bekommen über die generische API nur 403', async () => {
		await expectAllForbidden(keys.stranger!, receiptPath);
		expect(fakeObjects.size).toBe(1);
	});

	it('auch die Eigentümer*in kommt nicht über die generische API an den eigenen Beleg', async () => {
		await expectAllForbidden(keys.owner!, receiptPath);
		expect(fakeObjects.size).toBe(1);
	});

	it('Modul-Endpunkt: Eigentümer*in 200, Fremde ohne Freigabe 404', async () => {
		const own = await api(receiptUrl(), { token: keys.owner });
		expect(own.status).toBe(200);
		expect(new TextDecoder().decode(await own.arrayBuffer())).toBe(PDF);
		const foreign = await api(receiptUrl(), { token: keys.stranger });
		expect(await codeOf(foreign)).toEqual({ status: 404, code: 'not_found' });
	});

	it('Beleg einer abgeschlossenen Abrechnung lässt sich ohne core.storage.manage nicht löschen', async () => {
		await core.database.forModule('actions').transaction(async (tx) => {
			await tx.execute(
				sql`INSERT INTO action_accounting (action_id, closed_at, closed_by)
					VALUES (${actionId}, now(), ${userIds.owner})`
			);
		});
		const c = genericCalls(receiptPath);
		for (const who of ['owner', 'stranger']) {
			const res = await api(c.delete(), { token: keys[who], method: 'DELETE' });
			expect(await codeOf(res)).toEqual({ status: 403, code: 'forbidden' });
		}
		expect(fakeObjects.size).toBe(1);
		// Modul-Endpunkt respektiert die Sperre
		const modDel = await api(receiptUrl(), { token: keys.owner, method: 'DELETE' });
		expect(modDel.status).toBe(409);
		expect(fakeObjects.size).toBe(1);
	});

	it('mit core.storage.manage funktioniert die API unverändert', async () => {
		const c = genericCalls(receiptPath);
		const root = await api(c.list(), { token: keys.admin });
		expect(root.status).toBe(200);
		expect((await root.json()).data.folders).toContain(actionId);

		const dir = await api(c.listPrefix(), { token: keys.admin });
		expect(dir.status).toBe(200);
		expect((await dir.json()).data.files.map((f: { path: string }) => f.path)).toContain(
			receiptPath
		);

		const dl = await api(c.downloadUrl(), { token: keys.admin });
		expect(dl.status).toBe(200);

		const del = await api(c.delete(), { token: keys.admin, method: 'DELETE' });
		expect(del.status).toBe(200);
		expect(fakeObjects.size).toBe(0);
	});
});
