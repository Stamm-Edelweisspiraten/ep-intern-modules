/**
 * Modul `galleries` (Galerien) – Integrationstests über `handleApiRequest` mit API-Keys:
 * Modul-Smoke (Tabellen, Rechte, defaultRoleGrants), CRUD + Validierung, Zugriffsmatrix
 * (Eigentümer*in, Freigabe read/edit an Stamm/Gruppe/Rolle/Benutzer/Mitglied, öffentlich,
 * view-all, edit-all, Fremde, ohne Basisrecht), Liste (Filter, Paging, access), Titelbild
 * (über direkte DB-Inserts, ohne Storage), Audit ohne Inhalte, Website-Key, Modul deaktiviert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { listAudit } from '$testing';
import { core } from '$testing';
import galleriesModule from '$modules/galleries/module';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import type { GalleryDetail, GalleryList } from '$modules/galleries/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let adminId: string;
let close: () => Promise<void>;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'galleries'
): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${moduleId}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function fail(res: Res, status: number, code: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body.error?.code).toBe(code);
}

/** Feldpfade aus `error.details` (Zod-Issues bzw. `errors.validation([...])`) */
function paths(res: Res): string[] {
	const details = res.body.error?.details;
	if (!Array.isArray(details)) return [];
	return details.map((d: { path?: (string | number)[] }) => (d.path ?? []).join('.'));
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

type Share = { type: string; id: string; level: 'read' | 'edit' };
const body = (over: Record<string, unknown> = {}) => ({
	title: 'Sommerlager Fotos',
	description: 'Bilder vom Zeltplatz',
	visibility: 'private',
	shares: [] as Share[],
	...over
});

async function membersPost(path: string, json: unknown): Promise<string> {
	return ok<{ id: string }>(await call('admin', 'POST', path, json, 'members'), 201).id;
}

const createMember = (over: Record<string, unknown>) =>
	membersPost('/members', {
		birthDate: '2012-05-17',
		street: 'Musterweg 1',
		postalCode: '28357',
		city: 'Bremen',
		stage: 'pfadfinder',
		...over
	});

async function link(memberId: string, userId: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation)
				VALUES (${memberId}, ${userId}, 'Mutter')`
		);
	});
}

async function addUser(who: string, name: string, roleId: string, scopes: string[]) {
	const id = await createUser(admin, {
		name,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	userIds[who] = id;
	keys[who] = (await createApiKey(await ctxOf(id), { name: who, scopes })).key;
	return id;
}

async function dbRows(query: ReturnType<typeof sql>) {
	return (
		(await core.database
			.forModule('galleries')
			.transaction((tx) => tx.execute(query))) as unknown as {
			rows: Record<string, unknown>[];
		}
	).rows;
}

/** Bild direkt in die DB (ohne Storage), `createdAt` steuert die Reihenfolge für den Fallback */
async function insertImage(galleryId: string, createdAt: string, width = 800, height = 600) {
	const id = crypto.randomUUID();
	await dbRows(sql`INSERT INTO gallery_images
		(id, gallery_id, description, position, original_name, content_type, width, height,
		 size_bytes, thumb_path, web_path, full_path, uploaded_by, created_at)
		VALUES (${id}, ${galleryId}, NULL, 0, 'bild.jpg', 'image/jpeg', ${width}, ${height},
		 1234, ${`${galleryId}/${id}-thumb.webp`}, ${`${galleryId}/${id}-web.webp`},
		 ${`${galleryId}/${id}-full.jpg`}, ${userIds.owner!}, ${createdAt}::timestamptz)`);
	return id;
}

// Mitglieder / Gruppen
let anna: string; // in Falke → Benutzer b
let fritz: string; // ohne Gruppe → Benutzer f (Freigabe member)
let falke: string;
let editorsRole: string;

// Galerien
let gMain: string; // Freigaben Gruppe/Rolle(edit)/Benutzer/Mitglied
let gEvery: string; // everyone read
let gPrivate: string; // ohne Freigabe
let gPublic: string; // öffentlich, ohne Freigabe

let mainShares: Share[];
const mainBody = (over: Record<string, unknown> = {}) =>
	body({ title: 'Hike Falke', shares: mainShares, ...over });

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	registerModule(galleriesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'members');
	await enableModule(admin, 'events');
	await enableModule(admin, 'galleries');
	admin = await ctxOf(adminId);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [
				...membersModule.manifest.permissions,
				...eventsModule.manifest.permissions,
				...galleriesModule.manifest.permissions
			]
		})
	).key;

	const lea = await createMember({ firstName: 'Lea', lastName: 'Leitung' });
	falke = await membersPost('/groups', { name: 'Sippe Falke', type: 'sippe', leaderIds: [lea] });
	anna = await createMember({ firstName: 'Anna', lastName: 'Albrecht', groupIds: [falke] });
	fritz = await createMember({ firstName: 'Fritz', lastName: 'Frei' });

	const viewPerms = ['core.api.manage', 'galleries.gallery.view'];
	// Mitgliedsnamen und E-Mails in Freigaben/Suche nur mit diesen Rechten (siehe principals-privacy.test.ts)
	const noPublishPerms = [
		...viewPerms,
		'galleries.gallery.create',
		'members.member.view',
		'core.users.view'
	];
	const ownerPerms = [...noPublishPerms, 'galleries.gallery.publish'];
	const ownerRole = await createRole(admin, { name: 'Fotografie', permissions: ownerPerms });
	const noPublishRole = await createRole(admin, {
		name: 'Fotografie ohne Veröffentlichen',
		permissions: noPublishPerms
	});
	const viewerRole = await createRole(admin, { name: 'Lesende', permissions: viewPerms });
	editorsRole = await createRole(admin, { name: 'Redaktion', permissions: viewPerms });
	const viewAllRole = await createRole(admin, {
		name: 'Alle sehen',
		permissions: [...viewPerms, 'galleries.gallery.view-all']
	});
	const editAllRole = await createRole(admin, {
		name: 'Alle bearbeiten',
		permissions: [...viewPerms, 'galleries.gallery.edit-all']
	});
	const noViewRole = await createRole(admin, { name: 'Ohne', permissions: ['core.api.manage'] });
	const websiteRole = await createRole(admin, {
		name: 'Website',
		permissions: ['core.api.manage', 'galleries.website.read']
	});

	await addUser('owner', 'Olga Owner', ownerRole, ownerPerms);
	await addUser('q', 'Quentin Ohnepublish', noPublishRole, noPublishPerms);
	await addUser('a', 'Alle Anna', viewerRole, viewPerms);
	await addUser('b', 'Gruppen Bernd', viewerRole, viewPerms);
	await addUser('d', 'Rollen Dora', editorsRole, viewPerms);
	await addUser('e', 'Benutzer Emil', viewerRole, viewPerms);
	await addUser('f', 'Mitglieds Frieda', viewerRole, viewPerms);
	await addUser('g', 'Viewall Gina', viewAllRole, [...viewPerms, 'galleries.gallery.view-all']);
	await addUser('h', 'Editall Hans', editAllRole, [...viewPerms, 'galleries.gallery.edit-all']);
	await addUser('i', 'Fremd Ingo', viewerRole, viewPerms);
	await addUser('j', 'Ohne Jana', noViewRole, ['core.api.manage']);
	await addUser('web', 'Website', websiteRole, ['galleries.website.read']);

	await link(anna, userIds.b!);
	await link(fritz, userIds.f!);

	mainShares = [
		{ type: 'group', id: falke, level: 'read' },
		{ type: 'role', id: editorsRole, level: 'edit' },
		{ type: 'user', id: userIds.e!, level: 'read' },
		{ type: 'member', id: fritz, level: 'read' }
	];

	gMain = ok<GalleryDetail>(await call('owner', 'POST', '/galleries', mainBody()), 201).id;
	gEvery = ok<GalleryDetail>(
		await call(
			'owner',
			'POST',
			'/galleries',
			body({ title: 'Stammesfest', shares: [{ type: 'everyone', id: '*', level: 'read' }] })
		),
		201
	).id;
	gPrivate = ok<GalleryDetail>(
		await call('owner', 'POST', '/galleries', body({ title: 'Leiterrunde privat' })),
		201
	).id;
	gPublic = ok<GalleryDetail>(
		await call(
			'owner',
			'POST',
			'/galleries',
			body({ title: 'Pfingstlager', visibility: 'public', consentConfirmed: true })
		),
		201
	).id;
});

afterAll(async () => {
	await close();
});

async function listIds(who: string, query = ''): Promise<string[]> {
	return ok<GalleryList>(await call(who, 'GET', `/galleries${query}`)).items.map((i) => i.id);
}

/** Lesezugriff: GET 200 (ohne Freigaben), in der Liste mit `read`, PUT/DELETE/Cover 403 */
async function expectRead(who: string, id: string, put: unknown) {
	const detail = ok<GalleryDetail>(await call(who, 'GET', `/galleries/${id}`));
	expect(detail.access).toEqual({ level: 'read', isOwner: false });
	expect(detail.shares).toEqual([]);
	const listed = ok<GalleryList>(await call(who, 'GET', '/galleries?limit=200')).items.find(
		(i) => i.id === id
	);
	expect(listed?.access).toEqual({ level: 'read', isOwner: false });
	fail(await call(who, 'PUT', `/galleries/${id}`, put), 403, 'forbidden');
	fail(await call(who, 'PUT', `/galleries/${id}/cover`, { imageId: null }), 403, 'forbidden');
	fail(await call(who, 'DELETE', `/galleries/${id}`), 403, 'forbidden');
}

/** Kein Zugriff: GET/PUT/DELETE 404, nicht in der Liste */
async function expectNone(who: string, id: string, put: unknown) {
	fail(await call(who, 'GET', `/galleries/${id}`), 404, 'not_found');
	fail(await call(who, 'PUT', `/galleries/${id}`, put), 404, 'not_found');
	fail(await call(who, 'PUT', `/galleries/${id}/cover`, { imageId: null }), 404, 'not_found');
	fail(await call(who, 'DELETE', `/galleries/${id}`), 404, 'not_found');
	expect(await listIds(who, '?limit=200')).not.toContain(id);
}

describe('Modul galleries (Smoke)', () => {
	it('legt die Tabellen im Schema mod_galleries an', async () => {
		const res = (await getDb().execute(
			sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'mod_galleries'`
		)) as unknown as { rows: { table_name: string }[] };
		expect(res.rows.map((r) => r.table_name).sort()).toEqual([
			'galleries',
			'gallery_events',
			'gallery_images',
			'gallery_shares'
		]);
	});

	it('registriert die Rechte und gibt sie der Administrator-Rolle', async () => {
		const perms = await getDb()
			.select({ key: schema.permission.key })
			.from(schema.permission)
			.where(eq(schema.permission.moduleId, 'galleries'));
		expect(perms.map((p) => p.key).sort()).toEqual([
			'galleries.gallery.create',
			'galleries.gallery.edit-all',
			'galleries.gallery.publish',
			'galleries.gallery.view',
			'galleries.gallery.view-all',
			'galleries.website.read'
		]);
		for (const p of perms) expect(admin.permissions.has(p.key)).toBe(true);
	});

	it('gibt der Rolle Mitglied das Leserecht (defaultRoleGrants)', async () => {
		const granted = await getDb()
			.select({ key: schema.rolePermission.permissionKey })
			.from(schema.rolePermission)
			.innerJoin(schema.role, eq(schema.role.id, schema.rolePermission.roleId))
			.where(eq(schema.role.name, 'Mitglied'));
		const list = granted.map((g) => g.key).filter((k) => k.startsWith('galleries.'));
		expect(list).toEqual(['galleries.gallery.view']);
	});
});

