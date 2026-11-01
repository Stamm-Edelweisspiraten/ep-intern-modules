/**
 * Datenschutz der Freigabe-Suche (Issue #5) und `members`-Anbindung der Principal-Helfer (#45):
 * - `/principals` in `events`, `galleries`, `files` nur für Personen, die etwas teilen dürfen, mit
 *   eigenem Rate-Limit; Mitglieder (Kinder) nur mit `members.member.view`, E-Mails nur mit `core.users.view`.
 * - `describePrincipals`/`validatePrincipals`/`core.users.directory` werten den Kontext ebenso aus.
 * - Helfer funktionieren für Module mit harter `members`-Abhängigkeit; ohne Deklaration klarer Fehler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { isCoreError } from '$testing';
import {
	core,
	defineModule,
	describePrincipals,
	principalKeysFor,
	searchPrincipals,
	validatePrincipals,
	type PrincipalInfo
} from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import filesModule from '$modules/files/module';
import actionsModule from '$modules/actions/module';

/** Testmodul mit HARTER `members`-Abhängigkeit (wie `actions`, `orders`, `treasury`) */
const hardModule = defineModule({
	manifest: {
		id: 'hardmem',
		name: 'Hart abhängig',
		version: '1.0.0',
		dependencies: ['members'],
		permissions: [],
		navigation: []
	}
});
/** Testmodul ohne jede `members`-Deklaration */
const noDepsModule = defineModule({
	manifest: {
		id: 'nodeps',
		name: 'Ohne Abhängigkeit',
		version: '1.0.0',
		dependencies: [],
		permissions: [],
		navigation: []
	}
});

let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};

type Res = { status: number; body: { data?: unknown; error?: { code?: string } } };

