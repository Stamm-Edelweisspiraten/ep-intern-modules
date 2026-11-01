import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
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
import officesModule from '$modules/offices/module';
import {
	HOLDER_ROLE_NAME,
	type Office,
	type RoleRef,
	type UserRef
} from '$modules/offices/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Modul „Ämter“: CRUD, Reihenfolge, Validierung, Zugriff, Audit, Modul deaktiviert.

const BASE = 'http://localhost:5173/api/v1/modules/offices';
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

let close: () => Promise<void>;
let admin: RequestContext;
let adminKey: string;
let viewerKey: string;
let outsiderKey: string;
let hannaId: string;
let roleKasseId: string;
let roleMaterialId: string;

interface ApiResult<T = unknown> {
	status: number;
	data: T;
	error: { code: string; message: string; details?: unknown } | undefined;
}

async function api<T = unknown>(
	key: string,
	method: string,
	path: string,
	body?: unknown
): Promise<ApiResult<T>> {
	resetAllForTests();
	const url = new URL(`${BASE}${path}`);
	const headers: Record<string, string> = { authorization: `Bearer ${key}` };
	if (body !== undefined) headers['content-type'] = 'application/json';
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined
		}),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	const json = text ? (JSON.parse(text) as { data?: T; error?: ApiResult['error'] }) : {};
	return { status: res.status, data: json.data as T, error: json.error };
}

async function createOffice(name: string, extra: Record<string, unknown> = {}): Promise<Office> {
	const r = await api<Office>(adminKey, 'POST', '/offices', { name, ...extra });
	expect(r.status, JSON.stringify(r.error)).toBe(201);
	return r.data;
}

async function listOffices(key = adminKey): Promise<Office[]> {
	const r = await api<Office[]>(key, 'GET', '/offices');
	expect(r.status, JSON.stringify(r.error)).toBe(200);
	return r.data;
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'offices');
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	roleKasseId = await createRole(admin, { name: 'Kasse', permissions: ['core.audit.view'] });
	roleMaterialId = await createRole(admin, {
		name: 'Material',
		permissions: ['core.storage.read']
	});
	const viewerRole = await createRole(admin, {
		name: 'Ämter lesen',
		permissions: ['offices.office.view', 'core.api.manage']
	});
	const baseRole = await createRole(admin, { name: 'Basis', permissions: ['core.api.manage'] });

	const viewerId = await createUser(admin, {
		name: 'Vera Viewer',
		email: 'vera@example.test',
		password: 'correct-horse-battery-2',
		roleIds: [viewerRole]
	});
	viewerKey = (
		await createApiKey(await ctxOf(viewerId), { name: 'v', scopes: ['offices.office.view'] })
	).key;
	const outsiderId = await createUser(admin, {
		name: 'Otto Außen',
		email: 'otto@example.test',
		password: 'correct-horse-battery-3',
		roleIds: [baseRole]
	});
	outsiderKey = (
		await createApiKey(await ctxOf(outsiderId), { name: 'o', scopes: ['core.api.manage'] })
	).key;
	hannaId = await createUser(admin, {
		name: 'Hanna Holder',
		email: 'hanna@example.test',
		password: 'correct-horse-battery-4',
		roleIds: [baseRole]
	});
});

afterAll(async () => {
	await close();
});

