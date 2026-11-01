/**
 * Zusätzliche Qualitätssicherung zu Profil, Benutzer-Einstellungen, eigenen Mitgliedern,
 * Mail-Abwahlen und Standard-Rollenrechten (Lücken der Tests core-profile / members-own).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { getAuth } from '$testing';
import { contextForUser } from '$testing';
import {
	AVATAR_MAX_BYTES,
	readAvatar,
	removeOwnAvatar,
	removeUserAvatar,
	requestEmailChange,
	setOwnAvatar,
	setUserAvatar,
	updateOwnName
} from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { adoptDefaultRole } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { registerModule, unregisterModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { resetAllForTests, reset } from '$testing';
import { setSetting } from '$testing';
import { loadUserPrefs, resolveStartPage } from '$testing';
import { core } from '$lib/sdk/server';
import { blankTheme } from '$lib/appearance';
import membersModule from '$modules/members/module';
import { profileActions } from '$testing';
import type { RequestContext } from '$lib/sdk/types';

/** Echtes kleines Bild (Profilbilder laufen durch `core.images`, #19) */
const realImage = async (format: 'png' | 'jpeg' | 'webp' = 'png') =>
	new Uint8Array(
		await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
			.toFormat(format)
			.toBuffer()
	);

const ORIGIN = 'http://localhost:5173';
const PW = 'correct-horse-battery';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

async function login(email: string): Promise<Headers> {
	const res = await getAuth().api.signInEmail({
		body: { email, password: PW },
		returnHeaders: true
	});
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
	return new Headers({ cookie, origin: ORIGIN });
}

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
const M = (path: string, who: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys[who], ...init });

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	const id = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	userIds[name] = id;
	const ctx = await ctxOf(id);
	keys[name] = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
	return id;
}

