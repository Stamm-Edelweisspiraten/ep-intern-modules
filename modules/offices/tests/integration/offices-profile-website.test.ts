import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, setUserActive } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import officesModule from '$modules/offices/module';
import type { MyOffices, Office, WebsiteOffice } from '$modules/offices/schemas';
import { websiteOfficeSchema } from '$modules/offices/website.schemas';
import type { RequestContext } from '$lib/sdk/types';

// Persönliche Beschreibung (eine je Person), Website-Zustimmung (Opt-in, #27), Website-API und
// Datenauskunft des Moduls „Ämter“.

const BASE = 'http://localhost:5173/api/v1/modules/offices';
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

let close: () => Promise<void>;
let admin: RequestContext;
let adminKey: string;
let hannaKey: string;
let ninaKey: string;
let websiteKey: string;
let noScopeKey: string;
let hannaId: string;
let ninaId: string;
let ingoId: string;
let officeA: Office;
let officeB: Office;
let officeC: Office;

interface ApiResult<T = unknown> {
	status: number;
	data: T;
	error: { code: string; message: string; details?: unknown } | undefined;
	raw: string;
}

async function api<T = unknown>(
	key: string,
	method: string,
	path: string,
	body?: unknown
): Promise<ApiResult<T>> {
	resetAllForTests();
	const url = new URL(`${BASE}${path}`);
	const headers: Record<string, string> = { authorization: `Bearer ${key}` };
	if (body !== undefined) headers['content-type'] = 'application/json';
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined
		}),
		url,
		ip: '127.0.0.1'
	});
	const raw = await res.text();
	let json: { data?: T; error?: ApiResult['error'] } = {};
	try {
		json = raw ? JSON.parse(raw) : {};
	} catch {
		// Binärantwort (Avatar)
	}
	return { status: res.status, data: json.data as T, error: json.error, raw };
}

async function createOffice(name: string, extra: Record<string, unknown> = {}): Promise<Office> {
	const r = await api<Office>(adminKey, 'POST', '/offices', { name, ...extra });
	expect(r.status, JSON.stringify(r.error)).toBe(201);
	return r.data;
}

async function setHolders(officeId: string, holders: { userId: string; since?: string }[]) {
	const r = await api(adminKey, 'PUT', `/offices/${officeId}/holders`, { holders });
	expect(r.status, JSON.stringify(r.error)).toBe(200);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'offices');
	admin = await ctxOf(u!.id);
	adminKey = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...admin.permissions].filter((p) => p !== 'offices.website.read')
		})
	).key;

	const baseRole = await createRole(admin, { name: 'Basis', permissions: ['core.api.manage'] });
	const viewerRole = await createRole(admin, {
		name: 'Ämter lesen',
		permissions: ['offices.office.view', 'core.api.manage']
	});
	const websiteRole = await createRole(admin, {
		name: 'Website',
		permissions: ['offices.website.read', 'core.api.manage']
	});
	const secretRole = await createRole(admin, {
		name: 'Geheime Rolle',
		permissions: ['core.audit.view']
	});

	hannaId = await createUser(admin, {
		name: 'Hanna Holder',
		email: 'hanna@example.test',
		password: 'correct-horse-battery-2',
		roleIds: [baseRole]
	});
	ninaId = await createUser(admin, {
		name: 'Nina Nicht',
		email: 'nina@example.test',
		password: 'correct-horse-battery-3',
		roleIds: [viewerRole]
	});
	ingoId = await createUser(admin, {
		name: 'Ingo Inaktiv',
		email: 'ingo@example.test',
		password: 'correct-horse-battery-4',
		roleIds: [baseRole]
	});
	const webUserId = await createUser(admin, {
		name: 'Website',
		email: 'website@example.test',
		password: 'correct-horse-battery-5',
		roleIds: [websiteRole]
	});

	officeA = await createOffice('Stammesführung', {
		description: 'Leitet den Stamm',
		emails: [{ label: 'Leitung', email: 'stafue@stamm.example' }],
		roleIds: [secretRole]
	});
	officeB = await createOffice('Kasse', { emails: [{ email: 'kasse@stamm.example' }] });
	officeC = await createOffice('Materialwart');
	await setHolders(officeA.id, [{ userId: hannaId, since: '2024-09-01' }, { userId: ingoId }]);
	await setHolders(officeB.id, [{ userId: hannaId }]);

	// Key erst nach der Zuordnung: offices.office.view kommt über die Rolle „Amtsinhaber*in“
	hannaKey = (
		await createApiKey(await ctxOf(hannaId), { name: 'h', scopes: ['offices.office.view'] })
	).key;
	ninaKey = (
		await createApiKey(await ctxOf(ninaId), { name: 'n', scopes: ['offices.office.view'] })
	).key;
	const web = await ctxOf(webUserId);
	websiteKey = (await createApiKey(web, { name: 'web', scopes: ['offices.website.read'] })).key;
	noScopeKey = (await createApiKey(web, { name: 'kein', scopes: ['core.api.manage'] })).key;

	await setUserActive(admin, ingoId, false);
});