describe('Ämter anlegen und lesen', () => {
	let first: Office;
	let second: Office;

	it('legt ein Amt mit E-Mails und Rollen an', async () => {
		first = await createOffice('  Stammesführung  ', {
			description: 'Leitet den Stamm',
			emails: [
				{ label: 'Allgemein', email: 'Stafue@Stamm.Example' },
				{ email: 'leitung@stamm.example' }
			],
			roleIds: [roleKasseId, roleKasseId]
		});
		expect(first.name).toBe('Stammesführung');
		expect(first.description).toBe('Leitet den Stamm');
		expect(first.emails.map((e) => e.email)).toEqual([
			'stafue@stamm.example',
			'leitung@stamm.example'
		]);
		expect(first.emails[0]!.label).toBe('Allgemein');
		expect(first.emails[1]!.label).toBeNull();
		expect(first.roles).toEqual([{ id: roleKasseId, name: 'Kasse' }]);
		expect(first.holders).toEqual([]);
	});

	it('hängt neue Ämter am Ende der Reihenfolge an', async () => {
		second = await createOffice('Kasse');
		const third = await createOffice('Materialwart');
		expect(second.position).toBeGreaterThan(first.position);
		expect(third.position).toBeGreaterThan(second.position);
		const list = await listOffices();
		expect(list.map((o) => o.name)).toEqual(['Stammesführung', 'Kasse', 'Materialwart']);
	});

	it('liefert ein einzelnes Amt, unbekannte ID → 404, ungültige ID → 422', async () => {
		const r = await api<Office>(adminKey, 'GET', `/offices/${first.id}`);
		expect(r.status).toBe(200);
		expect(r.data.id).toBe(first.id);
		expect(r.data.roles).toEqual([{ id: roleKasseId, name: 'Kasse' }]);

		const missing = await api(adminKey, 'GET', `/offices/${crypto.randomUUID()}`);
		expect(missing.status).toBe(404);
		expect(missing.error?.code).toBe('not_found');

		const bad = await api(adminKey, 'GET', '/offices/kein-uuid');
		expect(bad.status).toBe(422);
		expect(bad.error?.code).toBe('validation_failed');
	});

	it('ändert per PATCH nur übergebene Felder und ersetzt Listen komplett', async () => {
		const r = await api<Office>(adminKey, 'PATCH', `/offices/${second.id}`, {
			name: 'Kassenwart*in',
			emails: [{ email: 'kasse@stamm.example' }]
		});
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect(r.data.name).toBe('Kassenwart*in');
		expect(r.data.emails.map((e) => e.email)).toEqual(['kasse@stamm.example']);
		expect(r.data.roles).toEqual([]);

		const roles = await api<Office>(adminKey, 'PATCH', `/offices/${second.id}`, {
			roleIds: [roleKasseId, roleMaterialId]
		});
		expect(roles.status).toBe(200);
		expect(roles.data.name).toBe('Kassenwart*in');
		expect(roles.data.emails).toHaveLength(1);
		expect(roles.data.roles.map((x) => x.id).sort()).toEqual([roleKasseId, roleMaterialId].sort());

		const cleared = await api<Office>(adminKey, 'PATCH', `/offices/${second.id}`, {
			description: '',
			emails: [],
			roleIds: []
		});
		expect(cleared.status).toBe(200);
		expect(cleared.data.description).toBeNull();
		expect(cleared.data.emails).toEqual([]);
		expect(cleared.data.roles).toEqual([]);

		const missing = await api(adminKey, 'PATCH', `/offices/${crypto.randomUUID()}`, {
			name: 'X'
		});
		expect(missing.status).toBe(404);
	});

	it('ordnet Inhaber*innen zu und zeigt sie in Liste und Detail', async () => {
		const r = await api<Office>(adminKey, 'PUT', `/offices/${second.id}/holders`, {
			holders: [{ userId: hannaId, since: '2024-09-01' }]
		});
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		const detail = await api<Office>(adminKey, 'GET', `/offices/${second.id}`);
		expect(detail.data.holders).toHaveLength(1);
		expect(detail.data.holders[0]).toMatchObject({
			userId: hannaId,
			name: 'Hanna Holder',
			since: '2024-09-01'
		});
		const list = await listOffices();
		expect(list.find((o) => o.id === second.id)!.holders.map((h) => h.userId)).toEqual([hannaId]);
	});

	it('lehnt doppelte Personen, ungültiges Datum und unbekannte Benutzer ab', async () => {
		const dup = await api(adminKey, 'PUT', `/offices/${second.id}/holders`, {
			holders: [{ userId: hannaId }, { userId: hannaId }]
		});
		expect(dup.status).toBe(422);
		const date = await api(adminKey, 'PUT', `/offices/${second.id}/holders`, {
			holders: [{ userId: hannaId, since: '2024-02-30' }]
		});
		expect(date.status).toBe(422);
		const unknown = await api(adminKey, 'PUT', `/offices/${second.id}/holders`, {
			holders: [{ userId: 'gibt-es-nicht' }]
		});
		expect([404, 422]).toContain(unknown.status);
		// Bestehende Zuordnung bleibt unverändert
		const detail = await api<Office>(adminKey, 'GET', `/offices/${second.id}`);
		expect(detail.data.holders.map((h) => h.userId)).toEqual([hannaId]);
	});
});

