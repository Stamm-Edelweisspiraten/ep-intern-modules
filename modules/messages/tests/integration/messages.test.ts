/**
 * Modul `messages` (Nachrichten): Absender (persönlich, Amt, Gruppe, Stamm), Empfänger aus Mitgliedern und
 * Gruppen, Einzelversand mit Anhängen, Verlauf/Wiederholen, Gruppenleitungs-Bereich, Audit ohne Adressen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, navigationFor, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests, type MailTransport } from '$testing';
import { resetAllForTests } from '$testing';
import { setSetting } from '$testing';
import { runJobNow } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import messagesModule from '$modules/messages/module';
import { deliveriesIdleForTests } from '$modules/messages/delivery.service';
import type {
	MessageDetail,
	MessageSummary,
	MessagePreview,
	RecipientsResult,
	SendersResponse
} from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'messages-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

type Sent = Parameters<MailTransport['sendMail']>[0];
let mails: Sent[] = [];
/** Adressen, an die der Test-Transport einen Fehler wirft */
const failing = new Set<string>();

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
/** Jedes POST antwortet mit 201 (auch das Auflösen der Empfänger) */
const created = <T>(res: Response) => data<T>(res, 201);
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const M = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/messages${path}`, { token: keys[who], ...init });
const MEM = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys.admin, ...init });

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

const memberBody = (firstName: string, lastName: string, emails: string[], groupIds: string[]) => ({
	firstName,
	lastName,
	scoutName: null,
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [],
	emails: emails.map((value) => ({ name: null, value })),
	stage: 'pfadfinder',
	groupIds
});
async function mkMember(
	firstName: string,
	lastName: string,
	emails: string[],
	groupIds: string[] = [],
	over: Record<string, unknown> = {}
) {
	return data<{ id: string }>(
		await MEM('/members', {
			method: 'POST',
			json: { ...memberBody(firstName, lastName, emails, groupIds), ...over }
		}),
		201
	);
}

const pdfBytes = (size = 20) =>
	new Uint8Array([...new TextEncoder().encode('%PDF-1.4 '), ...new Uint8Array(size).fill(65)]);

/** Nachricht senden: multipart mit Feld `data` und Dateien */
function send(
	who: string,
	body: Record<string, unknown>,
	files: { name: string; type?: string; size?: number }[] = []
) {
	const form = new FormData();
	form.set('data', JSON.stringify(body));
	for (const f of files) {
		form.append(
			'files',
			new File(
				[f.type === 'application/pdf' ? pdfBytes(f.size) : new Uint8Array(f.size ?? 10).fill(65)],
				f.name,
				{
					type: f.type ?? 'text/plain'
				}
			)
		);
	}
	return M(who, '/messages', { method: 'POST', body: form });
}

let gruen: { id: string };
let blau: { id: string };
let anna: { id: string };
let bert: { id: string };
let dora: { id: string };
let lea: { id: string };
const validBody = (over: Record<string, unknown> = {}) => ({
	senderKey: 'personal',
	subject: 'Einladung',
	bodyHtml: '<p>Hallo <strong>zusammen</strong></p>',
	groupIds: [gruen.id],
	memberIds: [],
	...over
});

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			if (failing.has(String(m.to))) throw new Error('550 Postfach nicht erreichbar');
			mails.push(m);
		}
	});
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
	await setSetting(admin, 'members.address.openPlzUrl', '');
	await setSetting(admin, 'members.address.photonUrl', '');
	await setSetting(admin, 'messages.domain', 'pfadfinder.test');
	await setSetting(admin, 'core.organization.email', 'stamm@pfadfinder.test');
	await setSetting(admin, 'core.organization.name', 'Stamm Test');

	const base = ['core.api.manage', 'messages.message.send'];
	await mkUser('sender', 'Anna Maria Müller', [
		...base,
		'members.member.view',
		'members.group.view'
	]);
	await mkUser('viewer', 'Vera Viewer', [...base, 'messages.message.view-all']);
	await mkUser('noperm', 'Nina Niemand', ['core.api.manage']);
	await mkUser('leiter', 'Lea Leiterin', [...base]);
	await mkUser('amt', 'Otto Amt', [...base]);
	for (const n of ['admin', 'sender', 'viewer', 'noperm', 'leiter', 'amt']) {
		if (n !== 'admin') await mkKey(n);
	}

	lea = await mkMember('Lea', 'Leiterin', ['lea@example.test'], [], {
		birthDate: '2004-03-01',
		stage: 'kreuzpfadfinder'
	});
	const ben = await mkMember('Ben', 'Blau', [], [], {
		birthDate: '2003-03-01',
		stage: 'kreuzpfadfinder'
	});
	const mkGroup = async (name: string, leader: string, email?: string) =>
		data<{ id: string }>(
			await MEM('/groups', {
				method: 'POST',
				json: {
					name,
					type: 'sippe',
					leaderIds: [leader],
					...(email ? { website: { onWebsite: false, contactEmail: email } } : {})
				}
			}),
			201
		);
	gruen = await mkGroup('Grün', lea.id, 'gruen@pfadfinder.test');
	blau = await mkGroup('Blau', ben.id);
	anna = await mkMember('Anna', 'Alt', ['anna@example.test', 'Anna2@Example.test'], [gruen.id]);
	bert = await mkMember('Bert', 'Blau', ['bert@example.test'], [blau.id]);
	// Carl teilt sich eine Adresse mit Anna (Geschwister) und ist in beiden Gruppen
	await mkMember('Carl', 'Alt', ['anna@example.test', 'carl@example.test'], [gruen.id, blau.id]);
	// Dora hat keine Adresse
	dora = await mkMember('Dora', 'Ohne', [], [gruen.id]);
	// Erik ist ausgetreten
	await mkMember('Erik', 'Weg', ['erik@example.test'], [gruen.id], { exitDate: '2026-01-01' });

	// Lea ist über ihr eigenes Konto Leiterin der Gruppe Grün
	await data(
		await MEM(`/members/${lea.id}/links`, {
			method: 'POST',
			json: { userId: userIds.leiter, relation: 'selbst' }
		}),
		201
	);
	await data(
		await MEM(`/members/${lea.id}/links/${userIds.leiter}`, { method: 'PUT', json: { self: true } })
	);
	await mkKey('leiter');
});
afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	uninstallFakeStorage();
	await close();
});
beforeEach(() => {
	resetAllForTests();
	mails = [];
	failing.clear();
});

describe('Absender', () => {
	it('persönlich: erster Vorname, Umlaute, Domain aus den Einstellungen; dazu Stamm-Adresse', async () => {
		const res = await data<SendersResponse>(await M('sender', '/senders'));
		const personal = res.senders.find((s) => s.kind === 'personal')!;
		expect(personal.address).toBe('anna.mueller@pfadfinder.test');
		expect(personal.name).toBe('Anna Müller');
		expect(res.senders.find((s) => s.kind === 'stamm')?.address).toBe('stamm@pfadfinder.test');
		expect(res.accountEmail).toBe('sender@example.test');
		expect(res.replyToDefault).toBe('account');
	});

	it('Hinweis zur Zustellbarkeit, wenn Absender-Domain und Mailserver-Domain abweichen', async () => {
		await setSetting(admin, 'core.smtp.from', 'intern@mailserver.example');
		try {
			const res = await data<SendersResponse>(await M('sender', '/senders'));
			expect(res.deliverabilityHint).toMatch(/pfadfinder\.test.*mailserver\.example.*SPF/s);
			expect(res.layoutDefault).toBe('stamm');
		} finally {
			await setSetting(admin, 'core.smtp.from', 'intern@pfadfinder.test');
		}
		const same = await data<SendersResponse>(await M('sender', '/senders'));
		expect(same.deliverabilityHint).toBeNull();
	});

	it('ohne Domain keine persönliche Adresse, aber ein Hinweis', async () => {
		await setSetting(admin, 'messages.domain', '');
		try {
			const res = await data<SendersResponse>(await M('sender', '/senders'));
			expect(res.senders.some((s) => s.kind === 'personal')).toBe(false);
			expect(res.personalHint).toMatch(/Domain/);
		} finally {
			await setSetting(admin, 'messages.domain', 'pfadfinder.test');
		}
	});

	it('Gruppenleitung bekommt die Adresse ihrer Gruppe, Amtsinhaber*in die Amt-Adressen', async () => {
		const leiter = await data<SendersResponse>(await M('leiter', '/senders'));
		expect(leiter.senders.find((s) => s.kind === 'group')?.address).toBe('gruen@pfadfinder.test');
		const office = await data<{ id: string }>(
			await api('/modules/offices/offices', {
				token: keys.admin,
				method: 'POST',
				json: {
					name: 'Kasse',
					emails: [{ label: 'Rechnungen', email: 'kasse@pfadfinder.test' }],
					roleIds: []
				}
			}),
			201
		);
		await data(
			await api(`/modules/offices/offices/${office.id}/holders`, {
				token: keys.admin,
				method: 'PUT',
				json: { holders: [{ userId: userIds.amt }] }
			})
		);
		const amt = await data<SendersResponse>(await M('amt', '/senders'));
		const fromOffice = amt.senders.find((s) => s.kind === 'office');
		expect(fromOffice?.address).toBe('kasse@pfadfinder.test');
		expect(fromOffice?.name).toBe('Kasse');
	});

	it('fremde Absenderadresse → 403, nichts gesendet', async () => {
		const res = await send('sender', validBody({ senderKey: 'group:fremd' }));
		expect(await errCode(res, 403)).toBe('forbidden');
		await deliveriesIdleForTests();
		expect(mails).toHaveLength(0);
	});
});

describe('Empfänger', () => {
	it('Gruppen und Mitglieder: eindeutige Adressen (Groß-/Kleinschreibung), Hinweise zu fehlenden und ausgetretenen', async () => {
		const res = await created<RecipientsResult>(
			await M('sender', '/recipients/resolve', {
				method: 'POST',
				json: { groupIds: [gruen.id], memberIds: [bert.id] }
			})
		);
		const addresses = res.recipients.map((r) => r.address).sort();
		expect(addresses).toEqual([
			'anna2@example.test',
			'anna@example.test',
			'bert@example.test',
			'carl@example.test'
		]);
		// Lea (Leiterin, in keiner Mitgliedsgruppe) ist nicht in der Gruppenmitgliederliste
		expect(res.withoutEmail.map((m) => m.name)).toEqual(['Dora Ohne']);
		expect(res.members).toBe(3);
	});

	it('ausgeschlossene Mitglieder entfallen', async () => {
		const res = await created<RecipientsResult>(
			await M('sender', '/recipients/resolve', {
				method: 'POST',
				json: { groupIds: [gruen.id], excludeMemberIds: [anna.id] }
			})
		);
		expect(res.recipients.map((r) => r.address)).toEqual([
			'anna@example.test',
			'carl@example.test'
		]);
	});

	it('Gruppenleitung: nur die eigene Gruppe, fremde Gruppe/Mitglieder → 404', async () => {
		const own = await created<RecipientsResult>(
			await M('leiter', '/recipients/resolve', { method: 'POST', json: { groupIds: [gruen.id] } })
		);
		expect(own.recipients.length).toBeGreaterThan(0);
		expect(
			await errCode(
				await M('leiter', '/recipients/resolve', { method: 'POST', json: { groupIds: [blau.id] } }),
				404
			)
		).toBe('not_found');
		expect(
			await errCode(
				await M('leiter', '/recipients/resolve', {
					method: 'POST',
					json: { memberIds: [bert.id] }
				}),
				404
			)
		).toBe('not_found');
	});

	it('freie Adressen: ohne Mitglieder-Recht erlaubt, normalisiert, Dublette zu Mitglied behält den Namen', async () => {
		const only = await created<RecipientsResult>(
			await M('viewer', '/recipients/resolve', {
				method: 'POST',
				json: { addresses: ['Gast@Extern.test', 'gast@extern.test'] }
			})
		);
		expect(only.recipients).toEqual([{ memberId: null, name: null, address: 'gast@extern.test' }]);
		expect(only.external).toBe(1);
		expect(only.members).toBe(0);

		const mixed = await created<RecipientsResult>(
			await M('sender', '/recipients/resolve', {
				method: 'POST',
				json: { memberIds: [bert.id], addresses: ['BERT@example.test', 'neu@extern.test'] }
			})
		);
		expect(mixed.recipients).toEqual([
			{ memberId: bert.id, name: 'Bert Blau', address: 'bert@example.test' },
			{ memberId: null, name: null, address: 'neu@extern.test' }
		]);
		expect(mixed.external).toBe(1);

		const bad = await M('viewer', '/recipients/resolve', {
			method: 'POST',
			json: { addresses: ['keine-adresse'] }
		});
		expect(await errCode(bad, 422)).toBe('validation_failed');
	});

	it('ohne Mitglieder-Recht (nur Nachrichten-Recht) → 403', async () => {
		expect(
			await errCode(
				await M('viewer', '/recipients/resolve', {
					method: 'POST',
					json: { memberIds: [anna.id] }
				}),
				403
			)
		).toBe('forbidden');
	});
});

describe('Senden', () => {
	it('einzeln je Adresse, mit From/Reply-To/Anhängen, bereinigtem HTML und Verlauf', async () => {
		const res = await send(
			'sender',
			validBody({
				bodyHtml:
					'<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:evil()">x</a>'
			}),
			[{ name: 'Einladung.txt' }, { name: 'Plan.pdf', type: 'application/pdf' }]
		);
		const created = await data<MessageDetail>(res, 201);
		expect(created.total).toBe(3);
		await deliveriesIdleForTests();

		expect(mails.map((m) => String(m.to)).sort()).toEqual([
			'anna2@example.test',
			'anna@example.test',
			'carl@example.test'
		]);
		for (const m of mails) {
			expect(m.from).toBe('"Anna Müller" <anna.mueller@pfadfinder.test>');
			expect(m.replyTo).toBe('sender@example.test');
			expect(m.subject).toBe('Einladung');
			const names = (m.attachments ?? []).map((a) => a.filename);
			expect(names).toEqual(expect.arrayContaining(['Einladung.txt', 'Plan.pdf']));
			expect(m.html).not.toMatch(/<script|onclick|javascript:/i);
			expect(m.text).toContain('Hi');
		}

		const detail = await data<MessageDetail>(await M('sender', `/messages/${created.id}`));
		expect(detail.status).toBe('done');
		expect(detail.sent).toBe(3);
		expect(detail.recipients.every((r) => r.status === 'sent')).toBe(true);
		expect(detail.attachments.map((a) => a.filename).sort()).toEqual(['Einladung.txt', 'Plan.pdf']);
		expect(detail.bodyHtml).not.toMatch(/<script|onclick|javascript:/i);
	});

	it('Aussehen „Einfach“: kein Stamm-Layout, keine Bilder; „Stamm“: Layout mit Anhängen (Logo)', async () => {
		const only = { groupIds: [], memberIds: [bert.id] };
		await data<MessageDetail>(
			await send(
				'sender',
				validBody({ ...only, layout: 'plain', bodyHtml: '<p>Hallo <strong>Bert</strong></p>' })
			),
			201
		);
		await deliveriesIdleForTests();
		expect(mails).toHaveLength(1);
		const plain = mails[0]!;
		expect(plain.html).toContain('<strong>Bert</strong>');
		expect(plain.html).not.toMatch(/cid:|<table|background|Pfadfinderschaft/);
		expect((plain.attachments ?? []).length).toBe(0);
		expect(plain.text).toContain('Hallo');

		mails = [];
		const stamm = await data<MessageDetail>(
			await send('sender', validBody({ ...only, layout: 'stamm' })),
			201
		);
		expect(stamm.layout).toBe('stamm');
		await deliveriesIdleForTests();
		expect(mails[0]!.html).toMatch(/cid:/);
		expect((mails[0]!.attachments ?? []).length).toBeGreaterThan(0);

		// ohne Angabe gilt die Einstellung
		await setSetting(admin, 'messages.layout.default', 'plain');
		try {
			const dflt = await data<MessageDetail>(await send('sender', validBody(only)), 201);
			expect(dflt.layout).toBe('plain');
			await deliveriesIdleForTests();
		} finally {
			await setSetting(admin, 'messages.layout.default', 'stamm');
		}
	});

	it('Zustellbarkeit: Message-ID mit Absender-Domain, List-Unsubscribe, Text-Fassung, alt-Texte', async () => {
		await data<MessageDetail>(
			await send('sender', validBody({ groupIds: [], memberIds: [bert.id] })),
			201
		);
		await deliveriesIdleForTests();
		const m = mails[0]!;
		expect(m.messageId).toMatch(/^<[0-9a-f-]+@pfadfinder\.test>$/);
		expect(m.headers?.['List-Unsubscribe']).toBe('<mailto:stamm@pfadfinder.test>');
		expect(m.text.length).toBeGreaterThan(0);
		expect(m.html).toMatch(/alt="Pfadfinder-Lilie"/);
		expect(m.html).not.toMatch(/<img[^>]*alt=""/);
	});

	it('Reply-To abweichend setzbar; Stamm-Absender ohne Namen-Mix', async () => {
		await data<MessageDetail>(
			await send(
				'sender',
				validBody({
					senderKey: 'stamm',
					replyTo: 'kasse@pfadfinder.test',
					groupIds: [],
					memberIds: [bert.id]
				})
			),
			201
		);
		await deliveriesIdleForTests();
		expect(mails).toHaveLength(1);
		expect(mails[0]!.from).toBe('"Stamm Test" <stamm@pfadfinder.test>');
		expect(mails[0]!.replyTo).toBe('kasse@pfadfinder.test');
	});

	it('Fehler einzelner Empfänger: Status „Teilweise gesendet“, Wiederholen schickt nur die Fehlgeschlagenen', async () => {
		failing.add('carl@example.test');
		const created = await data<MessageDetail>(await send('sender', validBody()), 201);
		await deliveriesIdleForTests();
		const partial = await data<MessageDetail>(await M('sender', `/messages/${created.id}`));
		expect(partial.status).toBe('partial');
		expect(partial.failed).toBe(1);
		expect(partial.recipients.find((r) => r.status === 'failed')?.address).toBe(
			'carl@example.test'
		);
		expect(mails).toHaveLength(2);

		failing.clear();
		mails = [];
		await data<MessageDetail>(
			await M('sender', `/messages/${created.id}/retry`, { method: 'POST' }),
			201
		);
		await deliveriesIdleForTests();
		expect(mails.map((m) => String(m.to))).toEqual(['carl@example.test']);
		const done = await data<MessageDetail>(await M('sender', `/messages/${created.id}`));
		expect(done.status).toBe('done');
		expect(done.sent).toBe(3);
		expect(
			await errCode(await M('sender', `/messages/${created.id}/retry`, { method: 'POST' }), 409)
		).toBe('conflict');
	});

	it('Validierung: kein Betreff/Text, keine Empfänger mit Adresse, Limit, Anhänge', async () => {
		expect(await errCode(await send('sender', validBody({ subject: ' ' })), 422)).toBe(
			'validation_failed'
		);
		expect(await errCode(await send('sender', validBody({ bodyHtml: '<p> </p>' })), 422)).toBe(
			'validation_failed'
		);
		expect(
			await errCode(await send('sender', validBody({ groupIds: [], memberIds: [dora.id] })), 422)
		).toBe('validation_failed');

		await setSetting(admin, 'messages.maxRecipients', 2);
		try {
			expect(await errCode(await send('sender', validBody()), 422)).toBe('validation_failed');
		} finally {
			await setSetting(admin, 'messages.maxRecipients', 500);
		}

		const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `a${i}.txt` }));
		expect(await errCode(await send('sender', validBody(), eleven), 422)).toBe('validation_failed');
		expect(
			await errCode(
				await send('sender', validBody(), [
					{ name: 'virus.exe', type: 'application/octet-stream' }
				]),
				422
			)
		).toBe('validation_failed');
		expect(
			await errCode(
				await send('sender', validBody(), [{ name: 'gross.bin', size: 11 * 1024 * 1024 }]),
				413
			)
		).toBe('payload_too_large');
		await deliveriesIdleForTests();
		expect(mails).toHaveLength(0);
	});

	it('an freie Adressen: eigene Mail, Empfänger ohne Mitglied im Verlauf', async () => {
		const res = await data<MessageDetail>(
			await send(
				'viewer',
				validBody({ senderKey: 'stamm', groupIds: [], addresses: ['gast@extern.test'] })
			),
			201
		);
		await deliveriesIdleForTests();
		expect(mails.map((m) => String(m.to))).toEqual(['gast@extern.test']);
		const detail = await data<MessageDetail>(await M('viewer', `/messages/${res.id}`));
		expect(detail.recipients).toMatchObject([
			{ name: null, address: 'gast@extern.test', status: 'sent' }
		]);
	});

	it('Vorschau: bereinigt, Layout wie beim Versand, nichts gesendet; fremder Absender 403', async () => {
		const body = {
			senderKey: 'personal',
			subject: ' Hallo ',
			bodyHtml: '<p>Hallo <strong>Welt</strong></p><script>alert(1)</script>'
		};
		const stamm = await created<MessagePreview>(
			await M('sender', '/preview', { method: 'POST', json: { ...body, layout: 'stamm' } })
		);
		expect(stamm.html).toContain('<strong>Welt</strong>');
		expect(stamm.html).not.toMatch(/<script|cid:/);
		expect(stamm.html).toMatch(/data:image/);
		expect(stamm.subject).toBe('Hallo');
		expect(stamm.from).toBe('Anna Müller <anna.mueller@pfadfinder.test>');

		const plain = await created<MessagePreview>(
			await M('sender', '/preview', { method: 'POST', json: { ...body, layout: 'plain' } })
		);
		expect(plain.html).toContain('<strong>Welt</strong>');
		expect(plain.html).not.toMatch(/<table|data:image|Pfadfinderschaft/);

		// leerer Entwurf geht auch
		await created<MessagePreview>(await M('sender', '/preview', { method: 'POST', json: {} }));
		expect(
			await errCode(
				await M('sender', '/preview', { method: 'POST', json: { senderKey: 'group:fremd' } }),
				403
			)
		).toBe('forbidden');
		expect(await errCode(await M('noperm', '/preview', { method: 'POST', json: body }), 403)).toBe(
			'forbidden'
		);
		expect(mails).toHaveLength(0);
	});

	it('ohne Recht 403; ungültiger Body 400; Gruppenleitung sendet an die eigene Gruppe', async () => {
		expect(await errCode(await send('noperm', validBody()), 403)).toBe('forbidden');
		const form = new FormData();
		form.set('data', '{kaputt');
		expect(await errCode(await M('sender', '/messages', { method: 'POST', body: form }), 400)).toBe(
			'bad_request'
		);

		const created = await data<MessageDetail>(
			await send('leiter', validBody({ senderKey: 'group:' + gruen.id })),
			201
		);
		await deliveriesIdleForTests();
		expect(created.senderAddress).toBe('gruen@pfadfinder.test');
		expect(mails.every((m) => m.from === '"Grün" <gruen@pfadfinder.test>')).toBe(true);
		// fremde Gruppe → 404
		expect(await errCode(await send('leiter', validBody({ groupIds: [blau.id] })), 404)).toBe(
			'not_found'
		);
	});
});

describe('Verlauf und Datenschutz', () => {
	it('eigene Nachrichten sichtbar, fremde → 404, mit view-all alle', async () => {
		const mine = await data<MessageDetail>(
			await send('sender', validBody({ groupIds: [], memberIds: [bert.id] })),
			201
		);
		await deliveriesIdleForTests();
		const list = await data<{ items: MessageSummary[]; total: number }>(
			await M('sender', '/messages')
		);
		expect(list.items.some((m) => m.id === mine.id)).toBe(true);
		expect(await errCode(await M('leiter', `/messages/${mine.id}`), 404)).toBe('not_found');
		const leiterList = await data<{ items: MessageSummary[] }>(await M('leiter', '/messages'));
		expect(leiterList.items.some((m) => m.id === mine.id)).toBe(false);
		const all = await data<{ items: MessageSummary[] }>(await M('viewer', '/messages'));
		expect(all.items.some((m) => m.id === mine.id)).toBe(true);
		expect((await data<MessageDetail>(await M('viewer', `/messages/${mine.id}`))).id).toBe(mine.id);
	});

	it('Audit enthält nur Zähler, keine Adressen oder Betreffe', async () => {
		await data<MessageDetail>(
			await send('sender', validBody({ subject: 'Geheimer Betreff' })),
			201
		);
		await deliveriesIdleForTests();
		const { rows } = await listAudit({ action: 'messages.message' });
		expect(rows.length).toBeGreaterThanOrEqual(2);
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toMatch(/example\.test|pfadfinder\.test|Geheimer/);
	});

	it('Jobs: Aufräumen entfernt alte Anhänge/Nachrichten, Fortsetzen ist idempotent', async () => {
		const created = await data<MessageDetail>(
			await send('sender', validBody({ groupIds: [], memberIds: [bert.id] }), [
				{ name: 'alt.txt' }
			]),
			201
		);
		await deliveriesIdleForTests();
		const { core } = await import('$lib/sdk/server');
		await core.database.forModule('messages').transaction(async (tx) => {
			const { sql } = await import('drizzle-orm');
			await tx.execute(
				sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${created.id}`
			);
		});
		await runJobNow(admin, 'messages.cleanup');
		const after = await data<MessageDetail>(await M('sender', `/messages/${created.id}`));
		expect(after.attachments.every((a) => a.removed)).toBe(true);
		await runJobNow(admin, 'messages.resume');
	});
});

describe('Seitenleiste', () => {
	it('sortiert modulübergreifend nach `order`, Konfigurationsseiten nur in der Verwaltung', async () => {
		const nav = await navigationFor(admin);
		// Registrierung: members, offices, messages – die Reihenfolge kommt aus `order`
		expect(nav.filter((n) => !n.admin).map((n) => n.path)).toEqual([
			'/modules/members',
			'/modules/members/groups',
			'/modules/messages',
			'/modules/offices'
		]);
		expect(nav.filter((n) => n.admin).map((n) => n.path)).toEqual([
			'/modules/members/fields',
			'/modules/members/retention',
			'/modules/messages/admin'
		]);
		expect(nav.some((n) => n.group)).toBe(false);
	});
});