afterAll(async () => {
	await close();
});

describe('GET /me und PUT /me/bio', () => {
	it('liefert die eigenen Ämter einer Inhaberin', async () => {
		const r = await api<MyOffices>(hannaKey, 'GET', '/me');
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect(r.data.offices.map((o) => o.id).sort()).toEqual([officeA.id, officeB.id].sort());
		expect(r.data.bio).toBeNull();
		expect(r.data.canEditBio).toBe(true);
	});

	it('eine Beschreibung erscheint bei allen Ämtern der Person', async () => {
		const bio = 'Ich bin seit 2010 im Stamm und kümmere mich um Finanzen.';
		const r = await api(hannaKey, 'PUT', '/me/bio', { bio });
		expect(r.status, JSON.stringify(r.error)).toBe(200);

		for (const id of [officeA.id, officeB.id]) {
			const detail = await api<Office>(adminKey, 'GET', `/offices/${id}`);
			const holder = detail.data.holders.find((h) => h.userId === hannaId);
			expect(holder?.bio).toBe(bio);
		}
		const me = await api<MyOffices>(hannaKey, 'GET', '/me');
		expect(me.data.bio).toBe(bio);
	});

	it('zu lange Beschreibung → 422, Leeren setzt null', async () => {
		const long = await api(hannaKey, 'PUT', '/me/bio', { bio: 'x'.repeat(2001) });
		expect(long.status).toBe(422);
		expect(long.error?.code).toBe('validation_failed');

		const max = await api(hannaKey, 'PUT', '/me/bio', { bio: 'y'.repeat(2000) });
		expect(max.status, JSON.stringify(max.error)).toBe(200);

		const cleared = await api(hannaKey, 'PUT', '/me/bio', { bio: '' });
		expect(cleared.status).toBe(200);
		expect((await api<MyOffices>(hannaKey, 'GET', '/me')).data.bio).toBeNull();

		await api(hannaKey, 'PUT', '/me/bio', { bio: 'Kassenwartin aus Leidenschaft' });
	});

	it('ohne Amt: canEditBio false und PUT → 403', async () => {
		const me = await api<MyOffices>(ninaKey, 'GET', '/me');
		expect(me.status, JSON.stringify(me.error)).toBe(200);
		expect(me.data.offices).toEqual([]);
		expect(me.data.canEditBio).toBe(false);

		const r = await api(ninaKey, 'PUT', '/me/bio', { bio: 'Ich will auch' });
		expect(r.status).toBe(403);
		expect(r.error?.code).toBe('forbidden');
	});

	it('Audit offices.profile.updated ohne Beschreibungstext', async () => {
		const rows = await getDb()
			.select({ metadata: schema.auditLog.metadata, target: schema.auditLog.target })
			.from(schema.auditLog)
			.where(eq(schema.auditLog.action, 'offices.profile.updated'));
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			const meta = JSON.stringify(r.metadata);
			expect(meta).not.toContain('Finanzen');
			expect(meta).not.toContain('Leidenschaft');
			expect(meta).not.toContain('yyyy');
			expect(meta).not.toContain('@');
		}
	});
});

