/**
 * PDF-Export der Termine mit `actions` (Teil des früheren `events/tests/integration/events-export.test.ts`, der Rest
 * liegt in `atrium-basic-modules` und läuft dort ohne `actions`): eigene Aktionen in Terminliste und Monatskalender,
 * Aktionen abwählbar und nicht bei Gruppen-/Tag-Filter, `actionsAvailable`, Audit ohne Aktionsnamen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
	bootstrapAdmin,
	contextForUser,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	getDb,
	handleApiRequest,
	listAudit,
	registerCoreApi,
	registerModule,
	schema,
	setPdfRendererForTests,
	syncModules,
	useTestDatabase
} from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import type { ExportOptions } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};
let html = '';
let renderOptions: { landscape?: boolean } = {};

function api(path: string, token?: string) {
	const headers = new Headers();
	if (token) headers.set('authorization', `Bearer ${token}`);
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({ request: new Request(url, { headers }), url, ip: '127.0.0.1' });
}
async function post<T>(path: string, json: unknown, method = 'POST'): Promise<T> {
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers: { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' },
			body: JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBeLessThan(300);
	return body.data as T;
}
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

/** Export abrufen; liefert das an den PDF-Renderer übergebene HTML */
async function exportHtml(who: string, query: Record<string, string>): Promise<string> {
	html = '';
	const res = await api(
		`/modules/events/events/export.pdf?${new URLSearchParams(query)}`,
		keys[who]
	);
	if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
	expect(res.headers.get('content-type')).toBe('application/pdf');
	return html;
}

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
		email: `${name}@example.test`,
		password: 'export-password-1234',
		roleIds: [role]
	});
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

const OCT = { from: '2026-10-01', to: '2026-10-31' };

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'actions', 'events']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setTodayForTests('2026-10-01');
	setPdfRendererForTests(async (h, o) => {
		html = h;
		renderOptions = o;
		return new TextEncoder().encode('%PDF-fake');
	});

	await mkUser('anna', ['core.api.manage', 'events.event.view', 'actions.own.view']);
	await mkUser('ohne', ['core.api.manage', 'actions.own.view']);

	const ev = (json: Record<string, unknown>) =>
		post<{ id: string }>('/modules/events/events', json);
	await ev({
		title: 'Stammesversammlung',
		startsOn: '2026-10-10',
		startsTime: '15:00',
		endsOn: '2026-10-10',
		endsTime: '17:00',
		location: 'Heim',
		tags: ['Versammlung'],
		groupIds: ['stamm'],
		shares: [{ type: 'everyone', id: '*', level: 'read' }]
	});
	await ev({ title: 'Nur für Admin', startsOn: '2026-10-11' });
	await ev({
		title: '<script>alert(1)</script>',
		startsOn: '2026-10-28',
		shares: [{ type: 'everyone', id: '*', level: 'read' }]
	});
	const series = await ev({
		title: 'Gruppenstunde',
		startsOn: '2026-10-05',
		startsTime: '17:00',
		endsOn: '2026-10-05',
		endsTime: '18:30',
		shares: [{ type: 'everyone', id: '*', level: 'read' }],
		recurrence: { freq: 'weekly', end: { type: 'count', count: 3 } }
	});
	await post(
		`/modules/events/events/${series.id}/occurrences/2026-10-12`,
		{ cancelled: true },
		'PUT'
	);
	await post(
		`/modules/events/events/${series.id}/occurrences/2026-10-19`,
		{ override: { title: 'Gruppenstunde Ausflug' } },
		'PUT'
	);
	const action = await post<{ id: string }>('/modules/actions/actions', {
		name: 'Herbstfahrt',
		description: 'Interne Planung',
		location: 'Harz',
		startsOn: '2026-10-23',
		startsTime: null,
		endsOn: '2026-10-25',
		endsTime: null
	});
	await moduleDb('actions').transaction((tx) =>
		tx.execute(
			sql`INSERT INTO action_participants (id, action_id, name, user_id)
				VALUES (${crypto.randomUUID()}, ${action.id}, 'Anna Test', ${userIds.anna})`
		)
	);
});
afterAll(async () => {
	setTodayForTests(null);
	setPdfRendererForTests(undefined);
	await close();
});

describe('Terminliste', () => {
	it('zeigt nur Sichtbares, Serien je Vorkommen (ohne Absage) und eigene Aktionen', async () => {
		const res = await api(
			`/modules/events/events/export.pdf?${new URLSearchParams({ layout: 'list', ...OCT })}`,
			keys.anna
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toContain('termine-2026-10.pdf');
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		const h = html;
		expect(h).toContain('Termine Oktober 2026');
		expect(h).toContain('Stammesversammlung');
		expect(h).toContain('Gruppenstunde (Serie)');
		expect(h).toContain('Gruppenstunde Ausflug (Serie)');
		expect(h).toContain('Mo 05.10.');
		expect(h).not.toContain('Mo 12.10.');
		expect(h).not.toContain('Nur für Admin');
		expect(h).toContain('Herbstfahrt (Aktion)');
		expect(h).toContain('Fr 23.10. – So 25.10.');
		expect(h).toContain('Stand: 01.10.2026');
		// Beschreibungen nur auf Wunsch
		expect(h).not.toContain('Interne Planung');
		expect(h).not.toContain('<script>alert(1)</script>');
		expect(h).toContain('&lt;script&gt;');
	});

	it('Aktionen abwählbar und bei Gruppen-/Tag-Filter nicht enthalten', async () => {
		expect(
			await exportHtml('admin', { layout: 'list', ...OCT, includeActions: 'false' })
		).not.toContain('Herbstfahrt');
		const byGroup = await exportHtml('admin', { layout: 'list', ...OCT, groupId: 'stamm' });
		expect(byGroup).toContain('Stammesversammlung');
		expect(byGroup).not.toContain('Gruppenstunde');
		expect(byGroup).not.toContain('Herbstfahrt');
		expect(byGroup).toContain('Gruppe: ');
		const byTag = await exportHtml('admin', { layout: 'list', ...OCT, tag: 'Versammlung' });
		expect(byTag).not.toContain('Herbstfahrt');
		expect(byTag).toContain('Tag: Versammlung');
	});
});

describe('Monatskalender und Jahresplan', () => {
	it('Monatskalender ohne Briefkopf quer, je Monat eine Tabelle Mo–So', async () => {
		const h = await exportHtml('anna', {
			layout: 'calendar',
			from: '2026-10-01',
			to: '2026-11-30'
		});
		expect(renderOptions.landscape).toBe(true);
		expect(h).toContain('Oktober 2026');
		expect(h).toContain('November 2026');
		expect(h).toContain('Stammesversammlung');
		expect(h).toContain('… Herbstfahrt');
		expect(h).not.toContain('Nur für Admin');
	});
});

describe('Prüfung, Recht, Audit', () => {
	it('Auswahl meldet Aktionen', async () => {
		const res = await api('/modules/events/events/export/options', keys.anna);
		const body = (await res.json()) as { data: ExportOptions };
		expect(body.data).toEqual({ actionsAvailable: true, maxDays: 400 });
	});

	it('Audit nur mit Zählern, ohne Titel', async () => {
		await exportHtml('anna', { layout: 'list', ...OCT });
		const audit = await listAudit({ action: 'events.events.exported' });
		expect(audit.rows.length).toBeGreaterThan(0);
		const text = JSON.stringify(audit.rows);
		expect(text).not.toContain('Stammesversammlung');
		expect(text).not.toContain('Herbstfahrt');
		expect(audit.rows[0]!.metadata).toMatchObject({ layout: expect.any(String) });
	});
});
