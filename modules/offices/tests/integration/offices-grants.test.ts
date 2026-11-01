import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser, setUserRoles } from '$testing';
import { createRole, deleteRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import { runJobNow } from '$testing';
import officesModule from '$modules/offices/module';
import { HOLDER_ROLE_NAME, type Office } from '$modules/offices/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Rollen aus Ämtern (`user_role_grant`): Rechte kommen und gehen mit Zuordnung, Amt, Rolle und Modulstatus.

const BASE = 'http://localhost:5173/api/v1/modules/offices';
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

let close: () => Promise<void>;
let admin: RequestContext;
let adminKey: string;
let managerKey: string;
let utaId: string;
let baseRoleId: string;
let holderRoleId: string;
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

async function createOffice(name: string, roleIds: string[] = []): Promise<Office> {
	const r = await api<Office>(adminKey, 'POST', '/offices', { name, roleIds });
	expect(r.status, JSON.stringify(r.error)).toBe(201);
	return r.data;
}

async function setHolders(officeId: string, userIds: string[], key = adminKey) {
	return api<Office>(key, 'PUT', `/offices/${officeId}/holders`, {
		holders: userIds.map((userId) => ({ userId }))
	});
}

async function expectHolders(officeId: string, userIds: string[]) {
	const r = await setHolders(officeId, userIds);
	expect(r.status, JSON.stringify(r.error)).toBe(200);
}

const perms = (userId: string) => core.permissions.forUser(userId);

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

	const [holder] = await getDb()
		.select({ id: schema.role.id })
		.from(schema.role)
		.where(eq(schema.role.name, HOLDER_ROLE_NAME));
	holderRoleId = holder!.id;

	roleKasseId = await createRole(admin, { name: 'Kasse', permissions: ['core.audit.view'] });
	roleMaterialId = await createRole(admin, {
		name: 'Material',
		permissions: ['core.storage.read']
	});
	baseRoleId = await createRole(admin, { name: 'Basis', permissions: ['core.api.manage'] });
	const managerRole = await createRole(admin, {
		name: 'Ämterverwaltung',
		permissions: [
			'offices.office.view',
			'offices.office.manage',
			'core.api.manage',
			'core.audit.view'
		]
	});

	utaId = await createUser(admin, {
		name: 'Uta Inhaberin',
		email: 'uta@example.test',
		password: 'correct-horse-battery-2',
		roleIds: [baseRoleId]
	});
	const managerId = await createUser(admin, {
		name: 'Max Verwalter',
		email: 'max@example.test',
		password: 'correct-horse-battery-3',
		roleIds: [managerRole]
	});
	managerKey = (
		await createApiKey(await ctxOf(managerId), {
			name: 'm',
			scopes: ['offices.office.view', 'offices.office.manage', 'core.api.manage', 'core.audit.view']
		})
	).key;
});

afterAll(async () => {
	await close();
});

describe('Rolle „Amtsinhaber*in“', () => {
	it('wird per defaultRoleGrants mit offices.office.view angelegt', async () => {
		const keys = await getDb()
			.select({ key: schema.rolePermission.permissionKey })
			.from(schema.rolePermission)
			.where(eq(schema.rolePermission.roleId, holderRoleId));
		expect(keys.map((k) => k.key)).toEqual(['offices.office.view']);
	});

	it('wird über die Standard-Kennung gefunden, nicht per Name (#67, 01a-07)', async () => {
		// Echte Inhaber-Rolle umbenennen, gleichnamige Rolle OHNE Kennung danebenlegen (Squatting)
		await getDb()
			.update(schema.role)
			.set({ name: 'Amtsinhaber*in (umbenannt)' })
			.where(eq(schema.role.id, holderRoleId));
		const squatId = crypto.randomUUID();
		await getDb()
			.insert(schema.role)
			.values({ id: squatId, name: HOLDER_ROLE_NAME, description: null, isSystem: false });
		try {
			const office = await createOffice('Squatting', []);
			await expectHolders(office.id, [utaId]);
			const grants = await core.roles.listModuleGrants('offices', { userId: utaId });
			expect(grants.map((g) => g.roleId)).toEqual([holderRoleId]);
			expect(await core.users.roleIds(utaId)).not.toContain(squatId);
			await api(adminKey, 'DELETE', `/offices/${office.id}`);
		} finally {
			await getDb().delete(schema.role).where(eq(schema.role.id, squatId));
			await getDb()
				.update(schema.role)
				.set({ name: HOLDER_ROLE_NAME })
				.where(eq(schema.role.id, holderRoleId));
		}
	});
});

