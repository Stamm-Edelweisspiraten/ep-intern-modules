/**
 * Website- und Meta-Endpunkte von `events` mit Gruppen aus `members` (Teil des früheren
 * `events/tests/integration/events-website.test.ts`, der Rest liegt in `atrium-basic-modules` und läuft dort ohne
 * `members`): Gruppennamen/`groupIds`, Filter `group=<id>` inkl. Serienvorkommen, Serien-Detail mit Gruppe,
 * Principal-Suche nach Gruppen, `/groups` mit und ohne `members`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { core } from '$testing';
import eventsModule from '$modules/events/module';
import membersModule from '$modules/members/module';
import { todayBerlin } from '$modules/events/website.endpoints';
import { DEFAULT_STAMM_NAME } from '$modules/events/schemas';
import { websiteEventSchema } from '$modules/events/website.schemas';
import type { RequestContext } from '$lib/sdk/types';

const BASE = 'http://localhost:5173/api/v1/modules/events';
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

let admin: RequestContext;
let adminKey: string;
let websiteKey: string;
let editorKey: string;

async function get(path: string, key: string) {
	return send('GET', path, key);
}

async function send(method: string, path: string, key: string, json?: unknown) {
	resetAllForTests();
	const url = new URL(`${BASE}${path}`);
	const headers = new Headers({ authorization: `Bearer ${key}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
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

function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

interface Seed {
	title: string;
	startsOn: string;
	startsAt?: string | null;
	endsOn?: string | null;
	onWebsite: boolean;
	tags?: string[];
	groups?: string[];
}

async function insertEvent(e: Seed): Promise<string> {
	const id = crypto.randomUUID();
	await core.database.forModule('events').transaction(async (tx) => {
		await tx.execute(sql`
			INSERT INTO events (id, title, description, location, color, starts_on, starts_at, ends_on,
				ends_at, on_website, owner_id, created_by)
			VALUES (${id}, ${e.title}, 'Beschreibung', 'Heim', '#2563eb', ${e.startsOn}::date,
				${e.startsAt ?? null}, ${e.endsOn ?? null}::date, null, ${e.onWebsite}, 'owner-1', 'owner-1')
		`);
		for (const [i, tag] of (e.tags ?? []).entries()) {
			await tx.execute(
				sql`INSERT INTO event_tags (event_id, tag, position) VALUES (${id}, ${tag}, ${i})`
			);
		}
		for (const g of e.groups ?? []) {
			await tx.execute(sql`INSERT INTO event_groups (event_id, group_id) VALUES (${id}, ${g})`);
		}
		await tx.execute(
			sql`INSERT INTO event_shares (event_id, principal_type, principal_id, level)
				VALUES (${id}, 'everyone', '*', 'read')`
		);
	});
	return id;
}

const today = todayBerlin();
let groupId: string;

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'events');
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'admin', scopes: ['events.event.view'] })).key;
	editorKey = (
		await createApiKey(admin, {
			name: 'editor',
			scopes: [
				'events.event.view',
				'events.event.create',
				'events.event.edit-all',
				'events.event.publish'
			]
		})
	).key;

	const roleId = await createRole(admin, {
		name: 'Website',
		permissions: ['events.website.read', 'core.api.manage']
	});
	const webUserId = await createUser(admin, {
		name: 'Website',
		email: 'website@example.test',
		password: 'correct-horse-battery-2',
		roleIds: [roleId]
	});
	const web = await ctxOf(webUserId);
	websiteKey = (await createApiKey(web, { name: 'web', scopes: ['events.website.read'] })).key;

	groupId = crypto.randomUUID();
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO groups (id, name, type) VALUES (${groupId}, 'Sippe Falke', 'sippe')`
		);
	});
});

describe('GET /website/events', () => {
	let future: string;
	let running: string;
	let later: string;

	beforeAll(async () => {
		later = await insertEvent({
			title: 'Sommerlager',
			startsOn: addDays(today, 30),
			endsOn: addDays(today, 37),
			onWebsite: true,
			tags: ['Lager', 'Sommer'],
			groups: ['stamm', groupId]
		});
		future = await insertEvent({
			title: 'Gruppenstunde',
			startsOn: addDays(today, 3),
			startsAt: '17:00',
			onWebsite: true,
			tags: ['Gruppenstunde'],
			groups: [groupId]
		});
		running = await insertEvent({
			title: 'Laufende Fahrt',
			startsOn: addDays(today, -2),
			endsOn: addDays(today, 1),
			onWebsite: true
		});
		await insertEvent({ title: 'Vorbei', startsOn: addDays(today, -10), onWebsite: true });
		await insertEvent({ title: 'Intern', startsOn: addDays(today, 5), onWebsite: false });
	});

	it('liefert nur Website-Termine ab heute, sortiert, nur öffentliche Felder', async () => {
		const { status, body } = await get('/website/events', websiteKey);
		expect(status, JSON.stringify(body)).toBe(200);
		// Vertrag (#48): strikt gegen das exportierte Website-Schema
		websiteEventSchema.array().parse(body.data);
		const items = body.data as Record<string, unknown>[];
		expect(items.map((e) => e.id)).toEqual([running, future, later]);
		for (const item of items) {
			expect(Object.keys(item).sort()).toEqual(
				[
					'color',
					'description',
					'endsOn',
					'endsTime',
					'groupIds',
					'groups',
					'id',
					'location',
					'occurrenceDate',
					'recurring',
					'startsOn',
					'startsTime',
					'tags',
					'title'
				].sort()
			);
		}
		const summer = items[2]!;
		expect(summer.tags).toEqual(['Lager', 'Sommer']);
		expect(summer.groups).toEqual([DEFAULT_STAMM_NAME, 'Sippe Falke']);
		expect(summer.groupIds).toEqual(['stamm', groupId]);
		expect(items[0]!.groupIds).toEqual([]);
		expect(summer.endsOn).toBe(addDays(today, 37));
		expect(items[1]!.startsTime).toBe('17:00');
		expect(items[1]!.endsOn).toBeNull();
	});
});

describe('Website: Gruppenfilter und Detail', () => {
	let weekly: string;
	let past: string;
	let single: string;

	/** Termin über die API anlegen (Serien, Ausnahmen wie im echten Betrieb) */
	async function create(over: Record<string, unknown>): Promise<string> {
		const res = await send('POST', '/events', editorKey, {
			title: 'Termin',
			description: null,
			location: 'Heim',
			color: null,
			startsOn: today,
			startsTime: null,
			endsOn: null,
			endsTime: null,
			tags: [],
			groupIds: [],
			shares: [],
			onWebsite: true,
			recurrence: null,
			...over
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.data.id as string;
	}

	beforeAll(async () => {
		// wöchentlich, offen, Start vor zwei Wochen am heutigen Wochentag → heute ist ein Vorkommen
		weekly = await create({
			title: 'Gruppenstunde Falke',
			startsOn: addDays(today, -14),
			startsTime: '16:30',
			endsOn: addDays(today, -14),
			endsTime: '18:00',
			groupIds: [groupId],
			recurrence: { freq: 'weekly', interval: 1, end: { type: 'never' } }
		});
		// abgeschlossene Serie in der Vergangenheit (3 Vorkommen im Wochenabstand)
		past = await create({
			title: 'Vergangene Reihe',
			startsOn: addDays(today, -60),
			recurrence: { freq: 'weekly', interval: 1, end: { type: 'count', count: 3 } }
		});
		single = await create({
			title: 'Stammesversammlung',
			startsOn: addDays(today, 9),
			groupIds: ['stamm']
		});
		await create({ title: 'Nur intern', startsOn: addDays(today, 9), onWebsite: false });
	});

	it('group=<id> liefert nur Termine dieser Gruppe (inkl. Serienvorkommen)', async () => {
		const { status, body } = await get(
			`/website/events?group=${groupId}&to=${addDays(today, 40)}`,
			websiteKey
		);
		expect(status, JSON.stringify(body)).toBe(200);
		const items = body.data as { id: string; groupIds: string[]; groups: string[] }[];
		expect(items.length).toBeGreaterThan(3);
		for (const item of items) expect(item.groupIds).toContain(groupId);
		const ids = new Set(items.map((i) => i.id));
		expect(ids.has(weekly)).toBe(true);
		expect(ids.has(single)).toBe(false);
		const occ = items.find((i) => i.id === weekly)!;
		expect(occ.groupIds).toEqual([groupId]);
		expect(occ.groups).toEqual(['Sippe Falke']);
	});

	it('Detail einer Serie: ohne occurrence nächstes Vorkommen ab heute, sonst das letzte', async () => {
		const next = await get(`/website/events/${weekly}`, websiteKey);
		expect(next.status, JSON.stringify(next.body)).toBe(200);
		expect(next.body.data).toMatchObject({
			id: weekly,
			recurring: true,
			occurrenceDate: today,
			startsOn: today,
			startsTime: '16:30',
			endsTime: '18:00',
			groupIds: [groupId]
		});

		const last = await get(`/website/events/${past}`, websiteKey);
		expect(last.status).toBe(200);
		expect(last.body.data).toMatchObject({
			recurring: true,
			occurrenceDate: addDays(today, -46),
			startsOn: addDays(today, -46)
		});
	});
});