describe('PUT /me/website (Opt-in für die Stammeswebsite, #27)', () => {
	const holdersOnWebsite = async () => {
		const r = await api<WebsiteOffice[]>(websiteKey, 'GET', '/website/offices');
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		return { data: r.data, raw: r.raw };
	};

	it('ohne Zustimmung: Ämter ohne Personen, weder Name noch Bio noch Bild', async () => {
		// Ingo (inaktiv) hat zugestimmt – bleibt trotzdem verborgen
		await getDb().execute(
			sql`INSERT INTO mod_offices.holder_profiles (user_id, show_on_website, show_on_website_at)
				VALUES (${ingoId}, true, now()) ON CONFLICT (user_id) DO NOTHING`
		);
		const me = await api<MyOffices>(hannaKey, 'GET', '/me');
		expect(me.data.showOnWebsite).toBe(false);
		const { data, raw } = await holdersOnWebsite();
		expect(data.length).toBe(3);
		for (const o of data) expect(o.holders).toEqual([]);
		expect(raw).not.toContain(hannaId);
		expect(raw).not.toContain('Hanna');
		expect(raw).not.toContain('Leidenschaft');
		expect(raw).not.toContain('avatar');
	});

	it('Zustimmung: Person erscheint, Beschreibung bleibt erhalten', async () => {
		const r = await api<MyOffices>(hannaKey, 'PUT', '/me/website', { showOnWebsite: true });
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect(r.data.showOnWebsite).toBe(true);
		expect(r.data.bio).toBe('Kassenwartin aus Leidenschaft');
		const { data } = await holdersOnWebsite();
		expect(data.find((o) => o.id === officeA.id)!.holders.map((h) => h.id)).toEqual([hannaId]);
	});

	it('Widerruf: Person verschwindet sofort, Zeitpunkt der Änderung wird gespeichert', async () => {
		const before = await getDb().execute(
			sql`SELECT show_on_website_at FROM mod_offices.holder_profiles WHERE user_id = ${hannaId}`
		);
		const r = await api<MyOffices>(hannaKey, 'PUT', '/me/website', { showOnWebsite: false });
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		expect(r.data.showOnWebsite).toBe(false);
		const { data, raw } = await holdersOnWebsite();
		for (const o of data) expect(o.holders).toEqual([]);
		expect(raw).not.toContain('Hanna');
		const after = await getDb().execute(
			sql`SELECT show_on_website, show_on_website_at FROM mod_offices.holder_profiles
				WHERE user_id = ${hannaId}`
		);
		const row = (after as unknown as { rows: Record<string, unknown>[] }).rows[0]!;
		const prev = (before as unknown as { rows: Record<string, unknown>[] }).rows[0]!;
		expect(row.show_on_website).toBe(false);
		expect(row.show_on_website_at).not.toBeNull();
		expect(new Date(String(row.show_on_website_at)).getTime()).toBeGreaterThanOrEqual(
			new Date(String(prev.show_on_website_at)).getTime()
		);

		// Für die folgenden Website-Tests wieder zustimmen
		const again = await api<MyOffices>(hannaKey, 'PUT', '/me/website', { showOnWebsite: true });
		expect(again.data.showOnWebsite).toBe(true);
	});

	it('ohne Amt → 403, ungültige Eingabe → 422', async () => {
		const r = await api(ninaKey, 'PUT', '/me/website', { showOnWebsite: true });
		expect(r.status).toBe(403);
		expect(r.error?.code).toBe('forbidden');
		const bad = await api(hannaKey, 'PUT', '/me/website', { showOnWebsite: 'ja' });
		expect(bad.status).toBe(422);
	});

	it('Audit offices.profile.website-changed nur mit dem Schalterwert', async () => {
		const rows = await getDb()
			.select({ metadata: schema.auditLog.metadata, target: schema.auditLog.target })
			.from(schema.auditLog)
			.where(eq(schema.auditLog.action, 'offices.profile.website-changed'));
		expect(rows.length).toBe(3);
		for (const r of rows) {
			expect(r.target).toBe(hannaId);
			expect(Object.keys(r.metadata as object)).toEqual(['showOnWebsite']);
		}
	});
});

