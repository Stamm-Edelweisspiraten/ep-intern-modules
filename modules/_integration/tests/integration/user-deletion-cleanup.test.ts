/**
 * Benutzerlöschung räumt Module auf (#8): Hook `onUserDeleted` in files, offices, members, events;
 * Profilbild-Objekt entfernt; öffentliche Links (Ansehen/Hochladen) gelöschter **und** deaktivierter Konten
 * liefern 404. Storage über `tests/helpers/fake-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { fakeFileRows, fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser, setUserActive } from '$testing';
import { setOwnAvatar } from '$testing';
import { createRole } from '$testing';
import { listModuleRoleGrants } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import filesModule from '$modules/files/module';
import officesModule from '$modules/offices/module';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'correct-horse-battery';
// Echtes 1×1-PNG: Profilbilder laufen durch `core.images` (#19)
const PNG = new Uint8Array(
	Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
		'base64'
	)
);
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

interface Res {
	status: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

async function send(
	who: string | null,
	method: string,
	path: string,
	init: { headers?: Record<string, string>; body?: BodyInit } = {}
): Promise<Res> {
	resetAllForTests();
	const headers = new Headers(init.headers ?? {});
	if (who) headers.set('authorization', `Bearer ${keys[who]}`);
	const url = new URL(`http://localhost:5173/api/v1/modules${path}`);
	const res = await handleApiRequest({
		request: new Request(url, { method, headers, body: init.body }),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* Rohinhalt */
	}
	return { status: res.status, body };
}

const call = (who: string | null, method: string, path: string, json?: unknown) =>
	send(
		who,
		method,
		path,
		json === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }
	);

