/**
 * Ordner im Posteingang (`messages`, Migration 0004): Anlegen/Umbenennen/Verschieben/Löschen je Postfach,
 * gemeinsam für alle mit Zugriff (Amts-Postfach), persönlich nur für die Person, Grenzen (Tiefe, Anzahl,
 * Namen, Zyklen), Mails einsortieren (Liste je Ordner, Zähler), Papierkorb behält den Ordner, Zuordnen
 * setzt ihn zurück, Sammelaktionen, Audit ohne Namen, Konto löschen entfernt persönliche Ordner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { setSettings } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb, rowsOf } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import messagesModule from '$modules/messages/module';
import { setImapConnectorForTests } from '$modules/messages/imap.client';
import type {
	DeleteFolderResult,
	InboxDetail,
	InboxFolder,
	InboxListResponse,
	MailboxesResponse,
	MoveMailsResult
} from '$modules/messages/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'folder-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

let imapBox: { uid: number; source: Buffer }[] = [];
let nextUid = 1;
let emlCounter = 0;
function deliver(to: string, subject = 'Frage zur Fahrt') {
	const source = [
		'From: Petra Extern <petra@extern.example>',
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: ${new Date(Date.now() - 60_000).toUTCString()}`,
		`Message-ID: <f${++emlCounter}.${Date.now()}@extern.example>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Hallo',
		''
	].join('\r\n');
	imapBox.push({ uid: nextUid++, source: Buffer.from(source, 'utf8') });
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

const poll = async () => data(await M('admin', '/inbox/poll', { method: 'POST' }), 201);
const mailboxes = async (who: string) => data<MailboxesResponse>(await M(who, '/mailboxes'));
const box = async (who: string, key: string) =>
	(await mailboxes(who)).mailboxes.find((b) => b.key === key)!;
const list = async (who: string, mailbox: string, folder = 'inbox', filter = 'all') =>
	data<InboxListResponse>(
		await M(who, `/inbox?mailbox=${encodeURIComponent(mailbox)}&folder=${folder}&filter=${filter}`)
	);
const createFolder = async (
	who: string,
	mailbox: string,
	name: string,
	parentId: string | null = null
) =>
	data<InboxFolder>(
		await M(who, '/folders', { method: 'POST', json: { mailbox, parentId, name } }),
		201
	);
const move = (who: string, ids: string[], folderId: string | null) =>
	M(who, '/inbox/move', { method: 'POST', json: { ids, folderId } });

let officeKey = '';
let annaKey = '';

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
		'messages.domain': 'pfadfinder.test',
		'core.organization.email': 'stamm@pfadfinder.test',
		'core.organization.name': 'Stamm Test',
		'messages.imap.enabled': true,
		'messages.imap.host': 'imap.pfadfinder.test',
		'messages.imap.user': 'catchall@pfadfinder.test',
		'messages.imap.password': 'geheim'
	});
	const base = ['core.api.manage', 'messages.message.send'];
	await mkUser('anna', 'Anna Müller', base);
	await mkUser('otto', 'Otto Amt', base);
	await mkUser('olga', 'Olga Kasse', base);
	await mkUser('nina', 'Nina Niemand', ['core.api.manage']);
	annaKey = `personal:${userIds.anna}`;

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
});
afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	setImapConnectorForTests(undefined);
	uninstallFakeStorage();
	await close();
});
beforeEach(() => resetAllForTests());

describe('Ordner anlegen und verwalten', () => {
	it('gemeinsames Postfach: angelegte Ordner sehen und ändern alle Berechtigten', async () => {
		const f = await createFolder('otto', officeKey, 'Rechnungen');
		expect(f).toMatchObject({ name: 'Rechnungen', parentId: null, unread: 0, total: 0 });
		const olgaBox = await box('olga', officeKey);
		expect(olgaBox.folders.map((x) => x.name)).toEqual(['Rechnungen']);
		// Olga benennt um, Otto sieht es
		await data(await M('olga', `/folders/${f.id}`, { method: 'PATCH', json: { name: 'Belege' } }));
		expect((await box('otto', officeKey)).folders.map((x) => x.name)).toEqual(['Belege']);
	});

	it('persönliche Ordner sieht nur die Person selbst; fremd → 404', async () => {
		const f = await createFolder('anna', annaKey, 'Privat');
		expect((await box('anna', annaKey)).folders.some((x) => x.id === f.id)).toBe(true);
		expect(
			await errCode(
				await M('otto', '/folders', {
					method: 'POST',
					json: { mailbox: annaKey, parentId: null, name: 'Fremd' }
				}),
				404
			)
		).toBe('not_found');
		expect(
			await errCode(
				await M('otto', `/folders/${f.id}`, { method: 'PATCH', json: { name: 'X' } }),
				404
			)
		).toBe('not_found');
		expect(await errCode(await M('otto', `/folders/${f.id}`, { method: 'DELETE' }), 404)).toBe(
			'not_found'
		);
		// Ordner des Amts kennt Anna nicht
		const office = await createFolder('otto', officeKey, 'Nur Amt');
		expect(await errCode(await M('anna', `/folders/${office.id}`, { method: 'DELETE' }), 404)).toBe(
			'not_found'
		);
	});

	it('ohne Senden-Recht 403, „Nicht zugeordnet“ hat keine Ordner (422)', async () => {
		expect(
			await errCode(
				await M('nina', '/folders', {
					method: 'POST',
					json: { mailbox: annaKey, parentId: null, name: 'X' }
				}),
				403
			)
		).toBe('forbidden');
		expect(
			await errCode(
				await M('admin', '/folders', {
					method: 'POST',
					json: { mailbox: 'unassigned', parentId: null, name: 'X' }
				}),
				422
			)
		).toBe('validation_failed');
	});

	it('Name je Ebene eindeutig (Groß/klein egal) → 409, leer → 422', async () => {
		const parent = await createFolder('anna', annaKey, 'Lager');
		expect(
			await errCode(
				await M('anna', '/folders', {
					method: 'POST',
					json: { mailbox: annaKey, parentId: null, name: 'lager' }
				}),
				409
			)
		).toBe('conflict');
		// gleicher Name auf anderer Ebene ist erlaubt
		await createFolder('anna', annaKey, 'Lager', parent.id);
		expect(
			await errCode(
				await M('anna', '/folders', {
					method: 'POST',
					json: { mailbox: annaKey, parentId: null, name: '   ' }
				}),
				422
			)
		).toBe('validation_failed');
	});

	it('höchstens 3 Ebenen, kein Zyklus, Elternordner nur aus demselben Postfach', async () => {
		const a = await createFolder('anna', annaKey, 'Ebene 1');
		const b = await createFolder('anna', annaKey, 'Ebene 2', a.id);
		const c = await createFolder('anna', annaKey, 'Ebene 3', b.id);
		expect(
			await errCode(
				await M('anna', '/folders', {
					method: 'POST',
					json: { mailbox: annaKey, parentId: c.id, name: 'Ebene 4' }
				}),
				422
			)
		).toBe('validation_failed');
		// a unter c → Zyklus
		expect(
			await errCode(
				await M('anna', `/folders/${a.id}`, { method: 'PATCH', json: { parentId: c.id } }),
				422
			)
		).toBe('validation_failed');
		// Unterbaum b (Höhe 2) unter einen Ordner der Ebene 2 → Tiefe 4
		const x = await createFolder('anna', annaKey, 'X');
		const y = await createFolder('anna', annaKey, 'Y', x.id);
		expect(
			await errCode(
				await M('anna', `/folders/${b.id}`, { method: 'PATCH', json: { parentId: y.id } }),
				422
			)
		).toBe('validation_failed');
		// erlaubt: b samt c unter x (Ebene 2 + Höhe 2 = 3)
		const moved = await data<InboxFolder>(
			await M('anna', `/folders/${b.id}`, { method: 'PATCH', json: { parentId: x.id } })
		);
		expect(moved.parentId).toBe(x.id);
		// Elternordner aus einem fremden Postfach
		const office = await createFolder('otto', officeKey, 'Amt-Ordner');
		expect(
			await errCode(
				await M('otto', '/folders', {
					method: 'POST',
					json: { mailbox: officeKey, parentId: a.id, name: 'Quer' }
				}),
				422
			)
		).toBe('validation_failed');
		// zurück auf die oberste Ebene
		const top = await data<InboxFolder>(
			await M('otto', `/folders/${office.id}`, { method: 'PATCH', json: { parentId: null } })
		);
		expect(top.parentId).toBeNull();
	});

	it('höchstens 100 Ordner je Postfach', async () => {
		await mkUser('viel', 'Viel Ordner', ['core.api.manage', 'messages.message.send']);
		const key = `personal:${userIds.viel}`;
		await moduleDb('messages').transaction(async (tx) => {
			for (let i = 0; i < 100; i++) {
				await tx.execute(
					sql`INSERT INTO inbox_folders (id, mailbox_key, name) VALUES (${crypto.randomUUID()}, ${key}, ${`O${i}`})`
				);
			}
		});
		expect(
			await errCode(
				await M('viel', '/folders', {
					method: 'POST',
					json: { mailbox: key, parentId: null, name: 'Zu viel' }
				}),
				422
			)
		).toBe('validation_failed');
	});
});

describe('Mails einsortieren', () => {
	it('verschieben, Liste je Ordner, Zähler, Rückgängig über den vorherigen Ort', async () => {
		deliver('kasse@pfadfinder.test', 'Rechnung 1');
		deliver('kasse@pfadfinder.test', 'Rechnung 2');
		deliver('kasse@pfadfinder.test', 'Frage');
		await poll();
		const inbox = await list('otto', officeKey);
		const ids = inbox.items.filter((m) => m.subject.startsWith('Rechnung')).map((m) => m.id);
		expect(ids).toHaveLength(2);
		const folder = await createFolder('otto', officeKey, 'Eingangsrechnungen');

		const res = await data<MoveMailsResult>(await move('otto', ids, folder.id), 201);
		expect(res.moved).toBe(2);
		expect(res.previous.every((p) => p.folderId === null)).toBe(true);

		// Olga (gemeinsam) sieht die Mails im Ordner, nicht mehr im Posteingang
		expect((await list('olga', officeKey, folder.id)).items.map((m) => m.subject).sort()).toEqual([
			'Rechnung 1',
			'Rechnung 2'
		]);
		const olgaInbox = await list('olga', officeKey);
		expect(olgaInbox.items.some((m) => m.subject.startsWith('Rechnung'))).toBe(false);
		const b = await box('olga', officeKey);
		expect(b.folders.find((f) => f.id === folder.id)).toMatchObject({ unread: 2, total: 2 });
		expect(b.unread).toBeGreaterThanOrEqual(3); // Postfach zählt alle Ordner
		expect((await list('olga', officeKey, folder.id, 'unread')).total).toBe(2);

		// Detail zeigt den Pfad und markiert gelesen
		const detail = await data<InboxDetail>(await M('olga', `/inbox/${ids[0]}`));
		expect(detail.folderPath).toEqual([{ id: folder.id, name: 'Eingangsrechnungen' }]);
		expect(detail.folderId).toBe(folder.id);

		// Rückgängig: zurück in den Posteingang
		await data(await move('otto', ids, null), 201);
		expect((await list('otto', officeKey, folder.id)).total).toBe(0);
	});

	it('nur innerhalb desselben Postfachs; fremde Mails 404; unbekannter Ordner 404', async () => {
		deliver('kasse@pfadfinder.test', 'Amt');
		deliver('anna.mueller@pfadfinder.test', 'Persönlich');
		await poll();
		const amt = (await list('otto', officeKey)).items.find((m) => m.subject === 'Amt')!;
		const own = (await list('anna', annaKey)).items.find((m) => m.subject === 'Persönlich')!;
		const annaFolder = await createFolder('anna', annaKey, 'Ablage');
		// Anna darf die Amts-Mail nicht anfassen
		expect(await errCode(await move('anna', [amt.id], annaFolder.id), 404)).toBe('not_found');
		// Otto: Ordner aus Annas Postfach als Ziel → 422
		expect(await errCode(await move('otto', [amt.id], annaFolder.id), 422)).toBe(
			'validation_failed'
		);
		// Admin sieht beides nicht gemeinsam (Annas Postfach gehört Anna) → 404
		expect(await errCode(await move('admin', [own.id], null), 404)).toBe('not_found');
		expect(
			await errCode(await M('anna', `/inbox?mailbox=${annaKey}&folder=${crypto.randomUUID()}`), 404)
		).toBe('not_found');
	});

	it('Ordner löschen: Mails zurück in den Posteingang, Unterordner mit weg', async () => {
		deliver('anna.mueller@pfadfinder.test', 'Lagerbrief');
		await poll();
		const mail = (await list('anna', annaKey)).items.find((m) => m.subject === 'Lagerbrief')!;
		const top = await createFolder('anna', annaKey, 'Lager 2026');
		const sub = await createFolder('anna', annaKey, 'Briefe', top.id);
		await data(await move('anna', [mail.id], sub.id), 201);
		const res = await data<DeleteFolderResult>(
			await M('anna', `/folders/${top.id}`, { method: 'DELETE' })
		);
		expect(res).toEqual({ deleted: true, movedMessages: 1 });
		const b = await box('anna', annaKey);
		expect(b.folders.some((f) => f.id === top.id || f.id === sub.id)).toBe(false);
		expect((await list('anna', annaKey)).items.some((m) => m.id === mail.id)).toBe(true);
	});

	it('Papierkorb behält den Ordner, Wiederherstellen bringt die Mail zurück', async () => {
		deliver('anna.mueller@pfadfinder.test', 'Wichtig');
		await poll();
		const mail = (await list('anna', annaKey)).items.find((m) => m.subject === 'Wichtig')!;
		const folder = await createFolder('anna', annaKey, 'Wichtiges');
		await data(await move('anna', [mail.id], folder.id), 201);
		await data(
			await M('anna', '/inbox/bulk', {
				method: 'POST',
				json: { ids: [mail.id], action: 'delete' }
			}),
			201
		);
		expect((await list('anna', annaKey, folder.id)).total).toBe(0);
		const trash = await data<InboxListResponse>(
			await M('anna', `/inbox?mailbox=${annaKey}&filter=trash`)
		);
		expect(trash.items.find((m) => m.id === mail.id)?.folderId).toBe(folder.id);
		await data(
			await M('anna', '/inbox/bulk', {
				method: 'POST',
				json: { ids: [mail.id], action: 'restore' }
			}),
			201
		);
		expect((await list('anna', annaKey, folder.id)).items.map((m) => m.id)).toEqual([mail.id]);
	});

	it('Sammelaktion gelesen/ungelesen gilt je Person', async () => {
		deliver('kasse@pfadfinder.test', 'Sammel 1');
		deliver('kasse@pfadfinder.test', 'Sammel 2');
		await poll();
		const ids = (await list('otto', officeKey)).items
			.filter((m) => m.subject.startsWith('Sammel'))
			.map((m) => m.id);
		await data(
			await M('otto', '/inbox/bulk', { method: 'POST', json: { ids, action: 'read' } }),
			201
		);
		const otto = (await list('otto', officeKey)).items.filter((m) => ids.includes(m.id));
		const olga = (await list('olga', officeKey)).items.filter((m) => ids.includes(m.id));
		expect(otto.every((m) => m.read)).toBe(true);
		expect(olga.every((m) => !m.read)).toBe(true);
		await data(
			await M('otto', '/inbox/bulk', { method: 'POST', json: { ids, action: 'unread' } }),
			201
		);
		expect(
			(await list('otto', officeKey)).items.filter((m) => ids.includes(m.id)).every((m) => !m.read)
		).toBe(true);
		expect(
			await errCode(
				await M('otto', '/inbox/bulk', { method: 'POST', json: { ids: [], action: 'read' } }),
				422
			)
		).toBe('validation_failed');
	});

	it('Zuordnen aus „Nicht zugeordnet“ setzt den Ordner zurück; dort kein Einsortieren', async () => {
		deliver('unbekannt@pfadfinder.test', 'Irrläufer');
		await poll();
		const mail = (
			await data<InboxListResponse>(await M('admin', '/inbox?mailbox=unassigned'))
		).items.find((m) => m.subject === 'Irrläufer')!;
		expect(await errCode(await move('admin', [mail.id], null), 422)).toBe('validation_failed');
		await data(
			await M('admin', `/inbox/${mail.id}/assign`, {
				method: 'POST',
				json: { mailbox: officeKey }
			}),
			201
		);
		const assigned = (await list('otto', officeKey)).items.find((m) => m.id === mail.id);
		expect(assigned?.folderId).toBeNull();
	});
});

describe('Datenschutz und Audit', () => {
	it('Audit nur mit Zählern, ohne Ordnernamen', async () => {
		await createFolder('anna', annaKey, 'Geheimer Ordnername');
		const { rows } = await listAudit({ action: 'messages.inbox.folder' });
		expect(rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(rows)).not.toContain('Geheimer Ordnername');
		const moved = await listAudit({ action: 'messages.inbox.moved' });
		expect(moved.rows[0]?.metadata).toMatchObject({ count: expect.any(Number) });
	});

	it('Konto löschen entfernt die persönlichen Ordner, gemeinsame bleiben', async () => {
		await mkUser('weg', 'Weg Gang', ['core.api.manage', 'messages.message.send']);
		const key = `personal:${userIds.weg}`;
		await createFolder('weg', key, 'Mein Ordner');
		await deleteUser(admin, userIds.weg!);
		const [left] = await moduleDb('messages').transaction((tx) =>
			rowsOf(tx, sql`SELECT count(*)::int AS n FROM inbox_folders WHERE mailbox_key = ${key}`)
		);
		expect(Number(left?.n)).toBe(0);
		expect((await box('otto', officeKey)).folders.length).toBeGreaterThan(0);
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'messages');
		expect(
			await errCode(
				await M('anna', '/folders', {
					method: 'POST',
					json: { mailbox: annaKey, parentId: null, name: 'X' }
				}),
				404
			)
		).toBe('module_disabled');
		await enableModule(admin, 'messages');
	});
});
