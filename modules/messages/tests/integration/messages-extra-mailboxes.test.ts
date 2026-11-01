/**
 * Zusätzliche Postfächer und Weiterleitungen im Modul `messages`: Verwaltung (Anlegen, Adresskonflikte 409, 403 ohne
 * `messages.mailbox.manage`), Freigaben an Benutzer*in/Mitglied/Gruppe → Zugriff, „Lesen“ ohne Absender (403 beim Senden),
 * „Lesen und senden“, Zuordnung beim Abruf (IMAP-Ersatz) an Zusatz- und Weiterleitungsadressen, unbekanntes Ziel →
 * „Nicht zugeordnet“, Löschen verschiebt Mails, fremde Person 404, Audit ohne Adressen, Konto gelöscht.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { setSettings } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import messagesModule from '$modules/messages/module';
import { deliveriesIdleForTests } from '$modules/messages/delivery.service';
import { setImapConnectorForTests } from '$modules/messages/imap.client';
import type {
	AliasesResponse,
	ComposePrefill,
	ExtraMailbox,
	InboxDetail,
	InboxListResponse,
	MailboxAlias,
	MailboxesResponse,
	PollResult,
	SendersResponse
} from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'extra-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

// --- IMAP-Ersatz -------------------------------------------------------------------------------

let imapBox: { uid: number; source: Buffer }[] = [];
let nextUid = 1;
let counter = 0;
function deliver(to: string, subject: string): void {
	const source = [
		'From: Petra Extern <petra@extern.example>',
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: ${new Date(Date.now() - 60_000).toUTCString()}`,
		`Message-ID: <x${++counter}.${Date.now()}@extern.example>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		'Hallo zusammen,\nwann geht es los?\nViele Grüße',
		''
	].join('\r\n');
	imapBox.push({ uid: nextUid++, source: Buffer.from(source, 'utf8') });
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
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

async function mkMember(firstName: string, lastName: string, groupIds: string[] = []) {
	return data<{ id: string }>(
		await MEM('/members', {
			method: 'POST',
			json: {
				firstName,
				lastName,
				scoutName: null,
				birthDate: '2004-03-01',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				country: 'DE',
				phones: [],
				emails: [],
				stage: 'kreuzpfadfinder',
				groupIds
			}
		}),
		201
	);
}
async function link(memberId: string, user: string) {
	await data(
		await MEM(`/members/${memberId}/links`, { method: 'POST', json: { userId: userIds[user] } }),
		201
	);
}

const poll = async () => data<PollResult>(await M('admin', '/inbox/poll', { method: 'POST' }), 201);
const list = async (who: string, mailbox: string) =>
	data<InboxListResponse>(await M(who, `/inbox?mailbox=${encodeURIComponent(mailbox)}`));
const mailboxes = async (who: string) => data<MailboxesResponse>(await M(who, '/mailboxes'));
const createMailbox = async (json: Record<string, unknown>, status = 201) =>
	M('admin', '/admin/mailboxes', { method: 'POST', json }).then((r) =>
		status === 201 ? data<ExtraMailbox>(r, 201) : (errCode(r, status) as unknown as ExtraMailbox)
	);

function sendForm(who: string, body: Record<string, unknown>) {
	const form = new FormData();
	form.set('data', JSON.stringify(body));
	return M(who, '/messages', { method: 'POST', body: form });
}

let groupId = '';
let monaMemberId = '';
let lager: ExtraMailbox;

beforeAll(async () => {
	setMailTransportForTests({ sendMail: async () => undefined });
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
	await mkUser('mia', 'Mia Lesen', base);
	await mkUser('max', 'Max Senden', base);
	await mkUser('gerd', 'Gerd Gruppe', base);
	await mkUser('mona', 'Mona Mitglied', base);
	await mkUser('fred', 'Fred Fremd', base);
	await mkUser('nina', 'Nina Ohnerecht', base);
	await mkUser('olga', 'Olga Amt', base);

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
			json: { holders: [{ userId: userIds.olga }] }
		})
	);

	const gerd = await mkMember('Gerd', 'Gruppe');
	const group = await data<{ id: string }>(
		await MEM('/groups', {
			method: 'POST',
			json: {
				name: 'Blau',
				type: 'sippe',
				leaderIds: [gerd.id],
				website: { onWebsite: false, contactEmail: 'blau@pfadfinder.test' }
			}
		}),
		201
	);
	groupId = group.id;
	await link(gerd.id, 'gerd');
	const mona = await mkMember('Mona', 'Mitglied');
	monaMemberId = mona.id;
	await link(mona.id, 'mona');
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
});

describe('Verwaltung', () => {
	it('anlegen mit Freigaben an Benutzer*in, Mitglied und Gruppe', async () => {
		lager = await createMailbox({
			name: 'Herbstlager',
			address: ' Herbstlager@Pfadfinder.test ',
			description: 'Anmeldungen und Fragen zum Lager',
			shares: [
				{ type: 'user', id: userIds.mia, level: 'read' },
				{ type: 'user', id: userIds.max, level: 'edit' },
				{ type: 'group', id: groupId, level: 'read' },
				{ type: 'member', id: monaMemberId, level: 'read' }
			]
		});
		expect(lager.address).toBe('herbstlager@pfadfinder.test');
		expect(lager.key).toBe(`extra:${lager.id}`);
		expect(lager.shares.map((s) => s.name).sort()).toEqual([
			'Blau',
			'Max Senden',
			'Mia Lesen',
			'Mona Mitglied'
		]);
		const all = await data<ExtraMailbox[]>(await M('admin', '/admin/mailboxes'));
		expect(all.map((m) => m.id)).toEqual([lager.id]);
	});

	it('Adresskonflikt mit Stamm, Amt, Gruppe, persönlicher Adresse oder anderem Postfach → 409', async () => {
		for (const address of [
			'stamm@pfadfinder.test',
			'kasse@pfadfinder.test',
			'blau@pfadfinder.test',
			'mia.lesen@pfadfinder.test',
			'herbstlager@pfadfinder.test'
		]) {
			expect(await createMailbox({ name: 'X', address }, 409), address).toBe('conflict');
		}
		expect(
			await errCode(
				await M('admin', '/admin/aliases', {
					method: 'POST',
					json: { address: 'herbstlager@pfadfinder.test', targetKey: 'stamm' }
				}),
				409
			)
		).toBe('conflict');
	});

	it('Validierung: unbekannte Freigabe, doppelte Freigabe, ungültige Adresse → 422', async () => {
		expect(
			await createMailbox(
				{
					name: 'X',
					address: 'x@pfadfinder.test',
					shares: [{ type: 'user', id: 'gibtsnicht', level: 'read' }]
				},
				422
			)
		).toBe('validation_failed');
		expect(
			await createMailbox(
				{
					name: 'X',
					address: 'x@pfadfinder.test',
					shares: [
						{ type: 'user', id: userIds.mia, level: 'read' },
						{ type: 'user', id: userIds.mia, level: 'edit' }
					]
				},
				422
			)
		).toBe('validation_failed');
		expect(await createMailbox({ name: 'X', address: 'kein-mail' }, 422)).toBe('validation_failed');
		expect(
			await createMailbox(
				{
					name: 'X',
					address: 'x@pfadfinder.test',
					shares: [{ type: 'role', id: 'r', level: 'read' }]
				},
				422
			)
		).toBe('validation_failed');
	});

	it('ohne messages.mailbox.manage → 403', async () => {
		expect(await errCode(await M('nina', '/admin/mailboxes'), 403)).toBe('forbidden');
		expect(
			await errCode(
				await M('nina', '/admin/mailboxes', {
					method: 'POST',
					json: { name: 'X', address: 'x@pfadfinder.test' }
				}),
				403
			)
		).toBe('forbidden');
		expect(await errCode(await M('nina', '/admin/aliases'), 403)).toBe('forbidden');
		expect(await errCode(await M('nina', '/admin/principals?search=Bl'), 403)).toBe('forbidden');
		expect(
			await errCode(await M('nina', `/admin/mailboxes/${lager.id}`, { method: 'DELETE' }), 403)
		).toBe('forbidden');
	});

	it('Freigabe-Suche findet Gruppen, Mitglieder und Benutzer*innen, keine Rollen', async () => {
		const hits = await data<{ type: string; name: string }[]>(
			await M('admin', '/admin/principals?search=Mo')
		);
		expect(hits.some((h) => h.type === 'member' && h.name.includes('Mona'))).toBe(true);
		expect(hits.some((h) => h.type === 'user' && h.name === 'Mona Mitglied')).toBe(true);
		const blau = await data<{ type: string }[]>(await M('admin', '/admin/principals?search=Bla'));
		expect(blau.map((h) => h.type)).toContain('group');
		expect(blau.map((h) => h.type)).not.toContain('role');
	});
});

describe('Zugriff', () => {
	it('Freigabe an Benutzer*in, Gruppe und Mitglied zeigt das Postfach, Fremde nicht (404)', async () => {
		for (const who of ['mia', 'max', 'gerd', 'mona']) {
			const box = (await mailboxes(who)).mailboxes.find((b) => b.key === lager.key);
			expect(box, who).toBeTruthy();
			expect(box!.kind).toBe('extra');
			expect(box!.shared).toBe(true);
			expect(box!.senderKey).toBe(who === 'max' ? lager.key : null);
		}
		expect((await mailboxes('fred')).mailboxes.some((b) => b.key === lager.key)).toBe(false);
		expect(
			await errCode(await M('fred', `/inbox?mailbox=${encodeURIComponent(lager.key)}`), 404)
		).toBe('not_found');
	});

	it('„Lesen“: kein Absender, Senden 403; „Lesen und senden“: Absender, Senden erlaubt', async () => {
		const miaSenders = await data<SendersResponse>(await M('mia', '/senders'));
		expect(miaSenders.senders.some((s) => s.key === lager.key)).toBe(false);
		const body = {
			senderKey: lager.key,
			addresses: ['jemand@extern.example'],
			subject: 'Lagerinfo',
			bodyHtml: '<p>Hallo</p>'
		};
		expect(await errCode(await sendForm('mia', body), 403)).toBe('forbidden');

		const maxSenders = await data<SendersResponse>(await M('max', '/senders'));
		const s = maxSenders.senders.find((x) => x.key === lager.key);
		expect(s).toMatchObject({ kind: 'extra', address: 'herbstlager@pfadfinder.test' });
		const sent = await data<{ id: string }>(await sendForm('max', body), 201);
		await deliveriesIdleForTests();
		const rows = await moduleDb('messages').transaction(
			(tx) =>
				tx.execute(
					sql`SELECT mailbox_key FROM messages WHERE id = ${sent.id}`
				) as unknown as Promise<{
					rows: { mailbox_key: string }[];
				}>
		);
		expect(rows.rows[0]?.mailbox_key).toBe(lager.key);
		// Gemeinsames Postfach: auch die Leserin sieht die gesendete Nachricht
		const sentList = await data<{ items: { id: string }[] }>(
			await M('mia', `/mailboxes/sent?mailbox=${encodeURIComponent(lager.key)}`)
		);
		expect(sentList.items.map((i) => i.id)).toContain(sent.id);
	});
});

describe('Abruf und Weiterleitungen', () => {
	it('Mail an Zusatzadresse und an Weiterleitungen landet im richtigen Postfach', async () => {
		const toLager = await data<MailboxAlias>(
			await M('admin', '/admin/aliases', {
				method: 'POST',
				json: { address: 'Lager@Pfadfinder.test', targetKey: lager.key }
			}),
			201
		);
		expect(toLager.target?.name).toBe('Herbstlager');
		await data(
			await M('admin', '/admin/aliases', {
				method: 'POST',
				json: { address: 'info@pfadfinder.test', targetKey: 'stamm' }
			}),
			201
		);
		const aliases = await data<AliasesResponse>(await M('admin', '/admin/aliases'));
		expect(aliases.aliases.map((a) => a.address)).toEqual([
			'info@pfadfinder.test',
			'lager@pfadfinder.test'
		]);
		expect(aliases.targets.some((t) => t.key === lager.key && t.kind === 'extra')).toBe(true);
		expect(aliases.targets.some((t) => t.key === 'stamm')).toBe(true);
		// Weiterleitungen sind keine eigenen Ziele
		expect(aliases.targets.filter((t) => t.key === lager.key)).toHaveLength(1);

		deliver('herbstlager@pfadfinder.test', 'Direkt ans Lager');
		deliver('lager@pfadfinder.test', 'Über die Weiterleitung');
		deliver('info@pfadfinder.test', 'Info an den Stamm');
		const res = await poll();
		expect(res.imported).toBe(3);
		const items = (await list('mia', lager.key)).items.map((i) => i.subject).sort();
		expect(items).toEqual(['Direkt ans Lager', 'Über die Weiterleitung']);
		expect((await list('gerd', lager.key)).items).toHaveLength(2);
		expect((await list('admin', 'unassigned')).items.map((i) => i.subject)).not.toContain(
			'Info an den Stamm'
		);
		const stamm = await moduleDb('messages').transaction(
			(tx) =>
				tx.execute(
					sql`SELECT mailbox_key FROM inbox_messages WHERE subject = 'Info an den Stamm'`
				) as unknown as Promise<{ rows: { mailbox_key: string }[] }>
		);
		expect(stamm.rows.map((r) => r.mailbox_key)).toEqual(['stamm']);
	});

	it('Antworten aus einem Nur-Lesen-Postfach: Vorbelegung ohne Postfach-Absender', async () => {
		const item = (await list('mia', lager.key)).items[0]!;
		const detail = await data<InboxDetail>(await M('mia', `/inbox/${item.id}`));
		expect(detail.canReply).toBe(true);
		const pre = await data<ComposePrefill>(await M('mia', `/inbox/${item.id}/compose?mode=reply`));
		expect(pre.senderKey).toBeNull();
		expect(pre.addresses).toEqual(['petra@extern.example']);
		const preMax = await data<ComposePrefill>(
			await M('max', `/inbox/${item.id}/compose?mode=reply`)
		);
		expect(preMax.senderKey).toBe(lager.key);
	});

	it('Weiterleitung auf ein unbekanntes Postfach → „Nicht zugeordnet“', async () => {
		await moduleDb('messages').transaction((tx) =>
			tx.execute(
				sql`INSERT INTO mailbox_aliases (id, address, target_key)
					VALUES (${crypto.randomUUID()}, 'weg@pfadfinder.test', 'extra:00000000-0000-0000-0000-000000000000')`
			)
		);
		deliver('weg@pfadfinder.test', 'Ins Leere');
		await poll();
		expect((await list('admin', 'unassigned')).items.map((i) => i.subject)).toContain('Ins Leere');
		const aliases = await data<AliasesResponse>(await M('admin', '/admin/aliases'));
		expect(aliases.aliases.find((a) => a.address === 'weg@pfadfinder.test')?.target).toBeNull();
	});

	it('Weiterleitung löschen: danach „Nicht zugeordnet“', async () => {
		const aliases = await data<AliasesResponse>(await M('admin', '/admin/aliases'));
		const info = aliases.aliases.find((a) => a.address === 'info@pfadfinder.test')!;
		expect(
			await data<{ deleted: boolean }>(
				await M('admin', `/admin/aliases/${info.id}`, { method: 'DELETE' })
			)
		).toEqual({ deleted: true });
		expect(
			await errCode(await M('admin', `/admin/aliases/${info.id}`, { method: 'DELETE' }), 404)
		).toBe('not_found');
		deliver('info@pfadfinder.test', 'Info ohne Weiterleitung');
		await poll();
		expect((await list('admin', 'unassigned')).items.map((i) => i.subject)).toContain(
			'Info ohne Weiterleitung'
		);
	});
});

describe('Ändern und Löschen', () => {
	it('Freigabe entziehen: Postfach verschwindet; Adresse ändern prüft Konflikte', async () => {
		const updated = await data<ExtraMailbox>(
			await M('admin', `/admin/mailboxes/${lager.id}`, {
				method: 'PATCH',
				json: {
					shares: [
						{ type: 'user', id: userIds.mia, level: 'edit' },
						{ type: 'user', id: userIds.max, level: 'edit' }
					]
				}
			})
		);
		expect(updated.shares).toHaveLength(2);
		expect((await mailboxes('gerd')).mailboxes.some((b) => b.key === lager.key)).toBe(false);
		expect((await mailboxes('mia')).mailboxes.find((b) => b.key === lager.key)?.senderKey).toBe(
			lager.key
		);
		expect(
			await errCode(
				await M('admin', `/admin/mailboxes/${lager.id}`, {
					method: 'PATCH',
					json: { address: 'kasse@pfadfinder.test' }
				}),
				409
			)
		).toBe('conflict');
		// Eigene Adresse unverändert speichern ist kein Konflikt
		await data(
			await M('admin', `/admin/mailboxes/${lager.id}`, {
				method: 'PATCH',
				json: { address: 'herbstlager@pfadfinder.test', name: 'Herbstlager 2026' }
			})
		);
	});

	it('Löschen: Mails nach „Nicht zugeordnet“, Ordner und Weiterleitungen entfernt', async () => {
		await data(
			await M('mia', '/folders', {
				method: 'POST',
				json: { mailbox: lager.key, parentId: null, name: 'Anmeldungen' }
			}),
			201
		);
		const before = (await list('mia', lager.key)).items.length;
		expect(before).toBe(2);
		const res = await data<{ movedMessages: number; deletedAliases: number }>(
			await M('admin', `/admin/mailboxes/${lager.id}`, { method: 'DELETE' })
		);
		expect(res).toMatchObject({ movedMessages: 2, deletedAliases: 1 });
		const unassigned = (await list('admin', 'unassigned')).items.map((i) => i.subject);
		expect(unassigned).toEqual(
			expect.arrayContaining(['Direkt ans Lager', 'Über die Weiterleitung'])
		);
		expect(
			await errCode(await M('mia', `/inbox?mailbox=${encodeURIComponent(lager.key)}`), 404)
		).toBe('not_found');
		const left = await moduleDb('messages').transaction(
			(tx) =>
				tx.execute(
					sql`SELECT (SELECT count(*)::int FROM inbox_folders WHERE mailbox_key = ${lager.key}) AS folders,
						(SELECT count(*)::int FROM mailbox_aliases WHERE target_key = ${lager.key}) AS aliases`
				) as unknown as Promise<{ rows: { folders: number; aliases: number }[] }>
		);
		expect(Number(left.rows[0]!.folders)).toBe(0);
		expect(Number(left.rows[0]!.aliases)).toBe(0);
		expect(
			await errCode(await M('admin', `/admin/mailboxes/${lager.id}`, { method: 'DELETE' }), 404)
		).toBe('not_found');
	});

	it('Audit ohne Adressen', async () => {
		const json = JSON.stringify([
			await listAudit({ action: 'messages.mailbox' }),
			await listAudit({ action: 'messages.alias' })
		]);
		for (const a of [
			'messages.mailbox.created',
			'messages.mailbox.updated',
			'messages.mailbox.deleted',
			'messages.alias.created',
			'messages.alias.deleted'
		]) {
			expect(json).toContain(a);
		}
		expect(json).not.toMatch(/herbstlager|lager@|info@|pfadfinder\.test/);
	});

	it('Konto gelöscht: Freigaben an das Konto und Weiterleitungen auf sein Postfach entfallen', async () => {
		const box = await createMailbox({
			name: 'Fahrt',
			address: 'fahrt@pfadfinder.test',
			shares: [{ type: 'user', id: userIds.fred, level: 'read' }]
		});
		await data(
			await M('admin', '/admin/aliases', {
				method: 'POST',
				json: { address: 'fred@pfadfinder.test', targetKey: `personal:${userIds.fred}` }
			}),
			201
		);
		await deleteUser(admin, userIds.fred!);
		const rows = await moduleDb('messages').transaction(
			(tx) =>
				tx.execute(
					sql`SELECT (SELECT count(*)::int FROM extra_mailbox_shares WHERE mailbox_id = ${box.id}) AS shares,
						(SELECT count(*)::int FROM mailbox_aliases WHERE address = 'fred@pfadfinder.test') AS aliases`
				) as unknown as Promise<{ rows: { shares: number; aliases: number }[] }>
		);
		expect(Number(rows.rows[0]!.shares)).toBe(0);
		expect(Number(rows.rows[0]!.aliases)).toBe(0);
	});
});
