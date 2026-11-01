import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, setUserActive } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { createRole } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PW = 'correct-horse-battery';
const PW = 'parent-password-123';
const BASE = '/modules/members';

let admin: RequestContext;
let fullKey: string;
let viewKey: string;
let lettersKey: string;
let apiRoleId: string;
const parents: Record<string, { id: string; key: string }> = {};
let html = '';

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

const pub = (path: string, init: Parameters<typeof api>[1] = {}) => {
	resetAllForTests();
	return api(`${BASE}/public/link${path}`, init);
};
const post = (path: string, json: unknown, token?: string) =>
	pub(path, { method: 'POST', json, token });

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
	emails: [],
	stage: 'pfadfinder',
	groupIds: [],
	consentSocialMedia: false,
	consentWebsite: false,
	consentPrint: false,
	...over
});

async function mkMember(firstName: string, groupIds: string[], over: Record<string, unknown> = {}) {
	const res = await call('/members', {
		method: 'POST',
		json: memberBody({ firstName, groupIds, ...over })
	});
	return (await data<{ id: string }>(res, 201)).id;
}

async function mkParent(name: string) {
	const id = await createUser(admin, {
		name,
		email: `${name.toLowerCase()}@example.test`,
		password: PW,
		roleIds: [apiRoleId]
	});
	const r = await contextForUser(id);
	const key = (
		await createApiKey(r!.ctx, {
			name: 'p',
			scopes: ['core.api.manage', 'members.own.view', 'members.own.edit']
		})
	).key;
	parents[name] = { id, key };
}

function tokenAndCode() {
	return {
		token: /verknuepfen\/([0-9a-f]{32})/.exec(html)![1]!,
		code: />(\d{3}) (\d{3})</.exec(html)!.slice(1, 3).join('')
	};
}

async function letter(id: string) {
	const res = await call(`/members/${id}/link-letter.pdf`);
	expect(res.status).toBe(200);
	return res;
}

