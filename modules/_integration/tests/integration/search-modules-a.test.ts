/**
 * Globale Suche: Suchquellen der Module members, actions, events, galleries.
 * Treffer nur mit Recht und nur für sichtbare Objekte; LIKE-Platzhalter wörtlich; keine sensiblen Felder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { searchEverything } from '$testing';
import type { RequestContext } from '$lib/sdk/types';
import type { SearchHit } from '$lib/sdk/types/search';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';

let close: () => Promise<void>;
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};

function call(who: string, method: string, path: string, json?: unknown) {
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`http://localhost:5173/api/v1/modules${path}`);
	return handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
}

async function created(who: string, path: string, json: unknown): Promise<string> {
	const res = await call(who, 'POST', path, json);
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.data.id as string;
}

async function ctxOf(userId: string): Promise<RequestContext> {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function hits(userId: string, q: string, source?: string): Promise<SearchHit[]> {
	const res = await searchEverything(await ctxOf(userId), q, { limitPerSource: 10 });
	return res.groups.filter((g) => !source || g.source === source).flatMap((g) => g.hits);
}

const isoDay = (offset: number) => {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + offset);
	return d.toISOString().slice(0, 10);
};

const member = (over: Record<string, unknown>) => ({
	firstName: 'Max',
	lastName: 'Muster',
	scoutName: null,
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [{ name: null, value: '0123 456' }],
	emails: [{ name: null, value: 'max@example.test' }],
	stage: 'pfadfinder',
	groupIds: [],
	consentSocialMedia: false,
	consentWebsite: false,
	consentPrint: false,
	...over
});

const action = (over: Record<string, unknown>) => ({
	name: 'Aktion',
	description: null,
	location: 'Cuxhaven',
	startsOn: isoDay(30),
	startsTime: null,
	endsOn: null,
	endsTime: null,
	...over
});

const event = (over: Record<string, unknown>) => ({
	title: 'Termin',
	description: null,
	location: 'Heim',
	startsOn: isoDay(10),
	startsTime: '17:00',
	endsOn: null,
	endsTime: null,
	tags: [],
	groupIds: [],
	shares: [],
	onWebsite: false,
	...over
});

const gallery = (over: Record<string, unknown>) => ({
	title: 'Galerie',
	description: null,
	visibility: 'private',
	shares: [],
	...over
});

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(eventsModule);
	registerModule(galleriesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	ids.admin = u!.id;
	let admin = await ctxOf(ids.admin);
	for (const m of ['members', 'actions', 'events', 'galleries']) await enableModule(admin, m);
	admin = await ctxOf(ids.admin);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: ['members.member.edit', 'members.member.view', 'members.group.edit']
		})
	).key;

	// Rolle ohne Gruppen-Recht, ohne view-all
	const roleId = await createRole(admin, {
		name: 'planer',
		permissions: [
			'core.api.manage',
			'members.member.view',
			'actions.action.view',
			'actions.action.create',
			'events.event.view',
			'events.event.create',
			'galleries.gallery.view',
			'galleries.gallery.create',
			'galleries.gallery.publish'
		]
	});
	for (const who of ['alice', 'bob']) {
		ids[who] = await createUser(admin, {
			name: who === 'alice' ? 'Alice Test' : 'Bob Test',
			email: `${who}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		keys[who] = (
			await createApiKey(await ctxOf(ids[who]!), {
				name: who,
				scopes: [
					'actions.action.view',
					'actions.action.create',
					'events.event.view',
					'events.event.create',
					'galleries.gallery.view',
					'galleries.gallery.create',
					'galleries.gallery.publish'
				]
			})
		).key;
	}

	// Mitglieder + Gruppe
	const leader = await created(
		'admin',
		'/members/members',
		member({ firstName: 'Gustav', lastName: 'Leiter' })
	);
	ids.group = await created('admin', '/members/groups', {
		name: 'Sippe Zeltfalken',
		type: 'sippe',
		leaderIds: [leader]
	});
	ids.leader = await created(
		'admin',
		'/members/members',
		member({ firstName: 'Lena', lastName: 'Zeltlager', scoutName: 'Eule', groupIds: [ids.group] })
	);
	ids.left = await created(
		'admin',
		'/members/members',
		member({
			firstName: 'Paul',
			lastName: 'Zeltlager',
			exitDate: '2020-01-01',
			entryDate: '2015-01-01'
		})
	);
	ids.pct = await created(
		'admin',
		'/members/members',
		member({ firstName: '100%', lastName: 'Prozent' })
	);
	ids.plain = await created(
		'admin',
		'/members/members',
		member({ firstName: '1000', lastName: 'Prozent' })
	);

	// Aktionen: Alice eigene, Bob fremde (nicht freigegebene) + freigegebene
	ids.actionOwn = await created('alice', '/actions/actions', action({ name: 'Zeltlager Nord' }));
	ids.actionForeign = await created(
		'bob',
		'/actions/actions',
		action({ name: 'Zeltlager Geheim' })
	);
	ids.actionShared = await created(
		'bob',
		'/actions/actions',
		action({ name: 'Zeltlager Geteilt', startsOn: isoDay(-60), location: 'Harz' })
	);
	const share = await call(
		'bob',
		'PUT',
		`/actions/actions/${ids.actionShared}/shares/${ids.alice}`,
		{
			level: 'read'
		}
	);
	expect(share.status).toBe(200);

	// Termine
	ids.eventOwn = await created(
		'alice',
		'/events/events',
		event({ title: 'Zeltaufbau', tags: ['Material'] })
	);
	ids.eventPast = await created(
		'alice',
		'/events/events',
		event({ title: 'Zeltabbau', startsOn: isoDay(-20), tags: ['Material'] })
	);
	ids.eventForeign = await created('bob', '/events/events', event({ title: 'Zeltgeheimnis' }));
	ids.eventShared = await created(
		'bob',
		'/events/events',
		event({ title: 'Zeltfest', shares: [{ type: 'user', id: ids.alice, level: 'read' }] })
	);

	// Galerien
	ids.galOwn = await created(
		'alice',
		'/galleries/galleries',
		gallery({ title: 'Zeltbilder Alice' })
	);
	ids.galForeign = await created(
		'bob',
		'/galleries/galleries',
		gallery({ title: 'Zeltbilder privat' })
	);
	ids.galPublic = await created(
		'bob',
		'/galleries/galleries',
		gallery({
			title: 'Öffentlich',
			description: 'Zeltbilder für alle',
			visibility: 'public',
			consentConfirmed: true
		})
	);
});

afterAll(async () => {
	await close?.();
});

describe('members', () => {
	it('findet Mitglieder (aktive zuerst, Ausgetretene mit Hinweis) ohne sensible Felder', async () => {
		const found = await hits(ids.admin!, 'Zeltlager', 'members');
		const people = found.filter((h) => h.type === 'Mitglied');
		expect(people.map((h) => h.title)).toEqual(['Lena Zeltlager (Eule)', 'Paul Zeltlager']);
		expect(people[0]!.subtitle).toContain('Sippe Zeltfalken');
		expect(people[0]!.subtitle).toContain('Pfadfinder');
		expect(people[1]!.subtitle).toContain('ausgetreten');
		expect(people[0]!.href).toBe(`/modules/members?open=${ids.leader}`);
		expect(people[1]!.href).toContain('status=all');
		const text = JSON.stringify(people);
		expect(text).not.toContain('2012');
		expect(text).not.toContain('17.05');
		expect(text).not.toContain('@example.test');
		expect(text).not.toContain('0123');
	});

	it('findet Gruppen nur mit members.group.view', async () => {
		const admin = await hits(ids.admin!, 'Zeltfalken', 'members');
		expect(admin.map((h) => [h.type, h.title])).toContainEqual(['Gruppe', 'Sippe Zeltfalken']);
		expect(admin.find((h) => h.type === 'Gruppe')!.href).toBe(
			`/modules/members/groups?open=${ids.group}`
		);
		const alice = await hits(ids.alice!, 'Zelt', 'members');
		expect(alice.some((h) => h.type === 'Gruppe')).toBe(false);
		expect(alice.some((h) => h.type === 'Mitglied')).toBe(true);
	});

	it('nimmt % und _ wörtlich', async () => {
		const pct = await hits(ids.admin!, '0%', 'members');
		expect(pct.map((h) => h.title)).toEqual(['100% Prozent']);
		const underscore = await hits(ids.admin!, 'Zelt_ager', 'members');
		expect(underscore).toEqual([]);
	});
});

describe('actions', () => {
	it('liefert eigene und freigegebene Aktionen, keine fremden', async () => {
		const found = await hits(ids.alice!, 'Zeltlager', 'actions');
		expect(found.map((h) => h.id).sort()).toEqual([ids.actionOwn, ids.actionShared].sort());
		// kommende vor vergangenen
		expect(found[0]!.id).toBe(ids.actionOwn);
		expect(found[0]!.href).toBe(`/modules/actions/${ids.actionOwn}`);
		expect(found[0]!.type).toBe('Aktion');
		const [y, m, d] = isoDay(30).split('-');
		expect(found[0]!.subtitle).toBe(`${d}.${m}.${y} · Cuxhaven`);
		const admin = await hits(ids.admin!, 'Zeltlager', 'actions');
		expect(admin.map((h) => h.id)).toContain(ids.actionForeign);
	});

	it('Ort ist durchsuchbar, Platzhalter wörtlich', async () => {
		expect((await hits(ids.alice!, 'Harz', 'actions')).map((h) => h.id)).toEqual([
			ids.actionShared
		]);
		expect(await hits(ids.alice!, 'Zelt%Nord', 'actions')).toEqual([]);
	});
});

describe('events', () => {
	it('liefert nur sichtbare Termine, kommende zuerst, Tags durchsuchbar', async () => {
		const found = await hits(ids.alice!, 'Zelt', 'events');
		expect(found.map((h) => h.id)).toEqual([ids.eventOwn, ids.eventShared, ids.eventPast]);
		expect(found.map((h) => h.id)).not.toContain(ids.eventForeign);
		const first = found[0]!;
		expect(first.type).toBe('Termin');
		expect(first.subtitle).toContain('17:00');
		expect(first.subtitle).toContain('Heim');
		expect(first.href).toBe(
			`/modules/events?month=${isoDay(10).slice(0, 7)}&event=${ids.eventOwn}`
		);
		const byTag = await hits(ids.alice!, 'Material', 'events');
		expect(byTag.map((h) => h.id)).toEqual([ids.eventOwn, ids.eventPast]);
	});

	it('Platzhalter wirken wörtlich', async () => {
		expect(await hits(ids.alice!, 'Zelt_ufbau', 'events')).toEqual([]);
	});
});

describe('galleries', () => {
	it('liefert eigene und öffentliche Galerien, keine fremden privaten', async () => {
		const found = await hits(ids.alice!, 'Zeltbilder', 'galleries');
		expect(found.map((h) => h.id).sort()).toEqual([ids.galOwn, ids.galPublic].sort());
		const own = found.find((h) => h.id === ids.galOwn)!;
		expect(own.href).toBe(`/modules/galleries/${ids.galOwn}`);
		expect(own.subtitle).toBe('0 Bilder');
		expect(own.type).toBe('Galerie');
	});

	it('Modul deaktiviert → keine Treffer', async () => {
		await disableModule(await ctxOf(ids.admin!), 'galleries');
		expect(await hits(ids.alice!, 'Zeltbilder', 'galleries')).toEqual([]);
		expect(await hits(ids.admin!, 'Zeltbilder', 'galleries')).toEqual([]);
	});
});

describe('ohne Rechte', () => {
	it('Benutzer*in ohne Modulrechte bekommt keine Modultreffer', async () => {
		const admin = await ctxOf(ids.admin!);
		const roleId = await createRole(admin, { name: 'leer', permissions: [] });
		const nobody = await createUser(admin, {
			name: 'Niemand',
			email: 'nobody@example.test',
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const res = await searchEverything(await ctxOf(nobody), 'Zelt');
		expect(res.groups).toEqual([]);
	});
});