describe('Meta-Endpoints', () => {
	it('GET /principals sucht Stamm und Gruppen', async () => {
		const { status, body } = await get('/principals?search=Falke', adminKey);
		expect(status, JSON.stringify(body)).toBe(200);
		expect(body.data).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: 'group', id: groupId })])
		);
		const short = await get('/principals?search=a', adminKey);
		expect(short.status).toBe(422);
	});

	it('GET /groups: Stamm zuerst, mit members-Gruppen; ohne members nur Stamm', async () => {
		const on = await get('/groups', adminKey);
		expect(on.status).toBe(200);
		expect(on.body.data).toEqual([
			{
				id: 'stamm',
				name: DEFAULT_STAMM_NAME,
				color: null,
				meetingWeekday: null,
				meetingTime: null,
				meetingEndTime: null,
				meetingPlace: null
			},
			{
				id: groupId,
				name: 'Sippe Falke',
				color: null,
				meetingWeekday: null,
				meetingTime: null,
				meetingEndTime: null,
				meetingPlace: null
			}
		]);

		await disableModule(admin, 'members');
		const off = await get('/groups', adminKey);
		expect(off.body.data).toEqual([
			{
				id: 'stamm',
				name: DEFAULT_STAMM_NAME,
				color: null,
				meetingWeekday: null,
				meetingTime: null,
				meetingEndTime: null,
				meetingPlace: null
			}
		]);
		// Website ohne members: Gruppennamen nur noch Stamm
		const web = await get('/website/events?tag=lager', websiteKey);
		expect(web.body.data[0].groups).toEqual([DEFAULT_STAMM_NAME]);
		await enableModule(admin, 'members');
	});
});
