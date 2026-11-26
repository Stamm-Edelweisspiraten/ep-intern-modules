/**
 * Modul `galleries` (1.6.0): Zeitraum je Galerie (`startsOn`/`endsOn`), Sortierung der Listen
 * (Zeitraum ?? frühester Termin ?? Anlagedatum) und ZIP-Download der ganzen Galerie
 * (eigenes Recht `galleries.gallery.download`). Storage über `tests/helpers/fake-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { DEFAULT_ALLOWED_CONTENT_TYPES } from '$lib/sdk/content-types';
import type { RequestContext } from '$lib/sdk/types';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import type { GalleryDetail, GalleryImage, GalleryList } from '$modules/galleries/schemas';
import { websiteGalleryListSchema } from '$modules/galleries/website.schemas';
import membersModule from '$modules/members/module';
import {
	bootstrapAdmin,
	contextForUser,
	core,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	fakeFileRows,
	fakeObjects,
	getDb,
	handleApiRequest,
	installFakeStorage,
	listAudit,
	registerCoreApi,
	registerModule,
	resetAllForTests,
	schema,
	setSetting,
	syncModules,
	uninstallFakeStorage,
	useTestDatabase
} from '$testing';
import { sampleMp4 } from '../video-fixtures';

const ROOT = 'http://localhost:5173/api/v1/modules/galleries';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function raw(who: string, method: string, path: string, body?: BodyInit, json = false) {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown
): Promise<Res<T>> {
	const res = await raw(
		who,
		method,
		path,
		json === undefined ? undefined : JSON.stringify(json),
		json !== undefined
	);
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function paths(res: Res): string[] {
	const details = res.body.error?.details;
	if (!Array.isArray(details)) return [];
	return details.map((d: { path?: (string | number)[] }) => (d.path ?? []).join('.'));
}

async function createGallery(
	over: Record<string, unknown> = {},
	who = 'owner'
): Promise<GalleryDetail> {
	return ok<GalleryDetail>(
		await call(who, 'POST', '/galleries', {
			title: 'Galerie',
			description: null,
			visibility: 'private',
			shares: [],
			...over
		}),
		201
	);
}

async function jpeg(color: string): Promise<Uint8Array> {
	const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
		.jpeg()
		.toBuffer();
	return new Uint8Array(buf);
}

async function uploadImage(galleryId: string, name: string, color = '#3366cc') {
	const fd = new FormData();
	fd.set('file', new File([(await jpeg(color)) as BlobPart], name, { type: 'image/jpeg' }));
	const res = await raw('owner', 'POST', `/galleries/${galleryId}/images`, fd);
	return ok<GalleryImage>({ status: res.status, body: await res.json() }, 201);
}

async function uploadVideo(galleryId: string, name: string) {
	const fd = new FormData();
	fd.set('file', new File([sampleMp4() as BlobPart], name, { type: 'video/mp4' }));
	fd.set(
		'poster',
		new File([(await jpeg('#000000')) as BlobPart], 'p.jpg', { type: 'image/jpeg' })
	);
	const res = await raw('owner', 'POST', `/galleries/${galleryId}/images`, fd);
	return ok<GalleryImage>({ status: res.status, body: await res.json() }, 201);
}

/** Bytes einer Datei im Fake-Storage */
function storedFile(path: string): Uint8Array {
	for (const row of fakeFileRows.values()) {
		if (row.moduleId === 'galleries' && row.path === path) {
			return fakeObjects.get(row.objectKey)!.body;
		}
	}
	throw new Error(`Datei fehlt: ${path}`);
}

async function fullPathOf(imageId: string): Promise<string> {
	return core.database.forModule('galleries').transaction(async (tx) => {
		const res = (await tx.execute(
			sql`SELECT full_path FROM gallery_images WHERE id = ${imageId}`
		)) as unknown as { rows: { full_path: string }[] };
		return res.rows[0]!.full_path;
	});
}

