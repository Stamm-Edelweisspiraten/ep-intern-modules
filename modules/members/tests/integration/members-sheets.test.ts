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
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { setPdfRendererForTests } from '$testing';
import membersModule from '$modules/members/module';
import type { MembersService } from '$modules/members/contract';
import type { RequestContext } from '$lib/sdk/types';

const BASE = '/modules/members';
const service = membersModule.provides as unknown as MembersService;
let admin: RequestContext;
let fullKey: string;
let viewKey: string; // member.view + group.view, aber ohne data.export
let exportOnlyKey: string; // data.export ohne member.view
let html = '';

function api(path: string, token: string, init: RequestInit & { json?: unknown } = {}) {
	resetAllForTests();
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${BASE}${path}`);
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
const post = (path: string, token: string, json: unknown) =>
	api(path, token, { method: 'POST', json });

const memberBody = (over: Record<string, unknown> = {}) => ({
	firstName: 'Max',
	lastName: 'Muster',
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '28357',
	city: 'Bremen',
	stage: 'pfadfinder',
	...over
});
const createMember = async (over: Record<string, unknown> = {}) =>
	(
		await data<{ id: string }>(
			await api('/members', fullKey, { method: 'POST', json: memberBody(over) }),
			201
		)
	).id;

let leader: string;
let groupA: string;
let groupB: string;
let anna: string;
let ben: string;

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);
	fullKey = (
		await createApiKey(admin, { name: 'full', scopes: [...membersModule.manifest.permissions] })
	).key;
	viewKey = (
		await createApiKey(admin, {
			name: 'view',
			scopes: ['members.member.view', 'members.group.view']
		})
	).key;
	exportOnlyKey = (await createApiKey(admin, { name: 'exp', scopes: ['members.data.export'] })).key;
	setPdfRendererForTests(async (h) => {
		html = h;
		return new TextEncoder().encode('%PDF-fake');
	});

	leader = await createMember({ firstName: 'Lea', lastName: 'Leitung' });
	const mkGroup = async (name: string) =>
		(
			await data<{ id: string }>(
				await api('/groups', fullKey, {
					method: 'POST',
					json: { name, type: 'sippe', leaderIds: [leader], color: '#16a34a' }
				}),
				201
			)
		).id;
	groupA = await mkGroup('Sippe Falke');
	groupB = await mkGroup('Sippe Adler');
	anna = await createMember({
		firstName: 'Anna',
		lastName: 'Allergisch',
		groupIds: [groupA, groupB],
		phones: [{ name: 'Mutter', value: '+49 170 1234567' }],
		emails: [{ name: null, value: 'anna.eltern@example.test' }],
		custom: { allergien: 'Haselnuss-Allergie', medikamente: 'Notfallspray' }
	});
	ben = await createMember({ firstName: 'Ben', lastName: 'Bunt', groupIds: [groupB] });
	await createMember({
		firstName: 'Egon',
		lastName: 'Weg',
		groupIds: [groupA],
		exitDate: '2020-01-01'
	});
});

afterAll(() => setPdfRendererForTests(undefined));

describe('GET /members/sheet-columns', () => {
	it('liefert Katalog (Basisspalten + Zusatzfelder) und Voreinstellungen, braucht data.export', async () => {
		const cat = await data<{
			columns: { key: string; group: string; sensitive?: boolean }[];
			presets: { id: string; keys: string[] }[];
		}>(await api('/members/sheet-columns', fullKey));
		const keys = cat.columns.map((c) => c.key);
		expect(keys.slice(0, 4)).toEqual(['name', 'scoutName', 'stage', 'groups']);
		expect(keys).toEqual(expect.arrayContaining(['age', 'emergencyPhone', 'field.allergien']));
		expect(cat.columns.find((c) => c.key === 'field.allergien')?.sensitive).toBe(true);
		expect(cat.columns.find((c) => c.key === 'field.juleica')?.sensitive).toBe(false);
		const fahrt = cat.presets.find((p) => p.id === 'fahrt')!;
		expect(fahrt.keys).toEqual([
			'name',
			'groups',
			'age',
			'emergencyPhone',
			'field.ernaehrung',
			'field.allergien',
			'field.medikamente'
		]);
		expect(cat.presets.map((p) => p.id)).toEqual(['fahrt', 'kontakt', 'gesundheit', 'minimal']);
		expect((await api('/members/sheet-columns', viewKey)).status).toBe(403);
	});
});

describe('POST /members/sheets.pdf', () => {
	it('Voreinstellung „Fahrt“: nur Fahrt-Spalten, Gesundheit enthalten, Anschrift/E-Mail nicht', async () => {
		await post('/members/sheets.pdf', fullKey, { ids: [anna] });
		expect(html).toContain('Allergien');
		expect(html).toContain('Haselnuss-Allergie');
		expect(html).toContain('Notfallspray');
		expect(html).toContain('Mutter: +49 170 1234567');
		expect(html).not.toContain('anna.eltern@example.test');
		expect(html).not.toContain('Musterweg');
		expect(html).not.toContain('Einwilligungen');
	});

	it('Spaltenauswahl: nur gewählte Spalten, leere Spalten entfallen, unbekannte Schlüssel werden ignoriert', async () => {
		const res = await post('/members/sheets.pdf', fullKey, {
			ids: [anna, ben],
			selection: {
				columns: ['name', 'email', 'field.ernaehrung', 'gibt-es-nicht'],
				hideEmpty: true
			}
		});
		expect(res.status).toBe(200);
		expect(html).toContain('E-Mail');
		expect(html).toContain('anna.eltern@example.test');
		// Ernährung hat bei keinem Mitglied einen Wert → Spalte entfällt
		expect(html).not.toContain('Ernährung');
		expect(html).not.toContain('Allergien');
		await post('/members/sheets.pdf', fullKey, {
			ids: [anna],
			selection: { columns: ['name', 'field.ernaehrung'], hideEmpty: false }
		});
		expect(html).toContain('Ernährung');
	});

	it('Selection ungültig: keine Spalten, zu viele Spalten, unbekanntes Feld → 422', async () => {
		const bad = (selection: unknown) =>
			post('/members/sheets.pdf', fullKey, { ids: [anna], selection });
		expect((await bad({ columns: [], hideEmpty: true })).status).toBe(422);
		const many = Array.from({ length: 41 }, (_, i) => `field.x${i}`);
		expect((await bad({ columns: many, hideEmpty: true })).status).toBe(422);
		expect((await bad({ columns: ['name'], extra: 1 })).status).toBe(422);
	});

	it('liefert ein PDF mit Kontakt- und Gesundheitsdaten in der Reihenfolge der IDs', async () => {
		const res = await post('/members/sheets.pdf', fullKey, {
			ids: [ben, anna],
			selection: { columns: ['name', 'phone', 'email', 'field.allergien', 'field.medikamente'] }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"]+\.pdf"$/);
		expect(res.headers.get('cache-control')).toContain('no-store');
		expect(html).toContain('Anna Allergisch');
		expect(html).toContain('Haselnuss-Allergie');
		expect(html).toContain('Notfallspray');
		expect(html).toContain('+49 170 1234567');
		expect(html).toContain('anna.eltern@example.test');
		expect(html).toContain('Vertraulich');
		expect(html.indexOf('Ben Bunt')).toBeLessThan(html.indexOf('Anna Allergisch'));
	});

	it('Rechte: ohne data.export 403, nur data.export (ohne member.view) 403, ohne Anmeldung 401', async () => {
		expect((await post('/members/sheets.pdf', viewKey, { ids: [anna] })).status).toBe(403);
		expect((await post('/members/sheets.pdf', exportOnlyKey, { ids: [anna] })).status).toBe(403);
		const url = new URL(`http://localhost:5173/api/v1${BASE}/members/sheets.pdf`);
		const anon = await handleApiRequest({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: [anna] })
			}),
			url,
			ip: '127.0.0.1'
		});
		expect(anon.status).toBe(401);
	});

	it('Validierung: leere/zu lange/ungültige Liste → 422, unbekannte ID → 404', async () => {
		expect((await post('/members/sheets.pdf', fullKey, { ids: [] })).status).toBe(422);
		expect((await post('/members/sheets.pdf', fullKey, { ids: ['kein-uuid'] })).status).toBe(422);
		const many = Array.from({ length: 2001 }, () => crypto.randomUUID());
		expect((await post('/members/sheets.pdf', fullKey, { ids: many })).status).toBe(422);
		const unknown = await post('/members/sheets.pdf', fullKey, { ids: [crypto.randomUUID()] });
		expect(unknown.status).toBe(404);
		expect((await post('/members/sheets.pdf', fullKey, { ids: [anna], extra: 1 })).status).toBe(
			422
		);
	});

	it('Audit nur mit Zähler, ohne personenbezogene Daten', async () => {
		await post('/members/sheets.pdf', fullKey, { ids: [anna, ben] });
		const { rows } = await listAudit({ action: 'members.member.sheet', limit: 10 });
		expect(rows.length).toBeGreaterThan(0);
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).toContain('"count":2');
		expect(text).toContain('"columns"');
		expect(text).not.toMatch(/Anna|Allergi|Haselnuss|\+49|@/);
	});
});