describe('Reihenfolge', () => {
	it('setzt die Reihenfolge mit allen IDs', async () => {
		const before = await listOffices();
		const ids = before.map((o) => o.id).reverse();
		const r = await api(adminKey, 'PUT', '/offices/order', { ids });
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		const after = await listOffices();
		expect(after.map((o) => o.id)).toEqual(ids);
		const positions = after.map((o) => o.position);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it('lehnt unvollständige, doppelte oder fremde ID-Listen mit 422 ab', async () => {
		const ids = (await listOffices()).map((o) => o.id);
		const partial = await api(adminKey, 'PUT', '/offices/order', { ids: ids.slice(1) });
		expect(partial.status).toBe(422);
		expect(partial.error?.code).toBe('validation_failed');

		const dup = await api(adminKey, 'PUT', '/offices/order', { ids: [...ids, ids[0]!] });
		expect(dup.status).toBe(422);

		const foreign = await api(adminKey, 'PUT', '/offices/order', {
			ids: [...ids.slice(1), crypto.randomUUID()]
		});
		expect(foreign.status).toBe(422);

		// Reihenfolge unverändert
		expect((await listOffices()).map((o) => o.id)).toEqual(ids);
	});

	it('neues Amt landet auch nach Umsortieren am Ende', async () => {
		const created = await createOffice('Öffentlichkeitsarbeit');
		const list = await listOffices();
		expect(list.at(-1)!.id).toBe(created.id);
	});
});

describe('Validierung', () => {
	it('Name leer oder zu lang → 422 mit Pfad name', async () => {
		const empty = await api(adminKey, 'POST', '/offices', { name: '   ' });
		expect(empty.status).toBe(422);
		expect(empty.error?.code).toBe('validation_failed');
		expect(JSON.stringify(empty.error?.details)).toContain('name');

		const long = await api(adminKey, 'POST', '/offices', { name: 'x'.repeat(101) });
		expect(long.status).toBe(422);

		const missing = await api(adminKey, 'POST', '/offices', {});
		expect(missing.status).toBe(422);
	});

	it('doppelte E-Mail (ohne Groß-/Kleinschreibung) → 422', async () => {
		const r = await api(adminKey, 'POST', '/offices', {
			name: 'Doppelt',
			emails: [{ email: 'a@stamm.example' }, { email: 'A@Stamm.Example' }]
		});
		expect(r.status).toBe(422);
		expect(JSON.stringify(r.error?.details)).toContain('emails');
	});

	it('ungültige E-Mail → 422', async () => {
		const r = await api(adminKey, 'POST', '/offices', {
			name: 'Kaputt',
			emails: [{ email: 'keine-adresse' }]
		});
		expect(r.status).toBe(422);
	});

	it('Rolle „Amtsinhaber*in“ lässt sich nicht verknüpfen → 422', async () => {
		const [holder] = await getDb()
			.select({ id: schema.role.id })
			.from(schema.role)
			.where(eq(schema.role.name, HOLDER_ROLE_NAME));
		const r = await api(adminKey, 'POST', '/offices', {
			name: 'Mit Inhaber-Rolle',
			roleIds: [holder!.id]
		});
		expect(r.status).toBe(422);
		expect(JSON.stringify(r.error?.details)).toContain('roleIds');
	});

	it('unbekannte Rolle → 422 (POST und PATCH)', async () => {
		const r = await api(adminKey, 'POST', '/offices', {
			name: 'Rollenlos',
			roleIds: ['role-gibt-es-nicht']
		});
		expect(r.status).toBe(422);
		expect(r.error?.code).toBe('validation_failed');

		const existing = (await listOffices())[0]!;
		const p = await api(adminKey, 'PATCH', `/offices/${existing.id}`, {
			roleIds: ['role-gibt-es-nicht']
		});
		expect(p.status).toBe(422);
		expect((await listOffices()).map((o) => o.name)).not.toContain('Rollenlos');
	});
});

describe('Hilfs-Endpunkte', () => {
	it('GET /users sucht Benutzer*innen', async () => {
		const r = await api<UserRef[]>(adminKey, 'GET', '/users?search=Hanna');
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect(r.data.map((u) => u.id)).toContain(hannaId);
		expect(r.data.find((u) => u.id === hannaId)!.name).toBe('Hanna Holder');
	});

	it('GET /roles liefert Rollen ohne die Rolle für Amtsinhaber*innen', async () => {
		const r = await api<RoleRef[]>(adminKey, 'GET', '/roles');
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		const names = r.data.map((x) => x.name);
		expect(names).toContain('Kasse');
		expect(names).toContain('Material');
		expect(names).not.toContain(HOLDER_ROLE_NAME);
	});
});

describe('Zugriff', () => {
	it('Lesende sehen die Ämter', async () => {
		const list = await listOffices(viewerKey);
		expect(list.length).toBeGreaterThan(0);
	});

	it('Lesende ohne manage → 403 bei allen Änderungen', async () => {
		const office = (await listOffices())[0]!;
		const ids = (await listOffices()).map((o) => o.id);
		const calls: [string, string, unknown][] = [
			['POST', '/offices', { name: 'Neu' }],
			['PATCH', `/offices/${office.id}`, { name: 'Anders' }],
			['DELETE', `/offices/${office.id}`, undefined],
			['PUT', '/offices/order', { ids }],
			['PUT', `/offices/${office.id}/holders`, { holders: [] }]
		];
		for (const [method, path, body] of calls) {
			const r = await api(viewerKey, method, path, body);
			expect(r.status, `${method} ${path}`).toBe(403);
			expect(r.error?.code).toBe('forbidden');
		}
		expect((await api<Office>(adminKey, 'GET', `/offices/${office.id}`)).data.name).toBe(
			office.name
		);
	});

	it('ohne offices.office.view → 403', async () => {
		const r = await api(outsiderKey, 'GET', '/offices');
		expect(r.status).toBe(403);
		expect(r.error?.code).toBe('forbidden');
		const one = await api(outsiderKey, 'GET', `/offices/${crypto.randomUUID()}`);
		expect(one.status).toBe(403);
	});
});

describe('Löschen', () => {
	it('löscht ein Amt; danach 404', async () => {
		const office = await createOffice('Wegwerf-Amt', {
			emails: [{ email: 'weg@stamm.example' }]
		});
		const r = await api(adminKey, 'DELETE', `/offices/${office.id}`);
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect((await api(adminKey, 'GET', `/offices/${office.id}`)).status).toBe(404);
		expect((await api(adminKey, 'DELETE', `/offices/${office.id}`)).status).toBe(404);
		expect((await listOffices()).map((o) => o.id)).not.toContain(office.id);
	});
});

describe('Audit', () => {
	it('protokolliert offices.office.* ohne personenbezogene Details', async () => {
		const rows = await getDb()
			.select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
			.from(schema.auditLog)
			.where(like(schema.auditLog.action, 'offices.%'));
		const actions = new Set(rows.map((r) => r.action));
		expect(actions).toContain('offices.office.created');
		expect(actions).toContain('offices.office.updated');
		expect(actions).toContain('offices.office.deleted');
		for (const r of rows) {
			const meta = JSON.stringify(r.metadata);
			expect(meta).not.toContain('@');
			expect(meta).not.toContain('Hanna');
			expect(meta).not.toContain('Leitet den Stamm');
		}
	});
});

describe('Modul deaktiviert', () => {
	it('alle Endpunkte → 404 module_disabled, danach wieder erreichbar', async () => {
		await disableModule(admin, 'offices');
		try {
			for (const path of ['/offices', '/roles', '/me', '/website/offices']) {
				const r = await api(adminKey, 'GET', path);
				expect(r.status, path).toBe(404);
				expect(r.error?.code).toBe('module_disabled');
			}
			const post = await api(adminKey, 'POST', '/offices', { name: 'Aus' });
			expect(post.status).toBe(404);
		} finally {
			await enableModule(admin, 'offices');
		}
		expect((await api(adminKey, 'GET', '/offices')).status).toBe(200);
	});
});
