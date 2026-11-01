/**
 * Posteingang des Moduls `messages`: Abruf des Catch-all-Postfachs (IMAP-Ersatz), Zuordnung zu persönlichen,
 * Amts-, Gruppen- und Stamm-Postfächern, Sichtbarkeit, Doppelimport-Schutz, Verschieben erst nach dem Speichern,
 * Bereinigung des HTML, Anhänge, Antworten/Weiterleiten mit In-Reply-To und Verlauf, Benachrichtigungen
 * („neue Nachricht“, „… hat geantwortet“) mit Profil-Einstellungen, Zuordnen, Papierkorb/Aufbewahrung, Audit.
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
import { getSetting, setSetting, setSettings } from '$testing';
import { dueBefore, runJobNow } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import messagesModule from '$modules/messages/module';
import { deliveriesIdleForTests } from '$modules/messages/delivery.service';
import { setImapConnectorForTests } from '$modules/messages/imap.client';
import { navBadgeCounts } from '$testing';
import { getMyPreferences, setMyPreference } from '$testing';
import type {
	ComposePrefill,
	InboxDetail,
	InboxListResponse,
	MailboxesResponse,
	MailboxSentResponse,
	MessageDetail,
	PollResult
} from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'inbox-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

type Sent = Parameters<MailTransport['sendMail']>[0];
let mails: Sent[] = [];

// --- IMAP-Ersatz -------------------------------------------------------------------------------

let imapBox: { uid: number; source: Buffer }[] = [];
let moved: number[] = [];
let nextUid = 1;
function deliver(source: string): number {
	const uid = nextUid++;
	imapBox.push({ uid, source: Buffer.from(source, 'utf8') });
	return uid;
}

interface EmlInput {
	from?: string;
	to: string;
	cc?: string;
	deliveredTo?: string;
	subject?: string;
	text?: string;
	html?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string;
	/** Standard: vor einer Minute */
	date?: Date;
	headers?: Record<string, string>;
	attachment?: { name: string; type: string; content: Buffer; cid?: string };
}
let emlCounter = 0;
function eml(o: EmlInput): string {
	const id = o.messageId ?? `<m${++emlCounter}.${Date.now()}@extern.example>`;
	const head = [
		`From: ${o.from ?? 'Petra Extern <petra@extern.example>'}`,
		`To: ${o.to}`,
		...(o.cc ? [`Cc: ${o.cc}`] : []),
		...(o.deliveredTo ? [`Delivered-To: ${o.deliveredTo}`] : []),
		`Subject: ${o.subject ?? 'Frage zur Fahrt'}`,
		`Date: ${(o.date ?? new Date(Date.now() - 60_000)).toUTCString()}`,
		`Message-ID: ${id}`,
		...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
		...(o.references ? [`References: ${o.references}`] : []),
		...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
		'MIME-Version: 1.0'
	];
	const text = o.text ?? 'Hallo,\nwann geht es los?\nViele Grüße';
	if (!o.html && !o.attachment) {
		return [
			...head,
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 8bit',
			'',
			text,
			''
		].join('\r\n');
	}
	const b = 'BOUNDARY42';
	const parts = [
		`--${b}`,
		o.html ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		o.html ?? text
	];
	if (o.attachment) {
		parts.push(
			`--${b}`,
			`Content-Type: ${o.attachment.type}; name="${o.attachment.name}"`,
			'Content-Transfer-Encoding: base64',
			o.attachment.cid
				? `Content-Disposition: inline; filename="${o.attachment.name}"`
				: `Content-Disposition: attachment; filename="${o.attachment.name}"`,
			...(o.attachment.cid ? [`Content-ID: <${o.attachment.cid}>`] : []),
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
}
async function mkKey(name: string) {
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

const poll = async () => data<PollResult>(await M('admin', '/inbox/poll', { method: 'POST' }), 201);
const list = async (who: string, mailbox: string, filter = 'all') =>
	data<InboxListResponse>(
		await M(who, `/inbox?mailbox=${encodeURIComponent(mailbox)}&filter=${filter}`)
	);
const mailboxes = async (who: string) => data<MailboxesResponse>(await M(who, '/mailboxes'));

function sendForm(who: string, body: Record<string, unknown>) {
	const form = new FormData();
	form.set('data', JSON.stringify(body));
	return M(who, '/messages', { method: 'POST', body: form });
}

let officeKey = '';
let groupKey = '';

beforeAll(async () => {
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	setImapConnectorForTests(async () => ({
		fetch: async (limit) =>
			imapBox
				.slice(0, limit)
				.map((m) => ({ uid: m.uid, size: m.source.length, source: m.source, truncated: false })),
		move: async (uids) => {
			moved.push(...uids);
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
	await mkUser('otto', 'Otto Amt', base);
	await mkUser('olga', 'Olga Kasse', base);
	await mkUser('lea', 'Lea Leiterin', base);
	await mkUser('sven', 'Sven Stamm', [...base, 'messages.inbox.stamm']);
	await mkUser('nina', 'Nina Niemand', ['core.api.manage']);
	await mkUser('tim', 'Tim Müller', base);
	await mkUser('tom', 'Tim Müller', base); // gleicher Name → mehrdeutige persönliche Adresse
	for (const n of Object.keys(userIds)) await mkKey(n);

	const office = await data<{ id: string }>(
		await api('/modules/offices/offices', {
			token: keys.admin,
			method: 'POST',
			json: {
				name: 'Kasse',
				emails: [{ label: null, email: 'kasse@pfadfinder.test' }],
				roleIds: []
			}
		}),
		201
	);
	await data(
		await api(`/modules/offices/offices/${office.id}/holders`, {
			token: keys.admin,
			method: 'PUT',
			json: { holders: [{ userId: userIds.otto }, { userId: userIds.olga }] }
		})
	);
	officeKey = `office:${office.id}:kasse@pfadfinder.test`;

	const MEM = (path: string, init: Parameters<typeof api>[1] = {}) =>
		api(`/modules/members${path}`, { token: keys.admin, ...init });
	const lea = await data<{ id: string }>(
		await MEM('/members', {
			method: 'POST',
			json: {
				firstName: 'Lea',
				lastName: 'Leiterin',
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
	const gruen = await data<{ id: string }>(
		await MEM('/groups', {
			method: 'POST',
			json: {
				name: 'Grün',
				type: 'sippe',
				leaderIds: [lea.id],
				website: { onWebsite: false, contactEmail: 'gruen@pfadfinder.test' }
			}
		}),
		201
	);
	groupKey = `group:${gruen.id}`;
	await data(
		await MEM(`/members/${lea.id}/links`, { method: 'POST', json: { userId: userIds.lea } }),
		201
	);
	await data(
		await MEM(`/members/${lea.id}/links/${userIds.lea}`, { method: 'PUT', json: { self: true } })
	);
	await mkKey('lea');
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
	moved = [];
});

describe('Zuordnung beim Abruf', () => {
	it('persönlich, Amt, Gruppe, Stamm und Nicht zugeordnet; Mail danach verschoben', async () => {
		const uids = [
			deliver(eml({ to: 'Anna <anna.mueller@pfadfinder.test>', subject: 'An Anna' })),
			deliver(eml({ to: 'kasse@pfadfinder.test', subject: 'An die Kasse' })),
			deliver(eml({ to: 'gruen@pfadfinder.test', subject: 'An Grün' })),
			deliver(eml({ to: 'STAMM@pfadfinder.test', subject: 'An den Stamm' })),
			deliver(eml({ to: 'tippfehler@pfadfinder.test', subject: 'Irrläufer' }))
		];
		const res = await poll();
		expect(res.imported).toBe(5);
		expect(moved.sort()).toEqual(uids.sort());
		expect((await list('anna', 'personal:' + userIds.anna)).items.map((i) => i.subject)).toEqual([
			'An Anna'
		]);
		expect((await list('otto', officeKey)).items[0]?.subject).toBe('An die Kasse');
		expect((await list('olga', officeKey)).items[0]?.subject).toBe('An die Kasse');
		expect((await list('lea', groupKey)).items[0]?.subject).toBe('An Grün');
		expect((await list('sven', 'stamm')).items[0]?.subject).toBe('An den Stamm');
		expect((await list('admin', 'unassigned')).items.map((i) => i.subject)).toContain('Irrläufer');
	});

	it('Bcc über Delivered-To; eine Mail an zwei Postfächer → zwei Einträge', async () => {
		deliver(
			eml({
				to: 'jemand@extern.example',
				deliveredTo: 'anna.mueller@pfadfinder.test',
				subject: 'Blindkopie'
			})
		);
		deliver(eml({ to: 'kasse@pfadfinder.test', cc: 'gruen@pfadfinder.test', subject: 'Doppelt' }));
		await poll();
		expect(
			(await list('anna', 'personal:' + userIds.anna)).items.some((i) => i.subject === 'Blindkopie')
		).toBe(true);
		expect((await list('otto', officeKey)).items.some((i) => i.subject === 'Doppelt')).toBe(true);
		expect((await list('lea', groupKey)).items.some((i) => i.subject === 'Doppelt')).toBe(true);
	});

	it('gleicher Name → mehrdeutig, landet in „Nicht zugeordnet“', async () => {
		deliver(eml({ to: 'tim.mueller@pfadfinder.test', subject: 'Welcher Tim?' }));
		await poll();
		const items = (await list('admin', 'unassigned')).items;
		const hit = items.find((i) => i.subject === 'Welcher Tim?')!;
		const detail = await data<InboxDetail>(await M('admin', `/inbox/${hit.id}`));
		expect(detail.unassignedReason).toBe('ambiguous');
	});

	it('Doppelimport derselben Message-ID wird übersprungen', async () => {
		const mail = eml({
			to: 'anna.mueller@pfadfinder.test',
			subject: 'Zweimal',
			messageId: '<dup-1@extern.example>'
		});
		deliver(mail);
		await poll();
		deliver(mail);
		await poll();
		const items = (await list('anna', 'personal:' + userIds.anna)).items.filter(
			(i) => i.subject === 'Zweimal'
		);
		expect(items).toHaveLength(1);
	});

	it('eigene Benachrichtigungen (alte Kopfzeile X-EP-Intern) werden nicht übernommen, aber verschoben', async () => {
		const uid = deliver(
			eml({
				to: 'anna.mueller@pfadfinder.test',
				subject: 'Schleife',
				headers: { 'X-EP-Intern': 'notification' }
			})
		);
		const res = await poll();
		expect(res.skipped).toBe(1);
		expect(moved).toContain(uid);
		expect(
			(await list('anna', 'personal:' + userIds.anna)).items.some((i) => i.subject === 'Schleife')
		).toBe(false);
	});

	it('ohne Speicher bleibt eine Mail mit Anhang im Eingang (wird nicht verschoben)', async () => {
		uninstallFakeStorage();
		try {
			const uid = deliver(
				eml({
					to: 'anna.mueller@pfadfinder.test',
					subject: 'Mit Anhang',
					attachment: {
						name: 'a.pdf',
						type: 'application/pdf',
						content: Buffer.from('%PDF-1.4 test')
					}
				})
			);
			const res = await poll();
			expect(res.failed).toBe(1);
			expect(moved).not.toContain(uid);
		} finally {
			await installFakeStorage(admin);
		}
		const res = await poll();
		expect(res.imported).toBe(1);
	});
});

describe('Sichtbarkeit', () => {
	it('Postfächer je Person; fremde Mail → 404; ohne Recht 403', async () => {
		deliver(eml({ to: 'kasse@pfadfinder.test', subject: 'Nur für die Kasse' }));
		await poll();
		const anna = await mailboxes('anna');
		expect(anna.mailboxes.map((m) => m.kind)).toEqual(['personal']);
		const otto = await mailboxes('otto');
		expect(otto.mailboxes.map((m) => m.kind)).toEqual(['personal', 'office']);
		expect(otto.mailboxes.find((m) => m.kind === 'office')!.unread).toBeGreaterThan(0);
		const sven = await mailboxes('sven');
		expect(sven.mailboxes.some((m) => m.key === 'stamm')).toBe(true);
		expect((await mailboxes('otto')).mailboxes.some((m) => m.key === 'stamm')).toBe(false);
		expect((await mailboxes('admin')).canManage).toBe(true);

		const id = (await list('otto', officeKey)).items.find(
			(i) => i.subject === 'Nur für die Kasse'
		)!.id;
		expect(await errCode(await M('anna', `/inbox/${id}`), 404)).toBe('not_found');
		expect(
			await errCode(await M('anna', `/inbox?mailbox=${encodeURIComponent(officeKey)}`), 404)
		).toBe('not_found');
		expect(await errCode(await M('anna', '/inbox?mailbox=unassigned'), 404)).toBe('not_found');
		expect(await errCode(await M('nina', '/mailboxes'), 403)).toBe('forbidden');
		expect(await errCode(await M('anna', '/inbox/poll', { method: 'POST' }), 403)).toBe(
			'forbidden'
		);
	});

	it('gelesen ist je Person; Ungelesen-Filter', async () => {
		deliver(eml({ to: 'kasse@pfadfinder.test', subject: 'Lesestatus' }));
		await poll();
		const id = (await list('otto', officeKey)).items.find((i) => i.subject === 'Lesestatus')!.id;
		await data<InboxDetail>(await M('otto', `/inbox/${id}`));
		expect((await list('otto', officeKey, 'unread')).items.some((i) => i.id === id)).toBe(false);
		expect((await list('olga', officeKey, 'unread')).items.some((i) => i.id === id)).toBe(true);
		await data(await M('otto', `/inbox/${id}/unread`, { method: 'POST' }), 201);
		expect((await list('otto', officeKey, 'unread')).items.some((i) => i.id === id)).toBe(true);
	});
});

describe('Inhalt und Anhänge', () => {
	it('HTML wird bereinigt: keine Skripte, keine externen Bilder, eigene CSP', async () => {
		deliver(
			eml({
				to: 'anna.mueller@pfadfinder.test',
				subject: 'HTML',
				html: '<p onclick="x()">Hallo <b>Welt</b></p><script>alert(1)</script><img src="https://tracker.example/p.gif" alt="Logo"><a href="javascript:alert(1)">böse</a><a href="https://gut.example">gut</a><style>body{background:url(https://x)}</style>'
			})
		);
		await poll();
		const id = (await list('anna', 'personal:' + userIds.anna)).items.find(
			(i) => i.subject === 'HTML'
		)!.id;
		const d = await data<InboxDetail>(await M('anna', `/inbox/${id}`));
		expect(d.document).toContain('<b>Welt</b>');
		expect(d.document).toContain("default-src 'none'");
		expect(d.document).not.toMatch(/<script|onclick|tracker\.example|javascript:|url\(https/);
		expect(d.blockedImages).toBe(1);
		expect(d.document).toContain('böse</a>');
		expect(d.document).toContain('href="https://gut.example"');
	});

	it('eingebettetes Bild (cid) wird als data:-URL gezeigt, Anhang lässt sich laden', async () => {
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64'
		);
		deliver(
			eml({
				to: 'anna.mueller@pfadfinder.test',
				subject: 'Mit Bild',
				html: '<p>Logo: <img src="cid:logo@x" alt="Logo"></p>',
				attachment: { name: 'logo.png', type: 'image/png', content: png, cid: 'logo@x' }
			})
		);
		deliver(
			eml({
				to: 'anna.mueller@pfadfinder.test',
				subject: 'Mit PDF',
				attachment: {
					name: 'Rechnung März.pdf',
					type: 'application/pdf',
					content: Buffer.from('%PDF-1.4 hallo')
				}
			})
		);
		await poll();
		const items = (await list('anna', 'personal:' + userIds.anna)).items;
		const img = await data<InboxDetail>(
			await M('anna', `/inbox/${items.find((i) => i.subject === 'Mit Bild')!.id}`)
		);
		expect(img.document).toContain('src="data:image/png;base64,');
		const pdf = await data<InboxDetail>(
			await M('anna', `/inbox/${items.find((i) => i.subject === 'Mit PDF')!.id}`)
		);
		expect(pdf.attachments).toHaveLength(1);
		const res = await M('anna', `/inbox/${pdf.id}/attachments/${pdf.attachments[0]!.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(
			await errCode(await M('otto', `/inbox/${pdf.id}/attachments/${pdf.attachments[0]!.id}`), 404)
		).toBe('not_found');
	});
});

describe('Antworten und Weiterleiten', () => {
	it('Antwort aus dem Amtspostfach: Re:, In-Reply-To, Absender = Amt; andere Inhaber*in wird informiert; Antwort darauf im Verlauf', async () => {
		deliver(
			eml({
				from: 'Petra Extern <petra@extern.example>',
				to: 'kasse@pfadfinder.test',
				subject: 'Rechnung offen?',
				messageId: '<orig-1@extern.example>',
				text: 'Ist meine Rechnung bezahlt?'
			})
		);
		await poll();
		mails = [];
		const id = (await list('otto', officeKey)).items.find(
			(i) => i.subject === 'Rechnung offen?'
		)!.id;
		const pre = await data<ComposePrefill>(await M('otto', `/inbox/${id}/compose?mode=reply`));
		expect(pre.senderKey).toBe(officeKey);
		expect(pre.addresses).toEqual(['petra@extern.example']);
		expect(pre.subject).toBe('Re: Rechnung offen?');
		expect(pre.bodyHtml).toContain('<blockquote>');

		const sent = await data<MessageDetail>(
			await sendForm('otto', {
				senderKey: pre.senderKey,
				subject: pre.subject,
				bodyHtml: '<p>Ja, ist bezahlt.</p>' + pre.bodyHtml,
				addresses: pre.addresses,
				replyOf: pre.replyOf
			}),
			201
		);
		await deliveriesIdleForTests();
		expect(sent.replyOf).toBe(id);
		const out = mails.find((m) => m.to === 'petra@extern.example')!;
		expect(out.from).toContain('kasse@pfadfinder.test');
		expect(out.replyTo).toBe('kasse@pfadfinder.test');
		expect(out.headers?.['In-Reply-To']).toBe('<orig-1@extern.example>');
		expect(out.headers?.['References']).toBe('<orig-1@extern.example>');
		expect(out.messageId).toMatch(/@pfadfinder\.test>$/);
		// Olga (zweite Inhaberin) bekommt „Otto Amt hat geantwortet“, Otto selbst nicht
		const info = mails.find(
			(m) => m.to === 'olga@example.test' && /hat geantwortet/.test(m.subject)
		);
		expect(info?.text).toContain('Ja, ist bezahlt.');
		expect(mails.some((m) => m.to === 'otto@example.test')).toBe(false);

		const detail = await data<InboxDetail>(await M('olga', `/inbox/${id}`));
		expect(detail.answered).toBe(true);
		expect(detail.replies[0]?.byName).toBe('Otto Amt');

		// Antwort der Petra auf unsere Mail landet im selben Verlauf
		deliver(
			eml({
				to: 'kasse@pfadfinder.test',
				subject: 'Re: Rechnung offen?',
				inReplyTo: out.messageId!,
				date: new Date(Date.now() + 60_000),
				references: `<orig-1@extern.example> ${out.messageId!}`,
				text: 'Danke!'
			})
		);
		await poll();
		const second = (await list('otto', officeKey)).items.find(
			(i) => i.subject === 'Re: Rechnung offen?'
		)!;
		const thread = await data<InboxDetail>(await M('otto', `/inbox/${second.id}`));
		expect(thread.thread.map((t) => t.direction)).toEqual(['in', 'out', 'in']);
	});

	it('Weiterleiten übernimmt gewählte Anhänge; fremde Mail als Bezug → 404', async () => {
		deliver(
			eml({
				to: 'anna.mueller@pfadfinder.test',
				subject: 'Beleg',
				attachment: {
					name: 'beleg.pdf',
					type: 'application/pdf',
					content: Buffer.from('%PDF-1.4 beleg')
				}
			})
		);
		await poll();
		const id = (await list('anna', 'personal:' + userIds.anna)).items.find(
			(i) => i.subject === 'Beleg'
		)!.id;
		const pre = await data<ComposePrefill>(await M('anna', `/inbox/${id}/compose?mode=forward`));
		expect(pre.subject).toBe('Wg: Beleg');
		expect(pre.addresses).toEqual([]);
		expect(pre.attachments).toHaveLength(1);
		await data<MessageDetail>(
			await sendForm('anna', {
				senderKey: 'personal',
				subject: pre.subject,
				bodyHtml: pre.bodyHtml,
				addresses: ['kasse@pfadfinder.test'],
				forwardOf: id,
				forwardAttachmentIds: pre.attachments.map((a) => a.id)
			}),
			201
		);
		await deliveriesIdleForTests();
		const out = mails.find((m) => m.to === 'kasse@pfadfinder.test')!;
		expect(out.attachments?.some((a) => 'filename' in a && a.filename === 'beleg.pdf')).toBe(true);

		const code = await errCode(
			await sendForm('otto', {
				senderKey: 'personal',
				subject: 'x',
				bodyHtml: '<p>x</p>',
				addresses: ['a@extern.example'],
				forwardOf: id
			}),
			404
		);
		expect(code).toBe('not_found');
	});

	it('ohne Posteingang bleibt die Antwortadresse wie eingestellt; mit Posteingang = Absenderadresse', async () => {
		await data<MessageDetail>(
			await sendForm('anna', {
				senderKey: 'personal',
				subject: 'Info',
				bodyHtml: '<p>Hallo</p>',
				addresses: ['x@extern.example']
			}),
			201
		);
		await deliveriesIdleForTests();
		expect(mails.find((m) => m.to === 'x@extern.example')?.replyTo).toBe(
			'anna.mueller@pfadfinder.test'
		);
	});
});

describe('Benachrichtigungen', () => {
	it('neue Mail → Benachrichtigung mit Inhalt an die Konto-Adresse; abschaltbar; Spam ohne', async () => {
		deliver(
			eml({
				to: 'anna.mueller@pfadfinder.test',
				subject: 'Hallo Anna',
				text: 'Treffen am Samstag?'
			})
		);
		await poll();
		const note = mails.find((m) => m.to === 'anna@example.test')!;
		expect(note.subject).toBe('Neue Nachricht von Petra Extern: Hallo Anna');
		expect(note.text).toContain('Neue Nachricht von Petra Extern <petra@extern.example>');
		expect(note.text).toContain('Treffen am Samstag?');
		expect(note.headers?.['X-Atrium']).toBe('notification');
		expect(note.headers?.['Auto-Submitted']).toBe('auto-generated');

		const annaCtx = (await contextForUser(userIds.anna!))!.ctx;
		const pref = { type: 'messages.inbox-new', scope: 'personal:' + userIds.anna };
		await setMyPreference(annaCtx, { ...pref, channel: 'off' });
		mails = [];
		deliver(eml({ to: 'anna.mueller@pfadfinder.test', subject: 'Leise' }));
		await poll();
		expect(mails.some((m) => m.to === 'anna@example.test')).toBe(false);
		await setMyPreference(annaCtx, { ...pref, channel: 'email' });

		mails = [];
		// Unbekannter Absender: bekannte (schon angeschriebene) Absender stuft der Spam-Schutz nie als Spam ein
		deliver(
			eml({
				from: 'Fremd <fremd@spam.example>',
				to: 'anna.mueller@pfadfinder.test',
				subject: 'Spam',
				headers: { 'X-Spam-Flag': 'YES' }
			})
		);
		await poll();
		expect(mails).toHaveLength(0);
		expect((await list('anna', 'personal:' + userIds.anna, 'spam')).items[0]?.subject).toBe('Spam');
	});

	it('Profil: „Antwort“ nur bei gemeinsamen Postfächern; fremdes Postfach → 404', async () => {
		const scopes = async (who: string) =>
			(await getMyPreferences((await contextForUser(userIds[who]!))!.ctx)).groups
				.find((g) => g.id === 'messages')!
				.items.map((i) => `${i.type}|${i.scope}`);
		const anna = await scopes('anna');
		expect(anna).toContain(`messages.inbox-new|personal:${userIds.anna}`);
		expect(anna).not.toContain(`messages.inbox-replied|personal:${userIds.anna}`);
		const otto = await scopes('otto');
		expect(otto).toContain(`messages.inbox-new|${officeKey}`);
		expect(otto).toContain(`messages.inbox-replied|${officeKey}`);
		await expect(
			setMyPreference((await contextForUser(userIds.anna!))!.ctx, {
				type: 'messages.inbox-new',
				scope: officeKey,
				channel: 'off'
			})
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('Verwaltung', () => {
	it('Nicht zugeordnet → Postfach zuordnen (benachrichtigt), nur mit Recht', async () => {
		deliver(eml({ to: 'kase@pfadfinder.test', subject: 'Vertippt' }));
		await poll();
		const id = (await list('admin', 'unassigned')).items.find((i) => i.subject === 'Vertippt')!.id;
		expect(
			await errCode(
				await M('otto', `/inbox/${id}/assign`, { method: 'POST', json: { mailbox: officeKey } }),
				403
			)
		).toBe('forbidden');
		mails = [];
		const res = await data<{ visible: boolean }>(
			await M('admin', `/inbox/${id}/assign`, { method: 'POST', json: { mailbox: officeKey } }),
			201
		);
		expect(res.visible).toBe(false);
		expect((await list('otto', officeKey)).items.some((i) => i.id === id)).toBe(true);
		expect(mails.some((m) => m.to === 'otto@example.test')).toBe(true);
	});

	it('Papierkorb (gemeinsam), Wiederherstellen, Aufbewahrung löscht samt Anhängen', async () => {
		deliver(eml({ to: 'kasse@pfadfinder.test', subject: 'Weg damit' }));
		await poll();
		const id = (await list('otto', officeKey)).items.find((i) => i.subject === 'Weg damit')!.id;
		await data(await M('otto', `/inbox/${id}`, { method: 'DELETE' }));
		expect((await list('olga', officeKey)).items.some((i) => i.id === id)).toBe(false);
		expect((await list('olga', officeKey, 'trash')).items.some((i) => i.id === id)).toBe(true);
		await data(await M('olga', `/inbox/${id}/restore`, { method: 'POST' }), 201);
		expect((await list('otto', officeKey)).items.some((i) => i.id === id)).toBe(true);

		await data(await M('otto', `/inbox/${id}`, { method: 'DELETE' }));
		await moduleDb('messages').transaction((tx) =>
			tx.execute(
				sql`UPDATE inbox_messages SET deleted_at = now() - interval '40 days' WHERE id = ${id}`
			)
		);
		await runJobNow(admin, 'messages.cleanup');
		expect(await errCode(await M('otto', `/inbox/${id}`), 404)).toBe('not_found');
	});

	it('Audit ohne Adressen/Betreffe', async () => {
		deliver(eml({ to: 'anna.mueller@pfadfinder.test', subject: 'Geheimer Betreff' }));
		await poll();
		const entries = await listAudit({ action: 'messages.inbox' });
		const json = JSON.stringify(entries);
		expect(json).toContain('messages.inbox.received');
		expect(json).not.toMatch(/Geheimer Betreff|petra@extern|anna\.mueller/);
	});

	it('Passwort wird verworfen, wenn sich der IMAP-Server ändert', async () => {
		await setSetting(admin, 'messages.imap.password', 'neu');
		await setSetting(admin, 'messages.imap.host', 'anderer.example');
		expect(await getSetting('messages.imap.password')).toBeFalsy();
		await setSettings(admin, {
			'messages.imap.host': 'imap.pfadfinder.test',
			'messages.imap.password': 'geheim'
		});
		expect(await getSetting('messages.imap.password')).toBe('geheim');
	});

	it('Abruf ohne Zugangsdaten → 503, ausgeschaltet → nichts', async () => {
		await setSetting(admin, 'messages.imap.enabled', false);
		try {
			expect((await poll()).message).toMatch(/ausgeschaltet/);
		} finally {
			await setSetting(admin, 'messages.imap.enabled', true);
		}
	});
});

describe('Gesendet je Postfach', () => {
	it('gemeinsames Postfach: alle Inhaber*innen sehen, was aus dem Amt gesendet wurde; Fremde nicht', async () => {
		const sent = await data<MessageDetail>(
			await sendForm('otto', {
				senderKey: officeKey,
				subject: 'Aus der Kasse',
				bodyHtml: '<p>Hallo</p>',
				addresses: ['extern1@extern.example', 'extern2@extern.example']
			}),
			201
		);
		await deliveriesIdleForTests();
		const q = `/mailboxes/sent?mailbox=${encodeURIComponent(officeKey)}`;
		const olga = await data<MailboxSentResponse>(await M('olga', q));
		const item = olga.items.find((i) => i.id === sent.id)!;
		expect(item.subject).toBe('Aus der Kasse');
		expect(item.createdByName).toBe('Otto Amt');
		expect(item.recipients).toBe(2);
		expect(item.to).toBe('extern1@extern.example');
		// Detail darf Olga über das Postfach öffnen, Anna nicht
		expect((await data<MessageDetail>(await M('olga', `/messages/${sent.id}`))).id).toBe(sent.id);
		expect(await errCode(await M('anna', `/messages/${sent.id}`), 404)).toBe('not_found');
		expect(await errCode(await M('anna', q), 404)).toBe('not_found');
		expect(await errCode(await M('admin', '/mailboxes/sent?mailbox=unassigned'), 404)).toBe(
			'not_found'
		);
		// Suche nach Empfänger
		const found = await data<MailboxSentResponse>(await M('olga', `${q}&search=extern2`));
		expect(found.items.some((i) => i.id === sent.id)).toBe(true);
	});

	it('persönlich: nur eigene; Altbestand ohne Postfach über die Absenderadresse', async () => {
		const own = await data<MessageDetail>(
			await sendForm('anna', {
				senderKey: 'personal',
				subject: 'Persönlich',
				bodyHtml: '<p>x</p>',
				addresses: ['x@extern.example']
			}),
			201
		);
		await deliveriesIdleForTests();
		await moduleDb('messages').transaction((tx) =>
			tx.execute(sql`UPDATE messages SET mailbox_key = NULL WHERE id = ${own.id}`)
		);
		const res = await data<MailboxSentResponse>(
			await M('anna', `/mailboxes/sent?mailbox=${encodeURIComponent('personal:' + userIds.anna)}`)
		);
		expect(res.items.some((i) => i.id === own.id)).toBe(true);
		expect(await errCode(await M('otto', `/messages/${own.id}`), 404)).toBe('not_found');
	});
});

describe('Zähler in der Seitenleiste', () => {
	it('ungelesene Mails der eigenen Postfächer, ohne „Nicht zugeordnet“; sinkt nach dem Lesen', async () => {
		const path = '/modules/messages';
		const before = (await navBadgeCounts(await ctxOf(userIds.olga!)))[path] ?? 0;
		deliver(eml({ to: 'kasse@pfadfinder.test', subject: 'Zähler 1' }));
		deliver(eml({ to: 'kasse@pfadfinder.test', subject: 'Zähler 2' }));
		deliver(eml({ to: 'niemand@pfadfinder.test', subject: 'Zähler unassigned' }));
		await poll();
		const olgaCtx = await ctxOf(userIds.olga!);
		expect((await navBadgeCounts(olgaCtx))[path]).toBe(before + 2);
		const id = (await list('olga', officeKey)).items.find((i) => i.subject === 'Zähler 1')!.id;
		await data(await M('olga', `/inbox/${id}`));
		expect((await navBadgeCounts(olgaCtx))[path]).toBe(before + 1);
		// Über die API (nur Anmeldung nötig)
		const viaApi = await data<Record<string, number>>(
			await api('/nav/badges', { token: keys.olga })
		);
		expect(viaApi[path]).toBe(before + 1);
		// Ohne Recht auf das Modul kein Eintrag
		expect(await navBadgeCounts(await ctxOf(userIds.nina!))).toEqual({});
		// Ohne Anmeldung 401
		expect((await api('/nav/badges')).status).toBe(401);
	});
});

describe('Core: Intervall-Jobs', () => {
	it('everyMinutes: fällig nach Ablauf des Abstands', () => {
		const now = new Date('2026-06-01T10:00:00Z');
		expect(dueBefore({ everyMinutes: 1 }, now)!.getTime()).toBe(now.getTime() - 55_000);
		expect(dueBefore({ everyMinutes: 10 }, now)!.getTime()).toBe(now.getTime() - 595_000);
	});
});
