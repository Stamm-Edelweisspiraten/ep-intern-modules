/**
 * Kontaktformular der Website → Posteingang (`messages`, `POST /website/contact`): Scope des API-Keys,
 * Proof-of-Work (gültig, gefälscht, zu schnell, abgelaufen, doppelt), Ablage im Stamm-Postfach bzw. „Nicht
 * zugeordnet“, Antworten an die eingegebene Adresse, Benachrichtigung, Audit ohne personenbezogene Daten.
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
import { disableModule, enableModule, syncModules } from '$testing';
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
import type { ComposePrefill, InboxDetail, InboxListResponse } from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'contact-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let mails: Parameters<MailTransport['sendMail']>[0][] = [];

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

/** Aufgabe holen und wie der Browser lösen */
async function solved(who = 'website') {
	const c = await data<PowChallenge>(await M(who, '/website/contact/challenge'));
	for (let n = 0; n <= c.maxNumber; n++) {
		if (createHash('sha256').update(`${c.salt}${n}`).digest('hex') === c.challenge) {
			return { salt: c.salt, challenge: c.challenge, number: n, signature: c.signature };
		}
	}
	throw new Error('Aufgabe nicht lösbar');
}
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const input = (pow: Awaited<ReturnType<typeof solved>>, over: Record<string, unknown> = {}) => ({
	name: 'Petra Interessiert',
	email: 'Petra@Extern.example',
	phone: '0421 123456',
	message: 'Hallo,\nkann meine Tochter (9) zur Probestunde kommen?',
	pow,
	...over
});
const submit = (body: unknown, who = 'website') =>
	M(who, '/website/contact', { method: 'POST', json: body });

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: `${name} Test`,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
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
	// Website-Key nur mit dem Kontakt-Scope (Konto darf es, Key ist darauf beschränkt)
	keys.website = (
		await createApiKey(admin, { name: 'website', scopes: ['messages.website.contact'] })
	).key;
	await setSettings(admin, {
		'core.organization.email': 'stamm@pfadfinder.test',
		'core.organization.name': 'Stamm Test'
	});
	await mkUser('sven', ['core.api.manage', 'messages.message.send', 'messages.inbox.stamm']);
	await mkUser('anna', ['core.api.manage', 'messages.message.send']);
});

afterEach(() => {
	vi.useRealTimers();
	resetAllForTests();
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close();
});

describe('Kontaktformular der Website', () => {
	it('verlangt den Scope messages.website.contact', async () => {
		expect((await errOf(await M('anna', '/website/contact/challenge'), 403)).code).toBe(
			'forbidden'
		);
		const res = await api('/modules/messages/website/contact/challenge');
		expect(res.status).toBe(401);
		// Der Website-Key kommt an nichts anderes
		expect((await errOf(await M('website', '/mailboxes'), 403)).code).toBe('forbidden');
	});

	it('legt eine gültige Anfrage ins Stamm-Postfach, Antworten gehen an die eingegebene Adresse', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const pow = await solved();
		later(5_000);
		mails = [];
		expect(await data(await submit(input(pow)), 201)).toEqual({ received: true });

		const listSven = await data<InboxListResponse>(await M('sven', '/inbox?mailbox=stamm'));
		const item = listSven.items.find((i) => i.subject === 'Kontaktanfrage über die Website');
		expect(item).toBeTruthy();
		// Ohne Stamm-Recht nicht sichtbar
		expect((await errOf(await M('anna', '/inbox?mailbox=stamm'), 404)).code).toBe('not_found');

		const detail = await data<InboxDetail>(await M('sven', `/inbox/${item!.id}`));
		expect(detail.from).toMatchObject({
			address: 'petra@extern.example',
			name: 'Petra Interessiert'
		});
		expect(detail.document).toContain('kann meine Tochter (9) zur Probestunde kommen?');
		expect(detail.document).toContain('Telefon: 0421 123456');
		expect(detail.replyTo).toBe('petra@extern.example');
		expect(detail.spam).toBe(false);

		const prefill = await data<ComposePrefill>(
			await M('sven', `/inbox/${item!.id}/compose?mode=reply`)
		);
		expect(prefill.addresses).toEqual(['petra@extern.example']);

		// Benachrichtigung an Sven (Stamm-Postfach), nicht an Anna
		await settleMails();
		await vi.waitFor(() =>
			expect(mails.some((m) => String(m.to).includes('sven@example.test'))).toBe(true)
		);
		expect(mails.some((m) => String(m.to).includes('anna@example.test'))).toBe(false);

		const audit = await listAudit({ action: 'messages.inbox.contact-received' });
		const text = JSON.stringify(audit);
		expect(text).toContain('messages.inbox.contact-received');
		expect(text).not.toContain('petra');
		expect(text).not.toContain('Tochter');
	});

	it('lehnt dieselbe Aufgabe ein zweites Mal ab (409)', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const pow = await solved();
		later(5_000);
		await data(await submit(input(pow, { message: 'Erste' })), 201);
		expect((await errOf(await submit(input(pow, { message: 'Zweite' })), 409)).code).toBe(
			'conflict'
		);
	});

	it('Zeitfalle: zu schnell und abgelaufen → 422', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const fast = await solved();
		later(1_000);
		const e1 = await errOf(await submit(input(fast)), 422);
		expect(e1.message).toContain('zu schnell');

		const old = await solved();
		later(2 * 60 * 60_000 + 1_000);
		const e2 = await errOf(await submit(input(old)), 422);
		expect(e2.message).toContain('zu lange');
	});

	it('gefälschte Lösung oder Signatur → 422, nichts gespeichert', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const pow = await solved();
		later(5_000);
		const before = (await data<InboxListResponse>(await M('sven', '/inbox?mailbox=stamm'))).items
			.length;
		await errOf(await submit(input({ ...pow, number: (pow.number + 1) % 100_001 })), 422);
		await errOf(await submit(input({ ...pow, signature: 'a'.repeat(64) })), 422);
		await errOf(
			await submit(input({ ...pow, salt: `${'0'.repeat(24)}.${Date.now() - 10_000}` })),
			422
		);
		await errOf(await submit(input(pow, { email: 'keine-adresse' })), 422);
		await errOf(await submit(input(pow, { name: 'Zeile\r\nBcc: x@y.z' })), 422);
		await errOf(await submit(input(pow, { extra: 1 })), 422);
		const after = (await data<InboxListResponse>(await M('sven', '/inbox?mailbox=stamm'))).items
			.length;
		expect(after).toBe(before);
	});

	it('ohne Stamm-Adresse → „Nicht zugeordnet“ für die Verwaltung', async () => {
		await setSettings(admin, { 'core.organization.email': '' });
		try {
			vi.useFakeTimers({ toFake: ['Date'] });
			const pow = await solved();
			later(5_000);
			await data(await submit(input(pow, { message: 'Ohne Stamm-Adresse' })), 201);
			const list = await data<InboxListResponse>(await M('admin', '/inbox?mailbox=unassigned'));
			expect(list.items.some((i) => i.subject === 'Kontaktanfrage über die Website')).toBe(true);
		} finally {
			await setSettings(admin, { 'core.organization.email': 'stamm@pfadfinder.test' });
		}
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'messages');
		try {
			expect((await errOf(await M('website', '/website/contact/challenge'), 404)).code).toBe(
				'module_disabled'
			);
		} finally {
			await enableModule(admin, 'messages');
		}
	});
});
