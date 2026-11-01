import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PW = 'correct-horse-battery';
const BASE = '/modules/members';

let admin: RequestContext;
let fullKey: string;

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

const call = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: fullKey, ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const memberBody = (over: Record<string, unknown> = {}) => ({
	firstName: 'Max',
	lastName: 'Muster',
	scoutName: null,
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [],
	emails: [{ name: null, value: 'max@example.test' }],
	stage: 'pfadfinder',
	groupIds: [],
	consentSocialMedia: false,
	consentWebsite: false,
	consentPrint: false,
	...over
});

interface MemberDto {
	id: string;
	firstName: string;
}
interface ListDto {
	items: MemberDto[];
	total: number;
}
interface IdsDto {
	items: { id: string; name: string }[];
	total: number;
	truncated: boolean;
}

const mk = async (over: Record<string, unknown>) =>
	(await data<MemberDto>(await call('/members', { method: 'POST', json: memberBody(over) }), 201))
		.id;
const mkGroup = async (name: string, leaderId: string) =>
	(
		await data<{ id: string }>(
			await call('/groups', {
				method: 'POST',
				json: { name, type: 'sippe', leaderIds: [leaderId] }
			}),
			201
		)
	).id;

/** Vornamen der Treffer (alphabetisch) für eine Filter-Query */
async function names(query: string): Promise<string[]> {
	const r = await data<ListDto>(await call(`/members?limit=200&${query}`));
	expect(r.total).toBe(r.items.length);
	return r.items.map((m) => m.firstName).sort();
}

let g1 = '';
let g2 = '';

beforeAll(async () => {
	await useTestDatabase();
	setTodayForTests('2026-10-21');
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin(ADMIN_EMAIL, ADMIN_PW);
	const [u] = await getDb().select().from(schema.user).where(eq(schema.user.email, ADMIN_EMAIL));
	const r = await contextForUser(u!.id);
	admin = r!.ctx;
	await enableModule(admin, 'members');
	admin = (await contextForUser(u!.id))!.ctx;
	fullKey = (
		await createApiKey(admin, { name: 'full', scopes: [...membersModule.manifest.permissions] })
	).key;

	// Leitung ohne Gruppe (36 J.), Anna 10 J., Ben 9 J., Cora 14 J., Dan 18 J.
	const leader = await mk({ firstName: 'Leiter', birthDate: '1990-01-01' });
	g1 = await mkGroup('Gruppe 1', leader);
	g2 = await mkGroup('Gruppe 2', leader);
	await mk({
		firstName: 'Anna',
		birthDate: '2016-10-21',
		stage: 'woelfling',
		groupIds: [g1],
		consentWebsite: true
	});
	await mk({
		firstName: 'Ben',
		birthDate: '2016-10-22',
		stage: 'woelfling',
		groupIds: [g1, g2]
	});
	await mk({
		firstName: 'Cora',
		birthDate: '2012-05-17',
		stage: 'jungpfadfinder',
		groupIds: [g2],
		emails: [],
		consentPrint: true
	});
	await mk({
		firstName: 'Dan',
		birthDate: '2008-01-01',
		stage: 'knappe',
		entryDate: '2020-03-01',
		secondaryMember: true,
		feeLevels: ['stamm']
	});
});

afterAll(() => setTodayForTests(null));

