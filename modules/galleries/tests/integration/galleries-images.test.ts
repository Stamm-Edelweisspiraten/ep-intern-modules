/**
 * Modul `galleries` – Bilder: Upload (multipart, sharp-Varianten ohne Metadaten), Rechte beim Upload,
 * Titelbild (Standard = ältestes Bild), Auslieferung der Varianten, Beschreibung + Termin-Zuordnung
 * (mit/ohne `events`), Sammelaktionen, Löschen der Dateien, Audit ohne Inhalte.
 * Storage über `tests/helpers/fake-storage.ts`; Testbilder werden mit sharp erzeugt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { fakeFileRows, fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
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
import eventsModule from '$modules/events/module';
import membersModule from '$modules/members/module';
import galleriesModule from '$modules/galleries/module';
import type {
	BulkResult,
	GalleryDetail,
	GalleryImage,
	GalleryItem
} from '$modules/galleries/schemas';
import type { RequestContext } from '$lib/sdk/types';

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

/** Feldpfade aus `error.details` */
function paths(res: Res): string[] {
	const details = res.body.error?.details;
	if (!Array.isArray(details)) return [];
	return details.map((d: { path?: (string | number)[] }) => (d.path ?? []).join('.'));
}

function form(bytes: Uint8Array | string, name: string, type: string, description?: string) {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type }));
	if (description !== undefined) fd.set('description', description);
	return fd;
}

async function upload(who: string, galleryId: string, fd: FormData): Promise<Res<GalleryImage>> {
	const res = await raw(who, 'POST', `/galleries/${galleryId}/images`, fd);
	return { status: res.status, body: await res.json() };
}

async function uploadOk(galleryId: string, bytes: Uint8Array, name = 'bild.jpg', who = 'owner') {
	return ok(await upload(who, galleryId, form(bytes, name, 'image/jpeg')), 201);
}

async function createGallery(
	over: Record<string, unknown> = {},
	who = 'owner'
): Promise<GalleryDetail> {
	return ok<GalleryDetail>(
		await call(who, 'POST', '/galleries', {
			title: 'Sommerlager',
			description: null,
			visibility: 'private',
			shares: [],
			...over
		}),
		201
	);
}

const detail = async (id: string, who = 'owner') =>
	ok<GalleryDetail>(await call(who, 'GET', `/galleries/${id}`));

/** Dateien (Fake-Storage) einer Galerie: Pfad → Bytes */
function filesOf(galleryId: string): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const row of fakeFileRows.values()) {
		if (row.moduleId !== 'galleries' || !row.path.startsWith(`${galleryId}/`)) continue;
		const obj = fakeObjects.get(row.objectKey);
		if (obj) out.set(row.path, obj.body);
	}
	return out;
}

async function imageRowCount(galleryId: string): Promise<number> {
	return core.database.forModule('galleries').transaction(async (tx) => {
		const res = (await tx.execute(
			sql`SELECT count(*)::int AS n FROM gallery_images WHERE gallery_id = ${galleryId}`
		)) as unknown as { rows: { n: number }[] };
		return Number(res.rows[0]!.n);
	});
}

// ---------------------------------------------------------------------------
// Testbilder
// ---------------------------------------------------------------------------

/** JPEG 600×400 mit EXIF (Kamera, Copyright, GPS) und Ausrichtung 6 (→ nach Drehung 400×600) */
async function exifJpeg(color = '#3366cc'): Promise<Uint8Array> {
	const buf = await sharp({ create: { width: 600, height: 400, channels: 3, background: color } })
		.jpeg({ quality: 90 })
		.withExif({
			IFD0: { Make: 'TestCam', Model: 'X1', Copyright: 'Geheim' },
			IFD3: {
				GPSLatitudeRef: 'N',
				GPSLatitude: '53/1 4/1 0/1',
				GPSLongitudeRef: 'E',
				GPSLongitude: '8/1 48/1 0/1'
			}
		})
		.withMetadata({ orientation: 6 })
		.toBuffer();
	return new Uint8Array(buf);
}