describe('Rechte kommen und gehen', () => {
	it('Zuordnen verleiht Rollenrechte und offices.office.view; Entfernen nimmt sie wieder', async () => {
		const office = await createOffice('Kasse', [roleKasseId]);
		expect((await perms(utaId)).has('core.audit.view')).toBe(false);
		expect((await perms(utaId)).has('offices.office.view')).toBe(false);

		await expectHolders(office.id, [utaId]);
		const p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(true);
		expect(p.has('offices.office.view')).toBe(true);
		expect(p.has('offices.office.manage')).toBe(false);
		expect(p.has('core.api.manage')).toBe(true);

		const grants = await core.roles.listModuleGrants('offices', { userId: utaId });
		expect(grants.map((g) => g.roleId).sort()).toEqual([holderRoleId, roleKasseId].sort());

		const roleIds = await core.users.roleIds(utaId);
		expect(roleIds.sort()).toEqual([baseRoleId, holderRoleId, roleKasseId].sort());

		await expectHolders(office.id, []);
		const after = await perms(utaId);
		expect(after.has('core.audit.view')).toBe(false);
		expect(after.has('offices.office.view')).toBe(false);
		expect(after.has('core.api.manage')).toBe(true);
		expect(await core.users.roleIds(utaId)).toEqual([baseRoleId]);
		expect(await core.roles.listModuleGrants('offices', { userId: utaId })).toEqual([]);

		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});

	it('Rolle vom Amt lösen nimmt deren Rechte, Inhaber-Rolle bleibt', async () => {
		const office = await createOffice('Kasse 2', [roleKasseId]);
		await expectHolders(office.id, [utaId]);
		expect((await perms(utaId)).has('core.audit.view')).toBe(true);

		const r = await api(adminKey, 'PATCH', `/offices/${office.id}`, { roleIds: [] });
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		let p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(false);
		expect(p.has('offices.office.view')).toBe(true);

		// Rolle wieder hinzufügen → Recht kommt zurück
		await api(adminKey, 'PATCH', `/offices/${office.id}`, { roleIds: [roleKasseId] });
		expect((await perms(utaId)).has('core.audit.view')).toBe(true);

		// Amt löschen → alles weg
		const del = await api(adminKey, 'DELETE', `/offices/${office.id}`);
		expect(del.status).toBe(200);
		p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(false);
		expect(p.has('offices.office.view')).toBe(false);
		expect(await core.roles.listModuleGrants('offices', { userId: utaId })).toEqual([]);
	});

	it('zwei Ämter mit gleicher Rolle: Entfernen aus einem lässt das Recht bestehen', async () => {
		const a = await createOffice('Amt A', [roleKasseId]);
		const b = await createOffice('Amt B', [roleKasseId]);
		await expectHolders(a.id, [utaId]);
		await expectHolders(b.id, [utaId]);
		expect((await perms(utaId)).has('core.audit.view')).toBe(true);

		await expectHolders(a.id, []);
		let p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(true);
		expect(p.has('offices.office.view')).toBe(true);

		await expectHolders(b.id, []);
		p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(false);
		expect(p.has('offices.office.view')).toBe(false);

		await api(adminKey, 'DELETE', `/offices/${a.id}`);
		await api(adminKey, 'DELETE', `/offices/${b.id}`);
	});

	it('manuell vergebene Rolle bleibt beim Entfernen aus dem Amt erhalten', async () => {
		await setUserRoles(admin, utaId, [baseRoleId, roleKasseId]);
		const office = await createOffice('Manuell', [roleKasseId]);
		await expectHolders(office.id, [utaId]);
		await expectHolders(office.id, []);
		const p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(true);
		expect(p.has('offices.office.view')).toBe(false);
		const manual = await getDb()
			.select({ roleId: schema.userRole.roleId })
			.from(schema.userRole)
			.where(eq(schema.userRole.userId, utaId));
		expect(manual.map((m) => m.roleId).sort()).toEqual([baseRoleId, roleKasseId].sort());

		await setUserRoles(admin, utaId, [baseRoleId]);
		await api(adminKey, 'DELETE', `/offices/${office.id}`);
		expect((await perms(utaId)).has('core.audit.view')).toBe(false);
	});
});