describe('Mitgliederliste: erweiterte Filter', () => {
	it('ohne Filter alle aktiven Mitglieder', async () => {
		expect(await names('')).toEqual(['Anna', 'Ben', 'Cora', 'Dan', 'Leiter']);
	});

	it('mehrere Stände (ODER) und alter Parameter `stage` addiert sich', async () => {
		expect(await names('stages=woelfling,knappe')).toEqual(['Anna', 'Ben', 'Dan']);
		expect(await names('stage=knappe&stages=woelfling')).toEqual(['Anna', 'Ben', 'Dan']);
		expect(await names('stage=jungpfadfinder')).toEqual(['Cora']);
	});

	it('mehrere Gruppen: mindestens eine, alle, ohne Gruppe', async () => {
		expect(await names(`groupIds=${g1},${g2}`)).toEqual(['Anna', 'Ben', 'Cora']);
		expect(await names(`groupIds=${g1},${g2}&groupMode=all`)).toEqual(['Ben']);
		expect(await names(`groupId=${g1}`)).toEqual(['Anna', 'Ben']);
		expect(await names('ungrouped=yes')).toEqual(['Dan', 'Leiter']);
		expect(await names(`groupIds=${g1}&ungrouped=yes`)).toEqual(['Anna', 'Ben', 'Dan', 'Leiter']);
	});

	it('Alter in Jahren an den Grenzen (heute 2026-10-21)', async () => {
		expect(await names('ageMin=10&ageMax=14')).toEqual(['Anna', 'Cora']);
		expect(await names('ageMax=9')).toEqual(['Ben']);
		expect(await names('ageMin=18')).toEqual(['Dan', 'Leiter']);
		expect(await names('ageMin=10&ageMax=10')).toEqual(['Anna']);
	});

	it('Einwilligungen, Zweitmitglied, E-Mail, Eintritt', async () => {
		expect(await names('consentWebsite=yes')).toEqual(['Anna']);
		expect(await names('consentPrint=yes')).toEqual(['Cora']);
		expect(await names('consentPrint=no')).toEqual(['Anna', 'Ben', 'Dan', 'Leiter']);
		expect(await names('secondary=yes')).toEqual(['Dan']);
		expect(await names('hasEmail=no')).toEqual(['Cora']);
		expect(await names('entryFrom=2020-01-01&entryTo=2020-12-31')).toEqual(['Dan']);
		expect(await names('entryFrom=2021-01-01')).toEqual([]);
	});

	it('Filter lassen sich kombinieren, Paginierung zählt alle Treffer', async () => {
		expect(await names(`groupIds=${g1},${g2}&stages=woelfling&ageMax=9`)).toEqual(['Ben']);
		const page = await data<ListDto>(await call(`/members?groupIds=${g1},${g2}&limit=1&offset=1`));
		expect(page.total).toBe(3);
		expect(page.items).toHaveLength(1);
	});

	it('ungültige Filter → 422', async () => {
		expect((await call('/members?stages=gibtsnicht')).status).toBe(422);
		expect((await call('/members?groupIds=keine-uuid')).status).toBe(422);
		expect((await call('/members?ageMin=121')).status).toBe(422);
		expect((await call('/members?entryFrom=2020-02-30')).status).toBe(422);
		expect((await call('/members?consentPrint=vielleicht')).status).toBe(422);
	});
});

describe('GET /members/ids (alle Treffer auswählen)', () => {
	it('liefert IDs und Namen aller Treffer, gleiche Zahl wie die Liste', async () => {
		const all = await data<IdsDto>(await call('/members/ids'));
		expect(all.total).toBe(5);
		expect(all.truncated).toBe(false);
		expect(all.items.map((m) => m.name)).toEqual([
			'Anna Muster',
			'Ben Muster',
			'Cora Muster',
			'Dan Muster',
			'Leiter Muster'
		]);
		const some = await data<IdsDto>(await call(`/members/ids?groupIds=${g1},${g2}&groupMode=all`));
		expect(some.total).toBe(1);
		expect(some.items[0]!.name).toBe('Ben Muster');
	});

	it('braucht members.member.view und prüft die Filter', async () => {
		const noView = (await createApiKey(admin, { name: 'ohne', scopes: ['members.group.view'] }))
			.key;
		expect((await api(`${BASE}/members/ids`, { token: noView })).status).toBe(403);
		expect((await call('/members/ids?stages=gibtsnicht')).status).toBe(422);
	});

	it('`/members/ids` wird nicht als Mitglieds-ID gelesen', async () => {
		const res = await call('/members/ids');
		expect(res.status).toBe(200);
	});
});

describe('Sammelaktionen mit vielen IDs', () => {
	it('akzeptiert mehr als 200 IDs (unbekannte → 404), lehnt über 2000 ab (422)', async () => {
		const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
		const bulk = (n: number) =>
			call('/members/bulk', {
				method: 'POST',
				json: { action: 'set-stage', stage: 'knappe', ids: ids(n) }
			});
		expect((await bulk(250)).status).toBe(404);
		expect((await bulk(2001)).status).toBe(422);
	});
});
