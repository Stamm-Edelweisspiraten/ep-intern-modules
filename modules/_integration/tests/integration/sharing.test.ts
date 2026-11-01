import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser, anonymousContext, systemContext } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { isCoreError } from '$testing';
import {
	core,
	describePrincipals,
	principalKeysFor,
	searchPrincipals,
	validatePrincipals,
	type Principal
} from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import type { RequestContext } from '$lib/sdk/types';

const MOD = 'events';
const LABEL = 'Stamm Edelweißpiraten';
const OPTS = { everyoneLabel: LABEL };

let close: () => Promise<void>;
let admin: RequestContext;
let adminKey = '';
let userId = '';
let roleId = '';
let kidId = '';
let leaderId = '';
let groupId = '';
let otherGroupId = '';

async function membersApi<T>(path: string, json: unknown): Promise<T> {
	const url = new URL(`http://localhost:5173/api/v1/modules/members${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.data as T;
}

const memberBody = (firstName: string, lastName: string, groupIds: string[] = []) => ({
	firstName,
	lastName,
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
});

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function validationIssues(p: Promise<unknown>) {
	try {
		await p;
	} catch (e) {
		expect(isCoreError(e)).toBe(true);
		const err = e as { code: string; details: { path: (string | number)[] }[] };
		expect(err.code).toBe('validation_failed');
		return err.details;
	}
	throw new Error('Validierungsfehler erwartet');
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.org', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.org'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, MOD);
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;

	roleId = await createRole(admin, {
		name: 'Testrolle Leitung',
		permissions: ['events.event.view']
	});
	userId = await createUser(admin, {
		name: 'Testa Tessa',
		email: 'tessa@example.org',
		password: 'tessa-password-123',
		roleIds: [roleId]
	});

	leaderId = (await membersApi<{ id: string }>('/members', memberBody('Lea', 'Leiterin'))).id;
	groupId = (
		await membersApi<{ id: string }>('/groups', {
			name: 'Testgruppe Wölflinge',
			type: 'meute',
			leaderIds: [leaderId]
		})
	).id;
	otherGroupId = (
		await membersApi<{ id: string }>('/groups', {
			name: 'Pfadis',
			type: 'sippe',
			leaderIds: [leaderId]
		})
	).id;
	kidId = (
		await membersApi<{ id: string }>('/members', memberBody('Testkind', 'Muster', [groupId]))
	).id;
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${kidId}, ${userId}, 'Mutter')`
		);
	});
});

afterAll(async () => {
	await close();
});