function ok<T>(res: Res, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

async function multipart(who: string | null, path: string, form: FormData) {
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	return send(who, 'POST', path, {
		headers: {
			'content-type': r.headers.get('content-type')!,
			'content-length': String(buf.byteLength)
		},
		body: buf
	});
}

const textFile = (name: string, text: string) =>
	new File([new TextEncoder().encode(text) as BlobPart], name, { type: 'text/plain' });

async function pubUpload(token: string) {
	const form = new FormData();
	form.append('file', textFile('fremd.txt', 'hallo'));
	return multipart(null, `/files/public/links/${token}/upload`, form);
}

async function rows(query: ReturnType<typeof sql>) {
	return (await getDb().execute(query)).rows as Record<string, unknown>[];
}

const tokenOf = (l: { url: string }) => String(l.url).split('/').pop()!;

let viewToken = '';
let uploadToken = '';
let folderId = '';
let fileId = '';
let officeId = '';
let memberId = '';
let eventId = '';

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	for (const m of [membersModule, filesModule, officesModule, eventsModule]) registerModule(m);
	await syncModules();
	await bootstrapAdmin('admin@example.test', PW);
	const [a] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	ids.admin = a!.id;
	admin = await ctxOf(a!.id);
	for (const m of ['members', 'files', 'offices', 'events']) await enableModule(admin, m);
	admin = await ctxOf(a!.id);
	keys.admin = (await createApiKey(admin, { name: 'k', scopes: [...admin.permissions] })).key;
	await installFakeStorage(admin);

	const role = await createRole(admin, {
		name: 'Person',
		permissions: [
			'core.api.manage',
			'files.file.view',
			'files.link.create',
			'offices.office.view',
			'events.event.view',
			'events.event.create'
		]
	});
	ids.anna = await createUser(admin, {
		name: 'Anna Ablage',
		email: 'anna@example.test',
		password: PW,
		roleIds: [role]
	});
	const anna = await ctxOf(ids.anna);
	keys.anna = (await createApiKey(anna, { name: 'k', scopes: [...anna.permissions] })).key;

	// files: Ordner + Datei + Ansicht- und Upload-Link
	folderId = ok<{ id: string }>(
		await call('anna', 'POST', '/files/folders', { parentId: null, name: 'Fotos' }),
		201
	).id;
	const form = new FormData();
	form.set('file', textFile('liste.txt', 'Inhalt'));
	fileId = ok<{ id: string }>(
		await multipart('anna', `/files/nodes/${folderId}/upload`, form),
		201
	).id;
	viewToken = tokenOf(
		ok(
			await call('anna', 'POST', `/files/nodes/${folderId}/links`, {
				expiresOn: null,
				password: null,
				mode: 'view'
			}),
			201
		)
	);
	uploadToken = tokenOf(
		ok(
			await call('anna', 'POST', `/files/nodes/${folderId}/links`, {
				expiresOn: null,
				password: null,
				mode: 'upload'
			}),
			201
		)
	);
	// Freigabe an Anna auf einem Ordner des Admins
	const adminFolder = ok<{ id: string }>(
		await call('admin', 'POST', '/files/folders', { parentId: null, name: 'Admin-Ordner' }),
		201
	).id;
	ok(
		await call('admin', 'PUT', `/files/nodes/${adminFolder}/shares`, {
			shares: [{ type: 'user', id: ids.anna, level: 'read' }]
		})
	);

	// offices: Amt mit Anna als Inhaberin, Beschreibung, Einstellung, Warteschlange
	officeId = ok<{ id: string }>(
		await call('admin', 'POST', '/offices/offices', { name: 'Materialwart' }),
		201
	).id;
	ok(
		await call('admin', 'PUT', `/offices/offices/${officeId}/holders`, {
			holders: [{ userId: ids.anna }]
		})
	);
	ok(await call('anna', 'PUT', '/offices/me/bio', { bio: 'Ich kümmere mich ums Material.' }));
	await getDb().execute(
		sql`INSERT INTO mod_offices.notification_prefs (user_id, module_id, office_key, event_key, mode)
			VALUES (${ids.anna}, 'treasury', 'kasse', 'payable-created', 'daily')`
	);
	await getDb().execute(
		sql`INSERT INTO mod_offices.notification_queue (id, user_id, module_id, office_key, event_key, subject, text)
			VALUES (${crypto.randomUUID()}, ${ids.anna}, 'treasury', 'kasse', 'payable-created', 'Betreff', 'Text')`
	);

	// members: Konto-Verknüpfung
	memberId = ok<{ id: string }>(
		await call('admin', 'POST', '/members/members', {
			firstName: 'Kind',
			lastName: 'Muster',
			scoutName: null,
			birthDate: '2014-05-17',
			street: 'Musterweg 1',
			postalCode: '12345',
			city: 'Musterstadt',
			country: 'DE',
			phones: [],
			emails: [],
			stage: 'pfadfinder',
			groupIds: []
		}),
		201
	).id;
	await getDb().execute(
		sql`INSERT INTO mod_members.member_user_links (member_id, user_id, relation)
			VALUES (${memberId}, ${ids.anna}, 'Mutter')`
	);

	// events: Termin von Anna
	eventId = ok<{ id: string }>(
		await call('anna', 'POST', '/events/events', {
			title: 'Materialtag',
			description: '',
			location: 'Heim',
			startsOn: '2026-11-03',
			startsTime: null,
			endsOn: null,
			endsTime: null,
			tags: [],
			groupIds: ['stamm'],
			shares: [],
			onWebsite: false
		}),
		201
	).id;

	// Profilbild
	await setOwnAvatar(anna, { data: PNG, contentType: 'image/png' });
});

afterAll(async () => {
	uninstallFakeStorage();
	await close?.();
});

const avatarStored = () =>
	[...fakeFileRows.values()].some(
		(r) => r.moduleId === 'core' && r.path === `avatars/${ids.anna}` && fakeObjects.has(r.objectKey)
	);
const filesObjectsOf = (nodeId: string) =>
	[...fakeFileRows.values()].filter(
		(r) => r.moduleId === 'files' && r.path.startsWith(`${nodeId}/`) && fakeObjects.has(r.objectKey)
	);

