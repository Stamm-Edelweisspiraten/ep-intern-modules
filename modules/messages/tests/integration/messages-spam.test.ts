/**
 * Spam-Schutz im Posteingang (`messages`): eigene Bewertung beim Abruf (Gründe, Links entschärft, keine
 * Benachrichtigung), bekannte Absender, „Spam“ / „Kein Spam“ mit Sperr- und Vertrauensliste (weitere Mails
 * desselben Absenders, neue Mails), Zugriff, Verwaltung der Liste (nur `messages.inbox.manage`), Massenversand,
 * Einstellung „eigene Spam-Erkennung“ aus, Aufbewahrung (Spam nach 30 Tagen), Audit ohne Adressen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
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
import { runJobNow } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import messagesModule from '$modules/messages/module';
import { setImapConnectorForTests } from '$modules/messages/imap.client';
import type {
	InboxDetail,
	InboxListResponse,
	PollResult,
	SenderRule,
	SpamMarkResult
} from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'spam-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

type Sent = Parameters<MailTransport['sendMail']>[0];
let mails: Sent[] = [];

// --- IMAP-Ersatz -------------------------------------------------------------------------------

let imapBox: { uid: number; source: Buffer }[] = [];
let nextUid = 1;
function deliver(source: string) {
	imapBox.push({ uid: nextUid++, source: Buffer.from(source, 'utf8') });
}

interface EmlInput {
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	html?: string;
	headers?: Record<string, string>;
	messageId?: string;
	attachment?: { name: string; type: string; content: Buffer };
}
let emlCounter = 0;
function eml(o: EmlInput): string {
	const head = [
		`From: ${o.from ?? 'Petra Extern <petra@extern.example>'}`,
		`To: ${o.to ?? 'anna.mueller@pfadfinder.test'}`,
		`Subject: ${o.subject ?? 'Frage zur Fahrt'}`,
		`Date: ${new Date(Date.now() - 60_000).toUTCString()}`,
		`Message-ID: ${o.messageId ?? `<s${++emlCounter}.${Date.now()}@extern.example>`}`,
		...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
		'MIME-Version: 1.0'
	];
	const text = o.text ?? 'Hallo,\nwann geht es los?';
	if (!o.html && !o.attachment) {
		return [...head, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n');
	}
	const b = 'BOUNDARY42';
	const parts = [
		`--${b}`,
		o.html ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8',
		'',
		o.html ?? text
	];
	if (o.attachment) {
		parts.push(
			`--${b}`,
			`Content-Type: ${o.attachment.type}; name="${o.attachment.name}"`,
			'Content-Transfer-Encoding: base64',
			`Content-Disposition: attachment; filename="${o.attachment.name}"`,
			'',
			o.attachment.content.toString('base64')
		);
	}
	parts.push(`--${b}--`, '');
	return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts].join('\r\n');
}

// --- API-Helfer ----------------------------------------------------------------------------------

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
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const M = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/messages${path}`, { token: keys[who], ...init });

async function mkUser(name: string, label: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: label,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

const poll = () =>
	M('admin', '/inbox/poll', { method: 'POST' }).then((r) => data<PollResult>(r, 201));
const annaBox = () => `personal:${userIds.anna}`;
const list = async (who: string, mailbox: string, filter = 'all') =>
	data<InboxListResponse>(
		await M(who, `/inbox?mailbox=${encodeURIComponent(mailbox)}&filter=${filter}`)
	);
const find = async (subject: string, filter = 'all', who = 'anna', mailbox = annaBox()) =>
	(await list(who, mailbox, filter)).items.find((i) => i.subject === subject);
const detail = async (id: string, who = 'anna') => data<InboxDetail>(await M(who, `/inbox/${id}`));
const markSpam = (who: string, ids: string[], spam: boolean, remember = true) =>
	M(who, '/inbox/spam', { method: 'POST', json: { ids, spam, remember } });

beforeAll(async () => {
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	setImapConnectorForTests(async () => ({
		fetch: async (limit) =>
			imapBox
				.slice(0, limit)
				.map((m) => ({ uid: m.uid, size: m.source.length, source: m.source, truncated: false })),
		move: async (uids) => {
			imapBox = imapBox.filter((m) => !uids.includes(m.uid));
		},
		close: async () => undefined
	}));
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(officesModule);
	registerModule(messagesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'offices', 'messages']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	await installFakeStorage(admin);
	setTodayForTests('2026-06-01');
	await setSettings(admin, {
		'members.address.openPlzUrl': '',
		'members.address.photonUrl': '',
		'messages.domain': 'pfadfinder.test',
		'core.organization.email': 'stamm@pfadfinder.test',
		'core.organization.name': 'Stamm Test',
		'messages.imap.enabled': true,
		'messages.imap.host': 'imap.pfadfinder.test',
		'messages.imap.user': 'catchall@pfadfinder.test',
		'messages.imap.password': 'geheim'
	});
	const base = ['core.api.manage', 'messages.message.send'];
	await mkUser('anna', 'Anna Maria Müller', base);
	await mkUser('mia', 'Mia Verwaltung', [...base, 'messages.inbox.manage', 'messages.inbox.stamm']);
	await mkUser('nina', 'Nina Niemand', ['core.api.manage']);
	// Mitglied mit Eltern-Adresse → bekannter Absender
	await data(
		await api('/modules/members/members', {
			token: keys.admin,
			method: 'POST',
			json: {
				firstName: 'Ben',
				lastName: 'Muster',
				scoutName: null,
				birthDate: '2015-03-01',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				country: 'DE',
				phones: [],
				emails: [{ name: 'Eltern', value: 'eltern@familie.example' }],
				stage: 'woelfling',
				groupIds: []
			}
		}),
		201
	);
});
afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	setImapConnectorForTests(undefined);
	uninstallFakeStorage();
	await close();
});
beforeEach(() => {
	resetAllForTests();
	mails = [];
});

describe('Bewertung beim Abruf', () => {
	it('unbekannter Absender mit gefährlichem Anhang und Phishing-Link → Spam mit Gründen, Links entschärft, keine Benachrichtigung', async () => {
		deliver(
			eml({
				from: 'Bank <service@bank-login.example>',
				subject: 'Konto gesperrt',
				html: '<p>Bitte bestätigen: <a href="https://login.evil.example/x">www.sparkasse.de</a></p>',
				attachment: {
					name: 'Rechnung.pdf.exe',
					type: 'application/octet-stream',
					content: Buffer.from('MZ')
				}
			})
		);
		deliver(eml({ subject: 'Ganz normal' }));
		await poll();
		expect(await find('Konto gesperrt')).toBeUndefined();
		const spam = await find('Konto gesperrt', 'spam');
		expect(spam?.spam).toBe(true);
		expect((await find('Ganz normal'))?.spam).toBe(false);

		const d = await detail(spam!.id);
		expect(d.spamSource).toBe('rules');
		expect(d.spamScore).toBeGreaterThanOrEqual(5);
		expect(d.spamReasons.map((r) => r.code)).toEqual(
			expect.arrayContaining(['dangerous-attachment', 'link-mismatch', 'subject-pattern'])
		);
		expect(d.document).not.toContain('href="https://login.evil.example');
		expect(d.document).toContain('Link deaktiviert: https://login.evil.example/x');
		// Benachrichtigung nur für die normale Mail
		const notes = mails.filter((m) => m.to === 'anna@example.test');
		expect(notes.map((m) => m.subject)).toEqual(['Neue Nachricht von Petra Extern: Ganz normal']);
	});

	it('bekannter Absender (Mitglied) trotz Server-Markierung kein Spam – mit DMARC-Fehler doch', async () => {
		deliver(
			eml({
				from: 'Familie Muster <Eltern@Familie.example>',
				subject: 'Krankmeldung',
				headers: { 'X-Spam-Flag': 'YES' }
			})
		);
		deliver(
			eml({
				from: 'Familie Muster <eltern@familie.example>',
				subject: 'Gefälscht',
				headers: { 'Authentication-Results': 'mx.example; dmarc=fail header.from=familie.example' }
			})
		);
		await poll();
		expect((await find('Krankmeldung'))?.spam).toBe(false);
		const forged = await find('Gefälscht', 'spam');
		expect(forged).toBeDefined();
		expect((await detail(forged!.id)).spamReasons[0]?.code).toBe('auth-fail');
	});

	it('eigene Mail und Antworten auf eigene Mails: kein Spam, auch wenn die Prüfung fehlschlägt bzw. der Server markiert', async () => {
		// Eine aus der App versendete Nachricht (Message-ID je Empfänger wie beim Versand)
		const msgId = crypto.randomUUID();
		await moduleDb('messages').transaction(async (tx) => {
			await tx.execute(
				sql`INSERT INTO messages (id, subject, body_html, body_text, sender_address, status)
					VALUES (${msgId}, 'Elternbrief', '<p>x</p>', 'x', 'anna.mueller@pfadfinder.test', 'done')`
			);
			await tx.execute(
				sql`INSERT INTO message_recipients (id, message_id, address, status, message_id_header)
					VALUES (${crypto.randomUUID()}, ${msgId}, 'stamm@pfadfinder.test', 'sent', '<own.1@pfadfinder.test>')`
			);
		});
		// Kopie kommt über das Catch-all zurück, die Absenderprüfung schlägt fehl (z. B. fehlendes SPF)
		deliver(
			eml({
				from: 'Anna Müller <anna.mueller@pfadfinder.test>',
				to: 'stamm@pfadfinder.test',
				subject: 'Eigene Kopie',
				messageId: '<own.1@pfadfinder.test>',
				headers: {
					'Reply-To': 'anna@gmail.example',
					'Authentication-Results': 'mx.pfadfinder.test; dmarc=fail header.from=pfadfinder.test'
				}
			})
		);
		// Unbekannte Person antwortet auf unsere Mail; der Mailserver hält sie für Spam
		deliver(
			eml({
				from: 'Opa Muster <opa@unbekannt.example>',
				subject: 'Re: Elternbrief',
				headers: { 'In-Reply-To': '<own.1@pfadfinder.test>', 'X-Spam-Flag': 'YES' }
			})
		);
		await poll();
		expect((await find('Eigene Kopie', 'all', 'mia', 'stamm'))?.spam).toBe(false);
		expect((await find('Re: Elternbrief'))?.spam).toBe(false);
	});

	it('Massenversand: ab der 11. Mail einer Stunde zusammen mit weiterem Signal Spam', async () => {
		for (let i = 1; i <= 11; i++) {
			deliver(eml({ from: 'news@mass.example', subject: `Bitcoin Rendite ${i}` }));
		}
		await poll();
		const inbox = (await list('anna', annaBox())).items.filter((i) =>
			i.subject.startsWith('Bitcoin Rendite')
		);
		const spam = (await list('anna', annaBox(), 'spam')).items.filter((i) =>
			i.subject.startsWith('Bitcoin Rendite')
		);
		expect(inbox).toHaveLength(10);
		expect(spam.map((i) => i.subject)).toEqual(['Bitcoin Rendite 11']);
	});

	it('eigene Erkennung aus: nur Server-Markierung und Listen zählen', async () => {
		await setSettings(admin, { 'messages.spam.enabled': false });
		try {
			deliver(
				eml({
					from: 'x@unbekannt.example',
					subject: 'Ohne Erkennung',
					attachment: {
						name: 'tool.exe',
						type: 'application/octet-stream',
						content: Buffer.from('MZ')
					}
				})
			);
			deliver(
				eml({
					from: 'y@unbekannt.example',
					subject: 'Server sagt Spam',
					headers: { 'X-Spam-Flag': 'YES' }
				})
			);
			await poll();
			expect((await find('Ohne Erkennung'))?.spam).toBe(false);
			const flagged = await find('Server sagt Spam', 'spam');
			expect((await detail(flagged!.id)).spamSource).toBe('server');
		} finally {
			await setSettings(admin, { 'messages.spam.enabled': true });
		}
	});
});

describe('„Spam“ / „Kein Spam“', () => {
	it('Spam sperrt den Absender: weitere Mails desselben Absenders gehen mit, neue landen direkt im Spam', async () => {
		deliver(eml({ from: 'Shop <werbung@shop.example>', subject: 'Angebot 1' }));
		deliver(eml({ from: 'werbung@shop.example', subject: 'Angebot 2' }));
		await poll();
		const first = await find('Angebot 1');
		expect(first?.spam).toBe(false);
		const res = await data<SpamMarkResult>(await markSpam('anna', [first!.id], true), 201);
		expect(res).toEqual({ changed: 2, remembered: 1 });
		expect((await find('Angebot 2', 'spam'))?.spam).toBe(true);
		expect((await detail(first!.id)).spamSource).toBe('user');

		deliver(eml({ from: 'WERBUNG@shop.example', subject: 'Angebot 3' }));
		await poll();
		const third = await find('Angebot 3', 'spam');
		const d = await detail(third!.id);
		expect(d.spamSource).toBe('blocklist');
		expect(d.spamReasons[0]).toMatchObject({ code: 'blocked', label: 'Absender ist gesperrt' });

		const rules = await data<SenderRule[]>(await M('mia', '/spam/rules'));
		expect(rules).toContainEqual(
			expect.objectContaining({
				kind: 'block',
				matchType: 'address',
				pattern: 'werbung@shop.example',
				origin: 'button',
				createdByName: 'Anna Maria Müller'
			})
		);
		const audit = await listAudit({ action: 'messages.inbox.spam-marked' });
		expect(audit.rows[0]?.metadata).toEqual({ count: 2, spam: true, remembered: 1 });
		expect(JSON.stringify(audit.rows)).not.toContain('shop.example');
	});

	it('Kein Spam vertraut dem Absender: Server-Markierung greift danach nicht mehr', async () => {
		deliver(
			eml({
				from: 'info@verein.example',
				subject: 'Newsletter 1',
				headers: { 'X-Spam-Flag': 'YES' }
			})
		);
		await poll();
		const flagged = await find('Newsletter 1', 'spam');
		const res = await data<SpamMarkResult>(await markSpam('anna', [flagged!.id], false), 201);
		expect(res).toEqual({ changed: 1, remembered: 1 });
		const d = await detail(flagged!.id);
		expect(d.spam).toBe(false);
		expect(d.spamSource).toBeNull();

		deliver(
			eml({
				from: 'info@verein.example',
				subject: 'Newsletter 2',
				headers: { 'X-Spam-Flag': 'YES' }
			})
		);
		await poll();
		expect((await find('Newsletter 2'))?.spam).toBe(false);
	});

	it('ohne „remember“ bleibt die Liste unverändert; eigene Adressen kommen nie auf die Liste', async () => {
		deliver(eml({ from: 'einmal@extern.example', subject: 'Nur diese' }));
		deliver(eml({ from: 'Kasse <kasse@pfadfinder.test>', subject: 'Intern' }));
		await poll();
		const once = await find('Nur diese');
		expect(
			await data<SpamMarkResult>(await markSpam('anna', [once!.id], true, false), 201)
		).toEqual({
			changed: 1,
			remembered: 0
		});
		const internal = await find('Intern');
		expect(await data<SpamMarkResult>(await markSpam('anna', [internal!.id], true), 201)).toEqual({
			changed: 1,
			remembered: 0
		});
		const patterns = (await data<SenderRule[]>(await M('mia', '/spam/rules'))).map(
			(r) => r.pattern
		);
		expect(patterns).not.toContain('einmal@extern.example');
		expect(patterns).not.toContain('kasse@pfadfinder.test');
	});

	it('nur für Mails mit Zugriff (404); ohne Senderecht 403; leere Auswahl 422', async () => {
		deliver(eml({ to: 'stamm@pfadfinder.test', subject: 'An den Stamm' }));
		await poll();
		const stamm = await find('An den Stamm', 'all', 'mia', 'stamm');
		expect(await errCode(await markSpam('anna', [stamm!.id], true), 404)).toBe('not_found');
		expect(await errCode(await markSpam('nina', [stamm!.id], true), 403)).toBe('forbidden');
		expect(await errCode(await markSpam('mia', [], true), 422)).toBe('validation_failed');
		expect((await find('An den Stamm', 'all', 'mia', 'stamm'))?.spam).toBe(false);
	});
});

describe('Sperr- und Vertrauensliste verwalten', () => {
	it('nur mit messages.inbox.manage; Domain sperrt auch Subdomains; Prüfungen', async () => {
		expect(await errCode(await M('anna', '/spam/rules'), 403)).toBe('forbidden');
		expect(
			await errCode(
				await M('anna', '/spam/rules', {
					method: 'POST',
					json: { kind: 'block', value: 'x.example' }
				}),
				403
			)
		).toBe('forbidden');

		const rule = await data<SenderRule>(
			await M('mia', '/spam/rules', {
				method: 'POST',
				json: { kind: 'block', value: '@Spam.example', note: 'Werbung' }
			}),
			201
		);
		expect(rule).toMatchObject({
			kind: 'block',
			matchType: 'domain',
			pattern: 'spam.example',
			note: 'Werbung',
			origin: 'manual'
		});
		const post = (json: unknown) => M('mia', '/spam/rules', { method: 'POST', json });
		expect(await errCode(await post({ kind: 'block', value: 'spam.example' }), 409)).toBe(
			'conflict'
		);
		expect(await errCode(await post({ kind: 'allow', value: 'spam.example' }), 409)).toBe(
			'conflict'
		);
		expect(await errCode(await post({ kind: 'block', value: 'kein eintrag' }), 422)).toBe(
			'validation_failed'
		);
		expect(await errCode(await post({ kind: 'block', value: 'pfadfinder.test' }), 422)).toBe(
			'validation_failed'
		);

		deliver(eml({ from: 'a@mail.spam.example', subject: 'Subdomain' }));
		await poll();
		expect((await find('Subdomain', 'spam'))?.spam).toBe(true);

		await data(await M('mia', `/spam/rules/${rule.id}`, { method: 'DELETE' }));
		expect(await errCode(await M('mia', `/spam/rules/${rule.id}`, { method: 'DELETE' }), 404)).toBe(
			'not_found'
		);
		deliver(eml({ from: 'a@mail.spam.example', subject: 'Wieder erlaubt' }));
		await poll();
		expect((await find('Wieder erlaubt'))?.spam).toBe(false);

		const audit = await listAudit({ action: 'messages.spam.rule-' });
		expect(audit.rows.map((a) => a.action)).toEqual(
			expect.arrayContaining(['messages.spam.rule-created', 'messages.spam.rule-deleted'])
		);
		expect(JSON.stringify(audit.rows)).not.toContain('spam.example');
	});
});

describe('Aufbewahrung', () => {
	it('Spam wird nach 30 Tagen gelöscht, normale Mails bleiben', async () => {
		deliver(eml({ subject: 'Alt und Spam', headers: { 'X-Spam-Flag': 'YES' } }));
		deliver(eml({ subject: 'Alt und gut' }));
		await poll();
		const spam = await find('Alt und Spam', 'spam');
		const good = await find('Alt und gut');
		await moduleDb('messages').transaction((tx) =>
			tx.execute(
				sql`UPDATE inbox_messages SET imported_at = now() - interval '31 days'
					WHERE id IN (${spam!.id}, ${good!.id})`
			)
		);
		await runJobNow(admin, 'messages.cleanup');
		expect(await errCode(await M('anna', `/inbox/${spam!.id}`), 404)).toBe('not_found');
		expect((await detail(good!.id)).subject).toBe('Alt und gut');
	});
});
