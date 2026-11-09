/**
 * Kalender-Abo (iCal) im Modul `events` mit `members` und `actions` (Teil des früheren
 * `events/tests/integration/events-calendar-feeds.test.ts`, der Rest liegt in `atrium-basic-modules` und läuft dort
 * ohne beide): `actionsAvailable`, Aktionen im Abo (sichtbare und eigene Anmeldungen ohne Beschreibung, mit Recht
 * mit Beschreibung und Link), reines Aktionen-Abo, Filter nach einer `members`-Gruppe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { resetAllForTests } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import type { CalendarFeed, CalendarFeedList } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

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
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
const E = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/events${path}`, { token: keys[who], ...init });

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
		email: `${name}@example.test`,
		password: 'calendar-password-1234',
		roleIds: [role]
	});
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

const newFeed = (who: string, json: Record<string, unknown> = {}) =>
	E(who, '/calendar-feeds', { method: 'POST', json: { name: 'Alles', ...json } }).then((r) =>
		data<CalendarFeed>(r, 201)
	);

/** Feed so abrufen, wie es eine Kalender-App tut (ohne Anmeldung) */
async function fetchIcs(url: string): Promise<Response> {
	const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
	return api(path);
}
async function ics(url: string): Promise<string> {
	const res = await fetchIcs(url);
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
	// Gefaltete Zeilen (RFC 5545) zusammenfügen, wie es eine Kalender-App tut
	return (await res.text()).replace(/\r\n /g, '');
}
const summaries = (text: string) =>
	text
		.split('\r\n')
		.filter((l) => l.startsWith('SUMMARY:'))
		.map((l) => l.slice(8));

let groupGruen = '';
let actionId = '';

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

	await mkUser('anna', ['core.api.manage', 'events.event.view', 'actions.own.view']);
	await mkUser('bert', ['core.api.manage', 'events.event.view']);
	await mkUser('ohne', ['core.api.manage', 'actions.own.view']);

	const MEM = (path: string, json: unknown) =>
		api(`/modules/members${path}`, { token: keys.admin, method: 'POST', json });
	const lea = await data<{ id: string }>(
		await MEM('/members', {
			firstName: 'Lea',
			lastName: 'Leitung',
			scoutName: null,
			birthDate: '2004-03-01',
			street: 'Weg 1',
			postalCode: '12345',
			city: 'Ort',
			country: 'DE',
			phones: [],
			emails: [],
			stage: 'kreuzpfadfinder',
			groupIds: []
		}),
		201
	);
	groupGruen = (
		await data<{ id: string }>(
			await MEM('/groups', { name: 'Grün', type: 'sippe', leaderIds: [lea.id] }),
			201
		)
	).id;

	const ev = (json: Record<string, unknown>) =>
		E('admin', '/events', { method: 'POST', json }).then((r) => data<{ id: string }>(r, 201));
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
	const series = await ev({
		title: 'Gruppenstunde Grün',
		startsOn: '2026-10-05',
		startsTime: '17:00',
		endsOn: '2026-10-05',
		endsTime: '18:30',
		groupIds: [groupGruen],
		shares: [{ type: 'everyone', id: '*', level: 'read' }],
		recurrence: { freq: 'weekly', end: { type: 'count', count: 3 } }
	});
	await data(
		await E('admin', `/events/${series.id}/occurrences/2026-10-12`, {
			method: 'PUT',
			json: { cancelled: true }
		})
	);
	await data(
		await E('admin', `/events/${series.id}/occurrences/2026-10-19`, {
			method: 'PUT',
			json: { override: { title: 'Gruppenstunde Grün (Ausflug)' } }
		})
	);

	actionId = (
		await data<{ id: string }>(
			await api('/modules/actions/actions', {
				token: keys.admin,
				method: 'POST',
				json: {
					name: 'Herbstfahrt',
					description: 'Interne Planung',
					location: 'Harz',
					startsOn: '2026-10-23',
					startsTime: null,
					endsOn: '2026-10-25',
					endsTime: null
				}
			}),
			201
		)
	).id;
	// Anna ist (z. B. über ein Formular mit Konto) angemeldet
	await moduleDb('actions').transaction((tx) =>
		tx.execute(
			sql`INSERT INTO action_participants (id, action_id, name, user_id)
				VALUES (${crypto.randomUUID()}, ${actionId}, 'Anna Test', ${userIds.anna})`
		)
	);
});
afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Abos verwalten', () => {
	it('anlegen, eigene Liste, Link mit .ics und webcal, Grenze 10, fremd → 404', async () => {
		resetAllForTests();
		const feed = await newFeed('bert', { name: 'Familie', tags: ['Versammlung'] });
		expect(feed.url).toMatch(/\/api\/v1\/modules\/events\/public\/calendar\/[\w-]{43}\.ics$/);
		expect(feed.webcalUrl).toBe(feed.url!.replace(/^https?:/, 'webcal:'));
		expect(feed).toMatchObject({
			name: 'Familie',
			includeEvents: true,
			includeActions: true,
			tags: ['Versammlung'],
			lastUsedAt: null
		});
		const list = await data<CalendarFeedList>(await E('bert', '/calendar-feeds'));
		expect(list).toMatchObject({ actionsAvailable: true, max: 10 });
		expect(list.feeds.map((f) => f.id)).toEqual([feed.id]);
		expect((await data<CalendarFeedList>(await E('anna', '/calendar-feeds'))).feeds).toEqual([]);

		expect(
			await errCode(await E('anna', `/calendar-feeds/${feed.id}`, { method: 'DELETE' }), 404)
		).toBe('not_found');
		expect(
			await errCode(
				await E('anna', `/calendar-feeds/${feed.id}`, { method: 'PUT', json: { name: 'x' } }),
				404
			)
		).toBe('not_found');

		for (let i = 2; i <= 10; i++) await newFeed('bert', { name: `Abo ${i}` });
		expect(
			await errCode(
				await E('bert', '/calendar-feeds', { method: 'POST', json: { name: 'Elf' } }),
				409
			)
		).toBe('conflict');
	});
});

