/**
 * Modul `galleries` – Website-API (`/website/…`, Key nur mit Scope `galleries.website.read`) und
 * Meta-Endpoints (`/principals`, `/events`, `/settings/stamm`).
 * Nur öffentliche Galerien, nur Website-Felder, nur `thumb`/`web`, Termine nur mit „auf der Website“.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { RequestContext } from '$lib/sdk/types';
import eventsModule from '$modules/events/module';
import type { GalleryRefsService } from '$modules/galleries/contract';
import galleriesModule from '$modules/galleries/module';
import { galleryRefsService } from '$modules/galleries/refs.service';
import type {
	GalleryDetail,
	GalleryImage,
	WebsiteGallery,
	WebsiteGalleryDetail
} from '$modules/galleries/schemas';
import {
	websiteGalleryDetailSchema,
	websiteGalleryListSchema
} from '$modules/galleries/website.schemas';
import membersModule from '$modules/members/module';
import {
	bootstrapAdmin,
	contextForUser,
	core,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	getDb,
	handleApiRequest,
	installFakeStorage,
	registerCoreApi,
	registerModule,
	resetAllForTests,
	schema,
	syncModules,
	uninstallFakeStorage,
	useTestDatabase
} from '$testing';

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

function fail(res: Res, status: number, code: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body.error?.code).toBe(code);
}

/** Liste als Array (Antwort entweder `T[]` oder `{ items: T[] }`) */
function listOf<T>(data: unknown): T[] {
	if (Array.isArray(data)) return data as T[];
	return ((data as { items?: T[] } | null)?.items ?? []) as T[];
}

async function jpeg(color: string, width = 640, height = 480): Promise<Uint8Array> {
	const buf = await sharp({ create: { width, height, channels: 3, background: color } })
		.jpeg()
		.withExif({ IFD0: { Make: 'TestCam', Copyright: 'Geheim' } })
		.toBuffer();
	return new Uint8Array(buf);
}

async function upload(galleryId: string, bytes: Uint8Array, name: string, description?: string) {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type: 'image/jpeg' }));
	if (description) fd.set('description', description);
	const res = await raw('owner', 'POST', `/galleries/${galleryId}/images`, fd);
	return ok<GalleryImage>({ status: res.status, body: await res.json() }, 201);
}

async function createGallery(
	title: string,
	visibility: 'public' | 'private',
	eventIds: string[] = []
) {
	return ok<GalleryDetail>(
		await call('owner', 'POST', '/galleries', {
			title,
			description: `Beschreibung ${title}`,
			visibility,
			consentConfirmed: visibility === 'public',
			shares: [{ type: 'user', id: userIds.reader!, level: 'read' }],
			eventIds
		}),
		201
	);
}

async function insertEvent(title: string, opts: { visible: boolean; onWebsite: boolean }) {
	const id = crypto.randomUUID();
	await core.database.forModule('events').transaction(async (tx) => {
		await tx.execute(sql`
			INSERT INTO events (id, title, description, location, color, starts_on, starts_at, ends_on,
				ends_at, on_website, owner_id, created_by)
			VALUES (${id}, ${title}, null, null, '#2563eb', '2026-08-01'::date, null, '2026-08-03'::date,
				null, ${opts.onWebsite}, 'owner-1', 'owner-1')
		`);
		if (opts.visible) {
			await tx.execute(
				sql`INSERT INTO event_shares (event_id, principal_type, principal_id, level)
					VALUES (${id}, 'everyone', '*', 'read')`
			);
		}
	});
	return id;
}

const ROLES: Record<string, string[]> = {
	owner: [
		'galleries.gallery.view',
		'galleries.gallery.create',
		'galleries.gallery.publish',
		'events.event.view',
		'core.api.manage'
	],
	reader: ['galleries.gallery.view', 'events.event.view', 'core.api.manage'],
	website: ['galleries.website.read', 'core.api.manage']
};
const USER_NAMES: Record<string, string> = {
	owner: 'Olga Eigner',
	reader: 'Lena Leserin',
	website: 'Stammeswebsite'
};