describe('GET /website/offices', () => {
	it('nur mit Scope offices.website.read', async () => {
		expect((await api(noScopeKey, 'GET', '/website/offices')).status).toBe(403);
		expect((await api(adminKey, 'GET', '/website/offices')).status).toBe(403);
		expect((await api(hannaKey, 'GET', '/website/offices')).status).toBe(403);
		// Website-Key erreicht keine internen Endpunkte
		expect((await api(websiteKey, 'GET', '/offices')).status).toBe(403);
		expect((await api(websiteKey, 'GET', '/me')).status).toBe(403);
	});

	it('liefert Ämter in Reihenfolge mit öffentlichen Feldern', async () => {
		const r = await api<WebsiteOffice[]>(websiteKey, 'GET', '/website/offices');
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		// Vertrag (#48): strikt gegen das exportierte Website-Schema
		websiteOfficeSchema.array().parse(r.data);
		expect(r.data.map((o) => o.id)).toEqual([officeA.id, officeB.id, officeC.id]);

		const a = r.data[0]!;
		expect(a.name).toBe('Stammesführung');
		expect(a.description).toBe('Leitet den Stamm');
		expect(a.emails).toEqual([{ label: 'Leitung', email: 'stafue@stamm.example' }]);
		expect(a.holders).toEqual([
			{
				id: hannaId,
				firstName: 'Hanna',
				bio: 'Kassenwartin aus Leidenschaft',
				since: '2024-09-01',
				avatarPath: null
			}
		]);
		expect(r.data[1]!.holders.map((h) => h.id)).toEqual([hannaId]);
		expect(r.data[2]!.holders).toEqual([]);
	});

	it('enthält keine Benutzer-Mails, keine Rollen, keine inaktiven Personen', async () => {
		const r = await api<WebsiteOffice[]>(websiteKey, 'GET', '/website/offices');
		expect(r.raw).not.toContain('example.test');
		expect(r.raw).not.toContain('Geheime Rolle');
		expect(r.raw).not.toContain('roles');
		expect(r.raw).not.toContain('roleIds');
		expect(r.raw).not.toContain(ingoId);
		expect(r.raw).not.toContain('Ingo');
		// Nachnamen verlassen den Server nicht (nur Vornamen)
		expect(r.raw).not.toContain('Holder');
		for (const o of r.data) {
			expect(Object.keys(o).sort()).toEqual(
				['description', 'emails', 'holders', 'id', 'name', 'position'].sort()
			);
			for (const h of o.holders) {
				expect(Object.keys(h).sort()).toEqual(['avatarPath', 'bio', 'firstName', 'id', 'since']);
			}
		}
	});

	it('Reihenfolge folgt PUT /offices/order', async () => {
		const ids = [officeC.id, officeA.id, officeB.id];
		const o = await api(adminKey, 'PUT', '/offices/order', { ids });
		expect(o.status, JSON.stringify(o.error)).toBe(200);
		const r = await api<WebsiteOffice[]>(websiteKey, 'GET', '/website/offices');
		expect(r.data.map((x) => x.id)).toEqual(ids);
	});

	it('avatarPath nur mit Profilbild', async () => {
		await getDb()
			.update(schema.user)
			.set({ image: `/avatar/${hannaId}?v=1` })
			.where(eq(schema.user.id, hannaId));
		const r = await api<WebsiteOffice[]>(websiteKey, 'GET', '/website/offices');
		const holder = r.data.flatMap((o) => o.holders).find((h) => h.id === hannaId)!;
		expect(holder.avatarPath).toContain(`holders/${hannaId}/avatar`);
		expect(holder.avatarPath).not.toContain('example.test');
	});
});