async function mkMember(firstName: string): Promise<string> {
	const res = await M('/members', 'admin', {
		method: 'POST',
		json: {
			firstName,
			lastName: 'Extra',
			scoutName: null,
			birthDate: '2012-05-17',
			street: 'Weg 1',
			postalCode: '12345',
			city: 'Stadt',
			country: 'DE',
			phones: [],
			emails: [],
			stage: 'pfadfinder',
			groupIds: []
		}
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}
async function link(member: string, user: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${member}, ${userIds[user]!}, 'Mutter')`
		);
	});
}

async function auditOf(target: string, action: string) {
	const { rows } = await listAudit({ target, limit: 100 });
	return rows.filter((r) => r.action === action);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', PW);
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	userIds.admin = u!.id;
	setMailTransportForTests({ sendMail: async () => undefined });
});
afterAll(async () => {
	setMailTransportForTests(undefined);
	uninstallFakeStorage();
	await close();
});
beforeEach(() => resetAllForTests());

describe('E-Mail-Wechsel: Randfälle', () => {
	it('gleiche Adresse (auch in anderer Schreibweise) -> bad_request, keine Mail', async () => {
		const id = await createUser(admin, { name: 'Gina', email: 'gina@example.test', password: PW });
		const headers = await login('gina@example.test');
		for (const newEmail of ['gina@example.test', '  GINA@Example.TEST ']) {
			await expect(
				requestEmailChange(await ctxOf(id), headers, { newEmail, password: PW })
			).rejects.toMatchObject({ code: 'bad_request' });
		}
	});

	it('Validierung kommt vor der Passwortprüfung (kein Zähler-Verbrauch bei ungültiger Adresse)', async () => {
		const id = await createUser(admin, { name: 'Hans', email: 'hans@example.test', password: PW });
		const headers = await login('hans@example.test');
		reset(`pwcheck:${id}`);
		for (let i = 0; i < 8; i++) {
			await expect(
				requestEmailChange(await ctxOf(id), headers, { newEmail: 'x', password: 'falsch' })
			).rejects.toMatchObject({ code: 'validation_failed' });
		}
		// Passwort ist noch nicht gesperrt: richtiges Passwort + gleiche Adresse -> bad_request (nicht Sperre)
		await expect(
			requestEmailChange(await ctxOf(id), headers, {
				newEmail: 'hans@example.test',
				password: PW
			})
		).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('aktuellen') });
	});

	it('zu lange Adresse (> 255) und leere Eingabe -> 422', async () => {
		const id = await createUser(admin, { name: 'Ida', email: 'ida@example.test', password: PW });
		const headers = await login('ida@example.test');
		const long = `${'a'.repeat(250)}@example.test`;
		for (const newEmail of [long, '', '   ']) {
			await expect(
				requestEmailChange(await ctxOf(id), headers, { newEmail, password: PW })
			).rejects.toMatchObject({ code: 'validation_failed' });
		}
	});

	it('leeres bzw. zu langes Passwort wird abgewiesen und zählt als Fehlversuch', async () => {
		const id = await createUser(admin, { name: 'Jan', email: 'jan@example.test', password: PW });
		const headers = await login('jan@example.test');
		for (const password of ['', 'x'.repeat(129)]) {
			await expect(
				requestEmailChange(await ctxOf(id), headers, { newEmail: 'jan2@example.test', password })
			).rejects.toMatchObject({ code: 'bad_request' });
		}
	});

	it('ohne Benutzer (API-Key-/System-Kontext ohne userId) -> unauthenticated', async () => {
		const ctx = { ...(await ctxOf(userIds.admin!)), userId: null } as RequestContext;
		await expect(
			requestEmailChange(ctx, new Headers(), { newEmail: 'a@example.test', password: PW })
		).rejects.toMatchObject({ code: 'unauthenticated' });
	});

	it('Audit ohne Klartext-Adressen, auch bei belegter Adresse', async () => {
		const id = await createUser(admin, { name: 'Kai', email: 'kai@example.test', password: PW });
		await createUser(admin, { name: 'Lea', email: 'lea@example.test', password: PW });
		const headers = await login('kai@example.test');
		await requestEmailChange(await ctxOf(id), headers, {
			newEmail: 'lea@example.test',
			password: PW
		});
		const rows = await auditOf(id, 'core.auth.email_change_requested');
		expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/kai@|lea@/);
	});
});

describe('updateOwnName', () => {
	let id: string;
	beforeAll(async () => {
		id = await createUser(admin, { name: 'Nora', email: 'nora@example.test', password: PW });
	});
	const nameOf = async () =>
		(await getDb().select().from(schema.user).where(eq(schema.user.id, id)))[0]!.name;

	it('trimmt, speichert und auditiert ohne Namen', async () => {
		await updateOwnName(await ctxOf(id), '  Nora Neu  ');
		expect(await nameOf()).toBe('Nora Neu');
		const rows = await auditOf(id, 'core.user.name_changed');
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0]!.metadata ?? {})).not.toContain('Nora');
	});

	it('Grenzen: 1 und 100 Zeichen ok, leer/Leerzeichen/101 -> 422', async () => {
		const ctx = await ctxOf(id);
		await updateOwnName(ctx, 'x');
		await updateOwnName(ctx, 'y'.repeat(100));
		expect(await nameOf()).toBe('y'.repeat(100));
		for (const bad of ['', '   \t ', 'z'.repeat(101)]) {
			await expect(updateOwnName(ctx, bad)).rejects.toMatchObject({ code: 'validation_failed' });
		}
		expect(await nameOf()).toBe('y'.repeat(100));
	});

	it('ohne Benutzer -> unauthenticated', async () => {
		const ctx = { ...(await ctxOf(id)), userId: null } as RequestContext;
		await expect(updateOwnName(ctx, 'A')).rejects.toMatchObject({ code: 'unauthenticated' });
	});
});

describe('Profilbild', () => {
	let id: string;
	let png: Uint8Array;
	beforeAll(async () => {
		png = await realImage('png');
		id = await createUser(admin, { name: 'Ava', email: 'ava@example.test', password: PW });
	});
	const imageOf = async () =>
		(await getDb().select().from(schema.user).where(eq(schema.user.id, id)))[0]!.image;

	it('ohne S3: gültiges Bild -> 503 unavailable, user.image bleibt leer', async () => {
		uninstallFakeStorage();
		await expect(
			setOwnAvatar(await ctxOf(id), { data: png, contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'unavailable' });
		expect(await imageOf()).toBeNull();
	});

	it('Typ: gif/svg/leer abgewiesen (bad_request), PNG mit Parameter + Großschreibung ok-Pfad erreicht Storage', async () => {
		const ctx = await ctxOf(id);
		for (const contentType of ['image/gif', 'image/svg+xml', 'application/pdf', '']) {
			await expect(setOwnAvatar(ctx, { data: png, contentType })).rejects.toMatchObject({
				code: 'bad_request'
			});
		}
		// Typprüfung passiert (Fehler kommt erst vom Storage)
		await expect(
			setOwnAvatar(ctx, { data: png, contentType: 'IMAGE/PNG; charset=binary' })
		).rejects.toMatchObject({ code: 'unavailable' });
	});

	it('Größe: 0 Byte und Maximum+1 -> 413, vor dem Storage', async () => {
		const ctx = await ctxOf(id);
		await expect(
			setOwnAvatar(ctx, { data: new Uint8Array(0), contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'payload_too_large' });
		await expect(
			setOwnAvatar(ctx, { data: new Uint8Array(AVATAR_MAX_BYTES + 1), contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'payload_too_large' });
	});

	it('removeOwnAvatar ohne S3 und ohne Bild: kein Fehler, Audit geschrieben', async () => {
		await expect(removeOwnAvatar(await ctxOf(id))).resolves.toBeUndefined();
		expect(await imageOf()).toBeNull();
		expect((await auditOf(id, 'core.user.avatar_removed')).length).toBeGreaterThan(0);
	});

	it('readAvatar: ohne gesetztes Bild null', async () => {
		expect(await readAvatar(id)).toBeNull();
		expect(await readAvatar('gibt-es-nicht')).toBeNull();
	});

	it('mit Fake-Storage: gespeichert wird bereinigtes WebP, Entfernen löscht', async () => {
		await installFakeStorage(admin);
		const ctx = await ctxOf(id);
		const img = await setOwnAvatar(ctx, {
			data: await realImage('jpeg'),
			contentType: 'image/jpeg'
		});
		expect(img).toMatch(new RegExp(`^/avatar/${id}\\?v=\\d+&n=1$`));
		expect(await imageOf()).toBe(img);
		const read = await readAvatar(id);
		expect(read?.contentType).toBe('image/webp');
		expect((await sharp(read!.data).metadata()).format).toBe('webp');
		const audit = await auditOf(id, 'core.user.avatar_changed');
		expect(JSON.stringify(audit.map((a) => a.metadata ?? {}))).not.toContain('webp');
		await removeOwnAvatar(ctx);
		expect(await imageOf()).toBeNull();
		expect(await readAvatar(id)).toBeNull();
		uninstallFakeStorage();
	});
});

describe('Profilbild durch die Verwaltung', () => {
	let id: string;
	let plainId: string;
	let png: Uint8Array;
	beforeAll(async () => {
		png = await realImage('png');
		id = await createUser(admin, { name: 'Bea', email: 'bea@example.test', password: PW });
		plainId = await createUser(admin, { name: 'Ohne', email: 'ohne@example.test', password: PW });
	});
	const imageOf = async () =>
		(await getDb().select().from(schema.user).where(eq(schema.user.id, id)))[0]!.image;

	it('ohne core.users.edit -> forbidden, unbekannter Benutzer -> not_found', async () => {
		const plain = await ctxOf(plainId);
		await expect(
			setUserAvatar(plain, id, { data: png, contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(removeUserAvatar(plain, id)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			setUserAvatar(admin, 'gibt-es-nicht', { data: png, contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(removeUserAvatar(admin, 'gibt-es-nicht')).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('gleiche Prüfungen wie beim eigenen Bild (Typ, Größe, ohne S3)', async () => {
		uninstallFakeStorage();
		await expect(
			setUserAvatar(admin, id, { data: png, contentType: 'image/gif' })
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			setUserAvatar(admin, id, { data: new Uint8Array(0), contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'payload_too_large' });
		await expect(
			setUserAvatar(admin, id, { data: png, contentType: 'image/png' })
		).rejects.toMatchObject({ code: 'unavailable' });
		expect(await imageOf()).toBeNull();
	});

	it('mit Fake-Storage: setzen, lesen, entfernen; Audit mit byAdmin am Zielkonto', async () => {
		await installFakeStorage(admin);
		const img = await setUserAvatar(admin, id, { data: png, contentType: 'image/png' });
		expect(img).toMatch(new RegExp(`^/avatar/${id}\\?v=\\d+&n=1$`));
		expect(await imageOf()).toBe(img);
		expect((await readAvatar(id))?.contentType).toBe('image/webp');
		const changed = await auditOf(id, 'core.user.avatar_changed');
		expect(changed[0]?.metadata).toMatchObject({ byAdmin: true });
		await removeUserAvatar(admin, id);
		expect(await imageOf()).toBeNull();
		expect(await readAvatar(id)).toBeNull();
		const removed = await auditOf(id, 'core.user.avatar_removed');
		expect(removed[0]?.metadata).toMatchObject({ byAdmin: true });
		uninstallFakeStorage();
	});
});

describe('saveSettings (Profil-Action)', () => {
	let uid: string;
	beforeAll(async () => {
		uid = await createUser(admin, { name: 'Sven', email: 'sven@example.test', password: PW });
	});

	async function save(fields: Record<string, string>) {
		const f = new FormData();
		for (const [k, v] of Object.entries(fields)) f.set(k, v);
		const cookiesSet: Record<string, string> = {};
		const ctx = await ctxOf(uid);
		const res = (await (profileActions.saveSettings as (e: unknown) => unknown)({
			request: new Request(`${ORIGIN}/profile?/saveSettings`, { method: 'POST', body: f }),
			locals: { ctx, user: { id: uid } },
			cookies: { set: (n: string, v: string) => (cookiesSet[n] = v) },
			url: new URL(`${ORIGIN}/profile`)
		})) as { status?: number; data?: { error?: string; success?: string } } & {
			error?: string;
			success?: string;
		};
		return { res, cookiesSet, ok: !!(res.success ?? res.data?.success) };
	}

	it('nur mitgesendete Felder werden gespeichert', async () => {
		const r = await save({ density: 'compact' });
		expect(r.ok).toBe(true);
		expect(r.cookiesSet).toEqual({});
		const p = await loadUserPrefs(uid);
		expect(p).toMatchObject({
			density: 'compact',
			themeExplicit: false,
			accentColor: '',
			pageSize: 25,
			startPage: '/dashboard'
		});
	});

	it('Theme setzt auch das Cookie; ungültiges Theme -> 400 ohne Cookie', async () => {
		const ok = await save({ theme: 'dark' });
		expect(ok.cookiesSet.theme).toBe('dark');
		const bad = await save({ theme: 'neon' });
		expect(bad.res.status).toBe(400);
		expect(bad.cookiesSet.theme).toBeUndefined();
		expect((await loadUserPrefs(uid)).theme).toBe('dark');
	});

	it('Hex-Injection in der Akzentfarbe wird abgewiesen, gültige gespeichert', async () => {
		for (const v of [
			'#12345',
			'#1234567',
			'red',
			'#ggg000',
			'#00ff00;background:url(x)',
			'"><script>',
			'#00ff00\n'
		]) {
			const r = await save({ accentColor: v });
			expect(r.res.status, v).toBe(400);
		}
		expect((await loadUserPrefs(uid)).accentColor).toBe('');
		expect((await save({ accentColor: '#ABCDEF' })).ok).toBe(true);
		expect((await loadUserPrefs(uid)).accentColor).toBe('#abcdef');
		expect((await save({ accentColor: '' })).ok).toBe(true);
		expect((await loadUserPrefs(uid)).accentColor).toBe('');
	});

	it('pageSize: 9 und 201 abgewiesen, 10 und 200 ok, 25.5/abc abgewiesen', async () => {
		for (const v of ['9', '201', '25.5', 'abc', '-10']) {
			expect((await save({ pageSize: v })).res.status, v).toBe(400);
		}
		expect((await save({ pageSize: '10' })).ok).toBe(true);
		expect((await loadUserPrefs(uid)).pageSize).toBe(10);
		expect((await save({ pageSize: '200' })).ok).toBe(true);
		expect((await loadUserPrefs(uid)).pageSize).toBe(200);
	});

	it('Leerer pageSize-String wird nicht als 0 durchgewunken (Grenzfall)', async () => {
		// Number('') === 0 -> muss an min(10) scheitern
		expect((await save({ pageSize: '' })).res.status).toBe(400);
	});

	it('startPage: externe/unbekannte Ziele fallen auf /dashboard zurück', async () => {
		for (const v of [
			'//evil.com',
			'https://evil.com',
			'//evil',
			'javascript:alert(1)',
			'/gibts-nicht',
			'/admin'
		]) {
			const r = await save({ startPage: v });
			expect(r.ok, v).toBe(true);
			const p = await loadUserPrefs(uid);
			expect(p.startPage, v).toBe('/dashboard');
		}
		expect((await save({ startPage: '/profile' })).ok).toBe(true);
		expect((await loadUserPrefs(uid)).startPage).toBe('/profile');
	});

	it('startPage: Modulseite nur mit Recht in der Navigation', async () => {
		// uid hat keine Rolle -> /modules/members nicht in der Navigation
		await save({ startPage: '/modules/members' });
		expect((await loadUserPrefs(uid)).startPage).toBe('/dashboard');
	});

	it('//evil wird vom Schema abgelehnt und von resolveStartPage nie ausgeliefert', async () => {
		await expect(
			setSetting(await ctxOf(uid), 'core.user.startPage', '//evil')
		).rejects.toMatchObject({ code: 'validation_failed' });
		const p = await loadUserPrefs(uid);
		expect(resolveStartPage(p.startPage, ['/modules/members'])).toBe('/dashboard');
		expect(resolveStartPage('//evil', ['//evil'])).toBe('/dashboard');
	});
});

describe('Eigene Mitglieder: Kontakte, Grenzen', () => {
	let kid = '';
	let fremd = '';
	const emails = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ name: null, value: `e${i}@example.test` }));
	const phones = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			name: null,
			value: `+49 170 10000${String(i).padStart(2, '0')}`
		}));
	const put = (id: string, json: unknown, who = 'eltern') =>
		M(`/my/members/${id}/contacts`, who, { method: 'PUT', json });

	beforeAll(async () => {
		await mkUser('eltern', ['core.api.manage', 'members.own.view', 'members.own.edit']);
		await mkUser('lesen', ['core.api.manage', 'members.own.view']);
		await mkUser('nurEdit', ['core.api.manage', 'members.own.edit']);
		kid = await mkMember('Kind');
		fremd = await mkMember('Fremd');
		await link(kid, 'eltern');
		await link(kid, 'lesen');
		await link(kid, 'nurEdit');
	});

	it('10 Einträge ok, 11 -> 422 (Telefone und E-Mails getrennt)', async () => {
		expect((await put(kid, { phones: phones(10), emails: emails(10) })).status).toBe(200);
		expect((await put(kid, { phones: phones(11), emails: emails(1) })).status).toBe(422);
		expect((await put(kid, { phones: [], emails: emails(11) })).status).toBe(422);
		const list = (await (await M('/my/members', 'eltern')).json()).data;
		expect(list[0].phones).toHaveLength(10);
		expect(list[0].emails).toHaveLength(10);
	});

	it('letzte E-Mail löschen -> 422 und Zustand bleibt; Telefone dürfen leer werden', async () => {
		await put(kid, { phones: phones(2), emails: emails(1) });
		const res = await put(kid, { phones: phones(2), emails: [] });
		expect(res.status).toBe(422);
		expect((await put(kid, { phones: [], emails: emails(1) })).status).toBe(200);
		const list = (await (await M('/my/members', 'eltern')).json()).data;
		expect(list[0].emails).toHaveLength(1);
		expect(list[0].phones).toHaveLength(0);
	});

	it('Zugriffsmatrix: fremdes Mitglied 404, ohne own.edit 403, ohne own.view 403, ohne Key 401', async () => {
		const body = { phones: [], emails: emails(1) };
		expect((await put(fremd, body)).status).toBe(404);
		expect((await put('00000000-0000-4000-8000-000000000000', body)).status).toBe(404);
		expect((await put(kid, body, 'lesen')).status).toBe(403);
		expect((await put(kid, body, 'nurEdit')).status).toBe(403);
		expect(
			(await api(`/modules/members/my/members/${kid}/contacts`, { method: 'PUT', json: body }))
				.status
		).toBe(401);
		// nicht-UUID in der URL
		expect((await put('abc', body)).status).toBe(422);
	});

	it('Fremdes Mitglied bleibt bei 404 unverändert (kein Seiteneffekt)', async () => {
		await put(fremd, { phones: phones(1), emails: emails(1) });
		const res = await M(`/members/${fremd}`, 'admin');
		const m = (await res.json()).data;
		expect(m.phones).toHaveLength(0);
		expect(m.emails).toHaveLength(0);
	});

	it('Unbekannte Felder/Body-Typen -> 422', async () => {
		expect((await put(kid, { phones: [], emails: emails(1), name: 'Hacker' })).status).toBe(422);
		expect((await put(kid, { phones: 'x', emails: emails(1) })).status).toBe(422);
		expect((await put(kid, { emails: emails(1) })).status).toBe(422);
		expect(
			(await put(kid, { phones: [{ name: null, value: 'abc' }], emails: emails(1) })).status
		).toBe(422);
		expect(
			(await put(kid, { phones: [], emails: [{ name: null, value: 'kein-mail' }] })).status
		).toBe(422);
	});

	it('Audit: nur Zahlen, keine Werte/Namen/IDs der Kontakte', async () => {
		resetAllForTests();
		await put(kid, { phones: phones(3), emails: emails(2) });
		const { rows: all } = await listAudit({ action: 'members.member.contacts', limit: 100 });
		const rows = all.filter((r) => r.action === 'members.member.contacts_updated');
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			const meta = (r.metadata ?? {}) as Record<string, unknown>;
			for (const [k, v] of Object.entries(meta))
				if (k !== 'memberId') expect(typeof v, k).toBe('number');
		}
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toMatch(/example\.test|\+49|e0@/);
	});

	it('Gescheiterte Anfragen schreiben keinen Audit-Eintrag', async () => {
		resetAllForTests();
		const before = (await listAudit({ action: 'members.member.contacts', limit: 500 })).rows.length;
		await put(kid, { phones: [], emails: [] });
		await put(fremd, { phones: [], emails: emails(1) });
		await put(kid, { phones: [], emails: emails(11) });
		const after = (await listAudit({ action: 'members.member.contacts', limit: 500 })).rows.length;
		expect(after).toBe(before);
	});

	it('Trennung der Eltern: Verknüpfung gelöst -> 404', async () => {
		const k2 = await mkMember('Zweitkind');
		await link(k2, 'eltern');
		expect((await put(k2, { phones: [], emails: [] })).status).toBe(200);
		await core.database.forModule('members').transaction(async (tx) => {
			await tx.execute(sql`DELETE FROM member_user_links WHERE member_id = ${k2}`);
		});
		expect((await put(k2, { phones: [], emails: [] })).status).toBe(404);
	});
});

describe('Mail-Abwahlen: Randfälle', () => {
	let kid = '';
	const pref = (id: string, json: unknown, who = 'eltern', prefix = '/my') =>
		M(`${prefix}/members/${id}/mail-prefs`, who, { method: 'PUT', json });
	const rows = async () =>
		(
			(await core.database
				.forModule('members')
				.transaction((tx) =>
					tx.execute(sql`SELECT member_id, category FROM member_mail_prefs`)
				)) as unknown as {
				rows: Record<string, unknown>[];
			}
		).rows;

	beforeAll(async () => {
		kid = await mkMember('Mailkind');
		await link(kid, 'eltern');
	});

	it('beide abschaltbaren Kategorien; idempotent; Wieder-An ohne Zeile ist ok', async () => {
		for (const category of ['payment-confirmation', 'action-info']) {
			expect((await pref(kid, { category, enabled: false })).status).toBe(200);
			expect((await pref(kid, { category, enabled: false })).status).toBe(200);
		}
		expect((await rows()).filter((r) => r.member_id === kid)).toHaveLength(2);
		for (const category of ['payment-confirmation', 'action-info']) {
			expect((await pref(kid, { category, enabled: true })).status).toBe(200);
			expect((await pref(kid, { category, enabled: true })).status).toBe(200);
		}
		expect((await rows()).filter((r) => r.member_id === kid)).toHaveLength(0);
	});

	it('Body-Validierung: fehlendes/nicht-boolesches enabled, zusätzliche Felder -> 422', async () => {
		expect((await pref(kid, { category: 'action-info' })).status).toBe(422);
		expect((await pref(kid, { category: 'action-info', enabled: 'false' })).status).toBe(422);
		expect((await pref(kid, { category: 'action-info', enabled: false, x: 1 })).status).toBe(422);
		expect((await pref(kid, { enabled: false })).status).toBe(422);
	});

	it('Zugriff: nur lesen -> 403, ohne Key -> 401, Verwaltungsroute ohne member.edit -> 403', async () => {
		const body = { category: 'action-info', enabled: false };
		expect((await pref(kid, body, 'lesen')).status).toBe(403);
		expect((await pref(kid, body, 'eltern', '')).status).toBe(403);
		expect(
			(await api(`/modules/members/my/members/${kid}/mail-prefs`, { method: 'PUT', json: body }))
				.status
		).toBe(401);
		expect((await pref('00000000-0000-4000-8000-000000000000', body, 'admin', '')).status).toBe(
			404
		);
	});

	it('Audit mit Kategorie und Flag, ohne personenbezogene Daten', async () => {
		resetAllForTests();
		await pref(kid, { category: 'action-info', enabled: false });
		const { rows: audit } = await listAudit({ action: 'members.member.mail', limit: 50 });
		expect(audit.length).toBeGreaterThan(0);
		const text = JSON.stringify(audit.map((a) => a.metadata));
		expect(text).toContain('action-info');
		expect(text).not.toMatch(/Mailkind|example\.test/);
		await pref(kid, { category: 'action-info', enabled: true });
	});
});

describe('defaultRoleGrants (Randfälle)', () => {
	const hasPerm = async (userId: string, key: string) => (await ctxOf(userId)).permissions.has(key);

	it('Rolle „Mitglied“ aus dem Manifest hat own.view und own.edit, ist kein System', async () => {
		const [r] = await getDb().select().from(schema.role).where(eq(schema.role.name, 'Mitglied'));
		expect(r).toBeTruthy();
		expect(r!.isSystem).toBe(false);
		const perms = await getDb()
			.select({ k: schema.rolePermission.permissionKey })
			.from(schema.rolePermission)
			.where(eq(schema.rolePermission.roleId, r!.id));
		expect(perms.map((p) => p.k).sort()).toEqual(['members.own.edit', 'members.own.view']);
	});

	it('gleichnamige, vorab angelegte Rolle bekommt Rechte erst nach ausdrücklicher Übernahme (#67, 01a-07)', async () => {
		const roleId = await createRole(admin, { name: 'Eltern-Bestand', permissions: [] });
		const uid = await createUser(admin, {
			name: 'Bestand',
			email: 'bestand@example.test',
			password: PW,
			roleIds: [roleId]
		});
		expect(await hasPerm(uid, 'grantx.thing.view')).toBe(false);
		registerModule({
			manifest: {
				id: 'grantx',
				name: 'Grant X',
				version: '1.0.0',
				dependencies: [],
				permissions: ['grantx.thing.view', 'grantx.thing.edit'],
				navigation: []
			},
			defaultRoleGrants: {
				'Eltern-Bestand': ['grantx.thing.view', 'grantx.thing.view']
			}
		});
		await syncModules();
		// Rechte deaktivierter Module sind nie wirksam: erst aktivieren
		await enableModule(admin, 'grantx');
		// Kein Namens-Squatting: die manuell angelegte Rolle hat keine Kennung → keine Modulrechte
		expect(await hasPerm(uid, 'grantx.thing.view')).toBe(false);
		await adoptDefaultRole(admin, roleId);
		await syncModules();
		expect(await hasPerm(uid, 'grantx.thing.view')).toBe(true);
		expect(await hasPerm(uid, 'grantx.thing.edit')).toBe(false);
		// Rolle nicht doppelt angelegt, Doppel-Einträge in der Liste führen nicht zu Duplikaten
		const roles = await getDb()
			.select()
			.from(schema.role)
			.where(eq(schema.role.name, 'Eltern-Bestand'));
		expect(roles).toHaveLength(1);
		const marks = await getDb().select().from(schema.roleGrantApplied);
		expect(marks.filter((m) => m.moduleId === 'grantx')).toHaveLength(1);
	});

	it('entzogenes Recht bleibt auch nach Sync und Rollen-Update entzogen (Marker bleibt)', async () => {
		const [r] = await getDb()
			.select()
			.from(schema.role)
			.where(eq(schema.role.name, 'Eltern-Bestand'));
		await getDb().delete(schema.rolePermission).where(eq(schema.rolePermission.roleId, r!.id));
		await syncModules();
		await syncModules();
		const left = await getDb()
			.select()
			.from(schema.rolePermission)
			.where(eq(schema.rolePermission.roleId, r!.id));
		expect(left).toHaveLength(0);
	});

	it('Rolle zwischenzeitlich gelöscht: Sync legt sie nicht erneut an, wenn alle Rechte markiert sind', async () => {
		const [r] = await getDb()
			.select()
			.from(schema.role)
			.where(eq(schema.role.name, 'Eltern-Bestand'));
		await getDb().delete(schema.role).where(eq(schema.role.id, r!.id));
		await syncModules();
		const again = await getDb()
			.select()
			.from(schema.role)
			.where(eq(schema.role.name, 'Eltern-Bestand'));
		expect(again).toHaveLength(0);
	});

	it('unbekanntes Recht in defaultRoleGrants: Sync schlägt fehl, Rolle wird nicht angelegt (#76, 10-10)', async () => {
		registerModule({
			manifest: {
				id: 'granty',
				name: 'Grant Y',
				version: '1.0.0',
				dependencies: [],
				permissions: ['granty.thing.view'],
				navigation: []
			},
			defaultRoleGrants: { 'Geister-Rolle': ['granty.unknown.x'] }
		});
		try {
			await expect(syncModules()).rejects.toThrow(/granty\.unknown\.x/);
		} finally {
			unregisterModule('granty');
		}
		expect(
			await getDb().select().from(schema.role).where(eq(schema.role.name, 'Geister-Rolle'))
		).toHaveLength(0);
	});
});

describe('Persönliche Themes (Profil-Actions)', () => {
	let uid: string;
	let other: string;
	beforeAll(async () => {
		uid = await createUser(admin, { name: 'Thea', email: 'thea@example.test', password: PW });
		other = await createUser(admin, { name: 'Otto', email: 'otto@example.test', password: PW });
	});

	async function act(name: string, fields: Record<string, string>, user = uid) {
		const f = new FormData();
		for (const [k, v] of Object.entries(fields)) f.set(k, v);
		const ctx = await ctxOf(user);
		const fn = profileActions[name as keyof typeof profileActions] as (e: unknown) => unknown;
		const res = (await fn({
			request: new Request(`${ORIGIN}/profile?/${name}`, { method: 'POST', body: f }),
			locals: { ctx, user: { id: user } },
			url: new URL(`${ORIGIN}/profile`)
		})) as { status?: number; data?: { error?: string }; success?: string };
		return { status: res.status ?? 200, error: res.data?.error, ok: res.status === undefined };
	}

	it('anlegen, ändern, aktivieren und löschen', async () => {
		const t = blankTheme(crypto.randomUUID(), 'Mein Wald');
		expect((await act('saveTheme', { theme: JSON.stringify(t), activate: '1' })).ok).toBe(true);
		let p = await loadUserPrefs(uid);
		expect(p.themes.map((x) => x.name)).toEqual(['Mein Wald']);
		expect(p.activeThemeId).toBe(t.id);
		expect(p.activeTheme?.name).toBe('Mein Wald');

		await act('saveTheme', { theme: JSON.stringify({ ...t, name: 'Umbenannt' }) });
		p = await loadUserPrefs(uid);
		expect(p.themes).toHaveLength(1);
		expect(p.themes[0]!.name).toBe('Umbenannt');

		expect((await act('activateTheme', { id: 'preset:ozean' })).ok).toBe(true);
		expect((await loadUserPrefs(uid)).activeTheme?.name).toBe('Ozean');
		expect((await act('activateTheme', { id: t.id })).ok).toBe(true);

		// Löschen des aktiven Themes setzt die Auswahl zurück
		expect((await act('deleteTheme', { id: t.id })).ok).toBe(true);
		p = await loadUserPrefs(uid);
		expect(p.themes).toEqual([]);
		expect(p.activeThemeId).toBe('');
		expect(p.activeTheme).toBeNull();
	});

	it('ungültige Daten, unbekannte und fremde Themes werden abgewiesen', async () => {
		expect((await act('saveTheme', { theme: '{kaputt' })).status).toBe(400);
		const bad = { ...blankTheme(crypto.randomUUID()), accent: 'red;}' };
		expect((await act('saveTheme', { theme: JSON.stringify(bad) })).status).toBe(400);

		const foreign = blankTheme(crypto.randomUUID(), 'Fremd');
		await act('saveTheme', { theme: JSON.stringify(foreign) }, other);
		expect((await act('activateTheme', { id: foreign.id })).status).toBe(400);
		expect((await act('activateTheme', { id: 'preset:gibtsnicht' })).status).toBe(400);
		expect((await act('deleteTheme', { id: foreign.id })).status).toBe(404);
		expect((await loadUserPrefs(other)).themes.map((x) => x.name)).toEqual(['Fremd']);
	});

	it('höchstens 20 eigene Themes', async () => {
		for (let i = 0; i < 20; i++) {
			const r = await act('saveTheme', {
				theme: JSON.stringify(blankTheme(crypto.randomUUID(), `T${i}`))
			});
			expect(r.ok).toBe(true);
		}
		const r = await act('saveTheme', { theme: JSON.stringify(blankTheme(crypto.randomUUID())) });
		expect(r.status).toBe(400);
		expect(r.error).toContain('20');
	});

	it('Favoriten: markieren, entfernen, Prüfungen und Aufräumen', async () => {
		const fav = await createUser(admin, { name: 'Fee', email: 'fee@example.test', password: PW });
		const ids = async () => (await loadUserPrefs(fav)).favorites.map((t) => t.id);
		expect((await act('toggleFavorite', { id: 'preset:ozean', on: '1' }, fav)).ok).toBe(true);
		expect((await act('toggleFavorite', { id: 'preset:wald', on: '1' }, fav)).ok).toBe(true);
		expect((await act('toggleFavorite', { id: 'preset:ozean', on: '1' }, fav)).ok).toBe(true);
		expect(await ids()).toEqual(['preset:wald', 'preset:ozean']);
		expect((await act('toggleFavorite', { id: 'preset:wald', on: '' }, fav)).ok).toBe(true);
		expect(await ids()).toEqual(['preset:ozean']);

		// Neues eigenes Theme wird automatisch Favorit; Löschen räumt den Favoriten mit weg
		const t = blankTheme(crypto.randomUUID(), 'Stern');
		await act('saveTheme', { theme: JSON.stringify(t) }, fav);
		expect(await ids()).toEqual(['preset:ozean', t.id]);
		await act('saveTheme', { theme: JSON.stringify({ ...t, name: 'Stern 2' }) }, fav);
		expect(await ids()).toEqual(['preset:ozean', t.id]);
		await act('deleteTheme', { id: t.id }, fav);
		expect(await ids()).toEqual(['preset:ozean']);

		// Unbekannte und fremde IDs
		expect((await act('toggleFavorite', { id: 'preset:gibtsnicht', on: '1' }, fav)).status).toBe(
			400
		);
		const foreign = blankTheme(crypto.randomUUID(), 'Fremd2');
		await act('saveTheme', { theme: JSON.stringify(foreign) }, other);
		expect((await act('toggleFavorite', { id: foreign.id, on: '1' }, fav)).status).toBe(400);

		// Verwaiste IDs (z. B. gelöschtes Theme) fallen beim Lesen still weg
		await setSetting(await ctxOf(fav), 'core.user.themeFavorites', [
			crypto.randomUUID(),
			'preset:ozean'
		]);
		expect(await ids()).toEqual(['preset:ozean']);
	});

	it('kaputte gespeicherte Daten führen zu keinem Theme statt zu Fehlern', async () => {
		await setSetting(await ctxOf(other), 'core.user.activeTheme', crypto.randomUUID());
		const p = await loadUserPrefs(other);
		expect(p.activeTheme).toBeNull();
		expect(p.activeThemeId).toBe('');
	});
});
