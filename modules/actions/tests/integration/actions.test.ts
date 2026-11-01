import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, setUserActive } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { getDb, schema } from '$testing';
import { eq } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const BASE = '/modules/actions';

let admin: RequestContext;
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

const actionBody = (over: Record<string, unknown> = {}) => ({
	name: 'Stammesfahrt 2026',
	description: 'Eine Woche an der Nordsee',
	location: 'Cuxhaven',
	startsOn: '2026-07-10',
	startsTime: '16:00',
	endsOn: '2026-07-17',
	endsTime: null,
	...over
});

interface ActionDto {
	id: string;
	name: string;
	owner: { userId: string; name: string };
	access: { level: 'edit' | 'read'; isOwner: boolean; canShare: boolean };
	participantCount: number;
}

const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	creator: [...BASE_PERMS, 'actions.action.create', 'actions.action.delete'],
	viewer: BASE_PERMS,
	viewall: [...BASE_PERMS, 'actions.action.view-all'],
	editall: [...BASE_PERMS, 'actions.action.edit-all']
};
const USERS: [string, keyof typeof ROLES][] = [
	['owner', 'creator'],
	['colleague', 'viewer'],
	['reader', 'viewer'],
	['stranger', 'viewer'],
	['viewall', 'viewall'],
	['editall', 'editall'],
	['inactive', 'viewer']
];

let actionId: string;

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf(u!.id);

	const roleIds: Record<string, string> = {};
	for (const [name, perms] of Object.entries(ROLES)) {
		roleIds[name] = await createRole(admin, { name: `role-${name}`, permissions: perms });
	}
	for (const [name, role] of USERS) {
		userIds[name] = await createUser(admin, {
			name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: [...ROLES[role]!] })).key;
	}
	await setUserActive(admin, userIds.inactive!, false);
});

describe('Aktionen: Anlegen und Validierung', () => {
	it('legt eine Aktion an; der Ersteller ist Eigentümer', async () => {
		const a = await data<ActionDto>(
			await as('owner', '/actions', { method: 'POST', json: actionBody() }),
			201
		);
		actionId = a.id;
		expect(a.owner.userId).toBe(userIds.owner);
		expect(a.access).toEqual({ level: 'edit', isOwner: true, canShare: true });
		expect(a.participantCount).toBe(0);
	});

	it('verweigert das Anlegen ohne actions.action.create (403)', async () => {
		const res = await as('colleague', '/actions', {
			method: 'POST',
			json: actionBody()
		});
		expect(res.status).toBe(403);
	});

	it('validiert Datum und Uhrzeit (422)', async () => {
		const before = await as('owner', '/actions', {
			method: 'POST',
			json: actionBody({ endsOn: '2026-07-01' })
		});
		expect(before.status).toBe(422);
		const timeWithoutDate = await as('owner', '/actions', {
			method: 'POST',
			json: actionBody({ endsOn: null, endsTime: '10:00' })
		});
		expect(timeWithoutDate.status).toBe(422);
		const badDate = await as('owner', '/actions', {
			method: 'POST',
			json: actionBody({ startsOn: '2026-02-30' })
		});
		expect(badDate.status).toBe(422);
	});
});