let publicG: GalleryDetail;
let privateG: GalleryDetail;
let otherPublicG: GalleryDetail;
let pubImg1: GalleryImage;
let pubImg2: GalleryImage;
let privImg: GalleryImage;
let eWeb: string;
let eIntern: string;
let eHidden: string;

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
			name: USER_NAMES[name]!,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = await ctxOf(userIds[name]!);
		// Website-Key: NUR der Website-Scope
		const scopes = name === 'website' ? ['galleries.website.read'] : perms;
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes })).key;
	}

	await installFakeStorage(admin);

	eWeb = await insertEvent('Sommerfest Website', { visible: true, onWebsite: true });
	eIntern = await insertEvent('Sommerfest intern', { visible: true, onWebsite: false });
	eHidden = await insertEvent('Geheimtreffen', { visible: false, onWebsite: true });

	publicG = await createGallery('Sommerlager 2026', 'public', [eWeb, eIntern]);
	privateG = await createGallery('Leiterrunde privat', 'private', [eWeb]);
	otherPublicG = await createGallery('Ohne Termin', 'public');
	pubImg1 = await upload(publicG.id, await jpeg('#aa3300'), 'kinder-am-see.jpg', 'Am See');
	pubImg2 = await upload(publicG.id, await jpeg('#0033aa', 300, 600), 'zweites.jpg');
	privImg = await upload(privateG.id, await jpeg('#00aa33'), 'privat.jpg', 'Privat');
	// Sortierung (1.6.0): „Ohne Termin“ zählt mit dem Anlagedatum (heute), Sommerlager mit dem
	// Website-Termin (2026-08-01) → „Ohne Termin“ zuerst
	ok(
		await call('owner', 'PUT', `/galleries/${publicG.id}/images/${pubImg1.id}`, {
			description: 'Am See'
		})
	);
});

afterAll(() => uninstallFakeStorage());

/** Website-Termin (auf der Website); interne Termine erscheinen nie */
const webEvent = () => ({
	id: eWeb,
	title: 'Sommerfest Website',
	startsOn: '2026-08-01',
	endsOn: '2026-08-03'
});

const GALLERY_KEYS = [
	'cover',
	'description',
	'endsOn',
	'events',
	'id',
	'imageCount',
	'startsOn',
	'title',
	'updatedAt'
].sort();
const IMAGE_KEYS = [
	'description',
	'durationSeconds',
	'galleryId',
	'height',
	'id',
	'mediaType',
	'position',
	'width'
].sort();
const FORBIDDEN_TEXT = [
	'ownerId',
	'shares',
	'originalName',
	'uploadedBy',
	'kinder-am-see',
	'Olga',
	'Lena',
	'_path',
	'access'
];

describe('GET /website/galleries', () => {
	it('listet nur öffentliche Galerien mit Website-Feldern', async () => {
		const res = await call('website', 'GET', '/website/galleries');
		// Vertrag (#48): strikt gegen das exportierte Website-Schema
		websiteGalleryListSchema.parse(ok(res));
		const items = listOf<WebsiteGallery>(ok(res));
		expect(items.map((g) => g.id)).toEqual([otherPublicG.id, publicG.id]);
		const g = items[1]!;
		expect(Object.keys(g).sort()).toEqual(GALLERY_KEYS);
		expect(g).toMatchObject({
			title: 'Sommerlager 2026',
			description: 'Beschreibung Sommerlager 2026',
			imageCount: 2,
			cover: { imageId: pubImg1.id, width: 640, height: 480 }
		});
		// nur Termine mit „auf der Website“
		expect(g.events).toEqual([webEvent()]);
		expect(items[0]!.events).toEqual([]);
		expect(new Date(g.updatedAt).toString()).not.toBe('Invalid Date');
		const text = JSON.stringify(res.body);
		for (const t of FORBIDDEN_TEXT) expect(text, t).not.toContain(t);
		expect(text).not.toContain(privateG.id);
	});

	it('Limit und Offset', async () => {
		expect(listOf(ok(await call('website', 'GET', '/website/galleries?limit=1')))).toHaveLength(1);
		expect(listOf(ok(await call('website', 'GET', '/website/galleries?offset=1')))).toHaveLength(1);
		expect(listOf(ok(await call('website', 'GET', '/website/galleries?offset=2')))).toHaveLength(0);
		fail(await call('website', 'GET', '/website/galleries?limit=0'), 422, 'validation_failed');
	});
});