describe('CRUD', () => {
	it('POST legt privat als Standard an, Eigentümer*in = Aufrufer*in', async () => {
		const created = ok<GalleryDetail>(
			await call('owner', 'POST', '/galleries', { title: '  Nur Titel  ' }),
			201
		);
		expect(created.title).toBe('Nur Titel');
		expect(created.description).toBeNull();
		expect(created.visibility).toBe('private');
		expect(created.ownerId).toBe(userIds.owner);
		expect(created.owner).toEqual({ id: userIds.owner, name: 'Olga Owner', image: null });
		expect(created.access).toEqual({ level: 'edit', isOwner: true });
		expect(created.shares).toEqual([]);
		expect(created.images).toEqual([]);
		expect(created.imageCount).toBe(0);
		expect(created.cover).toBeNull();
		expect(created.coverImageId).toBeNull();
		expect(created.coverIsDefault).toBe(true);

		const detail = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${created.id}`));
		expect(detail.id).toBe(created.id);
		expect(await listIds('owner', '?limit=200')).toContain(created.id);

		expect(ok(await call('owner', 'DELETE', `/galleries/${created.id}`))).toMatchObject({
			deleted: true
		});
		fail(await call('owner', 'GET', `/galleries/${created.id}`), 404, 'not_found');
	});

	it('PUT ersetzt Titel, Beschreibung, Sichtbarkeit und Freigaben', async () => {
		const id = ok<GalleryDetail>(
			await call(
				'owner',
				'POST',
				'/galleries',
				body({ title: 'Vorher', shares: [{ type: 'user', id: userIds.e!, level: 'read' }] })
			),
			201
		).id;
		const updated = ok<GalleryDetail>(
			await call(
				'owner',
				'PUT',
				`/galleries/${id}`,
				body({
					title: 'Nachher',
					description: null,
					visibility: 'public',
					consentConfirmed: true,
					shares: [{ type: 'role', id: editorsRole, level: 'edit' }]
				})
			)
		);
		expect(updated.title).toBe('Nachher');
		expect(updated.description).toBeNull();
		expect(updated.visibility).toBe('public');
		expect(updated.shares.map((s) => `${s.type}:${s.id}:${s.level}`)).toEqual([
			`role:${editorsRole}:edit`
		]);
		expect(updated.shares[0]?.name).toBe('Redaktion');
		// Freigabe an e ist weg, öffentlich bleibt lesbar
		const asE = ok<GalleryDetail>(await call('e', 'GET', `/galleries/${id}`));
		expect(asE.access.level).toBe('read');
		ok(await call('owner', 'DELETE', `/galleries/${id}`));
	});

	it('POST ohne galleries.gallery.create → 403', async () => {
		fail(await call('a', 'POST', '/galleries', body()), 403, 'forbidden');
		fail(await call('g', 'POST', '/galleries', body()), 403, 'forbidden');
		fail(await call('web', 'POST', '/galleries', body()), 403, 'forbidden');
	});

	it('422 bei ungültigen Daten mit error.code und Feldpfad', async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ title: '   ' }, 'title'],
			[{ title: 'x'.repeat(201) }, 'title'],
			[{ visibility: 'intern' }, 'visibility'],
			[{ unbekannt: true }, ''],
			[{ shares: [{ type: 'everyone', id: 'alle', level: 'read' }] }, 'shares.0.id'],
			[{ shares: [{ type: 'user', id: userIds.e, level: 'admin' }] }, 'shares.0.level'],
			[{ shares: [{ type: 'gast', id: 'x', level: 'read' }] }, 'shares.0.type'],
			[
				{
					shares: [
						{ type: 'user', id: userIds.e, level: 'read' },
						{ type: 'user', id: userIds.e, level: 'edit' }
					]
				},
				'shares.1.id'
			]
		];
		for (const [over, path] of cases) {
			const res = await call('owner', 'POST', '/galleries', body(over));
			fail(res, 422, 'validation_failed');
			expect(paths(res), JSON.stringify(over)).toContain(path);
		}
	});

	it('422 bei unbekannten Principals (nach Zod), Pfad shares.i.id', async () => {
		const cases: Share[] = [
			{ type: 'user', id: 'gibt-es-nicht', level: 'read' },
			{ type: 'role', id: 'gibt-es-nicht', level: 'read' },
			{ type: 'group', id: 'gibt-es-nicht', level: 'read' },
			{ type: 'member', id: 'gibt-es-nicht', level: 'read' }
		];
		for (const share of cases) {
			const res = await call(
				'owner',
				'POST',
				'/galleries',
				body({ shares: [{ type: 'everyone', id: '*', level: 'read' }, share] })
			);
			fail(res, 422, 'validation_failed');
			expect(paths(res), share.type).toContain('shares.1.id');
		}
		// auch bei PUT
		const res = await call(
			'owner',
			'PUT',
			`/galleries/${gPrivate}`,
			body({ title: 'Leiterrunde privat', shares: [cases[0]] })
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('shares.0.id');
	});

	it('404 bei ungültiger oder unbekannter ID', async () => {
		fail(await call('owner', 'GET', `/galleries/${crypto.randomUUID()}`), 404, 'not_found');
		const bad = await call('owner', 'GET', '/galleries/keine-uuid');
		expect([404, 422]).toContain(bad.status);
	});
});

describe('Zugriffsmatrix', () => {
	it('Eigentümer*in: voller Zugriff, Freigaben mit Namen sichtbar', async () => {
		const detail = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${gMain}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: true });
		expect(detail.owner?.name).toBe('Olga Owner');
		expect(detail.shares).toHaveLength(mainShares.length);
		const byKey = new Map(detail.shares.map((s) => [`${s.type}:${s.id}`, s]));
		expect(byKey.get(`group:${falke}`)).toMatchObject({ name: 'Sippe Falke', level: 'read' });
		expect(byKey.get(`role:${editorsRole}`)).toMatchObject({ name: 'Redaktion', level: 'edit' });
		expect(byKey.get(`user:${userIds.e}`)?.name).toBe('Benutzer Emil');
		expect(byKey.get(`member:${fritz}`)?.name).toBe('Fritz Frei');
		expect(await listIds('owner', '?limit=200')).toEqual(
			expect.arrayContaining([gMain, gEvery, gPrivate, gPublic])
		);
	});

	it('(a) everyone read: sieht Stammes- und öffentliche Galerie, sonst nichts', async () => {
		await expectRead('a', gEvery, body({ title: 'Stammesfest' }));
		await expectRead('a', gPublic, body({ title: 'Pfingstlager', visibility: 'public' }));
		await expectNone('a', gMain, mainBody());
		await expectNone('a', gPrivate, body());
	});

	it('(b) Freigabe Gruppe read über verknüpftes Mitglied', async () => {
		await expectRead('b', gMain, mainBody());
		await expectNone('b', gPrivate, body());
	});

	it('(e) Freigabe Benutzer read', async () => {
		await expectRead('e', gMain, mainBody());
	});

	it('(f) Freigabe Mitglied read (verknüpftes Mitglied)', async () => {
		await expectRead('f', gMain, mainBody());
	});

	it('(d) Freigabe Rolle edit: sieht Freigaben, darf ändern und löschen', async () => {
		const detail = ok<GalleryDetail>(await call('d', 'GET', `/galleries/${gMain}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: false });
		expect(detail.shares).toHaveLength(mainShares.length);
		const listed = ok<GalleryList>(await call('d', 'GET', '/galleries')).items.find(
			(i) => i.id === gMain
		);
		expect(listed?.access).toEqual({ level: 'edit', isOwner: false });

		const updated = ok<GalleryDetail>(
			await call('d', 'PUT', `/galleries/${gMain}`, mainBody({ title: 'Hike Falke (geändert)' }))
		);
		expect(updated.title).toBe('Hike Falke (geändert)');
		expect(updated.ownerId).toBe(userIds.owner);
		ok(await call('d', 'PUT', `/galleries/${gMain}/cover`, { imageId: null }));

		const del = ok<GalleryDetail>(
			await call(
				'owner',
				'POST',
				'/galleries',
				body({ title: 'Wegwerf D', shares: [{ type: 'role', id: editorsRole, level: 'edit' }] })
			),
			201
		).id;
		expect(ok(await call('d', 'DELETE', `/galleries/${del}`))).toMatchObject({ deleted: true });
		fail(await call('owner', 'GET', `/galleries/${del}`), 404, 'not_found');
		await expectNone('d', gPrivate, body());
	});

	it('(g) view-all: liest alles, ändert nichts', async () => {
		await expectRead('g', gPrivate, body());
		await expectRead('g', gMain, mainBody());
		expect(await listIds('g', '?limit=200')).toEqual(
			expect.arrayContaining([gMain, gEvery, gPrivate, gPublic])
		);
	});

	it('(h) edit-all: liest, ändert und löscht alles, sieht Freigaben', async () => {
		const detail = ok<GalleryDetail>(await call('h', 'GET', `/galleries/${gPrivate}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: false });
		const main = ok<GalleryDetail>(await call('h', 'GET', `/galleries/${gMain}`));
		expect(main.shares).toHaveLength(mainShares.length);
		expect(await listIds('h', '?limit=200')).toEqual(
			expect.arrayContaining([gMain, gEvery, gPrivate, gPublic])
		);
		const put = ok<GalleryDetail>(
			await call('h', 'PUT', `/galleries/${gPrivate}`, body({ title: 'Leiterrunde (Hans)' }))
		);
		expect(put.title).toBe('Leiterrunde (Hans)');
		expect(put.ownerId).toBe(userIds.owner);
		const del = ok<GalleryDetail>(
			await call('owner', 'POST', '/galleries', body({ title: 'Wegwerf H' })),
			201
		).id;
		ok(await call('h', 'DELETE', `/galleries/${del}`));
		fail(await call('owner', 'GET', `/galleries/${del}`), 404, 'not_found');
	});

	it('(i) Fremde: private 404, öffentliche und Stammes-Galerie lesbar, nicht bearbeitbar', async () => {
		await expectNone('i', gMain, mainBody());
		await expectNone('i', gPrivate, body());
		await expectRead('i', gPublic, body({ title: 'Pfingstlager', visibility: 'public' }));
		expect((await listIds('i')).sort()).toEqual([gEvery, gPublic].sort());
	});

	it('(j) ohne galleries.gallery.view: 403 überall', async () => {
		fail(await call('j', 'GET', '/galleries'), 403, 'forbidden');
		fail(await call('j', 'GET', `/galleries/${gPublic}`), 403, 'forbidden');
		fail(await call('j', 'PUT', `/galleries/${gPublic}`, body()), 403, 'forbidden');
		fail(await call('j', 'DELETE', `/galleries/${gPublic}`), 403, 'forbidden');
		fail(await call('j', 'POST', '/galleries', body()), 403, 'forbidden');
		fail(
			await call('j', 'PUT', `/galleries/${gPublic}/cover`, { imageId: null }),
			403,
			'forbidden'
		);
	});

	it('Website-Key (nur Scope galleries.website.read) bekommt intern 403', async () => {
		fail(await call('web', 'GET', '/galleries'), 403, 'forbidden');
		fail(await call('web', 'GET', `/galleries/${gPublic}`), 403, 'forbidden');
	});
});

describe('Liste', () => {
	it('filtert nach Suche und Sichtbarkeit', async () => {
		expect(await listIds('owner', '?search=pfingst')).toEqual([gPublic]);
		expect(await listIds('owner', '?search=%25')).toEqual([]);
		const pub = ok<GalleryList>(await call('owner', 'GET', '/galleries?visibility=public'));
		expect(pub.items.every((i) => i.visibility === 'public')).toBe(true);
		expect(pub.items.map((i) => i.id)).toContain(gPublic);
		const priv = ok<GalleryList>(await call('owner', 'GET', '/galleries?visibility=private'));
		expect(priv.items.every((i) => i.visibility === 'private')).toBe(true);
		expect(priv.items.map((i) => i.id)).toEqual(expect.arrayContaining([gMain, gPrivate]));
		expect(priv.items.map((i) => i.id)).not.toContain(gPublic);
		fail(await call('owner', 'GET', '/galleries?visibility=intern'), 422, 'validation_failed');
		fail(await call('owner', 'GET', '/galleries?limit=0'), 422, 'validation_failed');
	});

	it('total, limit und offset', async () => {
		const all = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=200'));
		expect(all.total).toBe(all.items.length);
		expect(all.total).toBeGreaterThanOrEqual(4);
		const first = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=2'));
		expect(first.items).toHaveLength(2);
		expect(first.total).toBe(all.total);
		const second = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=2&offset=2'));
		expect(second.total).toBe(all.total);
		const firstIds = first.items.map((i) => i.id);
		for (const item of second.items) expect(firstIds).not.toContain(item.id);
		const beyond = ok<GalleryList>(await call('owner', 'GET', '/galleries?offset=1000'));
		expect(beyond.items).toEqual([]);
		expect(beyond.total).toBe(all.total);
	});

	it('access.level je Item', async () => {
		const items = ok<GalleryList>(await call('d', 'GET', '/galleries?limit=200')).items;
		const byId = new Map(items.map((i) => [i.id, i.access]));
		expect(byId.get(gMain)).toEqual({ level: 'edit', isOwner: false });
		expect(byId.get(gPublic)).toEqual({ level: 'read', isOwner: false });
		const own = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=200')).items;
		for (const i of own) expect(i.access).toEqual({ level: 'edit', isOwner: true });
	});
});

describe('Titelbild', () => {
	let gCover: string;
	let img1: string;
	let img2: string;
	let foreign: string;

	beforeAll(async () => {
		gCover = ok<GalleryDetail>(
			await call('owner', 'POST', '/galleries', body({ title: 'Titelbild-Test' })),
			201
		).id;
		img2 = await insertImage(gCover, '2026-10-02T10:00:00Z', 1200, 900);
		img1 = await insertImage(gCover, '2026-10-01T10:00:00Z', 800, 600);
		foreign = await insertImage(gPrivate, '2026-10-01T09:00:00Z');
	});

	it('Standard = ältestes Bild', async () => {
		const detail = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${gCover}`));
		expect(detail.imageCount).toBe(2);
		expect(detail.images.map((i) => i.id).sort()).toEqual([img1, img2].sort());
		expect(detail.coverImageId).toBe(img1);
		expect(detail.coverIsDefault).toBe(true);
		expect(detail.cover).toEqual({ imageId: img1, width: 800, height: 600 });
		const listed = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=200')).items.find(
			(i) => i.id === gCover
		);
		expect(listed?.imageCount).toBe(2);
		expect(listed?.cover).toEqual({ imageId: img1, width: 800, height: 600 });
	});

	it('422 bei fremder oder unbekannter imageId, Freigabe ungültiger ID 422', async () => {
		fail(
			await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: foreign }),
			422,
			'validation_failed'
		);
		fail(
			await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: crypto.randomUUID() }),
			422,
			'validation_failed'
		);
		fail(
			await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: 'keine-uuid' }),
			422,
			'validation_failed'
		);
		fail(
			await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: img2, extra: 1 }),
			422,
			'validation_failed'
		);
	});

	it('setzen und mit null zurücksetzen', async () => {
		ok(await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: img2 }));
		let detail = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${gCover}`));
		expect(detail.coverImageId).toBe(img2);
		expect(detail.coverIsDefault).toBe(false);
		expect(detail.cover).toEqual({ imageId: img2, width: 1200, height: 900 });

		ok(await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: null }));
		detail = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${gCover}`));
		expect(detail.coverImageId).toBe(img1);
		expect(detail.coverIsDefault).toBe(true);
	});

	it('gelöschtes Titelbild → Fallback auf ältestes Bild', async () => {
		ok(await call('owner', 'PUT', `/galleries/${gCover}/cover`, { imageId: img2 }));
		await dbRows(sql`DELETE FROM gallery_images WHERE id = ${img2}`);
		const detail = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${gCover}`));
		expect(detail.coverImageId).toBe(img1);
		expect(detail.coverIsDefault).toBe(true);
		expect(detail.imageCount).toBe(1);
	});

	it('Audit cover_changed nur mit IDs', async () => {
		// listAudit entfernt `_` aus dem Präfix-Filter → Präfix ohne Unterstrich
		const { rows } = await listAudit({ action: 'galleries.gallery.cover', limit: 50 });
		expect(
			rows.some((r) => r.action === 'galleries.gallery.cover_changed' && r.target === gCover)
		).toBe(true);
		expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain('Titelbild-Test');
	});
});

describe('Veröffentlichen nur mit galleries.gallery.publish (#67, 01b-06)', () => {
	const publicBody = (over: Record<string, unknown> = {}) =>
		body({ visibility: 'public', consentConfirmed: true, ...over });

	it('Eigentümer*in ohne Publish-Recht: POST öffentlich → 403 (vor der Einwilligungsprüfung), privat → 201, PUT auf öffentlich → 403', async () => {
		fail(
			await call('q', 'POST', '/galleries', publicBody({ title: 'Q öffentlich' })),
			403,
			'forbidden'
		);
		// Ohne Recht zählt die fehlende Einwilligung nicht: 403 statt 422
		fail(await call('q', 'POST', '/galleries', body({ visibility: 'public' })), 403, 'forbidden');
		const id = ok<GalleryDetail>(
			await call('q', 'POST', '/galleries', body({ title: 'Q intern' })),
			201
		).id;
		fail(
			await call('q', 'PUT', `/galleries/${id}`, publicBody({ title: 'Q intern' })),
			403,
			'forbidden'
		);
		const stored = ok<GalleryDetail>(await call('q', 'GET', `/galleries/${id}`));
		expect(stored.visibility).toBe('private');
		expect(stored.publicConfirmation).toBeNull();
		// Sonstige Änderungen ohne Veröffentlichen bleiben erlaubt
		ok(await call('q', 'PUT', `/galleries/${id}`, body({ title: 'Q intern 2' })));
	});

	it('Mit Publish-Recht gilt weiterhin die Einwilligungsbestätigung (422)', async () => {
		const res = await call('owner', 'POST', '/galleries', body({ visibility: 'public' }));
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('consentConfirmed');
	});

	it('edit-Freigabe und edit-all ohne Publish-Recht → 403 beim Wechsel auf öffentlich; Zurücknehmen erlaubt; Audit', async () => {
		const shares = [{ type: 'role', id: editorsRole, level: 'edit' }];
		const id = ok<GalleryDetail>(
			await call('owner', 'POST', '/galleries', body({ title: 'Freigabe-Test', shares })),
			201
		).id;
		fail(
			await call('d', 'PUT', `/galleries/${id}`, publicBody({ title: 'Freigabe-Test', shares })),
			403,
			'forbidden'
		);
		fail(
			await call('h', 'PUT', `/galleries/${id}`, publicBody({ title: 'Freigabe-Test', shares })),
			403,
			'forbidden'
		);
		// Eigentümer*in mit Recht veröffentlicht; danach dürfen d/h weiter bearbeiten und zurücknehmen
		ok(
			await call('owner', 'PUT', `/galleries/${id}`, publicBody({ title: 'Freigabe-Test', shares }))
		);
		ok(
			await call(
				'd',
				'PUT',
				`/galleries/${id}`,
				body({ title: 'Freigabe-Test 2', visibility: 'public', shares })
			)
		);
		const back = ok<GalleryDetail>(
			await call('h', 'PUT', `/galleries/${id}`, body({ title: 'Freigabe-Test 2', shares }))
		);
		expect(back.visibility).toBe('private');

		const { rows } = await listAudit({ target: id, limit: 50 });
		const actions = rows.map((r) => r.action);
		expect(actions.filter((a) => a === 'galleries.gallery.published')).toHaveLength(1);
		expect(actions.filter((a) => a === 'galleries.gallery.unpublished')).toHaveLength(1);
	});

	it('POST öffentlich mit Recht schreibt galleries.gallery.published', async () => {
		const id = ok<GalleryDetail>(
			await call('owner', 'POST', '/galleries', publicBody({ title: 'Direkt öffentlich' })),
			201
		).id;
		const { rows } = await listAudit({ target: id, limit: 50 });
		expect(rows.map((r) => r.action)).toContain('galleries.gallery.published');
	});
});

describe('Veröffentlichen mit Bestätigung der Einwilligungen (#27)', () => {
	it('POST öffentlich ohne Bestätigung → 422 consentConfirmed, nichts angelegt', async () => {
		const before = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=200')).total;
		const res = await call('owner', 'POST', '/galleries', body({ visibility: 'public' }));
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('consentConfirmed');
		const res2 = await call(
			'owner',
			'POST',
			'/galleries',
			body({ visibility: 'public', consentConfirmed: false })
		);
		fail(res2, 422, 'validation_failed');
		expect(ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=200')).total).toBe(before);
	});

	it('POST öffentlich mit Bestätigung speichert Zeitpunkt und Person', async () => {
		const created = ok<GalleryDetail>(
			await call(
				'owner',
				'POST',
				'/galleries',
				body({ title: 'Bestätigt', visibility: 'public', consentConfirmed: true })
			),
			201
		);
		expect(created.publicConfirmation?.by?.id).toBe(userIds.owner);
		expect(created.publicConfirmation?.by?.name).toBeTruthy();
		expect(Date.now() - Date.parse(created.publicConfirmation!.at)).toBeLessThan(60_000);
		// privat angelegt → keine Bestätigung
		const priv = ok<GalleryDetail>(await call('owner', 'POST', '/galleries', body()), 201);
		expect(priv.publicConfirmation).toBeNull();
	});

	it('PUT: öffentlich bleibt ohne neue Bestätigung, privat → öffentlich verlangt sie erneut', async () => {
		const g = ok<GalleryDetail>(
			await call(
				'owner',
				'POST',
				'/galleries',
				body({ title: 'Wechsel', visibility: 'public', consentConfirmed: true })
			),
			201
		);
		const firstAt = g.publicConfirmation!.at;
		// Bleibt öffentlich (z. B. Titel ändern): keine Bestätigung nötig, Zeitpunkt unverändert
		const same = ok<GalleryDetail>(
			await call(
				'owner',
				'PUT',
				`/galleries/${g.id}`,
				body({ title: 'Wechsel 2', visibility: 'public' })
			)
		);
		expect(same.publicConfirmation?.at).toBe(firstAt);
		// Auf privat: Bestätigung bleibt als Historie
		const priv = ok<GalleryDetail>(
			await call('owner', 'PUT', `/galleries/${g.id}`, body({ title: 'Wechsel 2' }))
		);
		expect(priv.visibility).toBe('private');
		expect(priv.publicConfirmation?.at).toBe(firstAt);
		// Wieder öffentlich ohne Bestätigung → 422, Galerie bleibt privat
		const res = await call(
			'owner',
			'PUT',
			`/galleries/${g.id}`,
			body({ title: 'Wechsel 2', visibility: 'public' })
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('consentConfirmed');
		expect(ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${g.id}`)).visibility).toBe(
			'private'
		);
		// Mit Bestätigung → neuer Zeitpunkt
		const again = ok<GalleryDetail>(
			await call(
				'owner',
				'PUT',
				`/galleries/${g.id}`,
				body({ title: 'Wechsel 2', visibility: 'public', consentConfirmed: true })
			)
		);
		expect(again.visibility).toBe('public');
		expect(Date.parse(again.publicConfirmation!.at)).toBeGreaterThanOrEqual(Date.parse(firstAt));
		expect(again.publicConfirmation?.by?.id).toBe(userIds.owner);

		const { rows } = await listAudit({ action: 'galleries.gallery.', limit: 500 });
		const mine = rows.filter((r) => r.target === g.id);
		const confirmed = mine.filter(
			(r) => (r.metadata as { consentConfirmed?: boolean } | null)?.consentConfirmed === true
		);
		// Anlegen und erneutes Veröffentlichen, nicht das Ändern bei bleibender Sichtbarkeit
		expect(confirmed.map((r) => r.action).sort()).toEqual([
			'galleries.gallery.created',
			'galleries.gallery.updated'
		]);
	});

	it('Datenauskunft: subjectExport liefert Galerien, Freigaben und Bestätigungen des Kontos', async () => {
		const out = await galleriesModule.subjectExport!.run({
			userId: userIds.owner!,
			memberIds: []
		});
		const data = out as {
			ownedGalleries: { id: string; title: string }[];
			publishConfirmations: { galleryId: string }[];
		};
		expect(data.ownedGalleries.map((g) => g.id)).toContain(gPublic);
		expect(data.publishConfirmations.map((c) => c.galleryId)).toContain(gPublic);
		const reader = (await galleriesModule.subjectExport!.run({
			userId: userIds.e!,
			memberIds: []
		})) as { sharesToAccount: { galleryId: string }[] } | null;
		// Emil hat eine Benutzer-Freigabe auf gMain (sofern nicht in einem Test entfernt)
		expect(reader?.sharesToAccount.map((s) => s.galleryId) ?? []).toContain(gMain);
		expect(await galleriesModule.subjectExport!.run({ userId: null, memberIds: ['x'] })).toBeNull();
		expect(
			await galleriesModule.subjectExport!.run({ userId: crypto.randomUUID(), memberIds: [] })
		).toBeNull();
	});
});

