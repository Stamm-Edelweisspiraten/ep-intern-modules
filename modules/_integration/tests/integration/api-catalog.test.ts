/**
 * API-Übersicht (`/api-docs`): Katalog aus der Endpunkt-Registry.
 * Prüft Vollständigkeit gegen OpenAPI, Rechte (`allowed`), Modulstatus, den Rate-Limit-Spiegel
 * gegenüber dem Router, Fehlerliste und die Doku-Hygiene aller registrierten Module.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { buildOpenApiDocument } from '$testing';
import { resetAllForTests } from '$testing';
import { buildApiCatalog } from '$testing';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import treasuryModule from '$modules/treasury/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import type { ApiCatalog, ApiCatalogEntry } from '$lib/api-docs/types';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
let adminId: string;
let viewer: RequestContext;
let adminCatalog: ApiCatalog;
let viewerCatalog: ApiCatalog;

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

function find(c: ApiCatalog, method: string, path: string): ApiCatalogEntry {
	const e = c.entries.find((x) => x.method === method && x.path === path);
	if (!e) throw new Error(`Eintrag fehlt: ${method} ${path}`);
	return e;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	registerModule(eventsModule);
	registerModule(galleriesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'Sehr-Sicheres-Passwort-1');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	// galleries und treasury bleiben bewusst deaktiviert
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	await enableModule(admin, 'events');
	admin = await ctxOf(adminId);

	const roleId = await createRole(admin, {
		name: 'Nur API ansehen',
		permissions: ['core.api.view']
	});
	const viewerId = await createUser(admin, {
		name: 'Vera Viewer',
		email: 'viewer@example.test',
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	viewer = await ctxOf(viewerId);

	adminCatalog = await buildApiCatalog(admin);
	viewerCatalog = await buildApiCatalog(viewer);
});

afterAll(async () => {
	await close();
});

describe('API-Katalog: Inhalt', () => {
	it('enthält Core-Endpunkte mit Zugriffsart', () => {
		const health = find(adminCatalog, 'GET', '/api/v1/health');
		expect(health.access).toBe('public');
		expect(health.moduleId).toBe('core');
		expect(health.moduleEnabled).toBe(true);
		expect(health.group.startsWith('core:')).toBe(true);
		const me = find(adminCatalog, 'GET', '/api/v1/me');
		expect(me.access).toBe('authenticated');
		expect(me.permission).toBeNull();
		const createUserEntry = find(adminCatalog, 'POST', '/api/v1/users');
		expect(createUserEntry.access).toBe('permission');
		expect(createUserEntry.permission).toBe('core.users.create');
		expect(createUserEntry.successStatus).toBe(201);
	});

	it('enthält Endpunkte registrierter Module mit Gruppe module:<id>', () => {
		const ev = find(adminCatalog, 'GET', '/api/v1/modules/events/events/:id');
		expect(ev.moduleId).toBe('events');
		expect(ev.group).toBe('module:events');
		expect(ev.permission).toBe('events.event.view');
		expect(ev.successStatus).toBe(200);
		expect(adminCatalog.groups.some((g) => g.id === 'module:events')).toBe(true);
		for (const e of adminCatalog.entries) {
			expect(adminCatalog.groups.some((g) => g.id === e.group)).toBe(true);
		}
	});

	it('hat genau so viele Einträge wie OpenAPI-Operationen', () => {
		const doc = buildOpenApiDocument() as { paths?: Record<string, Record<string, unknown>> };
		let ops = 0;
		for (const item of Object.values(doc.paths ?? {})) {
			ops += Object.keys(item).filter((k) => HTTP_METHODS.includes(k)).length;
		}
		expect(ops).toBeGreaterThan(0);
		expect(adminCatalog.entries.length).toBe(ops);
	});

	it('liefert einen gültigen Zeitstempel', () => {
		expect(new Date(adminCatalog.generatedAt).toISOString()).toBe(adminCatalog.generatedAt);
	});
});

describe('API-Katalog: Rechte und Modulstatus', () => {
	it('Admin darf alles (aktive Module)', () => {
		// Rechte deaktivierter Module sind im Kontext nicht wirksam
		for (const e of adminCatalog.entries.filter((x) => x.moduleEnabled)) {
			expect(e.allowed, e.id).toBe(true);
		}
	});

	it('Benutzer nur mit core.api.view: allowed nach Recht', () => {
		expect(find(viewerCatalog, 'POST', '/api/v1/users').allowed).toBe(false);
		expect(find(viewerCatalog, 'GET', '/api/v1/health').allowed).toBe(true);
		expect(find(viewerCatalog, 'GET', '/api/v1/me').allowed).toBe(true);
		expect(find(viewerCatalog, 'GET', '/api/v1/modules/events/events').allowed).toBe(false);
		for (const e of viewerCatalog.entries) {
			if (e.permission) expect(e.allowed, e.id).toBe(viewer.permissions.has(e.permission));
		}
	});

	it('deaktivierte Module: moduleEnabled false, aktive true', () => {
		const byModule = new Map<string, boolean>();
		for (const e of adminCatalog.entries) {
			if (byModule.has(e.moduleId)) expect(e.moduleEnabled, e.id).toBe(byModule.get(e.moduleId));
			byModule.set(e.moduleId, e.moduleEnabled);
		}
		expect(byModule.get('core')).toBe(true);
		expect(byModule.get('events')).toBe(true);
		expect(byModule.get('members')).toBe(true);
		expect(byModule.get('galleries')).toBe(false);
		expect(byModule.get('treasury')).toBe(false);
	});
});

describe('API-Katalog: Rate-Limit-Spiegel', () => {
	it('Standardwerte stimmen mit dem Router überein', async () => {
		const me = find(adminCatalog, 'GET', '/api/v1/me');
		expect(me.rateLimit).toEqual({ limit: 120, windowSec: 60, isDefault: true });

		resetAllForTests();
		const { key } = await createApiKey(admin, { name: 'katalog', scopes: ['core.users.view'] });
		const url = new URL('http://localhost/api/v1/me');
		const res = await handleApiRequest({
			request: new Request(url, { headers: { authorization: `Bearer ${key}` } }),
			url,
			ip: '127.0.0.1'
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('x-ratelimit-remaining')).toBe(String(me.rateLimit.limit - 1));
	});

	it('eigene Limits werden als nicht Standard ausgewiesen', () => {
		const website = find(adminCatalog, 'GET', '/api/v1/modules/events/website/events');
		expect(website.rateLimit.isDefault).toBe(false);
		expect(website.rateLimit.limit).toBeGreaterThan(0);
		expect(website.rateLimit.windowSec).toBeGreaterThan(0);
	});
});

describe('API-Katalog: Hygiene (alle registrierten Module)', () => {
	it('jeder Endpunkt hat eine nicht-leere Zusammenfassung', () => {
		const missing = adminCatalog.entries.filter((e) => !e.summary.trim()).map((e) => e.id);
		expect(missing).toEqual([]);
	});

	it('Pfadparameter stimmen mit dem params-Schema überein', () => {
		const problems: string[] = [];
		for (const e of adminCatalog.entries) {
			const names = [...e.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!).sort();
			if (!names.length) continue;
			const props = Object.keys(e.params?.properties ?? {}).sort();
			if (JSON.stringify(props) !== JSON.stringify(names)) {
				problems.push(`${e.id}: Pfad [${names.join(',')}] vs. Schema [${props.join(',')}]`);
			}
		}
		expect(problems).toEqual([]);
	});

	it('ids sind eindeutig und beginnen mit der Methode', () => {
		const ids = adminCatalog.entries.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		// Vertrag: `METHOD fullPath` (Beispiel ohne /api/v1) – Pfad relativ oder absolut zulassen
		for (const e of adminCatalog.entries) {
			expect([
				`${e.method} ${e.path}`,
				`${e.method} ${e.path.replace(/^\/api\/v1/, '')}`
			]).toContain(e.id);
		}
	});

	it('ist JSON-serialisierbar und enthält keine Funktionen', () => {
		expect(JSON.parse(JSON.stringify(adminCatalog))).toEqual(adminCatalog);
		const fnPaths: string[] = [];
		const walk = (v: unknown, p: string) => {
			if (typeof v === 'function') fnPaths.push(p);
			else if (v && typeof v === 'object') {
				for (const [k, child] of Object.entries(v)) walk(child, `${p}.${k}`);
			}
		};
		walk(adminCatalog, 'catalog');
		expect(fnPaths).toEqual([]);
	});
});

describe('API-Katalog: Fehler', () => {
	it('Endpunkte mit Berechtigung nennen 403 forbidden', () => {
		const missing = adminCatalog.entries
			.filter((e) => e.permission)
			.filter((e) => !e.errors.some((x) => x.status === 403 && x.code === 'forbidden'))
			.map((e) => e.id);
		expect(missing).toEqual([]);
	});

	it('öffentliche GET-Endpunkte haben kein 401 für fehlende Anmeldung', () => {
		// Ein ungültiger Authorization-Header ergibt auch bei öffentlichen Endpunkten 401 (router.ts),
		// der Grund „keine Anmeldung“ darf dort aber nicht stehen. deriveErrors fasst gleiche
		// Status+Code zusammen – daher die Erklärtexte mit /me (authenticated) vergleichen.
		const when401 = (e: ApiCatalogEntry) =>
			e.errors
				.filter((x) => x.status === 401)
				.map((x) => x.when)
				.join(' | ');
		const me = when401(find(adminCatalog, 'GET', '/api/v1/me'));
		expect(me.length).toBeGreaterThan(0);
		const publicGets = adminCatalog.entries.filter(
			(e) => e.access === 'public' && e.method === 'GET'
		);
		expect(publicGets.length).toBeGreaterThan(0);
		for (const e of publicGets) expect(when401(e).length, e.id).toBeLessThan(me.length);
	});

	it('Fehlereinträge haben Status, Code und Erklärung', () => {
		for (const e of adminCatalog.entries) {
			for (const x of e.errors) {
				expect(x.status, e.id).toBeGreaterThanOrEqual(400);
				expect(x.code.length, e.id).toBeGreaterThan(0);
				expect(x.when.trim().length, e.id).toBeGreaterThan(0);
			}
		}
	});
});
