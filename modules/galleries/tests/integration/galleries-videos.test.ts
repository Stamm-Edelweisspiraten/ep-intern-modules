/**
 * Modul `galleries` – Videos: Freigabe im Dateispeicher (`GET /limits`, 422 ohne Videotypen), Upload
 * MP4/MOV mit Vorschaubild und Laufzeit, Metadaten (GPS/Gerät) entfernt, Ablehnung falscher Inhalte,
 * Auslieferung mit Range (206/416), `video` nur bei Videos, Website-API, Löschen der Dateien, Audit.
 * Storage über `tests/helpers/fake-storage.ts`; Videos sind synthetische Container (`video-fixtures.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { DEFAULT_ALLOWED_CONTENT_TYPES } from '$lib/sdk/content-types';
import type { RequestContext } from '$lib/sdk/types';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import type {
	GalleryDetail,
	GalleryImage,
	UploadLimits,
	WebsiteGalleryDetail
} from '$modules/galleries/schemas';
import { websiteGalleryDetailSchema } from '$modules/galleries/website.schemas';
import membersModule from '$modules/members/module';
import {
	bootstrapAdmin,
	contextForUser,
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
import {
	contains,
	DEVICE_TEXT,
	GPS_TEXT,
	MDAT_PAYLOAD,
	sampleMp4,
	sampleWebm
} from '../video-fixtures';

const ROOT = 'http://localhost:5173/api/v1/modules/galleries';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let poster: Uint8Array;
let jpeg: Uint8Array;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function raw(
	who: string,
	method: string,
	path: string,
	body?: BodyInit,
	extra: Record<string, string> = {}
) {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}`, ...extra });
	const url = new URL(`${ROOT}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(who: string, method: string, path: string, json?: unknown) {
	const res = await raw(
		who,
		method,
		path,
		json === undefined ? undefined : JSON.stringify(json),
		json === undefined ? {} : { 'content-type': 'application/json' }
	);
	return { status: res.status, body: await res.json() } as Res<T>;
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

function videoForm(
	bytes: Uint8Array,
	name: string,
	type: string,
	opts: { poster?: Uint8Array | null; duration?: string } = {}
) {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type }));
	const p = opts.poster === undefined ? poster : opts.poster;
	if (p) fd.set('poster', new File([p as BlobPart], 'poster.jpg', { type: 'image/jpeg' }));
	if (opts.duration !== undefined) fd.set('duration', opts.duration);
	return fd;
}

async function upload(galleryId: string, fd: FormData, who = 'owner'): Promise<Res<GalleryImage>> {
	const res = await raw(who, 'POST', `/galleries/${galleryId}/images`, fd);
	return { status: res.status, body: await res.json() };
}

async function createGallery(over: Record<string, unknown> = {}): Promise<GalleryDetail> {
	return ok<GalleryDetail>(
		await call('owner', 'POST', '/galleries', {
			title: 'Lagerfilm',
			description: null,
			visibility: 'private',
			shares: [],
			...over
		}),
		201
	);
}

function filesOf(galleryId: string): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const row of fakeFileRows.values()) {
		if (row.moduleId !== 'galleries' || !row.path.startsWith(`${galleryId}/`)) continue;
		const obj = fakeObjects.get(row.objectKey);
		if (obj) out.set(row.path, obj.body);
	}
	return out;
}

const ROLES: Record<string, string[]> = {
	owner: [
		'galleries.gallery.view',
		'galleries.gallery.create',
		'galleries.gallery.publish',
		'core.api.manage'
	],
	reader: ['galleries.gallery.view', 'core.api.manage'],
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
	await enableModule(admin, 'galleries');
	admin = await ctxOf(u!.id);
	for (const [name, perms] of Object.entries(ROLES)) {
		const roleId = await createRole(admin, { name: `role-${name}`, permissions: perms });
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = await ctxOf(userIds[name]!);
		const scopes = name === 'website' ? ['galleries.website.read'] : perms;
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes })).key;
	}
	poster = new Uint8Array(
		await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#335577' } })
			.jpeg()
			.toBuffer()
	);
	jpeg = new Uint8Array(
		await sharp({ create: { width: 320, height: 240, channels: 3, background: '#22aa55' } })
			.jpeg()
			.toBuffer()
	);
	await installFakeStorage(admin);
});

afterAll(() => uninstallFakeStorage());

describe('Dateispeicher ohne Videotypen (Standardliste)', () => {
	it('GET /limits meldet videosAllowed: false, Upload → 422 mit Hinweis', async () => {
		const limits = ok<UploadLimits>(await call('owner', 'GET', '/limits'));
		expect(limits).toEqual({
			maxImageBytes: 25 * 1024 * 1024,
			maxVideoBytes: 50 * 1024 * 1024,
			videosAllowed: false
		});
		const g = await createGallery();
		const res = await upload(g.id, videoForm(sampleMp4(), 'film.mp4', 'video/mp4'));
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['file']);
		expect(JSON.stringify(res.body)).toContain('video/mp4');
		expect(filesOf(g.id).size).toBe(0);
	});
});

describe('mit freigegebenen Videotypen', () => {
	beforeAll(async () => {
		await setSetting(admin, 'core.storage.allowedContentTypes', [
			...DEFAULT_ALLOWED_CONTENT_TYPES,
			'video/mp4',
			'video/quicktime',
			'video/webm'
		]);
	});

	it('GET /limits meldet videosAllowed: true', async () => {
		expect(ok<UploadLimits>(await call('reader', 'GET', '/limits')).videosAllowed).toBe(true);
	});

	it('MP4: Vorschaubilder + Video ohne GPS/Gerät, Laufzeit, Maße vom Vorschaubild', async () => {
		const g = await createGallery();
		const mp4 = sampleMp4();
		const v = ok(
			await upload(g.id, videoForm(mp4, 'zeltlager.mp4', 'video/mp4', { duration: '12.54' })),
			201
		);
		expect(v).toMatchObject({
			mediaType: 'video',
			durationSeconds: 12.5,
			contentType: 'video/mp4',
			originalName: 'zeltlager.mp4',
			width: 1280,
			height: 720,
			sizeBytes: mp4.length
		});
		const files = filesOf(g.id);
		expect([...files.keys()].sort()).toEqual(
			[`${g.id}/${v.id}-thumb.webp`, `${g.id}/${v.id}-web.webp`, `${g.id}/${v.id}-video.mp4`].sort()
		);
		const stored = files.get(`${g.id}/${v.id}-video.mp4`)!;
		expect(stored.length).toBe(mp4.length);
		expect(contains(stored, GPS_TEXT)).toBe(false);
		expect(contains(stored, DEVICE_TEXT)).toBe(false);
		expect(contains(stored, MDAT_PAYLOAD)).toBe(true);

		const d = ok<GalleryDetail>(await call('owner', 'GET', `/galleries/${g.id}`));
		expect(d.images[0]).toMatchObject({ id: v.id, mediaType: 'video', durationSeconds: 12.5 });
		expect(d.cover?.imageId).toBe(v.id);

		const { rows } = await listAudit({ action: 'galleries.image.uploaded', limit: 50 });
		const entry = rows.find((r) => r.metadata?.imageId === v.id);
		expect(entry?.metadata).toMatchObject({ mediaType: 'video' });
		expect(JSON.stringify(entry)).not.toContain('zeltlager');
	});

	it('MOV ohne Browser-Typ (nur Endung) und WebM', async () => {
		const g = await createGallery();
		const mov = ok(await upload(g.id, videoForm(sampleMp4('qt  '), 'IMG_0042.MOV', '')), 201);
		expect(mov.contentType).toBe('video/quicktime');
		expect(mov.durationSeconds).toBeNull();
		const webm = ok(await upload(g.id, videoForm(sampleWebm(), 'clip.webm', 'video/webm')), 201);
		expect(webm.contentType).toBe('video/webm');
		const files = filesOf(g.id);
		expect(files.has(`${g.id}/${mov.id}-video.mov`)).toBe(true);
		expect(contains(files.get(`${g.id}/${webm.id}-video.webm`)!, GPS_TEXT)).toBe(false);
	});

	it('ohne Vorschaubild, falscher Inhalt, ungültige Laufzeit → 422; nichts gespeichert', async () => {
		const g = await createGallery();
		let res = await upload(g.id, videoForm(sampleMp4(), 'a.mp4', 'video/mp4', { poster: null }));
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['poster']);

		const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
		res = await upload(g.id, videoForm(html, 'b.mp4', 'video/mp4'));
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['file']);

		// AVIF-Bild als „Video“ getarnt
		const avif = new Uint8Array(await sharp(Buffer.from(jpeg)).avif().toBuffer());
		res = await upload(g.id, videoForm(avif, 'c.mp4', 'video/mp4'));
		expect(res.status).toBe(422);

		res = await upload(g.id, videoForm(sampleMp4(), 'd.mp4', 'video/mp4', { duration: '-5' }));
		expect(res.status).toBe(422);
		expect(paths(res)).toEqual(['duration']);

		expect(filesOf(g.id).size).toBe(0);
	});

	it('nur Lesen → 403 (wie bei Bildern)', async () => {
		const g = await createGallery({
			shares: [{ type: 'user', id: userIds.reader!, level: 'read' }]
		});
		const res = await upload(g.id, videoForm(sampleMp4(), 'a.mp4', 'video/mp4'), 'reader');
		expect(res.status).toBe(403);
	});

	describe('Auslieferung', () => {
		let g: GalleryDetail;
		let v: GalleryImage;
		let img: GalleryImage;
		let mp4: Uint8Array;

		beforeAll(async () => {
			g = await createGallery({
				visibility: 'public',
				consentConfirmed: true
			});
			v = ok(await upload(g.id, videoForm(sampleMp4(), 'lager.mp4', 'video/mp4')), 201);
			mp4 = filesOf(g.id).get(`${g.id}/${v.id}-video.mp4`)!;
			const fd = new FormData();
			fd.set('file', new File([jpeg as BlobPart], 'bild.jpg', { type: 'image/jpeg' }));
			img = ok(await upload(g.id, fd), 201);
		});

		it('video: ganze Datei mit accept-ranges, Range → 206, außerhalb → 416', async () => {
			const base = `/galleries/${g.id}/images/${v.id}/video`;
			let res = await raw('reader', 'GET', base);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('video/mp4');
			expect(res.headers.get('accept-ranges')).toBe('bytes');
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
			expect<unknown>(new Uint8Array(await res.arrayBuffer())).toEqual(mp4);

			res = await raw('reader', 'GET', base, undefined, { range: 'bytes=4-11' });
			expect(res.status).toBe(206);
			expect(res.headers.get('content-range')).toBe(`bytes 4-11/${mp4.length}`);
			expect(res.headers.get('content-length')).toBe('8');
			expect<unknown>(new Uint8Array(await res.arrayBuffer())).toEqual(mp4.subarray(4, 12));

			res = await raw('reader', 'GET', base, undefined, { range: `bytes=${mp4.length}-` });
			expect(res.status).toBe(416);
			expect(res.headers.get('content-range')).toBe(`bytes */${mp4.length}`);
		});

		it('full = Video als Download, thumb/web = Vorschaubild, video bei Bild → 404', async () => {
			let res = await raw('owner', 'GET', `/galleries/${g.id}/images/${v.id}/full`);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-disposition')).toMatch(/^attachment;.*lager\.mp4/);
			res = await raw('owner', 'GET', `/galleries/${g.id}/images/${v.id}/thumb`);
			expect(res.headers.get('content-type')).toBe('image/webp');
			res = await raw('owner', 'GET', `/galleries/${g.id}/images/${img.id}/video`);
			expect(res.status).toBe(404);
		});

		it('Website: mediaType im Detail, Video mit Range, nur intern → 404', async () => {
			const d = ok<WebsiteGalleryDetail>(
				await call('website', 'GET', `/website/galleries/${g.id}`)
			);
			websiteGalleryDetailSchema.parse(d);
			expect(d.images.map((i) => [i.id, i.mediaType])).toEqual([
				[v.id, 'video'],
				[img.id, 'image']
			]);
			const base = `/website/galleries/${g.id}/images/${v.id}/video`;
			let res = await raw('website', 'GET', base, undefined, { range: 'bytes=0-3' });
			expect(res.status).toBe(206);
			expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
			// Kein Originalname nach außen
			expect(res.headers.get('content-disposition')).not.toContain('lager');
			res = await raw('website', 'GET', `/website/galleries/${g.id}/images/${img.id}/video`);
			expect(res.status).toBe(404);

			ok(
				await call('owner', 'PUT', `/galleries/${g.id}/images/${v.id}`, {
					description: null,
					isPrivate: true
				})
			);
			res = await raw('website', 'GET', base);
			expect(res.status).toBe(404);
		});

		it('Löschen entfernt Video und Vorschaubilder', async () => {
			ok(await call('owner', 'DELETE', `/galleries/${g.id}/images/${v.id}`));
			expect([...filesOf(g.id).keys()].some((p) => p.includes(v.id))).toBe(false);
		});
	});
});
