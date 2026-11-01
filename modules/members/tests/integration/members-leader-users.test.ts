import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser, setUserActive } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import { ledGroupIds } from '$modules/members/leader.service';
import { messagingService } from '$modules/members/messaging.service';
import { principalsService } from '$modules/members/principals.service';
import { subjectExport } from '$modules/members/subject-export';
import { LED_VIEW } from '$modules/members/schemas';
import type { Group, LinkUserRef, Member, MemberList } from '$modules/members/schemas';
import type { RequestContext } from '$lib/sdk/types';

/**
 * Benutzerkonten als Gruppenleitung (`group_leader_users`, Migr. 0016): Rolle „Gruppenleitung“,
 * Bereich der Gruppe, Gruppen-Postfach, Freigabe-Schlüssel – ohne verknüpftes Mitglied.
 */
const PW = 'leader-user-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
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
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function errBody(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error as { code: string; details?: { issues?: { path: string[] }[] } };
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
async function keyOf(name: string) {
	const ctx = await ctxOf(userIds[name]!);
	return (await createApiKey(ctx, { name: `k-${Date.now()}`, scopes: [...ctx.permissions] })).key;
}
let adminKey = '';
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: adminKey, ...init });
const as = (key: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: key, ...init });

async function mkMember(firstName: string, groupIds: string[] = []) {
	return data<Member>(
		await A('/members', {
			method: 'POST',
			json: {
				firstName,
				lastName: 'Muster',
				scoutName: null,
				birthDate: '2012-05-17',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				country: 'DE',
				phones: [],
				emails: [],
				stage: 'pfadfinder',
				groupIds
			}
		}),
		201
	);
}
async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
}
const grantedUsers = async () =>
	(await core.roles.listModuleGrants('members')).map((g) => g.userId).sort();

let ben: Member;
let gruen: Group;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;

	await mkUser('tessa', ['core.api.manage']);
	await mkUser('tom', ['core.api.manage']);
	await mkUser('gruppenverwaltung', [
		'core.api.manage',
		'members.group.view',
		'members.group.edit'
	]);
	ben = await mkMember('Ben');
});
afterAll(async () => {
	await close();
});
beforeEach(() => resetAllForTests());

