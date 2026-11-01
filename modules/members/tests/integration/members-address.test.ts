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
import { setSetting } from '$testing';
import { resetAllForTests } from '$testing';
import { setAddressFetchForTests } from '$modules/members/address.service';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const BASE = '/modules/members';
let admin: RequestContext;
let fullKey: string;
let viewKey: string;
let requested: URL[] = [];
let mode: 'ok' | 'error' | 'throw' = 'ok';

function api(path: string, token?: string, init: RequestInit & { json?: unknown } = {}) {
	const { json, ...rest } = init;
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
const get = (path: string, token = fullKey) => {
	resetAllForTests();
	return api(`${BASE}${path}`, token);
};

const PHOTON = {
	features: [
		{
			properties: {
				street: 'Rockwinkler Heerstraße',
				housenumber: '140',
				postcode: '28355',
				city: 'Bremen',
				countrycode: 'DE'
			}
		},
		{
			properties: {
				street: 'Rockwinkler Heerstraße',
				housenumber: '140',
				postcode: '28355',
				city: 'Bremen',
				countrycode: 'DE'
			}
		},
		{ properties: { name: 'Bremen', osm_key: 'place', postcode: '28195' } },
		{
			properties: {
				name: 'Rockwinkler Landstraße',
				osm_key: 'highway',
				postcode: '28355',
				city: 'Bremen',
				countrycode: 'DE'
			}
		}
	]
};

/** OpenPLZ-Antwort: nur für „Schwachh…“ Treffer, sonst leer (→ Photon als Ersatz) */
const STREETS = [
	{ name: 'Schwachhausen', postalCode: '27257', locality: 'Affinghausen' },
	{ name: 'Schwachhauser Heerstr.', postalCode: '28203', locality: 'Bremen' },
	{ name: 'Schwachhauser Heerstr.', postalCode: '28203', locality: 'Bremen' },
	{ name: 'Schwachhauser Heerstr.', postalCode: '28209', locality: 'Bremen' }
];
function openPlzFor(url: URL) {
	const name = (url.searchParams.get('name') ?? '').toLowerCase();
	if (!name.startsWith('schwachh')) return [];
	const plz = url.searchParams.get('postalCode');
	return STREETS.filter((s) => !plz || s.postalCode.startsWith(plz));
}
const photonRequests = () => requested.filter((u) => u.pathname === '/api/');
const openPlzRequests = () => requested.filter((u) => u.pathname.includes('/de/Streets'));

beforeAll(async () => {
	setAddressFetchForTests(async (input) => {
		const url = new URL(String(input));
		requested.push(url);
		if (mode === 'throw') throw new Error('Netz weg');
		if (mode === 'error') return new Response('x', { status: 502 });
		const body = url.pathname.includes('/de/Streets') ? openPlzFor(url) : PHOTON;
		return new Response(JSON.stringify(body), {
			headers: { 'content-type': 'application/json' }
		});
	});
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	const ctxOf = async () => (await contextForUser(u!.id))!.ctx;
	admin = await ctxOf();
	await enableModule(admin, 'members');
	admin = await ctxOf();
	fullKey = (
		await createApiKey(admin, { name: 'full', scopes: [...membersModule.manifest.permissions] })
	).key;
	viewKey = (await createApiKey(admin, { name: 'v', scopes: ['members.member.view'] })).key;
});
afterAll(() => setAddressFetchForTests(undefined));

describe('Adress-Autovervollständigung', () => {
	it('liefert dedupe, gefilterte Vorschläge und fragt Photon korrekt ab', async () => {
		requested = [];
		const res = await get(`/address/suggest?q=${encodeURIComponent('Rockwinkler Heerstr 140')}`);
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as {
			data: {
				items: { label: string; street: string; postalCode: string }[];
				unavailable: boolean;
			};
		};
		expect(data.unavailable).toBe(false);
		expect(data.items.map((i) => i.label)).toEqual([
			'Rockwinkler Heerstraße 140, 28355 Bremen',
			'Rockwinkler Landstraße, 28355 Bremen'
		]);
		// Straßenverzeichnis zuerst (leer) → Photon als Ersatz
		expect(openPlzRequests()[0]!.origin).toBe('https://openplzapi.org');
		const u = photonRequests()[0]!;
		expect(u.origin).toBe('https://photon.komoot.io');
		expect(u.pathname).toBe('/api/');
		expect(u.searchParams.get('q')).toBe('Rockwinkler Heerstr 140');
		expect(u.searchParams.get('lang')).toBe('de');
	});

	it('Dienstfehler und Timeouts → unavailable, kein Fehlerstatus', async () => {
		for (const m of ['error', 'throw'] as const) {
			mode = m;
			const res = await get('/address/suggest?q=Musterweg');
			expect(res.status).toBe(200);
			expect(((await res.json()) as { data: unknown }).data).toEqual({
				items: [],
				unavailable: true
			});
		}
		mode = 'ok';
	});

	it('leere Einstellungen schalten die Dienste ab (keine Anfrage)', async () => {
		await setSetting(admin, 'members.address.photonUrl', '');
		await setSetting(admin, 'members.address.openPlzUrl', '');
		requested = [];
		const res = await get('/address/suggest?q=Musterweg');
		expect(((await res.json()) as { data: { unavailable: boolean } }).data.unavailable).toBe(true);
		expect(requested).toHaveLength(0);
		await setSetting(admin, 'members.address.photonUrl', 'https://photon.example.test');
		await get('/address/suggest?q=Musterweg');
		expect(requested[0]!.origin).toBe('https://photon.example.test');
		await setSetting(admin, 'members.address.photonUrl', 'https://photon.komoot.io');
		await setSetting(admin, 'members.address.openPlzUrl', 'https://openplzapi.org');
	});

	it('Straßenverzeichnis: Region der PLZ zuerst, Hausnummer übernommen, ohne Photon', async () => {
		requested = [];
		const res = await get(
			`/address/suggest?q=${encodeURIComponent('Schwachh 12a')}&postalCode=28&country=DE`
		);
		const { data } = (await res.json()) as {
			data: { items: { label: string; street: string; source: string }[]; unavailable: boolean };
		};
		expect(data.unavailable).toBe(false);
		expect(data.items.map((i) => i.label)).toEqual([
			'Schwachhauser Heerstr. 12a, 28203 Bremen',
			'Schwachhauser Heerstr. 12a, 28209 Bremen',
			'Schwachhausen 12a, 27257 Affinghausen'
		]);
		expect(data.items[0]!.source).toBe('directory');
		const regional = openPlzRequests().find((u) => u.searchParams.get('postalCode') === '28');
		expect(regional?.searchParams.get('name')).toBe('Schwachh');
		expect(photonRequests()).toHaveLength(0);
	});

	it('Weitertippen (auch „straße“ statt „Str.“) filtert aus dem Zwischenspeicher', async () => {
		requested = [];
		const res = await get(
			`/address/suggest?q=${encodeURIComponent('Schwachhauser Heerstraße 5')}&postalCode=28`
		);
		const { data } = (await res.json()) as { data: { items: { label: string }[] } };
		expect(data.items[0]!.label).toBe('Schwachhauser Heerstr. 5, 28203 Bremen');
		expect(data.items.some((i) => i.label.includes('Affinghausen'))).toBe(false);
		// „schwachh“ war vollständig geladen → keine neue Anfrage
		expect(requested).toHaveLength(0);
	});

	it('Zwischenspeicher: gleiche Anfrage fragt die Dienste nicht erneut', async () => {
		await get('/address/suggest?q=Schwachhauser&postalCode=28203');
		requested = [];
		const res = await get('/address/suggest?q=Schwachhauser&postalCode=28209');
		expect(res.status).toBe(200);
		expect(requested).toHaveLength(0);
	});

	it('Ausland: kein Straßenverzeichnis, nur Photon', async () => {
		requested = [];
		await get('/address/suggest?q=Schwachhauser&country=AT');
		expect(openPlzRequests()).toHaveLength(0);
		expect(photonRequests()).toHaveLength(1);
	});

	it('validiert Suchtext (≥ 3 Zeichen) und braucht das Bearbeiten-Recht', async () => {
		expect((await get('/address/suggest?q=ab')).status).toBe(422);
		expect((await get('/address/suggest')).status).toBe(422);
		expect((await get('/address/suggest?q=Musterweg', viewKey)).status).toBe(403);
		resetAllForTests();
		expect((await api(`${BASE}/address/suggest?q=Musterweg`)).status).toBe(401);
	});

	it('PLZ → Orte aus der mitgelieferten Liste', async () => {
		const res = await get('/address/places?postalCode=28207');
		expect(((await res.json()) as { data: { items: string[] } }).data.items).toContain('Bremen');
		const none = await get('/address/places?postalCode=00000');
		expect(((await none.json()) as { data: { items: string[] } }).data.items).toEqual([]);
		expect((await get('/address/places?postalCode=2820')).status).toBe(422);
		expect((await get('/address/places?postalCode=28207', viewKey)).status).toBe(403);
	});
});

describe('Anschrift am Mitglied', () => {
	const body = (over: Record<string, unknown> = {}) => ({
		firstName: 'Max',
		lastName: 'Muster',
		birthDate: '2012-05-17',
		street: 'Musterweg 1',
		postalCode: '28357',
		city: 'Bremen',
		stage: 'pfadfinder',
		...over
	});

	it('speichert Straße, PLZ, Ort, Land (Standard DE) und liefert sie zurück', async () => {
		resetAllForTests();
		const res = await api(`${BASE}/members`, fullKey, { method: 'POST', json: body() });
		expect(res.status).toBe(201);
		const m = ((await res.json()) as { data: Record<string, unknown> }).data;
		expect(m).toMatchObject({
			street: 'Musterweg 1',
			postalCode: '28357',
			city: 'Bremen',
			country: 'DE'
		});
		expect(m).not.toHaveProperty('address');
		resetAllForTests();
		const upd = await api(`${BASE}/members/${m.id}`, fullKey, {
			method: 'PUT',
			json: body({ country: 'AT', postalCode: '1010', city: 'Wien', groupIds: [] })
		});
		expect(upd.status).toBe(200);
		const u = ((await upd.json()) as { data: Record<string, unknown> }).data;
		expect(u).toMatchObject({ country: 'AT', postalCode: '1010', city: 'Wien' });
	});

	it('Vorschläge enthalten vorhandene Mitglieder-Anschriften zuerst', async () => {
		resetAllForTests();
		await api(`${BASE}/members`, fullKey, {
			method: 'POST',
			json: body({ firstName: 'Lia', street: 'Schwachhauser Heerstr. 7', postalCode: '28209' })
		});
		const res = await get(`/address/suggest?q=${encodeURIComponent('Schwachhauser H')}`);
		const { data } = (await res.json()) as {
			data: { items: { label: string; source: string }[] };
		};
		expect(data.items[0]).toEqual(
			expect.objectContaining({
				label: 'Schwachhauser Heerstr. 7, 28209 Bremen',
				source: 'members'
			})
		);
		expect(data.items.some((i) => i.source === 'directory')).toBe(true);
	});

	it('lehnt ungültige Anschriften ab (422)', async () => {
		for (const bad of [{ postalCode: '123' }, { city: '' }, { street: '' }, { country: 'XXX' }]) {
			resetAllForTests();
			const res = await api(`${BASE}/members`, fullKey, { method: 'POST', json: body(bad) });
			expect(res.status, JSON.stringify(bad)).toBe(422);
		}
	});
});