describe('Modulstatus', () => {
	it('Modul deaktivieren nimmt verliehene Rechte, Aktivieren bringt sie zurück', async () => {
		const office = await createOffice('Modulstatus', [roleKasseId]);
		await expectHolders(office.id, [utaId]);
		expect((await perms(utaId)).has('core.audit.view')).toBe(true);

		await disableModule(admin, 'offices');
		try {
			const p = await perms(utaId);
			expect(p.has('core.audit.view')).toBe(false);
			expect(p.has('offices.office.view')).toBe(false);
			expect(p.has('core.api.manage')).toBe(true);
			expect(await core.users.roleIds(utaId)).toEqual([baseRoleId]);
			// Zeilen bleiben erhalten, wirken aber nicht
			expect(
				(await core.roles.listModuleGrants('offices', { userId: utaId })).length
			).toBeGreaterThan(0);
		} finally {
			await enableModule(admin, 'offices');
		}
		const back = await perms(utaId);
		expect(back.has('core.audit.view')).toBe(true);
		expect(back.has('offices.office.view')).toBe(true);
		expect((await core.users.roleIds(utaId)).sort()).toEqual(
			[baseRoleId, holderRoleId, roleKasseId].sort()
		);

		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});
});

describe('Schutz vor Rechteausweitung', () => {
	it('Amt ohne Inhaber*innen: fremde Rolle verknüpfen → 403, Personen zuordnen → 403', async () => {
		// Auch ein unbesetztes Amt darf keine Rollen bekommen, deren Rechte man nicht hat
		const r = await api(managerKey, 'POST', '/offices', {
			name: 'Ausweitung',
			roleIds: [roleMaterialId]
		});
		expect(r.status).toBe(403);
		expect(r.error?.code).toBe('forbidden');

		const empty = await api<Office>(managerKey, 'POST', '/offices', { name: 'Leer' });
		expect(empty.status, JSON.stringify(empty.error)).toBe(201);
		const patch = await api(managerKey, 'PATCH', `/offices/${empty.data.id}`, {
			roleIds: [roleMaterialId]
		});
		expect(patch.status).toBe(403);

		const office = await createOffice('Ausweitung Admin', [roleMaterialId]);
		const holders = await setHolders(office.id, [utaId], managerKey);
		expect(holders.status).toBe(403);
		expect(holders.error?.code).toBe('forbidden');
		expect((await perms(utaId)).has('core.storage.read')).toBe(false);
		expect((await perms(utaId)).has('offices.office.view')).toBe(false);
		await api(adminKey, 'DELETE', `/offices/${empty.data.id}`);
		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});

	it('Amt mit Inhaber*innen: Rollen ändern, Personen ändern, Löschen ohne alle Rechte → 403', async () => {
		const office = await createOffice('Materialwart', [roleMaterialId]);
		await expectHolders(office.id, [utaId]);
		expect((await perms(utaId)).has('core.storage.read')).toBe(true);

		const remove = await api(managerKey, 'PATCH', `/offices/${office.id}`, { roleIds: [] });
		expect(remove.status).toBe(403);
		expect(remove.error?.code).toBe('forbidden');
		const holders = await setHolders(office.id, [], managerKey);
		expect(holders.status).toBe(403);
		const del = await api(managerKey, 'DELETE', `/offices/${office.id}`);
		expect(del.status).toBe(403);

		// nichts verändert
		const detail = await api<Office>(adminKey, 'GET', `/offices/${office.id}`);
		expect(detail.data.roles.map((x) => x.id)).toEqual([roleMaterialId]);
		expect(detail.data.holders.map((h) => h.userId)).toEqual([utaId]);
		expect((await perms(utaId)).has('core.storage.read')).toBe(true);

		// Geprüft werden nur geänderte Rollen: eine Rolle ergänzen, deren Rechte man hat, ist erlaubt
		const ok = await api(managerKey, 'PATCH', `/offices/${office.id}`, {
			roleIds: [roleMaterialId, roleKasseId]
		});
		expect(ok.status, JSON.stringify(ok.error)).toBe(200);
		expect((await perms(utaId)).has('core.audit.view')).toBe(true);

		await api(adminKey, 'DELETE', `/offices/${office.id}`);
		expect((await perms(utaId)).has('core.storage.read')).toBe(false);
	});

	it('fremde Rolle an ein besetztes Amt hängen → 403', async () => {
		const office = await createOffice('Kasse besetzt', [roleKasseId]);
		await expectHolders(office.id, [utaId]);
		const r = await api(managerKey, 'PATCH', `/offices/${office.id}`, {
			roleIds: [roleKasseId, roleMaterialId]
		});
		expect(r.status).toBe(403);
		expect((await perms(utaId)).has('core.storage.read')).toBe(false);
		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});

	it('Verwaltende mit allen Rechten dürfen Inhaber*innen setzen', async () => {
		const office = await createOffice('Kasse Verwalter', [roleKasseId]);
		const r = await setHolders(office.id, [utaId], managerKey);
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect((await perms(utaId)).has('core.audit.view')).toBe(true);
		await api(adminKey, 'DELETE', `/offices/${office.id}`);
		expect((await perms(utaId)).has('core.audit.view')).toBe(false);
	});
});