describe('GET /website/offices/holders/:userId/avatar', () => {
	const avatar = (userId: string, key = websiteKey) =>
		api(key, 'GET', `/website/offices/holders/${encodeURIComponent(userId)}/avatar`);

	it('404 für Nicht-Inhaber*innen und unbekannte IDs', async () => {
		expect((await avatar(ninaId)).status).toBe(404);
		expect((await avatar('gibt-es-nicht')).status).toBe(404);
		expect((await avatar(admin.userId!)).status).toBe(404);
	});

	it('404 ohne Zustimmung zur Website-Anzeige (auch mit Bild)', async () => {
		await api(hannaKey, 'PUT', '/me/website', { showOnWebsite: false });
		try {
			expect((await avatar(hannaId)).status).toBe(404);
		} finally {
			await api(hannaKey, 'PUT', '/me/website', { showOnWebsite: true });
		}
	});

	it('404 für inaktive Inhaber*innen und ohne verfügbares Bild (kein Storage im Test)', async () => {
		expect((await avatar(ingoId)).status).toBe(404);
		expect((await avatar(hannaId)).status).toBe(404);
	});

	it('nur mit Scope', async () => {
		expect((await avatar(hannaId, noScopeKey)).status).toBe(403);
	});
});

describe('Deaktivierte Inhaber*innen', () => {
	it('bleiben beim Umsortieren erlaubt, neu hinzufügen → 422', async () => {
		const keep = await api<Office>(adminKey, 'PUT', `/offices/${officeA.id}/holders`, {
			holders: [{ userId: ingoId }, { userId: hannaId, since: '2024-09-01' }]
		});
		expect(keep.status, JSON.stringify(keep.error)).toBe(200);
		expect(keep.data.holders.map((h) => h.userId)).toEqual([ingoId, hannaId]);

		const add = await api(adminKey, 'PUT', `/offices/${officeB.id}/holders`, {
			holders: [{ userId: hannaId }, { userId: ingoId }]
		});
		expect(add.status).toBe(422);
		expect(JSON.stringify(add.error?.details)).toContain('holders');
	});
});

describe('Modul deaktiviert', () => {
	it('Website-API → 404 module_disabled', async () => {
		await disableModule(admin, 'offices');
		try {
			const r = await api(websiteKey, 'GET', '/website/offices');
			expect(r.status).toBe(404);
			expect(r.error?.code).toBe('module_disabled');
			const me = await api(hannaKey, 'GET', '/me');
			expect(me.status).toBe(404);
		} finally {
			await enableModule(admin, 'offices');
		}
	});
});

describe('Datenauskunft (subjectExport)', () => {
	it('liefert Ämter, Beschreibung und Website-Zustimmung der Person', async () => {
		const run = officesModule.subjectExport!.run;
		const data = (await run({ userId: hannaId, memberIds: [] }))!;
		expect(data).not.toBeNull();
		const offices = data.offices as { id: string; name: string; since: string | null }[];
		expect(offices.map((o) => o.id).sort()).toEqual([officeA.id, officeB.id].sort());
		expect(offices.find((o) => o.id === officeA.id)!.since).toBe('2024-09-01');
		const profile = data.profile as { bio: string; showOnWebsite: boolean };
		expect(profile.bio).toBe('Kassenwartin aus Leidenschaft');
		expect(profile.showOnWebsite).toBe(true);
		expect(JSON.stringify(data)).not.toContain('Ingo');
	});

	it('null ohne Konto bzw. ohne Daten', async () => {
		const run = officesModule.subjectExport!.run;
		expect(await run({ userId: null, memberIds: ['egal'] })).toBeNull();
		expect(await run({ userId: ninaId, memberIds: [] })).toBeNull();
	});
});