async function expireCode(memberId: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE member_link_codes SET expires_at = now() - interval '1 day' WHERE member_id = ${memberId}`
		);
	});
}

beforeAll(async () => {
	setPdfRendererForTests(async (h) => {
		html = h;
		const d = await PDFDocument.create();
		d.addPage([200, 300]);
		return d.save();
	});
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin(ADMIN_EMAIL, ADMIN_PW);
	const [u] = await getDb().select().from(schema.user).where(eq(schema.user.email, ADMIN_EMAIL));
	const ctxOf = async () => (await contextForUser(u!.id))!.ctx;
	admin = await ctxOf();
	await enableModule(admin, 'members');
	admin = await ctxOf();
	fullKey = (
		await createApiKey(admin, { name: 'full', scopes: [...membersModule.manifest.permissions] })
	).key;
	lettersKey = (
		await createApiKey(admin, {
			name: 'l',
			scopes: ['members.member.view', 'members.link.manage']
		})
	).key;
	viewKey = (
		await createApiKey(admin, { name: 'v', scopes: ['members.member.view', 'members.link.view'] })
	).key;
	apiRoleId = await createRole(admin, {
		name: 'api-role',
		permissions: ['core.api.manage', 'members.own.view', 'members.own.edit']
	});
});
afterAll(() => setPdfRendererForTests(undefined));

describe('Konto-Verknüpfung', () => {
	let leaderId: string;
	let groupId: string;
	let kid1: string;
	let kid2: string;
	let token = '';
	let code = '';

	it('Aufbau', async () => {
		leaderId = await mkMember('Leiter', []);
		const g = await data<{ id: string }>(
			await call('/groups', {
				method: 'POST',
				json: { name: 'Gruppe', type: 'sippe', leaderIds: [leaderId] }
			}),
			201
		);
		groupId = g.id;
		kid1 = await mkMember('Kind', [g.id]);
		kid2 = await mkMember('Zweitkind', [g.id], {
			street: 'Anderweg 2',
			postalCode: '54321',
			city: 'Andernstadt'
		});
		await mkParent('Mutter');
		await mkParent('Vater');
	});

	it('erzeugt den Brief mit Adressfeld, QR, Link und Code', async () => {
		const res = await letter(kid1);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-disposition')).toContain('attachment');
		expect(html).toContain('Eltern von Kind Muster');
		expect(html).toContain('Musterweg 1');
		expect(html).toContain('12345 Musterstadt');
		expect(html).toContain('künftig online verwalten');
		expect(html).toMatch(/<img src="data:image\/png;base64,/);
		// Sichtbar ohne Schema (der QR-Code enthält die volle URL)
		expect(html).toMatch(/>localhost:5173\/p\/members\/verknuepfen\/[0-9a-f]{32}</);
		({ token, code } = tokenAndCode());
		expect(code).toMatch(/^\d{6}$/);
	});

	it('Volljährige werden selbst angeschrieben, nicht „Eltern von“', async () => {
		const adult = await mkMember('Erwachsen', [groupId], {
			birthDate: '2000-01-31',
			country: 'AT',
			postalCode: '1010',
			city: 'Wien'
		});
		await letter(adult);
		expect(html).toContain('Erwachsen Muster');
		expect(html).not.toContain('Eltern von Erwachsen');
		expect(html).toContain('ÖSTERREICH');
		expect(html).toContain('Ihre Mitgliedschaft');
		expect(html).not.toContain('beide Elternteile');
		// Kind-Brief danach wieder wie gehabt (Token/Code des Kindes bleiben erhalten)
		await letter(kid1);
		expect(html).toContain('Eltern von Kind Muster');
	});

	it('verwendet denselben Code erneut, bis er neu erzeugt wird', async () => {
		await letter(kid1);
		expect(tokenAndCode()).toEqual({ token, code });
		await data(await call(`/members/${kid1}/link-code`, { method: 'POST' }), 201);
		await letter(kid1);
		const next = tokenAndCode();
		expect(next.token).not.toBe(token);
		const old = token;
		({ token, code } = next);
		expect((await pub(`/${old}`)).status).toBe(404);
	});

	it('öffentliche Info: nur Vorname, ohne Anmeldung viewer null', async () => {
		const info = await data<{ memberFirstName: string; viewer: unknown }>(await pub(`/${token}`));
		expect(info).toEqual({ memberFirstName: 'Kind', viewer: null });
		expect((await pub('/nichtgueltig')).status).toBe(422);
		expect((await pub(`/${'0'.repeat(32)}`)).status).toBe(404);
	});

	it('claim: ohne Anmeldung 401, falscher Code 403, richtiger Code verknüpft (idempotent)', async () => {
		expect((await post(`/${token}/claim`, { code })).status).toBe(401);
		const mutter = parents.Mutter!;
		expect((await post(`/${token}/claim`, { code: '000000' }, mutter.key)).status).toBe(403);
		expect((await post(`/${token}/claim`, { code: '12' }, mutter.key)).status).toBe(422);
		await data(await post(`/${token}/claim`, { code, relation: 'Mutter' }, mutter.key), 201);
		await data(await post(`/${token}/claim`, { code }, mutter.key), 201);
		await data(await post(`/${token}/claim`, { code, relation: 'Vater' }, parents.Vater!.key), 201);
		const links = await data<{ users: { name: string; relation: string | null }[] }>(
			await call(`/members/${kid1}/links`)
		);
		expect(links.users.map((x) => x.name).sort()).toEqual(['Mutter', 'Vater']);
		expect(links.users.find((x) => x.name === 'Mutter')!.relation).toBe('Mutter');
	});

	it('ein Elternteil mit mehreren Kindern; /my/members', async () => {
		await letter(kid2);
		const t2 = tokenAndCode();
		await data(await post(`/${t2.token}/claim`, { code: t2.code }, parents.Mutter!.key), 201);
		const mine = await data<{ firstName: string }[]>(
			await api(`${BASE}/my/members`, { token: parents.Mutter!.key })
		);
		expect(mine.map((m) => m.firstName).sort()).toEqual(['Kind', 'Zweitkind']);
		const vater = await data<unknown[]>(
			await api(`${BASE}/my/members`, { token: parents.Vater!.key })
		);
		expect(vater).toHaveLength(1);
		expect((await api(`${BASE}/my/members`)).status).toBe(401);
	});

	it('Mitgliederdetail zeigt die Anzahl verknüpfter Konten', async () => {
		const m = await data<{ linkCount: number }>(await call(`/members/${kid1}`));
		expect(m.linkCount).toBe(2);
	});

	it('register legt ein Konto mit Rolle „Mitglied“ an und verknüpft es', async () => {
		const body = {
			code,
			name: 'Oma Muster',
			email: 'Oma@Example.test',
			password: PW,
			relation: 'Oma'
		};
		// Mutter + Vater haben den Code schon genutzt; er bleibt bis zum Ablauf gültig
		const status = await data<{ code: { uses: number; expired: boolean } }>(
			await call(`/members/${kid1}/links`)
		);
		expect(status.code).toMatchObject({ uses: 2, expired: false });
		await data(await call(`/members/${kid1}/link-code`, { method: 'POST' }), 201);
		await letter(kid1);
		({ token, code } = tokenAndCode());
		body.code = code;
		expect((await post(`/${token}/register`, { ...body, code: '999999' })).status).toBe(403);
		expect((await post(`/${token}/register`, { ...body, password: 'kurz' })).status).toBe(422);
		await data(await post(`/${token}/register`, body), 201);
		const [u] = await getDb()
			.select()
			.from(schema.user)
			.where(eq(schema.user.email, 'oma@example.test'));
		expect(u).toBeTruthy();
		// Selbstregistrierung: unbestätigt, Anmeldung erst nach Bestätigung (#18)
		expect(u!.emailVerified).toBe(false);
		const roles = await getDb()
			.select({ name: schema.role.name })
			.from(schema.userRole)
			.innerJoin(schema.role, eq(schema.role.id, schema.userRole.roleId))
			.where(eq(schema.userRole.userId, u!.id));
		expect(roles.map((r) => r.name)).toEqual(['Mitglied']);
		const links = await data<{ users: { email: string }[] }>(await call(`/members/${kid1}/links`));
		expect(links.users.map((x) => x.email)).toContain('oma@example.test');
		expect((await post(`/${token}/register`, body)).status).toBe(409);
	});

	it('sperrt nach 10 Fehlversuchen (auch für den richtigen Code); neuer Code hebt es auf', async () => {
		const mutter = parents.Mutter!;
		const wrong = code === '000000' ? '000001' : '000000';
		for (let i = 0; i < 10; i++) {
			expect((await post(`/${token}/claim`, { code: wrong }, mutter.key)).status).toBe(403);
		}
		expect((await post(`/${token}/claim`, { code }, mutter.key)).status).toBe(403);
		const l = await data<{ code: { locked: boolean } }>(await call(`/members/${kid1}/links`));
		expect(l.code.locked).toBe(true);
		await letter(kid1); // gleicher (gesperrter) Code
		await data(await call(`/members/${kid1}/link-code`, { method: 'POST' }), 201);
		await letter(kid1);
		({ token, code } = tokenAndCode());
		await data(await post(`/${token}/claim`, { code }, mutter.key), 201);
	});

	it('abgelaufener Code: Link 404, der nächste Brief erzeugt einen neuen', async () => {
		await expireCode(kid1);
		expect((await pub(`/${token}`)).status).toBe(404);
		await letter(kid1);
		const next = tokenAndCode();
		expect(next.token).not.toBe(token);
		({ token, code } = next);
		expect((await pub(`/${token}`)).status).toBe(200);
	});

	it('Verknüpfung lösen', async () => {
		expect(
			(await call(`/members/${kid1}/links/${parents.Vater!.id}`, { method: 'DELETE' })).status
		).toBe(200);
		expect(
			(await call(`/members/${kid1}/links/${parents.Vater!.id}`, { method: 'DELETE' })).status
		).toBe(404);
		const vater = await data<unknown[]>(
			await api(`${BASE}/my/members`, { token: parents.Vater!.key })
		);
		expect(vater).toHaveLength(0);
	});

	it('Konto per Hand verknüpfen (ohne Code)', async () => {
		const vaterId = parents.Vater!.id;
		const found = await data<{ id: string; name: string; email: string }[]>(
			await call('/link-users?search=vat')
		);
		expect(found.map((u) => u.id)).toContain(vaterId);
		expect(await data<unknown[]>(await call('/link-users?search=v'))).toEqual([]);

		const links = await data<{ users: { id: string; relation: string | null }[] }>(
			await call(`/members/${kid1}/links`, {
				method: 'POST',
				json: { userId: vaterId, relation: 'Vater' }
			}),
			201
		);
		expect(links.users.find((u) => u.id === vaterId)?.relation).toBe('Vater');
		const vater = await data<{ id: string }[]>(
			await api(`${BASE}/my/members`, { token: parents.Vater!.key })
		);
		expect(vater.map((m) => m.id)).toEqual([kid1]);

		// doppelt → 409, unbekanntes Konto/Mitglied → 422/404, Fremdfelder → 422
		const again = await call(`/members/${kid1}/links`, {
			method: 'POST',
			json: { userId: vaterId }
		});
		expect(again.status).toBe(409);
		const unknownUser = await call(`/members/${kid1}/links`, {
			method: 'POST',
			json: { userId: 'gibt-es-nicht' }
		});
		expect(unknownUser.status).toBe(422);
		expect((await unknownUser.json()).error.code).toBe('validation_failed');
		expect(
			(
				await call(`/members/${crypto.randomUUID()}/links`, {
					method: 'POST',
					json: { userId: vaterId }
				})
			).status
		).toBe(404);
		expect(
			(
				await call(`/members/${kid1}/links`, {
					method: 'POST',
					json: { userId: vaterId, extra: 1 }
				})
			).status
		).toBe(422);

		// deaktivierte Konten lassen sich nicht verknüpfen
		const inactive = await createUser(admin, {
			name: 'Inaktiv',
			email: 'inaktiv@example.test',
			password: PW,
			roleIds: []
		});
		await setUserActive(admin, inactive, false);
		expect(
			(await call(`/members/${kid1}/links`, { method: 'POST', json: { userId: inactive } })).status
		).toBe(422);

		// wieder lösen, damit die folgenden Tests den alten Stand sehen
		expect((await call(`/members/${kid1}/links/${vaterId}`, { method: 'DELETE' })).status).toBe(
			200
		);
	});

	it('Sammel-PDF: ein Brief je Mitglied in einem Dokument', async () => {
		const res = await call('/members/link-letters.pdf', {
			method: 'POST',
			json: { ids: [kid1, kid2, leaderId] }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
		expect(doc.getPageCount()).toBe(3);
		expect(
			(await call('/members/link-letters.pdf', { method: 'POST', json: { ids: [] } })).status
		).toBe(422);
		const unknown = await call('/members/link-letters.pdf', {
			method: 'POST',
			json: { ids: [kid1, crypto.randomUUID()] }
		});
		expect(unknown.status).toBe(404);
	});

	it('Rechte: Ansehen ja, Verwalten nur mit link.manage', async () => {
		const as = (path: string, token?: string, method = 'GET') =>
			api(`${BASE}${path}`, { token, method }).then((r) => r.status);
		expect(await as(`/members/${kid1}/links`, viewKey)).toBe(200);
		expect(await as(`/members/${kid1}/link-code`, viewKey, 'POST')).toBe(403);
		expect(await as(`/members/${kid1}/link-letter.pdf`, viewKey)).toBe(403);
		expect(await as(`/members/${kid1}/links/x`, viewKey, 'DELETE')).toBe(403);
		expect(await as(`/members/${kid1}/links`, viewKey, 'POST')).toBe(403);
		expect(await as(`/link-users?search=ma`, viewKey)).toBe(403);
		expect(await as(`/members/${kid1}/links`, lettersKey)).toBe(403);
		expect(await as(`/members/${kid1}/link-letter.pdf`, lettersKey)).toBe(200);
		expect(await as(`/members/${kid1}/links`)).toBe(401);
	});

	it('Mitglied löschen entfernt Verknüpfungen und Codes', async () => {
		expect((await call(`/members/${kid2}`, { method: 'DELETE' })).status).toBe(200);
		const mine = await data<{ firstName: string }[]>(
			await api(`${BASE}/my/members`, { token: parents.Mutter!.key })
		);
		expect(mine.map((m) => m.firstName)).toEqual(['Kind']);
	});

	it('Audit ohne Code, Namen oder E-Mail-Adressen', async () => {
		for (const action of [
			'members.link.code',
			'members.link.created',
			'members.link.registered',
			'members.link.removed',
			'members.link.letters'
		]) {
			const { rows } = await listAudit({ action });
			expect(rows.length, action).toBeGreaterThan(0);
			const text = JSON.stringify(rows.map((r) => r.metadata));
			expect(text).not.toContain(code);
			expect(text).not.toContain('example.test');
			expect(text).not.toContain('Oma');
		}
	});

	it('deaktiviertes Modul: öffentliche Seite nicht erreichbar', async () => {
		await disableModule(admin, 'members');
		expect((await pub(`/${token}`)).status).toBe(404);
	});
});