describe('Abruf durch die Kalender-App', () => {
	it('nur sichtbare Termine; Serie ohne Absage, mit Änderung; eigene Anmeldung als Aktion ohne Beschreibung', async () => {
		resetAllForTests();
		const feed = await newFeed('anna');
		const text = await ics(feed.url!);
		expect(summaries(text)).toEqual(
			expect.arrayContaining([
				'Stammesversammlung',
				'Gruppenstunde Grün',
				'Gruppenstunde Grün (Ausflug)',
				'Herbstfahrt'
			])
		);
		expect(text).not.toContain('Nur für Admin');
		// Serie: 05.10. und 19.10. (12.10. abgesagt), je eigene UID
		const uids = text.split('\r\n').filter((l) => l.startsWith('UID:'));
		expect(uids.filter((l) => l.includes('-2026-10-'))).toHaveLength(2);
		expect(text).not.toContain('20261012T170000');
		expect(text).toContain('DTSTART;TZID=Europe/Berlin:20261005T170000');
		// Aktion: ganztägig 23.–25.10., angemeldet, aber ohne Zugriff → keine Beschreibung, kein Link
		expect(text).toContain('DTSTART;VALUE=DATE:20261023');
		expect(text).toContain('DTEND;VALUE=DATE:20261026');
		expect(text).toContain('Angemeldet: Anna Test');
		expect(text).not.toContain('Interne Planung');
		expect(text).not.toContain('/modules/actions/');

		const list = await data<CalendarFeedList>(await E('anna', '/calendar-feeds'));
		expect(list.feeds.find((f) => f.id === feed.id)?.lastUsedAt).not.toBeNull();
		// Der geheime Link landet nicht im API-Protokoll (nur das Muster)
		const token = feed.url!.split('/').pop()!.replace('.ics', '');
		const logged = await getDb().select({ path: schema.apiLog.path }).from(schema.apiLog);
		expect(logged.some((l) => l.path.includes('/public/calendar/'))).toBe(true);
		expect(JSON.stringify(logged)).not.toContain(token);
	});

	it('Admin sieht alles inkl. Beschreibung und Link der Aktion; Filter Gruppe, Tag, ohne Aktionen', async () => {
		resetAllForTests();
		const all = await ics((await newFeed('admin')).url!);
		expect(all).toContain('Nur für Admin');
		expect(all).toContain('Interne Planung');
		expect(all).toContain(`/modules/actions/${actionId}`);

		const gruen = await ics(
			(await newFeed('admin', { name: 'Grün', groupIds: [groupGruen], includeActions: false })).url!
		);
		expect(new Set(summaries(gruen))).toEqual(
			new Set(['Gruppenstunde Grün', 'Gruppenstunde Grün (Ausflug)'])
		);
		const tagged = await ics(
			(await newFeed('admin', { name: 'Tag', tags: ['versammlung'], includeActions: false })).url!
		);
		expect(summaries(tagged)).toEqual(['Stammesversammlung']);
		const onlyActions = await ics(
			(await newFeed('admin', { name: 'Aktionen', includeEvents: false })).url!
		);
		expect(summaries(onlyActions)).toEqual(['Herbstfahrt']);
	});
});
