/**
 * Sicherheitsreview Profil: gesperrter HTTP-Weg für /change-email und /update-user, Rate-Limit und
 * Session-Widerruf beim E-Mail-Wechsel, Info-Mail bei Kontaktänderung durch verknüpfte Konten,
 * Startseiten-Schema, Avatar (Magic-Bytes, eigener Pfad, aktive Benutzer).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { settleMails } from '$testing';
import { fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { getAuth } from '$testing';
import { contextForUser } from '$testing';
import { readAvatar, removeOwnAvatar, requestEmailChange, setOwnAvatar } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { resetAllForTests } from '$testing';
import { setSetting } from '$testing';
import { resolveStartPage } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct-horse-battery';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
const mails: { to: string; subject: string; text: string }[] = [];
let failMail = false;
let admin: RequestContext;
let close: () => Promise<void>;

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
// wartet ereignisbasiert auf „fire and forget“ gesendete Mails (#75)
const flush = settleMails;

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

function postAuth(path: string, headers: Headers, json: unknown) {
	const h = new Headers(headers);
	h.set('content-type', 'application/json');
	return getAuth().handler(
		new Request(`${ORIGIN}/api/auth${path}`, {
			method: 'POST',
			headers: h,
			body: JSON.stringify(json)
		})
	);
}

const userRow = async (id: string) =>
	(await getDb().select().from(schema.user).where(eq(schema.user.id, id)))[0]!;
const sessionsOf = async (id: string) =>
	getDb().select().from(schema.session).where(eq(schema.session.userId, id));

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`${ORIGIN}/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}
const M = (path: string, who: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys[who], ...init });

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
	setMailTransportForTests({
		sendMail: async (m) => {
			if (failMail) throw new Error('SMTP kaputt');
			mails.push({ to: m.to, subject: m.subject, text: m.text });
		}
	});
});
afterAll(async () => {
	setMailTransportForTests(undefined);
	uninstallFakeStorage();
	await close();
});
beforeEach(() => {
	resetAllForTests();
	mails.length = 0;
	failMail = false;
});

describe('E-Mail-Wechsel: HTTP-Weg gesperrt, Action-Weg offen', () => {
	it('POST /api/auth/change-email mit gültiger Session -> 403, keine Mail, keine Änderung', async () => {
		const id = await createUser(admin, { name: 'Eva', email: 'eva@example.test', password: PW });
		const headers = await login('eva@example.test');
		const res = await postAuth('/change-email', headers, { newEmail: 'angreifer@example.test' });
		expect(res.status).toBe(403);
		await flush();
		expect(mails).toHaveLength(0);
		expect((await userRow(id)).email).toBe('eva@example.test');
		const verifications = await getDb().select().from(schema.verification);
		expect(JSON.stringify(verifications)).not.toContain('angreifer');
	});

	it('Action-Weg (auth.api ohne Request): Mail an die NEUE Adresse, Hinweis an die alte', async () => {
		const id = await createUser(admin, { name: 'Emil', email: 'emil@example.test', password: PW });
		const headers = await login('emil@example.test');
		await requestEmailChange(await ctxOf(id), headers, {
			newEmail: 'emil2@example.test',
			password: PW
		});
		await flush();
		const toNew = mails.filter((m) => m.to === 'emil2@example.test');
		const toOld = mails.filter((m) => m.to === 'emil@example.test');
		expect(toNew).toHaveLength(1);
		expect(toNew[0]!.text).toContain('/verify-email?token=');
		expect(toOld).toHaveLength(1);
		expect(toOld[0]!.text).not.toContain('emil2@example.test');
		expect((await userRow(id)).email).toBe('emil@example.test');
	});

	it('Hinweismail an die alte Adresse nur nach erfolgreichem changeEmail-Aufruf', async () => {
		const id = await createUser(admin, { name: 'Ella', email: 'ella@example.test', password: PW });
		// Ungültige Session-Header: changeEmail wirft, also darf keine Hinweismail rausgehen
		await expect(
			requestEmailChange(await ctxOf(id), new Headers({ origin: ORIGIN }), {
				newEmail: 'ella2@example.test',
				password: PW
			})
		).rejects.toBeDefined();
		await flush();
		expect(mails.filter((m) => m.to === 'ella@example.test')).toHaveLength(0);
	});

	it('POST /api/auth/update-user mit image/name -> 403, Profil unverändert', async () => {
		const id = await createUser(admin, { name: 'Udo', email: 'udo@example.test', password: PW });
		const headers = await login('udo@example.test');
		for (const body of [
			{ image: `/avatar/${userIds.admin}` },
			{ name: 'Hacker' },
			{ name: 'X', image: '/avatar/x' }
		]) {
			expect((await postAuth('/update-user', headers, body)).status).toBe(403);
		}
		const u = await userRow(id);
		expect(u.name).toBe('Udo');
		expect(u.image).toBeNull();
	});
});

describe('E-Mail-Wechsel: Rate-Limit und Sessions', () => {
	it('höchstens 3 Anfragen je Stunde und Benutzer (danach rate_limited)', async () => {
		const id = await createUser(admin, { name: 'Rita', email: 'rita@example.test', password: PW });
		const headers = await login('rita@example.test');
		const ctx = await ctxOf(id);
		for (let i = 1; i <= 3; i++) {
			await requestEmailChange(ctx, headers, { newEmail: `rita${i}@example.test`, password: PW });
		}
		await expect(
			requestEmailChange(ctx, headers, { newEmail: 'rita4@example.test', password: PW })
		).rejects.toMatchObject({ code: 'rate_limited' });
		// anderer Benutzer ist nicht betroffen
		const other = await createUser(admin, { name: 'Ron', email: 'ron@example.test', password: PW });
		await expect(
			requestEmailChange(await ctxOf(other), await login('ron@example.test'), {
				newEmail: 'ron2@example.test',
				password: PW
			})
		).resolves.toBeUndefined();
	});

	it('nach abgeschlossenem Wechsel sind alle ANDEREN Sessions widerrufen', async () => {
		const id = await createUser(admin, { name: 'Sven', email: 'sven@example.test', password: PW });
		const a = await login('sven@example.test');
		await login('sven@example.test');
		await login('sven@example.test');
		expect(await sessionsOf(id)).toHaveLength(3);
		await requestEmailChange(await ctxOf(id), a, { newEmail: 'sven2@example.test', password: PW });
		await flush();
		const mail = mails.find((m) => m.to === 'sven2@example.test')!;
		const link = /https?:\/\/\S+\/verify-email\?\S+/.exec(mail.text)![0];
		const ok = await getAuth().handler(new Request(link, { headers: a }));
		expect(ok.status).toBe(302);
		expect((await userRow(id)).email).toBe('sven2@example.test');
		const left = await sessionsOf(id);
		expect(left).toHaveLength(1);
		// die verbleibende Session gehört zum bestätigenden Browser
		const me = await getAuth().api.getSession({ headers: a });
		expect(me?.session.id).toBe(left[0]!.id);
		const { rows } = await listAudit({ target: id, limit: 50 });
		const done = rows.find((r) => r.action === 'core.auth.email_changed')!;
		expect(done.metadata).toMatchObject({ otherSessionsRevoked: 2 });
	});
});

describe('Kontaktänderung durch verknüpftes Konto: Info-Mail', () => {
	let kid = '';
	const emailsOf = async (member: string) =>
		(
			(await core.database
				.forModule('members')
				.transaction((tx) =>
					tx.execute(
						sql`SELECT value FROM member_emails WHERE member_id = ${member} ORDER BY position`
					)
				)) as unknown as { rows: { value: string }[] }
		).rows.map((r) => r.value);
	const put = (json: unknown) => M(`/my/members/${kid}/contacts`, 'mama', { method: 'PUT', json });

	beforeAll(async () => {
		const role = await createRole(admin, {
			name: 'r-mama',
			permissions: ['core.api.manage', 'members.own.view', 'members.own.edit']
		});
		userIds.mama = await createUser(admin, {
			name: 'Mama',
			email: 'mama-konto@example.test',
			password: PW,
			roleIds: [role]
		});
		const ctx = await ctxOf(userIds.mama);
		keys.mama = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
		const res = await M('/members', 'admin', {
			method: 'POST',
			json: {
				firstName: 'Lena',
				lastName: 'Muster',
				scoutName: null,
				birthDate: '2012-05-17',
				street: 'Weg 1',
				postalCode: '12345',
				city: 'Stadt',
				country: 'DE',
				phones: [{ name: 'Mutter', value: '+49 170 1234567' }],
				emails: [
					{ name: 'Mutter', value: 'alt1@example.test' },
					{ name: 'Vater', value: 'alt2@example.test' }
				],
				stage: 'pfadfinder',
				groupIds: []
			}
		});
		expect(res.status).toBe(201);
		kid = (await res.json()).data.id;
		await core.database.forModule('members').transaction(async (tx) => {
			await tx.execute(
				sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${kid}, ${userIds.mama!}, 'Mutter')`
			);
		});
	});

	it('nur Telefonliste geändert: keine Mail', async () => {
		const res = await put({
			phones: [{ name: 'Mutter', value: '+49 170 7654321' }],
			emails: [
				{ name: 'Mutter', value: 'alt1@example.test' },
				{ name: 'Vater', value: 'alt2@example.test' }
			]
		});
		expect(res.status).toBe(200);
		await flush();
		expect(mails).toHaveLength(0);
	});

	it('E-Mail-Liste geändert: je eine Mail an die BISHERIGEN Adressen, ohne neue Adresse im Text', async () => {
		const res = await put({
			phones: [{ name: 'Mutter', value: '+49 170 7654321' }],
			emails: [
				{ name: 'Mutter', value: 'alt1@example.test' },
				{ name: 'Neu', value: 'angreifer@example.test' }
			]
		});
		expect(res.status).toBe(200);
		expect(mails.map((m) => m.to).sort()).toEqual(['alt1@example.test', 'alt2@example.test']);
		for (const m of mails) {
			expect(m.text).toContain('Lena');
			expect(m.text).toContain('Stammesleitung');
			expect(m.text).not.toContain('angreifer');
			expect(m.subject).not.toContain('angreifer');
		}
		const { rows } = await listAudit({ target: kid, limit: 50 });
		const audit = rows.filter((r) => r.action === 'members.member.contacts_updated');
		expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain('@');
		expect(JSON.stringify(audit.map((a) => a.metadata))).toContain('emailsAdded');
	});

	it('Mailfehler bricht das Speichern nicht ab', async () => {
		failMail = true;
		const res = await put({
			phones: [],
			emails: [{ name: 'Mutter', value: 'wieder@example.test' }]
		});
		expect(res.status).toBe(200);
		expect(await emailsOf(kid)).toEqual(['wieder@example.test']);
		expect(mails).toHaveLength(0);
	});
});

describe('Startseite', () => {
	it("'//x' wird vom Schema abgelehnt, gültige Pfade bleiben erlaubt", async () => {
		const id = await createUser(admin, { name: 'Sara', email: 'sara@example.test', password: PW });
		const ctx = await ctxOf(id);
		for (const bad of ['//x', '//evil.example', '/A']) {
			await expect(setSetting(ctx, 'core.user.startPage', bad)).rejects.toMatchObject({
				code: 'validation_failed'
			});
		}
		await expect(
			setSetting(ctx, 'core.user.startPage', '/modules/members')
		).resolves.toBeUndefined();
		expect(resolveStartPage('//x', ['//x'])).toBe('/dashboard');
	});
});

describe('Profilbild', () => {
	let id: string;
	let other: string;
	// Echte kleine Bilder: Profilbilder laufen durch `core.images` (#19)
	let png: Uint8Array;
	let jpeg: Uint8Array;
	let webp: Uint8Array;
	const make = async (format: 'png' | 'jpeg' | 'webp') =>
		new Uint8Array(
			await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aa3300' } })
				.toFormat(format)
				.toBuffer()
		);

	beforeAll(async () => {
		png = await make('png');
		jpeg = await make('jpeg');
		webp = await make('webp');
		id = await createUser(admin, { name: 'Ava', email: 'ava-sec@example.test', password: PW });
		other = await createUser(admin, { name: 'Ole', email: 'ole@example.test', password: PW });
		await installFakeStorage(admin);
	});

	it('Magic-Bytes: Typ muss zum Inhalt passen (HTML/Text als PNG -> 400)', async () => {
		const ctx = await ctxOf(id);
		const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
		for (const [data, contentType] of [
			[html, 'image/png'],
			[html, 'image/jpeg'],
			[html, 'image/webp'],
			[jpeg, 'image/png'],
			[png, 'image/jpeg'],
			[png, 'image/webp'],
			[new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 1, 2, 3, 4]), 'image/webp']
		] as [Uint8Array, string][]) {
			await expect(setOwnAvatar(ctx, { data, contentType })).rejects.toMatchObject({
				code: 'bad_request'
			});
		}
		expect((await userRow(id)).image).toBeNull();
		expect(fakeObjects.size).toBe(0);
	});

	it('gültige PNG/JPEG/WebP werden akzeptiert und gelesen', async () => {
		const ctx = await ctxOf(id);
		for (const [data, contentType] of [
			[png, 'image/png'],
			[jpeg, 'image/jpeg'],
			[webp, 'image/webp']
		] as [Uint8Array, string][]) {
			await setOwnAvatar(ctx, { data, contentType });
			// gespeichert wird immer neu kodiertes WebP
			expect((await readAvatar(id))?.contentType).toBe('image/webp');
		}
	});

	it('fremder /avatar/<id>-Wert in user.image liefert kein Bild; eigener Pfad schon', async () => {
		await setOwnAvatar(await ctxOf(other), { data: png, contentType: 'image/png' });
		await getDb()
			.update(schema.user)
			.set({ image: `/avatar/${other}?v=1` })
			.where(eq(schema.user.id, id));
		expect(await readAvatar(id)).toBeNull();
		expect(await readAvatar(other)).not.toBeNull();
		await getDb()
			.update(schema.user)
			.set({ image: `/avatar/${id}` })
			.where(eq(schema.user.id, id));
		expect(await readAvatar(id)).not.toBeNull();
	});

	it('deaktivierte Benutzer liefern kein Bild', async () => {
		expect(await readAvatar(other)).not.toBeNull();
		await getDb().update(schema.user).set({ active: false }).where(eq(schema.user.id, other));
		expect(await readAvatar(other)).toBeNull();
		await getDb().update(schema.user).set({ active: true }).where(eq(schema.user.id, other));
	});

	it('removeOwnAvatar löscht Bild und Datei sauber', async () => {
		const ctx = await ctxOf(other);
		const before = fakeObjects.size;
		await removeOwnAvatar(ctx);
		expect((await userRow(other)).image).toBeNull();
		expect(fakeObjects.size).toBe(before - 1);
		expect(await readAvatar(other)).toBeNull();
	});
});