async function plainJpeg(width = 320, height = 240, color = '#22aa55'): Promise<Uint8Array> {
	const buf = await sharp({ create: { width, height, channels: 3, background: color } })
		.jpeg()
		.toBuffer();
	return new Uint8Array(buf);
}

async function alphaPng(): Promise<Uint8Array> {
	const buf = await sharp({
		create: { width: 300, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } }
	})
		.png()
		.toBuffer();
	return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Termine (direkt in mod_events)
// ---------------------------------------------------------------------------

async function insertEvent(title: string, opts: { visible: boolean; onWebsite?: boolean }) {
	const id = crypto.randomUUID();
	await core.database.forModule('events').transaction(async (tx) => {
		await tx.execute(sql`
			INSERT INTO events (id, title, description, location, color, starts_on, starts_at, ends_on,
				ends_at, on_website, owner_id, created_by)
			VALUES (${id}, ${title}, null, null, '#2563eb', '2026-07-01'::date, null, null, null,
				${opts.onWebsite ?? false}, 'owner-1', 'owner-1')
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

async function hideEvent(id: string) {
	await core.database.forModule('events').transaction(async (tx) => {
		await tx.execute(sql`DELETE FROM event_shares WHERE event_id = ${id}`);
	});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ROLES: Record<string, string[]> = {
	owner: [
		'galleries.gallery.view',
		'galleries.gallery.create',
		'galleries.gallery.publish',
		'events.event.view',
		'core.api.manage'
	],
	reader: ['galleries.gallery.view', 'events.event.view', 'core.api.manage'],
	stranger: ['galleries.gallery.view', 'events.event.view', 'core.api.manage']
};

let jpegExif: Uint8Array;
let png: Uint8Array;

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

	jpegExif = await exifJpeg();
	png = await alphaPng();
});

// Muss vor dem Einrichten des Fake-Storage laufen
describe('ohne Storage-Konfiguration', () => {
	it('Upload → 503 unavailable', async () => {
		const g = await createGallery();
		const res = await upload('owner', g.id, form(jpegExif, 'bild.jpg', 'image/jpeg'));
		fail(res, 503, 'unavailable');
		expect(await imageRowCount(g.id)).toBe(0);
	});
});

describe('mit Storage', () => {
	beforeAll(async () => {
		await installFakeStorage(admin);
	});
	afterAll(() => uninstallFakeStorage());

	describe('Upload', () => {
		it('erzeugt drei metadatenfreie Varianten und liefert Maße nach EXIF-Drehung', async () => {
			const g = await createGallery({
				shares: [{ type: 'user', id: userIds.reader!, level: 'read' }]
			});
			const img = ok(
				await upload(
					'owner',
					g.id,
					form(jpegExif, 'urlaub-geheim.jpg', 'image/jpeg', 'Geheime Beschreibung am See')
				),
				201
			);
			expect(img.id).toMatch(/^[0-9a-f-]{36}$/);
			// Ausrichtung 6: 600×400 → 400×600
			expect(img.width).toBe(400);
			expect(img.height).toBe(600);
			expect(img.description).toBe('Geheime Beschreibung am See');
			expect(img.originalName).toBe('urlaub-geheim.jpg');
			expect(img).not.toHaveProperty('events');
			expect(img.sizeBytes).toBeGreaterThan(0);

			const files = filesOf(g.id);
			expect([...files.keys()].sort()).toEqual(
				[
					`${g.id}/${img.id}-full.jpg`,
					`${g.id}/${img.id}-thumb.webp`,
					`${g.id}/${img.id}-web.webp`
				].sort()
			);
			for (const [path, bytes] of files) {
				const meta = await sharp(Buffer.from(bytes)).metadata();
				expect(meta.exif, `${path} enthält EXIF`).toBeUndefined();
				expect(meta.xmp, `${path} enthält XMP`).toBeUndefined();
				expect(meta.iptc, `${path} enthält IPTC`).toBeUndefined();
				expect(meta.orientation ?? 1).toBe(1);
				expect(Buffer.from(bytes).toString('latin1')).not.toContain('TestCam');
			}
			const thumb = await sharp(Buffer.from(files.get(`${g.id}/${img.id}-thumb.webp`)!)).metadata();
			expect(thumb.format).toBe('webp');
			expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(480);
			expect(thumb.height).toBeGreaterThan(thumb.width!); // gedreht
			const web = await sharp(Buffer.from(files.get(`${g.id}/${img.id}-web.webp`)!)).metadata();
			expect(web.format).toBe('webp');
			expect([web.width, web.height]).toEqual([400, 600]); // nie vergrößert
			const full = await sharp(Buffer.from(files.get(`${g.id}/${img.id}-full.jpg`)!)).metadata();
			expect(full.format).toBe('jpeg');
			expect([full.width, full.height]).toEqual([400, 600]);

			const d = await detail(g.id);
			expect(d.imageCount).toBe(1);
			expect(d.images.map((i) => i.id)).toEqual([img.id]);
		});

		it('PNG mit Transparenz → volle Variante als PNG mit Alpha', async () => {
			const g = await createGallery();
			const img = ok(await upload('owner', g.id, form(png, 'logo.png', 'image/png')), 201);
			expect([img.width, img.height]).toEqual([300, 200]);
			const files = filesOf(g.id);
			const fullPath = `${g.id}/${img.id}-full.png`;
			expect(files.has(fullPath), [...files.keys()].join(', ')).toBe(true);
			const meta = await sharp(Buffer.from(files.get(fullPath)!)).metadata();
			expect(meta.format).toBe('png');
			expect(meta.hasAlpha).toBe(true);
		});

		it('Rechte: nur Lesen → 403, fremd → 404', async () => {
			const g = await createGallery({
				shares: [{ type: 'user', id: userIds.reader!, level: 'read' }]
			});
			fail(await upload('reader', g.id, form(jpegExif, 'a.jpg', 'image/jpeg')), 403, 'forbidden');
			fail(await upload('stranger', g.id, form(jpegExif, 'a.jpg', 'image/jpeg')), 404, 'not_found');
			fail(
				await upload('owner', crypto.randomUUID(), form(jpegExif, 'a.jpg', 'image/jpeg')),
				404,
				'not_found'
			);
			expect(await imageRowCount(g.id)).toBe(0);
			expect(filesOf(g.id).size).toBe(0);
		});

		it('leere Datei, Textdatei, fehlende Datei → 422; falscher Inhalt → 400', async () => {
			const g = await createGallery();
			// einheitliche Upload-Regel (#33): Typ/leer/fehlend 422, unlesbares Bild 400 (core.images)
			fail(
				await upload('owner', g.id, form('', 'leer.jpg', 'image/jpeg')),
				422,
				'validation_failed'
			);
			fail(
				await upload('owner', g.id, form('hallo welt', 'notiz.txt', 'text/plain')),
				422,
				'validation_failed'
			);
			// Text, der sich als JPEG ausgibt
			fail(
				await upload('owner', g.id, form('kein bild', 'fake.jpg', 'image/jpeg')),
				400,
				'bad_request'
			);
			const res = await raw('owner', 'POST', `/galleries/${g.id}/images`, new FormData());
			expect(res.status).toBe(422);
			expect(((await res.json()) as Res['body']).error?.code).toBe('validation_failed');
			expect(await imageRowCount(g.id)).toBe(0);
			expect(filesOf(g.id).size).toBe(0);
		});
	});

	describe('Titelbild', () => {
		it('Standard = ältestes Bild, manuell änderbar, Fallback nach Löschen, null = Standard', async () => {
			const g = await createGallery();
			const empty = await detail(g.id);
			expect(empty.coverImageId).toBeNull();
			expect(empty.cover).toBeNull();

			const a = await uploadOk(g.id, await plainJpeg(320, 240, '#111111'), 'a.jpg');
			const b = await uploadOk(g.id, await plainJpeg(200, 300, '#222222'), 'b.jpg');
			const c = await uploadOk(g.id, await plainJpeg(100, 100, '#333333'), 'c.jpg');

			let d = await detail(g.id);
			expect(d.coverImageId).toBe(a.id);
			expect(d.coverIsDefault).toBe(true);
			expect(d.cover).toEqual({ imageId: a.id, width: 320, height: 240 });

			d = ok<GalleryDetail>(
				await call('owner', 'PUT', `/galleries/${g.id}/cover`, { imageId: b.id })
			);
			expect(d.coverImageId).toBe(b.id);
			expect(d.coverIsDefault).toBe(false);
			d = await detail(g.id);
			expect(d.coverImageId).toBe(b.id);
			expect(d.coverIsDefault).toBe(false);
			expect(d.cover).toEqual({ imageId: b.id, width: 200, height: 300 });

			// Liste zeigt dasselbe Titelbild
			const list = ok<{ items: GalleryItem[] }>(await call('owner', 'GET', '/galleries'));
			expect(list.items.find((i) => i.id === g.id)?.cover?.imageId).toBe(b.id);

			// Titelbild löschen → wieder ältestes Bild
			ok(await call('owner', 'DELETE', `/galleries/${g.id}/images/${b.id}`));
			d = await detail(g.id);
			expect(d.coverImageId).toBe(a.id);
			expect(d.coverIsDefault).toBe(true);

			// gesetzt und zurück auf Standard
			ok(await call('owner', 'PUT', `/galleries/${g.id}/cover`, { imageId: c.id }));
			expect((await detail(g.id)).coverImageId).toBe(c.id);
			ok(await call('owner', 'PUT', `/galleries/${g.id}/cover`, { imageId: null }));
			d = await detail(g.id);
			expect(d.coverImageId).toBe(a.id);
			expect(d.coverIsDefault).toBe(true);
		});

		it('Bild einer anderen Galerie → 422, nur Lesen → 403', async () => {
			const g = await createGallery({
				shares: [{ type: 'user', id: userIds.reader!, level: 'read' }]
			});
			const other = await createGallery();
			const own = await uploadOk(g.id, await plainJpeg());
			const foreign = await uploadOk(other.id, await plainJpeg());
			fail(
				await call('owner', 'PUT', `/galleries/${g.id}/cover`, { imageId: foreign.id }),
				422,
				'validation_failed'
			);
			fail(
				await call('reader', 'PUT', `/galleries/${g.id}/cover`, { imageId: own.id }),
				403,
				'forbidden'
			);
			expect((await detail(g.id)).coverIsDefault).toBe(true);
		});
	});

	describe('Auslieferung der Varianten', () => {
		let privateG: string;
		let publicG: string;
		let privImg: GalleryImage;
		let pubImg: GalleryImage;

		beforeAll(async () => {
			privateG = (
				await createGallery({ shares: [{ type: 'user', id: userIds.reader!, level: 'read' }] })
			).id;
			publicG = (
				await createGallery({
					visibility: 'public',
					consentConfirmed: true,
					title: 'Öffentlich'
				})
			).id;
			privImg = await uploadOk(privateG, jpegExif, 'privat.jpg');
			pubImg = await uploadOk(publicG, jpegExif, 'oeffentlich.jpg');
		});

		const variantUrl = (g: string, i: string, v: string) => `/galleries/${g}/images/${i}/${v}`;

		it('thumb/web als WebP, full als JPEG-Anhang, privat zwischengespeichert', async () => {
			for (const v of ['thumb', 'web']) {
				const res = await raw('owner', 'GET', variantUrl(privateG, privImg.id, v));
				expect(res.status, v).toBe(200);
				expect(res.headers.get('content-type')).toBe('image/webp');
				expect(res.headers.get('cache-control')).toContain('private');
				expect(res.headers.get('x-content-type-options')).toBe('nosniff');
				expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
				expect(res.headers.get('content-disposition') ?? '').not.toContain('attachment');
				const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
				expect(meta.format).toBe('webp');
				expect(meta.exif).toBeUndefined();
			}
			const full = await raw('owner', 'GET', variantUrl(privateG, privImg.id, 'full'));
			expect(full.status).toBe(200);
			expect(full.headers.get('content-type')).toBe('image/jpeg');
			expect(full.headers.get('cache-control')).toContain('private');
			expect(full.headers.get('content-disposition')).toContain('attachment');
			expect((await sharp(Buffer.from(await full.arrayBuffer())).metadata()).exif).toBeUndefined();
		});

		it('Leser*in mit Freigabe darf, Fremde → 404, ungültige Variante → 422', async () => {
			expect((await raw('reader', 'GET', variantUrl(privateG, privImg.id, 'thumb'))).status).toBe(
				200
			);
			fail(
				await call('stranger', 'GET', variantUrl(privateG, privImg.id, 'thumb')),
				404,
				'not_found'
			);
			fail(
				await call('owner', 'GET', variantUrl(privateG, privImg.id, 'original')),
				422,
				'validation_failed'
			);
			// Bild gehört zu einer anderen Galerie
			fail(await call('owner', 'GET', variantUrl(privateG, pubImg.id, 'thumb')), 404, 'not_found');
			fail(
				await call('owner', 'GET', variantUrl(privateG, crypto.randomUUID(), 'thumb')),
				404,
				'not_found'
			);
		});

		it('öffentliche Galerie: Leser*in ohne Freigabe → 200', async () => {
			for (const v of ['thumb', 'web', 'full']) {
				const res = await raw('stranger', 'GET', variantUrl(publicG, pubImg.id, v));
				expect(res.status, v).toBe(200);
			}
		});
	});

	describe('Beschreibung', () => {
		let g: string;
		let img: GalleryImage;

		beforeAll(async () => {
			g = (await createGallery({ shares: [{ type: 'user', id: userIds.reader!, level: 'read' }] }))
				.id;
			img = await uploadOk(g, await plainJpeg());
		});

		const put = (body: unknown, who = 'owner') =>
			call<GalleryImage>(who, 'PUT', `/galleries/${g}/images/${img.id}`, body);

		it('speichert die Beschreibung', async () => {
			const res = ok(await put({ description: 'Am Lagerfeuer' }));
			expect(res.description).toBe('Am Lagerfeuer');
			expect((await detail(g)).images[0]!.description).toBe('Am Lagerfeuer');
			ok(await put({ description: '  ' }));
			expect((await detail(g)).images[0]!.description).toBeNull();
			ok(await put({ description: 'Am Lagerfeuer' }));
		});

		it('nur Lesen → 403, fremd → 404, Termine am Bild → 422 (strikt)', async () => {
			fail(await put({ description: 'x' }, 'reader'), 403, 'forbidden');
			fail(await put({ description: 'x' }, 'stranger'), 404, 'not_found');
			fail(await put({ description: 'x', extra: 1 }), 422, 'validation_failed');
			// Termine hängen an der Galerie, nicht am einzelnen Bild
			fail(await put({ description: 'x', eventIds: [] }), 422, 'validation_failed');
			expect((await detail(g)).images[0]!.description).toBe('Am Lagerfeuer');
		});
	});

	describe('Termine der Galerie', () => {
		let g: GalleryDetail;
		let eVisible: string;
		let eVisible2: string;
		let eHidden: string;
		let eLater: string;

		beforeAll(async () => {
			eVisible = await insertEvent('Sommerfest', { visible: true });
			eVisible2 = await insertEvent('Herbstfahrt', { visible: true });
			eHidden = await insertEvent('Geheimtreffen', { visible: false });
			eLater = await insertEvent('Später versteckt', { visible: true });
			g = await createGallery({
				shares: [{ type: 'user', id: userIds.reader!, level: 'read' }],
				eventIds: [eVisible]
			});
		});

		const input = (eventIds: string[]) => ({
			title: g.title,
			description: g.description,
			visibility: g.visibility,
			shares: [{ type: 'user', id: userIds.reader!, level: 'read' }],
			eventIds
		});
		const put = (eventIds: string[], who = 'owner') =>
			call<GalleryDetail>(who, 'PUT', `/galleries/${g.id}`, input(eventIds));

		it('POST/PUT speichern die Termine der ganzen Galerie, Liste filtert nach Termin', async () => {
			expect(g.events.map((e) => e.id)).toEqual([eVisible]);
			expect(g.events[0]).toMatchObject({ title: 'Sommerfest', startsOn: '2026-07-01' });

			const res = ok(await put([eVisible, eVisible2]));
			expect(res.events.map((e) => e.id).sort()).toEqual([eVisible, eVisible2].sort());

			// Leser*in sieht die Termine im Detail und in der Liste
			const asReader = ok<GalleryDetail>(await call('reader', 'GET', `/galleries/${g.id}`));
			expect(asReader.events.map((e) => e.id).sort()).toEqual([eVisible, eVisible2].sort());
			const list = ok<{ items: GalleryItem[] }>(
				await call('owner', 'GET', `/galleries?eventId=${eVisible2}`)
			);
			expect(list.items.map((i) => i.id)).toEqual([g.id]);
			expect(list.items[0]!.events.map((e) => e.id).sort()).toEqual([eVisible, eVisible2].sort());
		});

		it('unsichtbarer oder unbekannter Termin → 422 mit Pfad eventIds.i, nichts geändert', async () => {
			const hidden = await put([eVisible, eHidden]);
			fail(hidden, 422, 'validation_failed');
			expect(paths(hidden)).toContain('eventIds.1');
			const unknown = await put(['gibt-es-nicht']);
			fail(unknown, 422, 'validation_failed');
			expect(paths(unknown)).toContain('eventIds.0');
			const create = await call('owner', 'POST', '/galleries', {
				title: 'Neu',
				eventIds: [eHidden]
			});
			fail(create, 422, 'validation_failed');
			expect((await detail(g.id)).events.map((e) => e.id).sort()).toEqual(
				[eVisible, eVisible2].sort()
			);
			const many = Array.from({ length: 21 }, (_, i) => `e${i}`);
			fail(await put(many), 422, 'validation_failed');
		});

		it('bereits gespeicherte, inzwischen unsichtbare Termine blockieren das Speichern nicht', async () => {
			ok(await put([eLater]));
			await hideEvent(eLater);
			// Termin ist für den Aufrufer nicht mehr sichtbar → nicht in der Antwort
			expect((await detail(g.id)).events.map((e) => e.id)).not.toContain(eLater);
			const res = ok(await put([eLater, eVisible]));
			expect(res.events.map((e) => e.id)).toEqual([eVisible]);
		});

		it('events deaktiviert: eventIds → 422, ohne Termine weiter speicherbar', async () => {
			await disableModule(admin, 'events');
			try {
				const res = await put([eVisible]);
				fail(res, 422, 'validation_failed');
				expect(paths(res)).toContain('eventIds');
				const okRes = ok(await put([]));
				expect(okRes.events).toEqual([]);
				expect((await detail(g.id)).events).toEqual([]);
			} finally {
				await enableModule(admin, 'events');
			}
		});

		it('Galerie löschen entfernt die Termin-Zuordnung', async () => {
			const tmp = await createGallery({ eventIds: [eVisible] });
			ok(await call('owner', 'DELETE', `/galleries/${tmp.id}`));
			const rows = await core.database.forModule('galleries').transaction(async (tx) => {
				const r = (await tx.execute(
					sql`SELECT count(*)::int AS n FROM gallery_events WHERE gallery_id = ${tmp.id}`
				)) as unknown as { rows: { n: number }[] };
				return r.rows;
			});
			expect(Number(rows[0]!.n)).toBe(0);
		});
	});

	describe('Sammelaktionen', () => {
		let g: string;
		let other: string;
		let imgs: GalleryImage[];
		let foreign: GalleryImage;

		beforeAll(async () => {
			g = (await createGallery()).id;
			other = (await createGallery()).id;
			imgs = [];
			for (let i = 0; i < 3; i++) imgs.push(await uploadOk(g, await plainJpeg(100 + i, 80)));
			foreign = await uploadOk(other, await plainJpeg());
		});

		const bulk = (body: unknown, who = 'owner') =>
			call<BulkResult>(who, 'POST', `/galleries/${g}/images/bulk`, body);
		it('nur delete: Termin-Aktionen gibt es nicht mehr (422)', async () => {
			const ids = [imgs[0]!.id];
			fail(await bulk({ action: 'add-events', ids, eventIds: ['e1'] }), 422, 'validation_failed');
			fail(
				await bulk({ action: 'remove-events', ids, eventIds: ['e1'] }),
				422,
				'validation_failed'
			);
			expect(await imageRowCount(g)).toBe(3);
		});

		it('fremde Bild-ID → 404 und nichts geändert', async () => {
			const before = filesOf(g).size;
			fail(await bulk({ action: 'delete', ids: [imgs[2]!.id, foreign.id] }), 404, 'not_found');
			expect(await imageRowCount(g)).toBe(3);
			expect(await imageRowCount(other)).toBe(1);
			expect(filesOf(g).size).toBe(before);
			fail(await bulk({ action: 'delete', ids: [imgs[2]!.id] }, 'stranger'), 404, 'not_found');
		});

		it('delete entfernt DB-Zeilen und Dateien', async () => {
			const ids = [imgs[0]!.id, imgs[1]!.id];
			expect(ok(await bulk({ action: 'delete', ids }), 201)).toEqual({ affected: 2 });
			expect(await imageRowCount(g)).toBe(1);
			const files = [...filesOf(g).keys()];
			expect(files).toHaveLength(3);
			expect(files.every((p) => p.includes(imgs[2]!.id))).toBe(true);
			expect((await detail(g)).images.map((i) => i.id)).toEqual([imgs[2]!.id]);
			// Bilder der anderen Galerie unberührt
			expect(filesOf(other).size).toBe(3);
		});
	});

	describe('Löschen', () => {
		it('einzelnes Bild entfernt Zeile und Dateien', async () => {
			const g = (await createGallery()).id;
			const a = await uploadOk(g, await plainJpeg());
			const b = await uploadOk(g, await plainJpeg());
			ok(await call('owner', 'DELETE', `/galleries/${g}/images/${a.id}`));
			expect([...filesOf(g).keys()].every((p) => p.includes(b.id))).toBe(true);
			expect(filesOf(g).size).toBe(3);
			fail(await call('owner', 'DELETE', `/galleries/${g}/images/${a.id}`), 404, 'not_found');
		});

		it('Galerie löschen entfernt alle Dateien', async () => {
			const g = (await createGallery()).id;
			await uploadOk(g, await plainJpeg());
			await uploadOk(g, jpegExif);
			expect(filesOf(g).size).toBe(6);
			ok(await call('owner', 'DELETE', `/galleries/${g}`));
			expect(filesOf(g).size).toBe(0);
			expect(await imageRowCount(g)).toBe(0);
			fail(await call('owner', 'GET', `/galleries/${g}`), 404, 'not_found');
		});
	});

	describe('Audit', () => {
		it('enthält Bild-Aktionen, aber keine Dateinamen oder Beschreibungen', async () => {
			const { rows } = await listAudit({ action: 'galleries.', limit: 500 });
			const actions = new Set(rows.map((r) => r.action));
			for (const a of [
				'galleries.image.uploaded',
				'galleries.image.updated',
				'galleries.image.deleted',
				'galleries.image.bulk_updated',
				'galleries.gallery.cover_changed',
				'galleries.gallery.deleted'
			]) {
				expect(actions.has(a), a).toBe(true);
			}
			const text = JSON.stringify(rows.map((r) => [r.target, r.metadata]));
			for (const secret of [
				'urlaub-geheim',
				'Geheime Beschreibung',
				'Am Lagerfeuer',
				'Neue Beschreibung',
				'logo.png',
				'privat.jpg'
			]) {
				expect(text).not.toContain(secret);
			}
		});
	});
});