describe('Benutzerkonten als Gruppenleitung', () => {
	it('Gruppe nur mit Konto-Leitung anlegen; Namen werden aufgelöst', async () => {
		gruen = await data<Group>(
			await A('/groups', {
				method: 'POST',
				json: {
					name: 'Grün',
					type: 'sippe',
					leaderUserIds: [userIds.tessa],
					website: {
						onWebsite: false,
						slug: null,
						description: null,
						contactEmail: 'Gruen@Stamm.Test'
					}
				}
			}),
			201
		);
		expect(gruen.leaders).toEqual([]);
		expect(gruen.leaderUsers).toEqual([{ id: userIds.tessa, name: 'tessa', active: true }]);
		const list = await data<Group[]>(await A('/groups'));
		expect(list.find((g) => g.id === gruen.id)?.leaderUsers[0]?.name).toBe('tessa');
	});

	it('ohne jede Leitung 422; unbekanntes Konto 422', async () => {
		const none = await errBody(
			await A('/groups', { method: 'POST', json: { name: 'Leer', type: 'sippe' } }),
			422
		);
		expect(JSON.stringify(none)).toContain('leaderIds');
		const unknown = await errBody(
			await A('/groups', {
				method: 'POST',
				json: { name: 'Fremd', type: 'sippe', leaderUserIds: ['gibt-es-nicht'] }
			}),
			422
		);
		expect(JSON.stringify(unknown)).toContain('leaderUserIds');
	});

	it('Konto-Leitung bekommt die Rolle „Gruppenleitung“ und den Bereich der Gruppe', async () => {
		expect(await grantedUsers()).toEqual([userIds.tessa]);
		const tessa = await ctxOf(userIds.tessa!);
		expect(tessa.permissions.has(LED_VIEW)).toBe(true);
		expect(await ledGroupIds(tessa)).toEqual([gruen.id]);

		const anna = await mkMember('Anna', [gruen.id]);
		await mkMember('Bert');
		const key = await keyOf('tessa');
		const listed = await data<MemberList>(await as(key, '/led/members'));
		expect(listed.items.map((m) => m.id)).toEqual([anna.id]);
	});

	it('Gruppen-Postfach, Absender und Freigabe-Schlüssel enthalten die Konto-Leitung', async () => {
		const boxes = await messagingService.listGroupMailboxes();
		expect(boxes).toEqual([
			{ id: gruen.id, name: 'Grün', email: 'gruen@stamm.test', leaderUserIds: [userIds.tessa] }
		]);
		const led = await messagingService.listLedGroups(await ctxOf(userIds.tessa!));
		expect(led.map((g) => g.id)).toEqual([gruen.id]);

		const ids = await principalsService.principalIdsForUser(userIds.tessa!);
		expect(ids).toEqual({ memberIds: [], groupIds: [gruen.id] });
		const users = await principalsService.userIdsForPrincipals({
			memberIds: [],
			groupIds: [gruen.id]
		});
		expect(users).toContain(userIds.tessa);
	});

	it('Mitglieder- und Konto-Leitung gemischt; einziges leitendes Mitglied bleibt löschbar', async () => {
		const updated = await data<Group>(
			await A(`/groups/${gruen.id}`, {
				method: 'PUT',
				json: {
					name: 'Grün',
					type: 'sippe',
					leaderIds: [ben.id],
					leaderUserIds: [userIds.tessa]
				}
			})
		);
		expect(updated.leaders.map((l) => l.id)).toEqual([ben.id]);
		expect(updated.leaderUsers.map((u) => u.id)).toEqual([userIds.tessa]);
		// Website-Felder bleiben ohne `website` unverändert
		expect(updated.website.contactEmail).toBe('gruen@stamm.test');
		// Ben ist nicht die einzige Leitung (Konto „tessa“ leitet mit) → Löschen erlaubt
		expect((await A(`/members/${ben.id}`, { method: 'DELETE' })).status).toBe(200);
	});

	it('Rechteausweitung: neue Konto-Leitung braucht die Rechte der Rolle (403)', async () => {
		const key = await keyOf('gruppenverwaltung');
		const err = await errBody(
			await as(key, `/groups/${gruen.id}`, {
				method: 'PUT',
				json: { name: 'Grün', type: 'sippe', leaderUserIds: [userIds.tessa, userIds.tom] }
			}),
			403
		);
		expect(err.code).toBe('forbidden');
		// Bestehende Konto-Leitung behalten und Gruppe ändern geht ohne Rollenrechte
		const kept = await data<Group>(
			await as(key, `/groups/${gruen.id}`, {
				method: 'PUT',
				json: { name: 'Grün', type: 'sippe', leaderUserIds: [userIds.tessa] }
			})
		);
		expect(kept.leaderUsers.map((u) => u.id)).toEqual([userIds.tessa]);
	});

	it('Kontosuche für die Auswahl (ab 2 Zeichen, mit members.group.edit)', async () => {
		expect(await data<LinkUserRef[]>(await A('/groups/leader-users?search=t'))).toEqual([]);
		const found = await data<LinkUserRef[]>(await A('/groups/leader-users?search=tom'));
		expect(found.map((u) => u.id)).toEqual([userIds.tom]);
		const key = await keyOf('tom');
		expect((await as(key, '/groups/leader-users?search=tom')).status).toBe(403);
	});

	it('deaktiviertes Konto bleibt eingetragen („Unbekannt“), neu hinzufügen geht nicht', async () => {
		await setUserActive(admin, userIds.tom!, false);
		const err = await errBody(
			await A(`/groups/${gruen.id}`, {
				method: 'PUT',
				json: { name: 'Grün', type: 'sippe', leaderUserIds: [userIds.tessa, userIds.tom] }
			}),
			422
		);
		expect(JSON.stringify(err)).toContain('leaderUserIds');
		await setUserActive(admin, userIds.tom!, true);
	});

	it('Datenauskunft enthält die direkten Leitungen des Kontos', async () => {
		const out = (await subjectExport.run({ userId: userIds.tessa!, memberIds: [] })) as {
			accountLeaderOf?: { id: string; name: string }[];
		} | null;
		expect(out?.accountLeaderOf).toEqual([{ id: gruen.id, name: 'Grün' }]);
	});

	it('Konto löschen entfernt die Leitung und die Rolle', async () => {
		await deleteUser(admin, userIds.tessa!);
		const g = await data<Group>(await A(`/groups/${gruen.id}`));
		expect(g.leaderUsers).toEqual([]);
		await expect.poll(() => grantedUsers()).toEqual([]);
	});
});