async function setCreatedAt(galleryId: string, iso: string) {
	await core.database.forModule('galleries').transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE galleries SET created_at = ${iso}::timestamptz WHERE id = ${galleryId}`
		);
	});
}

async function insertEvent(startsOn: string, onWebsite = false) {
	const id = crypto.randomUUID();
	await core.database.forModule('events').transaction(async (tx) => {
		await tx.execute(sql`
			INSERT INTO events (id, title, description, location, color, starts_on, starts_at, ends_on,
				ends_at, on_website, owner_id, created_by)
			VALUES (${id}, ${'Termin ' + startsOn}, null, null, '#2563eb', ${startsOn}::date, null, null,
				null, ${onWebsite}, 'owner-1', 'owner-1')
		`);
		await tx.execute(
			sql`INSERT INTO event_shares (event_id, principal_type, principal_id, level)
				VALUES (${id}, 'everyone', '*', 'read')`
		);
	});
	return id;
}

const ROLES: Record<string, string[]> = {
	owner: [
		'galleries.gallery.view',
		'galleries.gallery.create',
		'galleries.gallery.publish',
		'galleries.gallery.download',
		'events.event.view',
		'core.api.manage'
	],
	/** Liest (Freigabe), darf aber nicht herunterladen */
	reader: ['galleries.gallery.view', 'events.event.view', 'core.api.manage'],
	/** Darf herunterladen, sieht die Galerie aber nicht */
	stranger: ['galleries.gallery.view', 'galleries.gallery.download', 'core.api.manage'],
	website: ['galleries.website.read', 'core.api.manage']
};

beforeAll(async () => {
	await useTestDatabase();
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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'events');
	await enableModule(admin, 'galleries');
	admin = await ctxOf(u!.id);

	for (const [name, perms] of Object.entries(ROLES)) {
		const roleId = await createRole(admin, { name: `role-${name}`, permissions: perms });
		userIds[name] = await createUser(admin, {
			name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: perms })).key;
	}
	await installFakeStorage(admin);
	await setSetting(admin, 'core.storage.allowedContentTypes', [
		...DEFAULT_ALLOWED_CONTENT_TYPES,
		'video/mp4',
		'video/quicktime',
		'video/webm'
	]);
});

afterAll(() => uninstallFakeStorage());

describe('Zeitraum', () => {
	it('POST/PUT speichern startsOn/endsOn, Detail und Liste liefern sie', async () => {
		const g = await createGallery({ startsOn: '2026-04-03', endsOn: '2026-04-06' });
		expect(g.startsOn).toBe('2026-04-03');
		expect(g.endsOn).toBe('2026-04-06');

		const updated = ok<GalleryDetail>(
			await call('owner', 'PUT', `/galleries/${g.id}`, {
				title: g.title,
				description: null,
				visibility: 'private',
				shares: [],
				startsOn: '2026-05-01'
			})
		);
		expect(updated.startsOn).toBe('2026-05-01');
		expect(updated.endsOn).toBeNull();

		const list = ok<GalleryList>(await call('owner', 'GET', '/galleries?limit=200'));
		const item = list.items.find((i) => i.id === g.id)!;
		expect(item.startsOn).toBe('2026-05-01');
		expect(item.endsOn).toBeNull();

		// PUT ohne Felder löscht den Zeitraum (ersetzt alles)
		const cleared = ok<GalleryDetail>(
			await call('owner', 'PUT', `/galleries/${g.id}`, {
				title: g.title,
				description: null,
				visibility: 'private',
				shares: []
			})
		);
		expect(cleared.startsOn).toBeNull();
	});

	it('422: Ende ohne Start, Ende vor Start, ungültiges Datum', async () => {
		const base = { title: 'X', description: null, visibility: 'private', shares: [] };
		let res = await call('owner', 'POST', '/galleries', { ...base, endsOn: '2026-04-06' });
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['endsOn']);
		res = await call('owner', 'POST', '/galleries', {
			...base,
			startsOn: '2026-04-06',
			endsOn: '2026-04-05'
		});
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['endsOn']);
		res = await call('owner', 'POST', '/galleries', { ...base, startsOn: '2026-02-30' });
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['startsOn']);
	});
});

describe('Sortierung', () => {
	it('eigenes Datum ?? frühester Termin ?? Anlagedatum, neueste zuerst; Website ebenso', async () => {
		const search = `Sort-${crypto.randomUUID().slice(0, 8)}`;
		const evLate = await insertEvent('2025-08-10', true);
		const evEarly = await insertEvent('2025-06-01', true);
		// eigenes Datum 2025-07-01
		const own = await createGallery({
			title: `${search} eigen`,
			visibility: 'public',
			consentConfirmed: true,
			startsOn: '2025-07-01'
		});
		// Termine 2025-06-01 und 2025-08-10 → frühester zählt (2025-06-01)
		const byEvent = await createGallery({
			title: `${search} termin`,
			visibility: 'public',
			consentConfirmed: true,
			eventIds: [evLate, evEarly]
		});
		// weder Datum noch Termin → Anlagedatum 2025-09-15
		const byCreated = await createGallery({
			title: `${search} anlage`,
			visibility: 'public',
			consentConfirmed: true
		});
		await setCreatedAt(byCreated.id, '2025-09-15T10:00:00Z');
		// eigenes Datum schlägt Termin
		const ownBeatsEvent = await createGallery({
			title: `${search} beides`,
			visibility: 'public',
			consentConfirmed: true,
			startsOn: '2024-01-01',
			eventIds: [evLate]
		});

		// 2025-09-15 (Anlage) > 2025-07-01 (eigen) > 2025-06-01 (frühester Termin) > 2024-01-01
		const expected = [byCreated.id, own.id, byEvent.id, ownBeatsEvent.id];
		const list = ok<GalleryList>(
			await call('owner', 'GET', `/galleries?search=${encodeURIComponent(search)}`)
		);
		expect(list.items.map((i) => i.id)).toEqual(expected);
		expect(list.total).toBe(4);

		// Blättern behält die Reihenfolge
		const page2 = ok<GalleryList>(
			await call('owner', 'GET', `/galleries?search=${encodeURIComponent(search)}&limit=2&offset=2`)
		);
		expect(page2.items.map((i) => i.id)).toEqual(expected.slice(2));
		expect(page2.total).toBe(4);

		// Website: gleiche Reihenfolge (alle vier öffentlich, Termine auf der Website)
		const res = await raw('website', 'GET', '/website/galleries?limit=200');
		const web = websiteGalleryListSchema.parse((await res.json()).data);
		const ids = web.items.map((i) => i.id).filter((id) => expected.includes(id));
		expect(ids).toEqual(expected);
		expect(web.items.find((i) => i.id === own.id)!.startsOn).toBe('2025-07-01');
	});
});

describe('ZIP-Download', () => {
	it('liefert alle Bilder (full) und Videos mit eindeutigen Namen, Audit ohne Dateinamen', async () => {
		const g = await createGallery({
			title: 'Osterlager 2026',
			shares: [{ type: 'user', id: userIds.reader!, level: 'read' }]
		});
		const a = await uploadImage(g.id, 'see.jpg', '#112233');
		const b = await uploadImage(g.id, 'SEE.jpg', '#445566');
		const v = await uploadVideo(g.id, 'film.mp4');

		const res = await raw('owner', 'GET', `/galleries/${g.id}/download`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		expect(res.headers.get('content-disposition')).toContain('attachment');
		expect(res.headers.get('content-disposition')).toContain('Osterlager_2026.zip');
		expect(res.headers.get('cache-control')).toBe('no-store');

		const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
		expect(Object.keys(files)).toEqual(['see.jpg', 'SEE (2).jpg', 'film.mp4']);
		expect<unknown>(files['see.jpg']).toEqual(storedFile(await fullPathOf(a.id)));
		expect<unknown>(files['SEE (2).jpg']).toEqual(storedFile(await fullPathOf(b.id)));
		expect<unknown>(files['film.mp4']).toEqual(storedFile(await fullPathOf(v.id)));

		const { rows } = await listAudit({ action: 'galleries.gallery.downloaded', limit: 50 });
		const entry = rows.find((e) => e.target === g.id)!;
		expect(entry.metadata).toEqual({ images: 2, videos: 1 });
		expect(JSON.stringify(entry)).not.toContain('see.jpg');
	});

	it('ohne Recht 403, fremde Galerie 404, leere Galerie 422', async () => {
		const g = await createGallery({
			shares: [{ type: 'user', id: userIds.reader!, level: 'read' }]
		});
		await uploadImage(g.id, 'a.jpg');
		const noPerm = await call('reader', 'GET', `/galleries/${g.id}/download`);
		expect(noPerm.status).toBe(403);
		const foreign = await call('stranger', 'GET', `/galleries/${g.id}/download`);
		expect(foreign.status).toBe(404);
		const empty = await createGallery();
		const res = await call('owner', 'GET', `/galleries/${empty.id}/download`);
		expect(res.status).toBe(422);
	});
});