describe('Deaktiviertes Konto', () => {
	it('öffentliche Links funktionieren vorher', async () => {
		ok(await call(null, 'GET', `/files/public/links/${viewToken}`));
		ok(await call(null, 'GET', `/files/public/links/${viewToken}/nodes`));
		ok(await pubUpload(uploadToken), 201);
	});

	it('Deaktivieren sperrt Ansicht-, Inhalts- und Upload-Links (404), Aktivieren gibt sie frei', async () => {
		await setUserActive(admin, ids.anna!, false);
		expect((await call(null, 'GET', `/files/public/links/${viewToken}`)).status).toBe(404);
		expect((await call(null, 'GET', `/files/public/links/${viewToken}/nodes`)).status).toBe(404);
		expect(
			(await call(null, 'GET', `/files/public/links/${viewToken}/content/${fileId}`)).status
		).toBe(404);
		expect(
			(await call(null, 'POST', `/files/public/links/${viewToken}/unlock`, { password: 'x' }))
				.status
		).toBe(404);
		expect((await pubUpload(uploadToken)).status).toBe(404);
		await setUserActive(admin, ids.anna!, true);
		ok(await call(null, 'GET', `/files/public/links/${viewToken}`));
	});
});

describe('Gelöschtes Konto', () => {
	it('vorher: Daten sind vorhanden', async () => {
		expect(avatarStored()).toBe(true);
		expect(filesObjectsOf(fileId).length).toBeGreaterThan(0);
		expect(await listModuleRoleGrants('offices', { userId: ids.anna })).not.toHaveLength(0);
	});

	it('deleteUser räumt alle Module auf', async () => {
		await deleteUser(admin, ids.anna!);
		const anna = ids.anna!;

		// files
		expect((await call(null, 'GET', `/files/public/links/${viewToken}`)).status).toBe(404);
		expect((await pubUpload(uploadToken)).status).toBe(404);
		expect(await rows(sql`SELECT id FROM mod_files.nodes WHERE owner_id = ${anna}`)).toHaveLength(
			0
		);
		expect(
			await rows(sql`SELECT 1 FROM mod_files.share_links WHERE node_id = ${folderId}`)
		).toHaveLength(0);
		expect(
			await rows(
				sql`SELECT 1 FROM mod_files.node_shares WHERE principal_type = 'user' AND principal_id = ${anna}`
			)
		).toHaveLength(0);
		expect(
			await rows(
				sql`SELECT 1 FROM mod_files.nodes WHERE created_by = ${anna} OR deleted_by = ${anna}`
			)
		).toHaveLength(0);
		expect(filesObjectsOf(fileId)).toHaveLength(0);
		expect(filesObjectsOf(folderId)).toHaveLength(0);

		// Core: Profilbild
		expect(avatarStored()).toBe(false);

		// offices
		for (const t of [
			'office_holders',
			'holder_profiles',
			'notification_prefs',
			'notification_queue'
		]) {
			expect(
				await rows(sql`SELECT 1 FROM ${sql.raw(`mod_offices.${t}`)} WHERE user_id = ${anna}`),
				t
			).toHaveLength(0);
		}
		expect(await listModuleRoleGrants('offices', { userId: anna })).toHaveLength(0);
		const office = ok<{ holders: unknown[] }>(
			await call('admin', 'GET', `/offices/offices/${officeId}`)
		);
		expect(office.holders).toHaveLength(0);

		// members: Mitglied bleibt, Verknüpfung weg
		expect(
			await rows(sql`SELECT 1 FROM mod_members.member_user_links WHERE user_id = ${anna}`)
		).toHaveLength(0);
		expect(await rows(sql`SELECT 1 FROM mod_members.members WHERE id = ${memberId}`)).toHaveLength(
			1
		);

		// events: Termin bleibt, gehört jetzt der löschenden Person
		const [ev] = await rows(
			sql`SELECT owner_id, created_by FROM mod_events.events WHERE id = ${eventId}`
		);
		expect(ev).toMatchObject({ owner_id: ids.admin, created_by: null });

		// Audit ohne Fehlerliste
		const { rows: audit } = await listAudit({ target: anna, limit: 50 });
		const deleted = audit.find((r) => r.action === 'core.user.deleted');
		expect(deleted).toBeTruthy();
		expect(deleted!.metadata ?? {}).not.toHaveProperty('cleanupFailed');
	});
});