async function call(
	who: string,
	module: string,
	method: string,
	path: string,
	json?: unknown
): Promise<Res> {
	const url = new URL(`http://localhost:5173/api/v1/modules/${module}${path}`);
	const headers: Record<string, string> = { authorization: `Bearer ${keys[who]}` };
	if (json !== undefined) headers['content-type'] = 'application/json';
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

function ok<T>(res: Res, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

const memberBody = (firstName: string, lastName: string, groupIds: string[] = []) => ({
	firstName,
	lastName,
	scoutName: null,
	birthDate: '2015-03-14',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [],
	emails: [],
	stage: 'woelfling',
	groupIds
});

const eventBody = (shares: unknown[]) => ({
	title: 'Elternabend',
	description: null,
	location: null,
	startsOn: '2026-11-03',
	startsTime: null,
	endsOn: null,
	endsTime: null,
	tags: [],
	groupIds: [],
	shares,
	onWebsite: false
});

const galleryBody = (shares: unknown[]) => ({
	title: 'Sommerlager',
	description: '',
	visibility: 'private',
	shares
});

const PRINCIPAL_PATHS: Record<string, (q: string) => string> = {
	events: (q) => `/principals?search=${encodeURIComponent(q)}`,
	galleries: (q) => `/principals?search=${encodeURIComponent(q)}`,
	files: (q) => `/principals?q=${encodeURIComponent(q)}`
};

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	registerModule(galleriesModule);
	registerModule(filesModule);
	registerModule(actionsModule);
	registerModule(hardModule);
	registerModule(noDepsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.org', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.org'));
	ids.admin = u!.id;
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'events', 'galleries', 'files', 'actions']) {
		await enableModule(admin, m);
	}
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	// Rolle „Mitglied“ entsteht über `defaultRoleGrants` der Module
	const [mitglied] = await getDb()
		.select()
		.from(schema.role)
		.where(eq(schema.role.name, 'Mitglied'));
	expect(mitglied).toBeTruthy();
	const apiRole = await createRole(admin, { name: 'API', permissions: ['core.api.manage'] });
	const managerPerms = [
		'core.api.manage',
		'core.users.view',
		'members.member.view',
		'members.group.view',
		'events.event.view',
		'events.event.create',
		'galleries.gallery.view',
		'galleries.gallery.create',
		'files.file.view',
		'actions.action.view'
	];
	const managerRole = await createRole(admin, { name: 'Verwaltung', permissions: managerPerms });
	const readerRole = await createRole(admin, {
		name: 'Aktionen lesen',
		permissions: ['core.api.manage', 'actions.action.view']
	});

	ids.parent = await createUser(admin, {
		name: 'Paula Muster',
		email: 'paula@example.org',
		password: 'paula-password-123',
		roleIds: [mitglied!.id, apiRole]
	});
	ids.manager = await createUser(admin, {
		name: 'Moritz Verwalter',
		email: 'moritz@example.org',
		password: 'moritz-password-123',
		roleIds: [managerRole]
	});
	ids.reader = await createUser(admin, {
		name: 'Rita Leserin',
		email: 'rita@example.org',
		password: 'rita-password-123',
		roleIds: [readerRole]
	});
	for (const who of ['parent', 'manager', 'reader'] as const) {
		const ctx = await ctxOf(ids[who]!);
		keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
	}

	ids.leader = ok<{ id: string }>(
		await call('admin', 'members', 'POST', '/members', memberBody('Lea', 'Leiterin')),
		201
	).id;
	ids.group = ok<{ id: string }>(
		await call('admin', 'members', 'POST', '/groups', {
			name: 'Wölflinge Rudel',
			type: 'meute',
			leaderIds: [ids.leader]
		}),
		201
	).id;
	ids.kid = ok<{ id: string }>(
		await call(
			'admin',
			'members',
			'POST',
			'/members',
			memberBody('Kinderling', 'Muster', [ids.group])
		),
		201
	).id;
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${ids.kid}, ${ids.parent}, 'Mutter')`
		);
	});
});

afterAll(async () => {
	await close();
});

beforeEach(() => {
	resetAllForTests();
});

describe('/principals: Zugang nur für Personen, die teilen dürfen', () => {
	it('Rolle „Mitglied“ ohne teilbares Objekt → 403 in allen drei Modulen', async () => {
		for (const [mod, path] of Object.entries(PRINCIPAL_PATHS)) {
			const res = await call('parent', mod, 'GET', path('Muster'));
			expect(res.status, mod).toBe(403);
			expect(res.body.error?.code, mod).toBe('forbidden');
		}
	});

	it('Verwaltende sehen Mitglieder samt Gruppen und Benutzer*innen mit E-Mail', async () => {
		// files: Verwaltende*r braucht einen eigenen Knoten
		ok(await call('manager', 'files', 'POST', '/folders', { parentId: null, name: 'Ablage' }), 201);
		for (const [mod, path] of Object.entries(PRINCIPAL_PATHS)) {
			const res = ok<PrincipalInfo[]>(await call('manager', mod, 'GET', path('Muster')));
			expect(
				res.find((p) => p.type === 'member'),
				mod
			).toMatchObject({
				id: ids.kid,
				name: 'Kinderling Muster',
				detail: 'Wölflinge Rudel'
			});
			expect(
				res.find((p) => p.type === 'user'),
				mod
			).toMatchObject({
				id: ids.parent,
				name: 'Paula Muster',
				detail: 'paula@example.org'
			});
		}
	});

	it('mit teilbarem Objekt: Zugang ja, aber keine Mitglieder und keine E-Mails', async () => {
		// events/galleries: Bearbeiten-Freigabe an die Person; files: eigener Ordner
		const editShare = [{ type: 'user', id: ids.parent, level: 'edit' }];
		ok(await call('admin', 'events', 'POST', '/events', eventBody(editShare)), 201);
		ok(await call('admin', 'galleries', 'POST', '/galleries', galleryBody(editShare)), 201);
		ok(await call('parent', 'files', 'POST', '/folders', { parentId: null, name: 'Meins' }), 201);

		for (const [mod, path] of Object.entries(PRINCIPAL_PATHS)) {
			const res = ok<PrincipalInfo[]>(await call('parent', mod, 'GET', path('Muster')));
			expect(
				res.some((p) => p.type === 'member'),
				mod
			).toBe(false);
			const user = res.find((p) => p.type === 'user' && p.id === ids.parent);
			expect(user, mod).toBeTruthy();
			for (const p of res) expect(p.detail ?? null, mod).toBeNull();
			expect(JSON.stringify(res), mod).not.toContain('@example.org');

			// Gruppen bleiben bewusst sichtbar (keine personenbezogenen Daten)
			const groups = ok<PrincipalInfo[]>(await call('parent', mod, 'GET', path('Wölf')));
			expect(groups.find((p) => p.type === 'group')?.id, mod).toBe(ids.group);

			// keine Suche über E-Mail-Teile
			const byMail = ok<PrincipalInfo[]>(await call('parent', mod, 'GET', path('example.org')));
			expect(
				byMail.filter((p) => p.type === 'user'),
				mod
			).toEqual([]);
		}
	});

	it('eigenes Rate-Limit (60 je Minute)', async () => {
		let last = 0;
		for (let i = 0; i < 61; i++) {
			last = (await call('manager', 'files', 'GET', PRINCIPAL_PATHS.files!('zz'))).status;
		}
		expect(last).toBe(429);
	});
});

describe('describePrincipals / validatePrincipals werten den Kontext aus', () => {
	const list = () => [
		{ type: 'user' as const, id: ids.manager! },
		{ type: 'member' as const, id: ids.kid! },
		{ type: 'group' as const, id: ids.group! }
	];

	it('ohne Rechte: keine E-Mail, Mitglied nur als „Mitglied“', async () => {
		const parent = await ctxOf(ids.parent!);
		const res = await describePrincipals(parent, 'events', list(), { everyoneLabel: 'Stamm' });
		expect(res[0]).toMatchObject({ type: 'user', name: 'Moritz Verwalter', detail: null });
		expect(res[1]).toEqual({ type: 'member', id: ids.kid, name: 'Mitglied' });
		expect(res[2]).toMatchObject({ type: 'group', name: 'Wölflinge Rudel' });
	});

	it('Verwaltende: E-Mail und Mitgliedsname', async () => {
		const manager = await ctxOf(ids.manager!);
		const res = await describePrincipals(manager, 'files', list(), { everyoneLabel: 'Stamm' });
		expect(res[0]).toMatchObject({ detail: 'moritz@example.org' });
		expect(res[1]).toMatchObject({ name: 'Kinderling Muster', detail: 'Wölflinge Rudel' });
	});

	it('validatePrincipals prüft nur die Existenz – auch ohne members.member.view', async () => {
		const parent = await ctxOf(ids.parent!);
		await expect(
			validatePrincipals(parent, 'galleries', [{ type: 'member', id: ids.kid! }])
		).resolves.toBeUndefined();
		await expect(
			validatePrincipals(parent, 'galleries', [{ type: 'member', id: crypto.randomUUID() }])
		).rejects.toMatchObject({ code: 'validation_failed' });
	});
});

describe('core.users.directory: E-Mail nur mit core.users.view', () => {
	it('ohne Recht: E-Mail leer (außer eigenes Konto), keine Suche über die Adresse', async () => {
		const parent = await ctxOf(ids.parent!);
		const found = await core.users.directory(parent, { ids: [ids.manager!, ids.parent!] });
		const byId = new Map(found.map((u) => [u.id, u]));
		expect(byId.get(ids.manager!)?.email).toBe('');
		expect(byId.get(ids.parent!)?.email).toBe('paula@example.org');
		expect(await core.users.directory(parent, { search: 'moritz@' })).toEqual([]);
	});

	it('mit core.users.view und im System-Kontext: E-Mail und Suche über die Adresse', async () => {
		const manager = await ctxOf(ids.manager!);
		const [hit] = await core.users.directory(manager, { search: 'paula@' });
		expect(hit).toMatchObject({ id: ids.parent, email: 'paula@example.org' });
		const [sys] = await core.users.directory(core.auth.systemContext('test'), {
			ids: [ids.manager!]
		});
		expect(sys?.email).toBe('moritz@example.org');
	});
});

describe('actions /users', () => {
	it('nur Lesen ohne eigene Aktion → 403; Admin sieht E-Mails', async () => {
		const denied = await call('reader', 'actions', 'GET', '/users?search=Muster');
		expect(denied.status).toBe(403);
		const res = ok<{ id: string; email: string }[]>(
			await call('admin', 'actions', 'GET', '/users?search=Muster')
		);
		expect(res.find((u) => u.id === ids.parent)?.email).toBe('paula@example.org');
	});
});

describe('Principal-Helfer bei harter members-Abhängigkeit (#45)', () => {
	it('principalKeysFor liefert Mitglieds- und Gruppenschlüssel', async () => {
		const keysOf = await principalKeysFor(await ctxOf(ids.parent!), 'hardmem');
		expect(keysOf).toEqual(expect.arrayContaining([`member:${ids.kid}`, `group:${ids.group}`]));
	});

	it('searchPrincipals, describePrincipals, validatePrincipals funktionieren', async () => {
		const res = await searchPrincipals(admin, 'hardmem', 'Muster', { everyoneLabel: 'Stamm' });
		expect(res.find((p) => p.type === 'member')?.id).toBe(ids.kid);
		const desc = await describePrincipals(admin, 'hardmem', [{ type: 'group', id: ids.group! }], {
			everyoneLabel: 'Stamm'
		});
		expect(desc[0]?.name).toBe('Wölflinge Rudel');
		await expect(
			validatePrincipals(admin, 'hardmem', [{ type: 'member', id: ids.kid! }])
		).resolves.toBeUndefined();
	});

	it('Modul ohne Deklaration → definierter Programmierfehler', async () => {
		const parent = await ctxOf(ids.parent!);
		const err = await principalKeysFor(parent, 'nodeps').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(isCoreError(err)).toBe(false);
		expect((err as Error).message).toContain('nodeps');
		await expect(
			searchPrincipals(admin, 'nodeps', 'Wölf', { everyoneLabel: 'Stamm' })
		).rejects.toThrow(/nodeps/);
	});
});