describe('GET /website/galleries/:id', () => {
	it('liefert öffentliche Galerie mit Bildern, Termine nur mit „auf der Website“', async () => {
		const res = await call<WebsiteGalleryDetail>(
			'website',
			'GET',
			`/website/galleries/${publicG.id}`
		);
		const d = ok(res);
		websiteGalleryDetailSchema.parse(d);
		expect(Object.keys(d).sort()).toEqual([...GALLERY_KEYS, 'images'].sort());
		expect(d.images.map((i) => i.id)).toEqual([pubImg1.id, pubImg2.id]);
		for (const img of d.images) expect(Object.keys(img).sort()).toEqual(IMAGE_KEYS);
		const first = d.images[0]!;
		expect(first).toMatchObject({
			galleryId: publicG.id,
			description: 'Am See',
			width: 640,
			height: 480
		});
		expect(d.events).toEqual([webEvent()]);
		expect([d.images[1]!.width, d.images[1]!.height]).toEqual([300, 600]);
		const text = JSON.stringify(res.body);
		for (const t of FORBIDDEN_TEXT) expect(text, t).not.toContain(t);
		expect(text).not.toContain(eIntern);
	});

	it('private oder unbekannte Galerie → 404', async () => {
		fail(await call('website', 'GET', `/website/galleries/${privateG.id}`), 404, 'not_found');
		fail(
			await call('website', 'GET', `/website/galleries/${crypto.randomUUID()}`),
			404,
			'not_found'
		);
	});
});

describe('Website-Bilddateien', () => {
	const url = (g: string, i: string, v: string) => `/website/galleries/${g}/images/${i}/${v}`;

	it('thumb und web: 200, WebP, öffentlich cachebar, ohne EXIF', async () => {
		for (const v of ['thumb', 'web']) {
			const res = await raw('website', 'GET', url(publicG.id, pubImg1.id, v));
			expect(res.status, v).toBe(200);
			expect(res.headers.get('content-type')).toBe('image/webp');
			expect(res.headers.get('cache-control')).toContain('public');
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
			const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
			expect(meta.format).toBe('webp');
			expect(meta.exif).toBeUndefined();
			if (v === 'thumb') expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(480);
		}
	});

	it('full ist für die Website nicht erlaubt', async () => {
		const res = await call('website', 'GET', url(publicG.id, pubImg1.id, 'full'));
		expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect([422, 404]).toContain(res.status);
		expect(res.body.error?.code).toBe(res.status === 422 ? 'validation_failed' : 'not_found');
	});

	it('Bild einer privaten Galerie oder falsche Zuordnung → 404', async () => {
		fail(await call('website', 'GET', url(privateG.id, privImg.id, 'thumb')), 404, 'not_found');
		// Bild der privaten Galerie unter der öffentlichen Galerie-ID
		fail(await call('website', 'GET', url(publicG.id, privImg.id, 'thumb')), 404, 'not_found');
		fail(
			await call('website', 'GET', url(publicG.id, crypto.randomUUID(), 'web')),
			404,
			'not_found'
		);
	});
});

describe('GET /website/galleries?eventId=', () => {
	it('liefert nur öffentliche Galerien zu einem Website-Termin', async () => {
		const res = await call('website', 'GET', `/website/galleries?eventId=${eWeb}`);
		const items = listOf<WebsiteGallery>(ok(res));
		expect(items.map((g) => g.id)).toEqual([publicG.id]);
		expect(res.body.data).toMatchObject({ total: 1 });
		const text = JSON.stringify(res.body);
		for (const t of FORBIDDEN_TEXT) expect(text, t).not.toContain(t);
		expect(text).not.toContain(privateG.id);
	});

	it('Termin nicht auf der Website oder unbekannt → keine Galerien; /website/images gibt es nicht', async () => {
		expect(
			listOf(ok(await call('website', 'GET', `/website/galleries?eventId=${eIntern}`)))
		).toEqual([]);
		expect(
			listOf(ok(await call('website', 'GET', `/website/galleries?eventId=gibt-es-nicht`)))
		).toEqual([]);
		expect((await call('website', 'GET', `/website/images?eventId=${eWeb}`)).status).toBe(404);
	});
});

