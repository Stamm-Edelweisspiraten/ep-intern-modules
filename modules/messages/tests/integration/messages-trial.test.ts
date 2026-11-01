/**
 * Probestunden-Formular der Website → Posteingang der passenden Gruppe (`messages`, `POST /website/trial`):
 * Zuordnung nach Alter bzw. gewählter Gruppe, Rückfall ins Stamm-Postfach (Gruppe ohne Postfach/Leitung),
 * Benachrichtigung der Gruppenleitung, Spam-Schutz (gleiche Aufgabe wie das Kontaktformular, einmalig), Audit ohne Daten.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { settleMails } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests, type MailTransport } from '$testing';
import { resetAllForTests } from '$testing';
import { setSettings } from '$testing';
import membersModule from '$modules/members/module';
import messagesModule from '$modules/messages/module';
import type { PowChallenge } from '$modules/messages/contact-pow';
import type { InboxDetail, InboxListResponse } from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'trial-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let mails: Parameters<MailTransport['sendMail']>[0][] = [];
let meuteKey = '';

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
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function errOf(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error as { code: string; message: string; details?: unknown };
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const M = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/messages${path}`, { token: keys[who], ...init });
const MEM = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys.admin, ...init });
const box = (key: string) => `/inbox?mailbox=${encodeURIComponent(key)}`;

async function solved() {
	const c = await data<PowChallenge>(await M('website', '/website/contact/challenge'));
	for (let n = 0; n <= c.maxNumber; n++) {
		if (createHash('sha256').update(`${c.salt}${n}`).digest('hex') === c.challenge) {
			return { salt: c.salt, challenge: c.challenge, number: n, signature: c.signature };
		}
	}
	throw new Error('Aufgabe nicht lösbar');
}
/** Aufgabe holen, lösen und die Zeitfalle (3 s) überspringen */
async function freshPow() {
	const pow = await solved();
	vi.setSystemTime(Date.now() + 5_000);
	return pow;
}
const input = (pow: Awaited<ReturnType<typeof solved>>, over: Record<string, unknown> = {}) => ({
	childName: 'Mia Muster',
	childAge: 8,
	name: 'Petra Muster',
	email: 'Petra@Extern.example',
	phone: '0421 123456',
	message: 'Mia war schon einmal zelten.',
	pow,
	...over
});
const submit = (body: unknown) => M('website', '/website/trial', { method: 'POST', json: body });

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: `${name} Test`,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
}
async function mkKey(name: string) {
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

async function mkMember(firstName: string) {
	return data<{ id: string }>(
		await MEM('/members', {
			method: 'POST',
			json: {
				firstName,
				lastName: 'Leitung',
				scoutName: null,
				birthDate: '2004-03-01',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				country: 'DE',
				phones: [],
				emails: [],
				stage: 'kreuzpfadfinder',
				groupIds: []
			}
		}),
		201
	);
}

beforeAll(async () => {
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(messagesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'messages']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	keys.website = (
		await createApiKey(admin, { name: 'website', scopes: ['messages.website.contact'] })
	).key;
	await setSettings(admin, {
		'core.organization.email': 'stamm@pfadfinder.test',
		'core.organization.name': 'Stamm Test'
	});
	await mkUser('sven', ['core.api.manage', 'messages.message.send', 'messages.inbox.stamm']);
	await mkUser('lea', ['core.api.manage', 'messages.message.send']);
	await mkKey('sven');

	// Meute 6–10 mit Postfach und Leitung mit eigenem Konto; Sippe ab 11 ohne Kontakt-Adresse
	const lea = await mkMember('Lea');
	const otto = await mkMember('Otto');
	const meute = await data<{ id: string }>(
		await MEM('/groups', {
			method: 'POST',
			json: {
				name: 'Füchse',
				type: 'meute',
				leaderIds: [lea.id],
				website: {
					onWebsite: true,
					slug: 'fuechse',
					ageMin: 6,
					ageMax: 10,
					contactEmail: 'fuechse@pfadfinder.test'
				}
			}
		}),
		201
	);
	meuteKey = `group:${meute.id}`;
	await data(
		await MEM('/groups', {
			method: 'POST',
			json: {
				name: 'Adler',
				type: 'sippe',
				leaderIds: [otto.id],
				website: { onWebsite: true, slug: 'adler', ageMin: 11, contactEmail: null }
			}
		}),
		201
	);
	await data(
		await MEM(`/members/${lea.id}/links`, { method: 'POST', json: { userId: userIds.lea } }),
		201
	);
	await data(
		await MEM(`/members/${lea.id}/links/${userIds.lea}`, { method: 'PUT', json: { self: true } })
	);
	await mkKey('lea');
});

afterEach(() => {
	vi.useRealTimers();
	resetAllForTests();
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close();
});

describe('Probestunden-Formular der Website', () => {
	it('verlangt den Website-Scope', async () => {
		const res = await M('lea', '/website/trial', { method: 'POST', json: {} });
		expect((await errOf(res, 403)).code).toBe('forbidden');
	});

	it('legt die Anfrage passend zum Alter ins Gruppen-Postfach und benachrichtigt die Leitung', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const pow = await freshPow();
		mails = [];
		expect(await data(await submit(input(pow)), 201)).toEqual({
			received: true,
			group: 'fuechse'
		});

		const list = await data<InboxListResponse>(await M('lea', box(meuteKey)));
		const item = list.items.find((i) => i.subject === 'Probestunde: Mia Muster (8 Jahre)');
		expect(item).toBeTruthy();
		const detail = await data<InboxDetail>(await M('lea', `/inbox/${item!.id}`));
		expect(detail.replyTo).toBe('petra@extern.example');
		expect(detail.document).toContain('Alter: 8 Jahre');
		expect(detail.document).toContain('Meute Füchse (6 bis 10 Jahre) – passend zum Alter');
		expect(detail.document).toContain('Telefon: 0421 123456');
		expect(detail.document).toContain('Mia war schon einmal zelten.');

		// Nicht im Stamm-Postfach
		const stamm = await data<InboxListResponse>(await M('sven', box('stamm')));
		expect(stamm.items.some((i) => i.subject.startsWith('Probestunde'))).toBe(false);

		await settleMails();
		await vi.waitFor(() =>
			expect(mails.some((m) => String(m.to).includes('lea@example.test'))).toBe(true)
		);
		expect(mails.some((m) => String(m.to).includes('sven@example.test'))).toBe(false);

		const audit = JSON.stringify(await listAudit({ action: 'messages.inbox.trial-received' }));
		expect(audit).toContain('"mailbox":"group"');
		expect(audit).not.toContain('Mia');
		expect(audit).not.toContain('petra');
	});

	it('Gruppe ohne Postfach → Stamm-Postfach mit Hinweis; gewählte Gruppe geht vor dem Alter', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const ben = input(await freshPow(), { childName: 'Ben', childAge: 13 });
		expect(await data(await submit(ben), 201)).toEqual({ received: true, group: 'adler' });
		const stamm = await data<InboxListResponse>(await M('sven', box('stamm')));
		const benItem = stamm.items.find((i) => i.subject === 'Probestunde: Ben (13 Jahre)');
		expect(benItem).toBeTruthy();
		const benDetail = await data<InboxDetail>(await M('sven', `/inbox/${benItem!.id}`));
		expect(benDetail.document).toContain('Sippe Adler (ab 11 Jahren)');
		expect(benDetail.document).toContain('bitte weiterleiten');

		// 12-Jährige, aber ausdrücklich die Meute gewählt
		const ida = input(await freshPow(), { childName: 'Ida', childAge: 12, groupSlug: 'fuechse' });
		expect(await data(await submit(ida), 201)).toEqual({ received: true, group: 'fuechse' });
		const list = await data<InboxListResponse>(await M('lea', box(meuteKey)));
		const idaItem = list.items.find((i) => i.subject === 'Probestunde: Ida (12 Jahre)');
		const idaDetail = await data<InboxDetail>(await M('lea', `/inbox/${idaItem!.id}`));
		expect(idaDetail.document).toContain('auf der Website ausgewählt');
		expect(idaDetail.document).toContain('außerhalb der Altersangabe');
	});

	it('prüft Eingaben und Spam-Schutz; eine Aufgabe gilt formularübergreifend nur einmal', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const pow = await freshPow();
		expect((await errOf(await submit(input(pow, { phone: '' })), 422)).code).toBe(
			'validation_failed'
		);
		expect((await errOf(await submit(input(pow, { childAge: 2 })), 422)).code).toBe(
			'validation_failed'
		);
		await data(await submit(input(pow)), 201);
		expect((await errOf(await submit(input(pow)), 409)).code).toBe('conflict');
		// dieselbe Aufgabe im Kontaktformular
		const contact = await M('website', '/website/contact', {
			method: 'POST',
			json: { name: 'Petra', email: 'petra@extern.example', message: 'Hallo', pow }
		});
		expect((await errOf(contact, 409)).code).toBe('conflict');

		// zu schnell (Zeitfalle)
		const quick = await solved();
		expect((await errOf(await submit(input(quick)), 422)).code).toBe('validation_failed');
	});
});