describe('Aktionen: Zugriffsmatrix', () => {
	it('versteckt die Aktion vor fremden Benutzern (404) und in der Liste', async () => {
		expect((await as('stranger', `/actions/${actionId}`)).status).toBe(404);
		const list = await data<{ items: ActionDto[]; total: number }>(
			await as('stranger', '/actions')
		);
		expect(list.items.find((a) => a.id === actionId)).toBeUndefined();
		const own = await data<{ items: ActionDto[] }>(await as('owner', '/actions'));
		expect(own.items.map((a) => a.id)).toContain(actionId);
	});

	it('Freigabe "edit": Zugriff, Bearbeiten ja, Teilen/Löschen nein', async () => {
		const share = await data<{ userId: string; level: string }>(
			await as('owner', `/actions/${actionId}/shares/${userIds.colleague}`, {
				method: 'PUT',
				json: { level: 'edit' }
			})
		);
		expect(share.level).toBe('edit');

		const seen = await data<ActionDto>(await as('colleague', `/actions/${actionId}`));
		expect(seen.access).toEqual({ level: 'edit', isOwner: false, canShare: false });
		const upd = await data<ActionDto>(
			await as('colleague', `/actions/${actionId}`, {
				method: 'PUT',
				json: actionBody({ name: 'Stammesfahrt 2026 (neu)' })
			})
		);
		expect(upd.name).toBe('Stammesfahrt 2026 (neu)');
		expect(
			(
				await as('colleague', `/actions/${actionId}/shares/${userIds.stranger}`, {
					method: 'PUT',
					json: { level: 'read' }
				})
			).status
		).toBe(403);
		expect((await as('colleague', `/actions/${actionId}`, { method: 'DELETE' })).status).toBe(403);
	});

	it('Freigabe "read": lesen ja, Änderungen nein', async () => {
		await data(
			await as('owner', `/actions/${actionId}/shares/${userIds.reader}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		const seen = await data<ActionDto>(await as('reader', `/actions/${actionId}`));
		expect(seen.access.level).toBe('read');
		expect(
			(await as('reader', `/actions/${actionId}`, { method: 'PUT', json: actionBody() })).status
		).toBe(403);
		expect(
			(
				await as('reader', `/actions/${actionId}/participants`, {
					method: 'POST',
					json: { name: 'Nicht erlaubt' }
				})
			).status
		).toBe(403);
	});

	it('view-all darf lesen, edit-all bearbeiten und teilen', async () => {
		const read = await data<ActionDto>(await as('viewall', `/actions/${actionId}`));
		expect(read.access).toEqual({ level: 'read', isOwner: false, canShare: false });
		expect(
			(await as('viewall', `/actions/${actionId}`, { method: 'PUT', json: actionBody() })).status
		).toBe(403);

		const edit = await data<ActionDto>(await as('editall', `/actions/${actionId}`));
		expect(edit.access).toEqual({ level: 'edit', isOwner: false, canShare: true });
		await data(
			await as('editall', `/actions/${actionId}/shares/${userIds.stranger}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		await data(
			await as('editall', `/actions/${actionId}/shares/${userIds.stranger}`, {
				method: 'DELETE'
			})
		);
		expect((await as('stranger', `/actions/${actionId}`)).status).toBe(404);
	});

	it('listet Freigaben mit Namen; fremde Benutzer sehen sie nicht', async () => {
		const shares = await data<{
			owner: { userId: string };
			shares: { userId: string; name: string; level: string }[];
			canManage: boolean;
		}>(await as('owner', `/actions/${actionId}/shares`));
		expect(shares.owner.userId).toBe(userIds.owner);
		expect(shares.canManage).toBe(true);
		expect(shares.shares.map((s) => s.userId).sort()).toEqual(
			[userIds.colleague, userIds.reader].sort()
		);
		expect(shares.shares.every((s) => s.name !== 'Unbekannt')).toBe(true);
		expect((await as('stranger', `/actions/${actionId}/shares`)).status).toBe(404);
		const asReader = await data<{ canManage: boolean }>(
			await as('reader', `/actions/${actionId}/shares`)
		);
		expect(asReader.canManage).toBe(false);
	});

	it('prüft Freigabe-Ziele (Eigentümer, unbekannt, inaktiv)', async () => {
		const put = (userId: string) =>
			as('owner', `/actions/${actionId}/shares/${userId}`, {
				method: 'PUT',
				json: { level: 'read' }
			});
		expect((await put(userIds.owner!)).status).toBe(400);
		expect((await put('00000000-0000-4000-8000-000000000000')).status).toBe(422);
		expect((await put(userIds.inactive!)).status).toBe(422);
		const bad = await as('owner', `/actions/${actionId}/shares/${userIds.stranger}`, {
			method: 'PUT',
			json: { level: 'admin' }
		});
		expect(bad.status).toBe(422);
	});

	it('erlaubt, die eigene Freigabe zu entfernen ("Aktion verlassen")', async () => {
		await data(
			await as('owner', `/actions/${actionId}/shares/${userIds.stranger}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		await data(
			await as('stranger', `/actions/${actionId}/shares/${userIds.stranger}`, {
				method: 'DELETE'
			})
		);
		expect((await as('stranger', `/actions/${actionId}`)).status).toBe(404);
	});
});

describe('Benutzersuche für Freigaben', () => {
	it('liefert aktive Benutzer ohne core.users.view und ab 2 Zeichen (ohne E-Mail)', async () => {
		const found = await data<{ id: string; name: string; email: string }[]>(
			await as('owner', '/users?search=reader')
		);
		expect(found.map((f) => f.id)).toEqual([userIds.reader]);
		expect(Object.keys(found[0]!).sort()).toEqual(['email', 'id', 'image', 'name']);
		// E-Mail nur mit core.users.view; Suche nur im Namen
		expect(found[0]!.email).toBe('');
		expect(await data<unknown[]>(await as('owner', '/users?search=example.test'))).toEqual([]);

		const inactive = await data<unknown[]>(await as('owner', '/users?search=inactive'));
		expect(inactive).toEqual([]);
		expect((await as('owner', '/users?search=r')).status).toBe(422);
	});

	it('nur für Personen, die teilen dürfen (Eigentümer*in einer Aktion oder edit-all)', async () => {
		const denied = await as('colleague', '/users?search=reader');
		expect(denied.status).toBe(403);
		expect((await data<unknown[]>(await as('editall', '/users?search=reader'))).length).toBe(1);
	});
});

describe('Teilnehmende', () => {
	let participantId: string;

	it('legt Teilnehmende manuell an, listet, ändert und löscht sie', async () => {
		const p = await data<{ id: string; source: string; birthDate: string | null }>(
			await as('colleague', `/actions/${actionId}/participants`, {
				method: 'POST',
				json: {
					name: 'Lena Beispiel',
					groupLabel: 'Meute Wolf',
					birthDate: '2015-04-03',
					bremenResident: true,
					role: 'participant',
					diet: 'vegetarian',
					allergies: 'Nüsse'
				}
			}),
			201
		);
		participantId = p.id;
		expect(p.source).toBe('manual');
		expect(p.birthDate).toBe('2015-04-03');

		const list = await data<{ id: string; name: string }[]>(
			await as('reader', `/actions/${actionId}/participants`)
		);
		expect(list.map((x) => x.name)).toEqual(['Lena Beispiel']);

		const upd = await data<{ juleica: boolean; role: string }>(
			await as('owner', `/actions/${actionId}/participants/${participantId}`, {
				method: 'PUT',
				json: { name: 'Lena Beispiel', role: 'team', juleica: true }
			})
		);
		expect(upd).toMatchObject({ role: 'team', juleica: true });

		const summary = await data<ActionDto>(await as('owner', `/actions/${actionId}`));
		expect(summary.participantCount).toBe(1);
	});

	it('validiert Eingaben und blendet fremde Aktionen aus', async () => {
		const bad = await as('owner', `/actions/${actionId}/participants`, {
			method: 'POST',
			json: { name: 'Zukunft', birthDate: '2999-01-01' }
		});
		expect(bad.status).toBe(422);
		const noName = await as('owner', `/actions/${actionId}/participants`, {
			method: 'POST',
			json: { name: '  ' }
		});
		expect(noName.status).toBe(422);
		expect((await as('stranger', `/actions/${actionId}/participants`)).status).toBe(404);
		expect(
			(
				await as('stranger', `/actions/${actionId}/participants`, {
					method: 'POST',
					json: { name: 'Eindringling' }
				})
			).status
		).toBe(404);
	});

	it('findet keine Teilnehmenden einer anderen Aktion', async () => {
		const other = await data<ActionDto>(
			await as('owner', '/actions', { method: 'POST', json: actionBody({ name: 'Andere' }) }),
			201
		);
		const res = await as('owner', `/actions/${other.id}/participants/${participantId}`, {
			method: 'PUT',
			json: { name: 'Fremd' }
		});
		expect(res.status).toBe(404);
	});
});

describe('Löschen, Audit und Modulstatus', () => {
	it('löscht nur mit Recht und als Eigentümer/edit-all', async () => {
		// colleague hat Freigabe "edit", aber kein actions.action.delete
		expect((await as('colleague', `/actions/${actionId}`, { method: 'DELETE' })).status).toBe(403);
		await data(await as('owner', `/actions/${actionId}`, { method: 'DELETE' }));
		expect((await as('owner', `/actions/${actionId}`)).status).toBe(404);
		expect((await as('colleague', `/actions/${actionId}`)).status).toBe(404);
	});

	it('protokolliert Änderungen ohne personenbezogene Details', async () => {
		// Teilnehmer*in anlegen und wieder löschen (participant.deleted)
		const tmp = await data<{ id: string }>(
			await as('owner', '/actions', { method: 'POST', json: actionBody({ name: 'Audit-Test' }) }),
			201
		);
		const p = await data<{ id: string }>(
			await as('owner', `/actions/${tmp.id}/participants`, {
				method: 'POST',
				json: { name: 'Paul Löschtest' }
			}),
			201
		);
		await data(await as('owner', `/actions/${tmp.id}/participants/${p.id}`, { method: 'DELETE' }));
		const { rows } = await listAudit({ action: 'actions.' });
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'actions.action.created',
			'actions.action.updated',
			'actions.action.shared',
			'actions.action.unshared',
			'actions.participant.created',
			'actions.participant.updated',
			'actions.participant.deleted',
			'actions.action.deleted'
		]) {
			expect(actions, a).toContain(a);
		}
		const serialized = JSON.stringify(rows.map((r) => r.metadata));
		expect(serialized).not.toContain('@example.test');
		expect(serialized).not.toContain('2015-04-03');
		// Keine Teilnehmendennamen (Issue #26)
		expect(serialized).not.toContain('Lena Beispiel');
		expect(serialized).not.toContain('Paul Löschtest');
	});

	it('liefert 404, wenn das Modul deaktiviert ist', async () => {
		await disableModule(admin, 'actions');
		expect((await as('owner', '/actions')).status).toBe(404);
	});
});
