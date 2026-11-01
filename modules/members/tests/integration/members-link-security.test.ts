/**
 * #18: Verknüpfungscode nur begrenzt oft nutzbar (Standard 2), Hinweismail an bereits verknüpfte Konten,
 * Selbstregistrierung über den Brief erst nach E-Mail-Bestätigung anmeldbar.
 * #26: Mitglieder-Audit ohne Klarnamen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { useTestDatabase } from '$testing';
import { settleMails } from '$testing';
import { getDb, schema } from '$testing';
import { getAuth } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, getUser, verifyUserEmail } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { createRole } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'parent-password-123';
const BASE = '/modules/members';
let admin: RequestContext;
let fullKey: string;
let roleId: string;
let html = '';
let close: () => Promise<void>;
const mails: { to: string; subject: string; text: string }[] = [];
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
const call = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: fullKey, ...init });
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
const post = (path: string, json: unknown, token?: string) => {
	resetAllForTests();
	return api(`${BASE}/public/link${path}`, { method: 'POST', json, token });
};
// wartet ereignisbasiert auf „fire and forget“ gesendete Mails (#75)
const flush = settleMails;

async function mkMember(firstName: string) {
	const res = await call('/members', {
		method: 'POST',
		json: {
			firstName,
			lastName: 'Geheimname',
			scoutName: null,
			birthDate: '2014-03-02',
			street: 'Weg 1',
			postalCode: '12345',
			city: 'Stadt',
			country: 'DE',
			phones: [],
			emails: [],
			stage: 'pfadfinder',
			groupIds: [],
			consentSocialMedia: false,
			consentWebsite: false,
			consentPrint: false
		}
	});
	return (await data<{ id: string }>(res, 201)).id;
}

async function mkParent(name: string) {
	const id = await createUser(admin, {
		name,
		email: `${name.toLowerCase()}@example.test`,
		password: PW,
		roleIds: [roleId]
	});
	keys[name] = (
		await createApiKey((await contextForUser(id))!.ctx, {
			name: 'p',
			scopes: ['core.api.manage', 'members.own.view']
		})
	).key;
}

async function letterOf(memberId: string, regenerate = false) {
	if (regenerate) await data(await call(`/members/${memberId}/link-code`, { method: 'POST' }), 201);
	expect((await call(`/members/${memberId}/link-letter.pdf`)).status).toBe(200);
	return {
		token: /verknuepfen\/([0-9a-f]{32})/.exec(html)![1]!,
		code: />(\d{3}) (\d{3})</.exec(html)!.slice(1, 3).join('')
	};
}

beforeAll(async () => {
	setPdfRendererForTests(async (h) => {
		html = h;
		const d = await PDFDocument.create();
		d.addPage([200, 300]);
		return d.save();
	});
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = (await contextForUser(u!.id))!.ctx;
	await enableModule(admin, 'members');
	admin = (await contextForUser(u!.id))!.ctx;
	fullKey = (
		await createApiKey(admin, { name: 'f', scopes: [...membersModule.manifest.permissions] })
	).key;
	roleId = await createRole(admin, {
		name: 'eltern',
		permissions: ['core.api.manage', 'members.own.view']
	});
	for (const n of ['Mutter', 'Vater', 'Fremd']) await mkParent(n);
	setMailTransportForTests({
		sendMail: async (m) => {
			mails.push({ to: m.to, subject: m.subject, text: m.text });
		}
	});
});
afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	await close();
});
beforeEach(() => {
	mails.length = 0;
});

describe('Verknüpfungscode: bis zum Ablauf gültig, Benachrichtigung (#18)', () => {
	let kid: string;
	let token = '';
	let code = '';

	it('Brief: mehrere Personen können den Code bis zum Ablauf nutzen', async () => {
		kid = await mkMember('Lina');
		({ token, code } = await letterOf(kid));
		expect(html).toContain('bis zum Ablauf nutzen');
	});

	it('erste Verknüpfung: keine Hinweismail; wiederholtes Einlösen verbraucht nichts', async () => {
		await data(await post(`/${token}/claim`, { code }, keys.Mutter), 201);
		await data(await post(`/${token}/claim`, { code }, keys.Mutter), 201);
		await flush();
		expect(mails).toHaveLength(0);
		const l = await data<{ code: { uses: number } }>(await call(`/members/${kid}/links`));
		expect(l.code).toMatchObject({ uses: 1 });
	});

	it('zweite Verknüpfung: Mail an das bereits verknüpfte Konto + Audit', async () => {
		await data(await post(`/${token}/claim`, { code }, keys.Vater), 201);
		await flush();
		expect(mails.map((m) => m.to)).toEqual(['mutter@example.test']);
		expect(mails[0]!.subject).toContain('Weiteres Konto mit Lina verknüpft');
		expect(mails[0]!.text).not.toContain('vater@');
		const { rows } = await listAudit({ action: 'members.link.created', target: kid });
		expect(rows.some((r) => (r.metadata as { notified?: number }).notified === 1)).toBe(true);
	});

	it('dritte Verknüpfung mit demselben Code klappt bis zum Ablauf (alle bisherigen informiert)', async () => {
		await data(await post(`/${token}/claim`, { code }, keys.Fremd), 201);
		await flush();
		expect(mails.map((m) => m.to).sort()).toEqual(['mutter@example.test', 'vater@example.test']);
		const l = await data<{ users: unknown[]; code: { uses: number; expired: boolean } }>(
			await call(`/members/${kid}/links`)
		);
		expect(l.users).toHaveLength(3);
		expect(l.code).toMatchObject({ uses: 3, expired: false });
	});

	it('der nächste Brief behält den gültigen Code', async () => {
		const next = await letterOf(kid);
		expect(next.token).toBe(token);
	});
});

describe('Registrierung über den Brief: erst nach E-Mail-Bestätigung (#18)', () => {
	it('Konto unbestätigt, Login vorher abgelehnt, nach dem Link möglich; verknüpfte Konten informiert', async () => {
		const kid = await mkMember('Mia');
		const { token, code } = await letterOf(kid);
		await data(await post(`/${token}/claim`, { code }, keys.Mutter), 201);
		mails.length = 0;
		await data(
			await post(`/${token}/register`, {
				code,
				name: 'Oma Mia',
				email: 'oma.mia@example.test',
				password: PW,
				relation: 'Oma'
			}),
			201
		);
		await flush();
		const [u] = await getDb()
			.select()
			.from(schema.user)
			.where(eq(schema.user.email, 'oma.mia@example.test'));
		expect(u!.emailVerified).toBe(false);
		expect(mails.some((m) => m.to === 'mutter@example.test')).toBe(true);
		const verify = mails.find((m) => m.to === 'oma.mia@example.test');
		expect(verify?.subject).toContain('E-Mail-Adresse bestätigen');
		const link = /\/verify-email\?token=([^&\s]+)/.exec(verify!.text)![1]!;

		resetAllForTests();
		await expect(
			getAuth().api.signInEmail({ body: { email: 'oma.mia@example.test', password: PW } })
		).rejects.toMatchObject({ body: { code: 'EMAIL_NOT_VERIFIED' } });
		const sessions = await getDb()
			.select()
			.from(schema.session)
			.where(eq(schema.session.userId, u!.id));
		expect(sessions).toHaveLength(0);

		// Bestätigungslink (ohne Session erlaubt, erzeugt selbst keine Session)
		await getAuth().api.verifyEmail({ query: { token: decodeURIComponent(link) } });
		const [after] = await getDb().select().from(schema.user).where(eq(schema.user.id, u!.id));
		expect(after!.emailVerified).toBe(true);
		const res = await getAuth().api.signInEmail({
			body: { email: 'oma.mia@example.test', password: PW }
		});
		expect(res.user.id).toBe(u!.id);
		const { rows } = await listAudit({ action: 'core.auth.email_verified', target: u!.id });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.actorName).toBe('o***@example.test');
	});

	it('Verwaltung sieht unbestätigte Konten und kann sie von Hand bestätigen', async () => {
		const kid = await mkMember('Paul');
		const { token, code } = await letterOf(kid);
		await data(
			await post(`/${token}/register`, {
				code,
				name: 'Opa Paul',
				email: 'opa.paul@example.test',
				password: PW,
				relation: 'Opa'
			}),
			201
		);
		await flush();
		const [u] = await getDb()
			.select()
			.from(schema.user)
			.where(eq(schema.user.email, 'opa.paul@example.test'));
		expect((await getUser(admin, u!.id)).emailVerified).toBe(false);

		const usersKey = (await createApiKey(admin, { name: 'u', scopes: [...admin.permissions] })).key;
		const res = await api(`/users/${u!.id}/verify-email`, { token: usersKey, method: 'POST' });
		expect((await data<{ emailVerified: boolean }>(res, 201)).emailVerified).toBe(true);
		resetAllForTests();
		const signIn = await getAuth().api.signInEmail({
			body: { email: 'opa.paul@example.test', password: PW }
		});
		expect(signIn.user.id).toBe(u!.id);
		const { rows } = await listAudit({ action: 'core.user.email_verified', target: u!.id });
		expect(rows).toHaveLength(1);
		// Wiederholen schadet nicht, unbekannte Konten → 404
		await verifyUserEmail(admin, u!.id);
		await expect(verifyUserEmail(admin, 'gibt-es-nicht')).rejects.toMatchObject({ status: 404 });
	});
});

describe('Mitglieder-Audit ohne Klarnamen (#26)', () => {
	it('created/updated/deleted enthalten weder Vor- noch Nachnamen', async () => {
		const id = await mkMember('Klarname');
		await data(await call(`/members/${id}`, { method: 'DELETE' }));
		for (const action of ['members.member.created', 'members.member.deleted']) {
			const { rows } = await listAudit({ action, target: id });
			expect(rows.length, action).toBeGreaterThan(0);
			const text = JSON.stringify(rows.map((r) => r.metadata));
			expect(text).not.toContain('Klarname');
			expect(text).not.toContain('Geheimname');
		}
	});
});