describe('Trennung intern / Website', () => {
	it('Website-Key bekommt intern 403', async () => {
		fail(await call('website', 'GET', '/galleries'), 403, 'forbidden');
		fail(await call('website', 'GET', `/galleries/${publicG.id}`), 403, 'forbidden');
		const img = await raw('website', 'GET', `/galleries/${publicG.id}/images/${pubImg1.id}/thumb`);
		expect(img.status).toBe(403);
		fail(await call('website', 'GET', '/principals?search=Le'), 403, 'forbidden');
	});

	it('interner Key ohne Website-Scope bekommt /website 403', async () => {
		fail(await call('owner', 'GET', '/website/galleries'), 403, 'forbidden');
		fail(await call('reader', 'GET', `/website/galleries/${publicG.id}`), 403, 'forbidden');
	});
});

describe('Meta-Endpoints', () => {
	it('GET /principals sucht ab 2 Zeichen', async () => {
		const res = await call<{ type: string; id: string }[]>(
			'owner',
			'GET',
			'/principals?search=Lena'
		);
		const data = ok(res);
		expect(data).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: 'user', id: userIds.reader })])
		);
		fail(await call('owner', 'GET', '/principals?search=L'), 422, 'validation_failed');
		fail(await call('owner', 'GET', '/principals'), 422, 'validation_failed');
	});

	it('GET /events?search= liefert nur sichtbare Termine', async () => {
		const ids = (search: string) =>
			call<{ id: string }[]>('owner', 'GET', `/events?search=${encodeURIComponent(search)}`).then(
				(r) => listOf<{ id: string }>(ok(r)).map((e) => e.id)
			);
		expect((await ids('Sommerfest')).sort()).toEqual([eWeb, eIntern].sort());
		expect(await ids('Geheim')).toEqual([]);
		const all = await ids('');
		expect(all).toEqual(expect.arrayContaining([eWeb, eIntern]));
		expect(all).not.toContain(eHidden);
		fail(await call('owner', 'GET', '/events?limit=51'), 422, 'validation_failed');
	});

	it('GET /settings/stamm liefert den Stammesnamen', async () => {
		const data = ok<{ name: string }>(await call('owner', 'GET', '/settings/stamm'));
		expect(typeof data.name).toBe('string');
		expect(data.name.length).toBeGreaterThan(0);
	});
});