describe('Abgleich-Job', () => {
	it('offices.sync-grants stellt Verleihungen aus den Ämtern wieder her', async () => {
		const office = await createOffice('Job', [roleKasseId]);
		await expectHolders(office.id, [utaId]);
		await core.roles.replaceModuleGrants('offices', []);
		expect((await perms(utaId)).has('core.audit.view')).toBe(false);

		await runJobNow(admin, 'offices.sync-grants');
		const p = await perms(utaId);
		expect(p.has('core.audit.view')).toBe(true);
		expect(p.has('offices.office.view')).toBe(true);
		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});
});

describe('Aufräumen im Core', () => {
	it('Löschen eines Benutzers entfernt seine Verleihungen (FK-Kaskade)', async () => {
		const tmpId = await createUser(admin, {
			name: 'Tim Temporär',
			email: 'tim@example.test',
			password: 'correct-horse-battery-5'
		});
		const office = await createOffice('Temporär', [roleKasseId]);
		await expectHolders(office.id, [tmpId]);
		expect(
			(await core.roles.listModuleGrants('offices', { userId: tmpId })).length
		).toBeGreaterThan(0);

		await deleteUser(admin, tmpId);
		expect(await core.roles.listModuleGrants('offices', { userId: tmpId })).toEqual([]);
		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});

	it('Löschen einer Rolle entfernt deren Verleihungen (FK-Kaskade)', async () => {
		const roleId = await createRole(admin, { name: 'Kurzlebig', permissions: ['core.ai.view'] });
		const office = await createOffice('Kurzlebig', [roleId]);
		await expectHolders(office.id, [utaId]);
		expect((await perms(utaId)).has('core.ai.view')).toBe(true);

		await deleteRole(admin, roleId);
		expect((await perms(utaId)).has('core.ai.view')).toBe(false);
		const grants = await core.roles.listModuleGrants('offices', { userId: utaId });
		expect(grants.map((g) => g.roleId)).not.toContain(roleId);
		expect(grants.map((g) => g.roleId)).toContain(holderRoleId);

		// Amt zeigt die gelöschte Rolle höchstens als „Unbekannte Rolle“
		const detail = await api<Office>(adminKey, 'GET', `/offices/${office.id}`);
		expect(detail.status).toBe(200);
		for (const r of detail.data.roles) expect(r.name).toBe('Unbekannte Rolle');

		await api(adminKey, 'DELETE', `/offices/${office.id}`);
	});
});
