/**
 * Test-Schnittstelle `$testing` (Kalypzo Atrium, Phase 3): Ein Modultest kommt nur mit `$testing` und dem
 * eigenen Modul aus – Aufbau, Aktivieren, Rolle/Benutzer/API-Key, REST-Aufruf, Audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminContext,
	apiCall,
	createApiKey,
	createRole,
	createUser,
	contextForUser,
	enableModule,
	listAudit,
	registerCoreApi,
	registerModule,
	syncModules,
	useTestDatabase
} from '$testing';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
let key = '';

beforeAll(async () => {
	close = (await useTestDatabase()).close;
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	admin = await adminContext('facade@example.test', 'correct-horse-battery');
	await enableModule(admin, 'members');
	admin = await adminContext('facade@example.test', 'correct-horse-battery');
	const roleId = await createRole(admin, {
		name: 'Fassade',
		permissions: ['members.member.view', 'core.api.manage']
	});
	const userId = await createUser(admin, {
		name: 'Fassade Person',
		email: 'fassade-person@example.test',
		password: 'correct-horse-battery',
		roleIds: [roleId]
	});
	const userCtx = (await contextForUser(userId))!.ctx;
	key = (await createApiKey(userCtx, { name: 'Test', scopes: ['members.member.view'] })).key;
});
afterAll(async () => close());

describe('$testing', () => {
	it('Modul aktivieren, REST aufrufen, Audit lesen', async () => {
		const res = await apiCall<{ items: unknown[] }>(key, 'GET', '/modules/members/members');
		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.data?.items)).toBe(true);
		const audit = await listAudit({ limit: 50 });
		expect(JSON.stringify(audit)).toContain('core.module.enabled');
	});
});