describe('Bilder „nur intern“ (is_private)', () => {
	const fileUrl = (g: string, i: string, v: string) => `/website/galleries/${g}/images/${i}/${v}`;
	let a: GalleryImage;
	let b: GalleryImage;
	let c: GalleryImage;

	beforeAll(async () => {
		a = await upload(otherPublicG.id, await jpeg('#111111'), 'a.jpg', 'Erstes');
		b = await upload(otherPublicG.id, await jpeg('#222222', 400, 300), 'b.jpg');
		c = await upload(otherPublicG.id, await jpeg('#333333'), 'c.jpg');
		expect([a.isPrivate, b.isPrivate, c.isPrivate]).toEqual([false, false, false]);
	});

	it('PUT setzt isPrivate; ohne Feld bleibt es unverändert; nur mit edit', async () => {
		const img = ok<GalleryImage>(
			await call('owner', 'PUT', `/galleries/${otherPublicG.id}/images/${a.id}`, {
				description: 'Erstes',
				isPrivate: true
			})
		);
		expect(img.isPrivate).toBe(true);
		const again = ok<GalleryImage>(
			await call('owner', 'PUT', `/galleries/${otherPublicG.id}/images/${a.id}`, {
				description: 'Erstes, neu'
			})
		);
		expect(again).toMatchObject({ isPrivate: true, description: 'Erstes, neu' });
		fail(
			await call('reader', 'PUT', `/galleries/${otherPublicG.id}/images/${b.id}`, {
				description: null,
				isPrivate: true
			}),
			403,
			'forbidden'
		);
		fail(
			await call('owner', 'PUT', `/galleries/${otherPublicG.id}/images/${b.id}`, {
				description: null,
				isPrivate: 'ja'
			}),
			422,
			'validation_failed'
		);
	});

	it('Website: privates Bild fehlt in Detail, Bildanzahl, Titelbild und als Datei', async () => {
		// gesetztes Titelbild ist privat → ältestes nicht privates Bild gilt
		ok(await call('owner', 'PUT', `/galleries/${otherPublicG.id}/cover`, { imageId: a.id }));
		const d = ok(
			await call<WebsiteGalleryDetail>('website', 'GET', `/website/galleries/${otherPublicG.id}`)
		);
		websiteGalleryDetailSchema.parse(d);
		expect(d.images.map((i) => i.id)).toEqual([b.id, c.id]);
		expect(d.imageCount).toBe(2);
		expect(d.cover).toEqual({ imageId: b.id, width: 400, height: 300 });
		expect(JSON.stringify(d)).not.toContain(a.id);

		const list = listOf<WebsiteGallery>(ok(await call('website', 'GET', '/website/galleries')));
		const item = list.find((g) => g.id === otherPublicG.id)!;
		expect(item).toMatchObject({ imageCount: 2, cover: { imageId: b.id } });

		for (const v of ['thumb', 'web']) {
			fail(await call('website', 'GET', fileUrl(otherPublicG.id, a.id, v)), 404, 'not_found');
			expect((await raw('website', 'GET', fileUrl(otherPublicG.id, b.id, v))).status).toBe(200);
		}
	});

	it('intern bleibt das Bild sichtbar und abrufbar (Titelbild intern unverändert)', async () => {
		const d = ok(await call<GalleryDetail>('reader', 'GET', `/galleries/${otherPublicG.id}`));
		expect(d.images.map((i) => [i.id, i.isPrivate])).toEqual([
			[a.id, true],
			[b.id, false],
			[c.id, false]
		]);
		expect(d.coverImageId).toBe(a.id);
		const res = await raw('reader', 'GET', `/galleries/${otherPublicG.id}/images/${a.id}/thumb`);
		expect(res.status).toBe(200);
	});

	it('Verweis-Dienst zählt für öffentliche Verweise nur nicht private Bilder', async () => {
		const service: GalleryRefsService = galleryRefsService;
		const [ref] = await service.publicGalleryRefs([otherPublicG.id]);
		expect(ref?.imageCount).toBe(2);
	});

	it('Sammelaktion make-private / make-public mit Audit', async () => {
		const r = ok<{ affected: number }>(
			await call('owner', 'POST', `/galleries/${otherPublicG.id}/images/bulk`, {
				action: 'make-private',
				ids: [b.id, c.id]
			}),
			201
		);
		expect(r.affected).toBe(2);
		let d = ok(
			await call<WebsiteGalleryDetail>('website', 'GET', `/website/galleries/${otherPublicG.id}`)
		);
		expect(d.images).toEqual([]);
		expect(d.imageCount).toBe(0);
		expect(d.cover).toBeNull();

		ok(
			await call('owner', 'POST', `/galleries/${otherPublicG.id}/images/bulk`, {
				action: 'make-public',
				ids: [a.id, b.id, c.id]
			}),
			201
		);
		d = ok(
			await call<WebsiteGalleryDetail>('website', 'GET', `/website/galleries/${otherPublicG.id}`)
		);
		expect(d.images.map((i) => i.id)).toEqual([a.id, b.id, c.id]);
		expect(d.cover?.imageId).toBe(a.id);

		// fremdes Bild in der Auswahl → 404, nichts geändert
		fail(
			await call('owner', 'POST', `/galleries/${otherPublicG.id}/images/bulk`, {
				action: 'make-private',
				ids: [a.id, pubImg1.id]
			}),
			404,
			'not_found'
		);
		fail(
			await call('reader', 'POST', `/galleries/${otherPublicG.id}/images/bulk`, {
				action: 'make-private',
				ids: [a.id]
			}),
			403,
			'forbidden'
		);
		const after = ok(await call<GalleryDetail>('owner', 'GET', `/galleries/${otherPublicG.id}`));
		expect(after.images.every((i) => !i.isPrivate)).toBe(true);
	});
});