describe('Audit', () => {
	it('created/updated/deleted ohne Titel oder Beschreibung in metadata', async () => {
		const { rows } = await listAudit({ action: 'galleries.gallery.', limit: 500 });
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'galleries.gallery.created',
			'galleries.gallery.updated',
			'galleries.gallery.deleted'
		]) {
			expect(actions).toContain(a);
		}
		expect(rows.some((r) => r.action === 'galleries.gallery.created' && r.target === gMain)).toBe(
			true
		);
		expect(rows.some((r) => r.action === 'galleries.gallery.updated' && r.target === gMain)).toBe(
			true
		);
		const meta = JSON.stringify(rows.map((r) => r.metadata));
		for (const secret of [
			'Sommerlager',
			'Zeltplatz',
			'Hike Falke',
			'Leiterrunde',
			'Stammesfest',
			'Pfingstlager',
			'Wegwerf',
			'Nachher'
		]) {
			expect(meta, secret).not.toContain(secret);
		}
	});
});

describe('Modul deaktiviert', () => {
	it('alle Endpoints → 404 module_disabled', async () => {
		await disableModule(admin, 'galleries');
		fail(await call('owner', 'GET', '/galleries'), 404, 'module_disabled');
		fail(await call('owner', 'GET', `/galleries/${gMain}`), 404, 'module_disabled');
		fail(await call('owner', 'POST', '/galleries', body()), 404, 'module_disabled');
		fail(await call('owner', 'PUT', `/galleries/${gMain}`, mainBody()), 404, 'module_disabled');
		fail(await call('owner', 'DELETE', `/galleries/${gMain}`), 404, 'module_disabled');
	});
});