describe('principalKeysFor', () => {
	it('ohne userId nur everyone', async () => {
		expect(await principalKeysFor(systemContext(), MOD)).toEqual(['everyone:*']);
		expect(await principalKeysFor(anonymousContext(), MOD)).toEqual(['everyone:*']);
	});

	it('Benutzer: everyone, user, Rolle, verknüpftes Mitglied und dessen Gruppe', async () => {
		const keys = await principalKeysFor(await ctxOf(userId), MOD);
		expect(keys).toEqual(
			expect.arrayContaining([
				'everyone:*',
				`user:${userId}`,
				`role:${roleId}`,
				`member:${kidId}`,
				`group:${groupId}`
			])
		);
		expect(keys).not.toContain(`group:${otherGroupId}`);
		expect(keys).not.toContain(`member:${leaderId}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe('searchPrincipals', () => {
	it('unter 2 Zeichen keine Treffer', async () => {
		expect(await searchPrincipals(admin, MOD, ' t ', OPTS)).toEqual([]);
	});

	it('Reihenfolge everyone, group, role, member, user', async () => {
		const res = await searchPrincipals(admin, MOD, 'test', {
			everyoneLabel: 'Testtrupp'
		});
		expect(res.map((p) => p.type)).toEqual(['everyone', 'group', 'role', 'member', 'user']);
		expect(res[0]).toMatchObject({ type: 'everyone', id: '*', name: 'Testtrupp' });
		expect(res[1]).toMatchObject({ id: groupId, name: 'Testgruppe Wölflinge' });
		expect(res[2]).toMatchObject({ id: roleId, name: 'Testrolle Leitung' });
		expect(res[3]).toMatchObject({ id: kidId, detail: 'Testgruppe Wölflinge' });
		expect(res[4]).toMatchObject({ id: userId, name: 'Testa Tessa', detail: 'tessa@example.org' });
	});

	it('everyone über „Stamm“/„alle“ (case-insensitiv)', async () => {
		expect((await searchPrincipals(admin, MOD, 'STAMM', OPTS))[0]).toMatchObject({
			type: 'everyone',
			name: LABEL
		});
		expect((await searchPrincipals(admin, MOD, 'Alle', OPTS))[0]?.type).toBe('everyone');
		expect((await searchPrincipals(admin, MOD, 'weiß', OPTS))[0]?.type).toBe('everyone');
	});

	it('beachtet erlaubte Typen und limitPerType', async () => {
		const res = await searchPrincipals(admin, MOD, 'test', {
			everyoneLabel: 'Testtrupp',
			types: ['user', 'group'],
			limitPerType: 1
		});
		expect(res.map((p) => p.type)).toEqual(['group', 'user']);
	});
});

describe('describePrincipals', () => {
	it('löst alle Typen in Reihenfolge auf, Unbekannte als „Unbekannt“', async () => {
		const list: Principal[] = [
			{ type: 'user', id: userId },
			{ type: 'everyone', id: '*' },
			{ type: 'member', id: kidId },
			{ type: 'role', id: 'gibts-nicht' },
			{ type: 'group', id: otherGroupId },
			{ type: 'role', id: roleId }
		];
		const res = await describePrincipals(admin, MOD, list, OPTS);
		expect(res).toEqual([
			{ type: 'user', id: userId, name: 'Testa Tessa', detail: 'tessa@example.org', image: null },
			{ type: 'everyone', id: '*', name: LABEL },
			{
				type: 'member',
				id: kidId,
				name: expect.stringContaining('Testkind'),
				detail: 'Testgruppe Wölflinge'
			},
			{ type: 'role', id: 'gibts-nicht', name: 'Unbekannt' },
			{ type: 'group', id: otherGroupId, name: 'Pfadis', color: null, image: null },
			{ type: 'role', id: roleId, name: 'Testrolle Leitung' }
		]);
	});

	it('leere Liste', async () => {
		expect(await describePrincipals(admin, MOD, [], OPTS)).toEqual([]);
	});
});

describe('validatePrincipals', () => {
	it('akzeptiert gültige Principals', async () => {
		await expect(
			validatePrincipals(admin, MOD, [
				{ type: 'everyone', id: '*' },
				{ type: 'group', id: groupId },
				{ type: 'role', id: roleId },
				{ type: 'user', id: userId },
				{ type: 'member', id: kidId }
			])
		).resolves.toBeUndefined();
	});

	it('everyone nur mit *, Unbekannte und nicht erlaubte Typen', async () => {
		const issues = await validationIssues(
			validatePrincipals(
				admin,
				MOD,
				[
					{ type: 'user', id: userId },
					{ type: 'everyone', id: 'x' },
					{ type: 'user', id: 'gibts-nicht' },
					{ type: 'group', id: groupId }
				],
				{ types: ['everyone', 'user'], pathPrefix: 'visibility' }
			)
		);
		expect(issues.map((i) => i.path)).toEqual([
			['visibility', 1, 'id'],
			['visibility', 2, 'id'],
			['visibility', 3, 'id']
		]);
	});

	it('Standardpfad shares', async () => {
		const issues = await validationIssues(
			validatePrincipals(admin, MOD, [{ type: 'member', id: 'nix' }])
		);
		expect(issues.map((i) => i.path)).toEqual([['shares', 0, 'id']]);
	});
});

describe('members deaktiviert', () => {
	it('keine Gruppen/Mitglieder in Schlüsseln, Suche, Beschreibung und Validierung', async () => {
		await disableModule(admin, 'members');

		const keys = await principalKeysFor(await ctxOf(userId), MOD);
		expect(keys.sort()).toEqual(['everyone:*', `role:${roleId}`, `user:${userId}`].sort());

		const res = await searchPrincipals(admin, MOD, 'test', { everyoneLabel: 'Testtrupp' });
		expect(res.map((p) => p.type)).toEqual(['everyone', 'role', 'user']);

		const desc = await describePrincipals(
			admin,
			MOD,
			[
				{ type: 'group', id: groupId },
				{ type: 'member', id: kidId }
			],
			OPTS
		);
		expect(desc.map((d) => d.name)).toEqual(['Unbekannt', 'Unbekannt']);

		const issues = await validationIssues(
			validatePrincipals(admin, MOD, [
				{ type: 'user', id: userId },
				{ type: 'group', id: groupId },
				{ type: 'member', id: kidId }
			])
		);
		expect(issues.map((i) => i.path)).toEqual([
			['shares', 1, 'id'],
			['shares', 2, 'id']
		]);
	});
});