describe('POST /groups/sheets.pdf', () => {
	it('eine Seite je Gruppe, nur aktuelle Mitglieder, Mehrfachmitgliedschaft in beiden Gruppen', async () => {
		const res = await post('/groups/sheets.pdf', fullKey, { groupIds: [groupA, groupB] });
		expect(res.status).toBe(200);
		expect(html).toContain('Sippe Falke');
		expect(html).toContain('Sippe Adler');
		expect(html.indexOf('Sippe Falke')).toBeLessThan(html.indexOf('Sippe Adler'));
		// Anna ist in beiden Gruppen und steht zweimal, Ben nur in Adler, der Ausgetretene fehlt
		expect(html.match(/Anna Allergisch/g)?.length).toBe(2);
		expect(html.match(/Ben Bunt/g)?.length).toBe(1);
		expect(html).not.toContain('Egon Weg');
	});

	it('Rechte und Fehler: 403 ohne data.export, 404 unbekannte Gruppe, 422 leer, Audit ohne Namen', async () => {
		expect((await post('/groups/sheets.pdf', viewKey, { groupIds: [groupA] })).status).toBe(403);
		const unknown = await post('/groups/sheets.pdf', fullKey, { groupIds: [crypto.randomUUID()] });
		expect(unknown.status).toBe(404);
		expect((await post('/groups/sheets.pdf', fullKey, { groupIds: [] })).status).toBe(422);
		const audit = await listAudit({ action: 'members.group.sheet', limit: 5 });
		expect(audit.rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit.rows.map((r) => r.metadata))).not.toMatch(/Falke|Anna/);
	});
});

describe('Dienst listMemberSheets', () => {
	it('liefert Telefone, Gruppen und Zusatzfelder in der Reihenfolge der IDs, unbekannte entfallen', async () => {
		const sheets = await service.listMemberSheets([ben, crypto.randomUUID(), anna]);
		expect(sheets.map((s) => s.firstName)).toEqual(['Ben', 'Anna']);
		const a = sheets[1]!;
		expect(a.phones).toEqual([{ name: 'Mutter', value: '+49 170 1234567' }]);
		expect(a.groups.map((g) => g.name).sort()).toEqual(['Sippe Adler', 'Sippe Falke']);
		expect(a.custom.allergien).toBe('Haselnuss-Allergie');
		expect(a.stage).toBe('Pfadfinder');
		expect(await service.listMemberSheets([])).toEqual([]);
	});
});
