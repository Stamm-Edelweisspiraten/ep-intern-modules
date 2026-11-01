/**
 * Performance-Fixes #23/#24 (Team Performance):
 * - `core.storage.removeMany`: S3 DeleteObjects in Paketen à 1000, eine Metadaten-Löschung, genau ein Audit-Eintrag
 * - Galerie löschen und Papierkorb leeren (`files`) nutzen die Sammel-Löschung
 * - Bild-/Thumbnail-Endpunkte haben ein eigenes Rate-Limit (200 GETs desselben Benutzers ohne 429)
 * - Storage-Konfiguration wird gecacht, Speichern der Einstellungen invalidiert sofort
 * - `principalKeysFor` wird je Kontext (Request) memoisiert
 * Storage über `tests/helpers/fake-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import {
	fakeFileRows,
	fakeObjects,
	fakeS3Calls,
	installFakeStorage,
	uninstallFakeStorage
} from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { setSetting } from '$testing';
import { core } from '$testing';
import { principalKeysFor } from '$lib/sdk/server';
import eventsModule from '$modules/events/module';
import membersModule from '$modules/members/module';
import galleriesModule from '$modules/galleries/module';
import filesModule from '$modules/files/module';
import type { GalleryDetail, GalleryImage } from '$modules/galleries/schemas';
import type { RequestContext } from '$lib/sdk/types';

const BASE = 'http://localhost:5173/api/v1/modules';
const PW = 'a-long-enough-pw';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

interface Res {
	status: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

async function raw(
	who: string,
	method: string,
	path: string,
	init: { body?: BodyInit; headers?: Record<string, string> } = {},
	opts: { reset?: boolean } = {}
): Promise<Response> {
	if (opts.reset !== false) resetAllForTests();
	const url = new URL(BASE + path);
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${keys[who]}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body: init.body }),
		url,
		ip: '127.0.0.1'
	});
}

async function api(who: string, method: string, path: string, data?: unknown): Promise<Res> {
	const res = await raw(who, method, path, {
		headers: data === undefined ? {} : { 'content-type': 'application/json' },
		body: data === undefined ? undefined : JSON.stringify(data)
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

async function jpeg(color = '#3366cc'): Promise<Uint8Array> {
	const buf = await sharp({ create: { width: 200, height: 150, channels: 3, background: color } })
		.jpeg()
		.toBuffer();
	return new Uint8Array(buf);
}

async function uploadGalleryImage(galleryId: string, bytes: Uint8Array): Promise<GalleryImage> {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], 'bild.jpg', { type: 'image/jpeg' }));
	const res = await raw('owner', 'POST', `/galleries/galleries/${galleryId}/images`, { body: fd });
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.data as GalleryImage;
}

async function uploadFile(parent: string, name: string): Promise<string> {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(10).fill(65)], name, { type: 'text/plain' }));
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	const res = await raw('owner', 'POST', `/files/nodes/${parent}/upload`, {
		headers: {
			'content-type': r.headers.get('content-type')!,
			'content-length': String(buf.byteLength)
		},
		body: buf
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.data.id as string;
}

async function storageDeleteAudits(): Promise<{ target: string; metadata: unknown }[]> {
	const res = await getDb().execute(
		sql`SELECT target, metadata FROM audit_log WHERE action = 'core.storage.files_deleted' ORDER BY created_at`
	);
	return (res as unknown as { rows: { target: string; metadata: unknown }[] }).rows;
}

const count = (name: string) => fakeS3Calls.get(name) ?? 0;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	registerModule(galleriesModule);
	registerModule(filesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'events', 'galleries', 'files']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);

	const perms = [
		'galleries.gallery.view',
		'galleries.gallery.create',
		'files.file.view',
		'core.api.manage'
	];
	const roleId = await createRole(admin, { name: 'Perf', permissions: perms });
	userIds.owner = await createUser(admin, {
		name: 'Owner Test',
		email: 'owner@example.test',
		password: PW,
		roleIds: [roleId]
	});
	keys.owner = (await createApiKey(await ctxOf(userIds.owner), { name: 'k', scopes: perms })).key;
});

afterAll(async () => {
	uninstallFakeStorage();
	await close();
});

describe('core.storage.removeMany', () => {
	it('300 Pfade → ein DeleteObjects-Aufruf, ein Audit-Eintrag, Metadaten weg', async () => {
		const sys = core.auth.systemContext('test');
		const paths = Array.from({ length: 300 }, (_, i) => `batch/datei-${i}.txt`);
		for (const p of paths) {
			await core.storage.upload(sys, {
				module: 'galleries',
				path: p,
				file: new TextEncoder().encode('x'),
				contentType: 'text/plain'
			});
		}
		const auditsBefore = (await storageDeleteAudits()).length;
		fakeS3Calls.clear();

		const res = await core.storage.removeMany(sys, {
			module: 'galleries',
			paths: [...paths, 'batch/gibt-es-nicht.txt', paths[0]!]
		});
		expect(res).toEqual({ removed: 300, missing: 1, failed: 0 });
		expect(count('DeleteObjectsCommand')).toBe(1);
		expect(count('DeleteObjectCommand')).toBe(0);
		const rows = [...fakeFileRows.values()].filter((r) => r.path.startsWith('batch/'));
		expect(rows).toEqual([]);
		const audits = await storageDeleteAudits();
		expect(audits.length).toBe(auditsBefore + 1);
		expect(audits.at(-1)!.target).toBe('galleries');
		expect(audits.at(-1)!.metadata).toMatchObject({ count: 300, failed: 0 });
	});

	it('mehr als 1000 Pfade → Pakete à 1000, trotzdem ein Audit-Eintrag', async () => {
		const sys = core.auth.systemContext('test');
		const paths = Array.from({ length: 1001 }, (_, i) => `gross/d-${i}.txt`);
		for (const p of paths) {
			await core.storage.upload(sys, {
				module: 'galleries',
				path: p,
				file: new Uint8Array([1]),
				contentType: 'text/plain'
			});
		}
		const auditsBefore = (await storageDeleteAudits()).length;
		fakeS3Calls.clear();
		const res = await core.storage.removeMany(sys, { module: 'galleries', paths });
		expect(res.removed).toBe(1001);
		expect(count('DeleteObjectsCommand')).toBe(2);
		expect((await storageDeleteAudits()).length).toBe(auditsBefore + 1);
	});

	it('prüft Rechte und Pfade vor jeder Löschung; leere Liste ohne Audit', async () => {
		const owner = await ctxOf(userIds.owner!);
		await expect(
			core.storage.removeMany(owner, { module: 'galleries', paths: ['a.txt'] })
		).rejects.toMatchObject({ code: 'forbidden' });
		const sys = core.auth.systemContext('test');
		await expect(
			core.storage.removeMany(sys, { module: 'galleries', paths: ['../boese'] })
		).rejects.toMatchObject({ code: 'bad_request' });
		const before = (await storageDeleteAudits()).length;
		expect(await core.storage.removeMany(sys, { module: 'galleries', paths: [] })).toEqual({
			removed: 0,
			missing: 0,
			failed: 0
		});
		expect((await storageDeleteAudits()).length).toBe(before);
	});
});

describe('Galerien', () => {
	let galleryId: string;
	let image: GalleryImage;

	beforeAll(async () => {
		const g = ok<GalleryDetail>(
			await api('owner', 'POST', '/galleries/galleries', {
				title: 'Fahrtenfotos',
				description: null,
				visibility: 'private',
				shares: []
			}),
			201
		);
		galleryId = g.id;
		image = await uploadGalleryImage(galleryId, await jpeg('#3366cc'));
		await uploadGalleryImage(galleryId, await jpeg('#cc6633'));
		await uploadGalleryImage(galleryId, await jpeg('#33cc66'));
	});

	it('200 Thumbnail-Abrufe desselben Benutzers ohne 429 (eigenes Bild-Kontingent)', async () => {
		resetAllForTests();
		const path = `/galleries/galleries/${galleryId}/images/${image.id}/thumb`;
		for (let i = 0; i < 200; i++) {
			const res = await raw('owner', 'GET', path, {}, { reset: false });
			expect(res.status, `Abruf ${i + 1}`).toBe(200);
			if (i === 0) {
				expect(res.headers.get('content-type')).toBe('image/webp');
				const bytes = new Uint8Array(await res.arrayBuffer());
				expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
				expect((await sharp(Buffer.from(bytes)).metadata()).format).toBe('webp');
			} else {
				await res.body?.cancel();
			}
		}
	});

	it('Galerie löschen: alle Varianten in einem Batch, genau ein Storage-Audit', async () => {
		const objectsBefore = [...fakeFileRows.values()].filter((r) =>
			r.path.startsWith(`${galleryId}/`)
		);
		expect(objectsBefore.length).toBe(9);
		const auditsBefore = (await storageDeleteAudits()).length;
		fakeS3Calls.clear();

		ok(await api('owner', 'DELETE', `/galleries/galleries/${galleryId}`));

		expect(count('DeleteObjectsCommand')).toBe(1);
		expect(count('DeleteObjectCommand')).toBe(0);
		expect([...fakeFileRows.values()].filter((r) => r.path.startsWith(`${galleryId}/`))).toEqual(
			[]
		);
		for (const r of objectsBefore) expect(fakeObjects.has(r.objectKey)).toBe(false);
		const audits = await storageDeleteAudits();
		expect(audits.length).toBe(auditsBefore + 1);
		expect(audits.at(-1)!.metadata).toMatchObject({ count: 9 });
	});
});

describe('Dateien: Papierkorb leeren', () => {
	it('löscht alle Objekte eines Ordners in einem Batch mit einem Storage-Audit', async () => {
		const folder = ok<{ id: string }>(
			await api('owner', 'POST', '/files/folders', { parentId: null, name: 'Kiste' }),
			201
		).id;
		for (const n of ['a.txt', 'b.txt', 'c.txt']) await uploadFile(folder, n);
		ok(await api('owner', 'POST', '/files/nodes/trash', { ids: [folder] }), 201);
		const auditsBefore = (await storageDeleteAudits()).length;
		fakeS3Calls.clear();

		const p = ok<{ affected: number }>(
			await api('owner', 'POST', '/files/trash/purge', { ids: [folder] }),
			201
		);
		expect(p.affected).toBe(1);
		expect(count('DeleteObjectsCommand')).toBe(1);
		expect(count('DeleteObjectCommand')).toBe(0);
		const audits = await storageDeleteAudits();
		expect(audits.length).toBe(auditsBefore + 1);
		expect(audits.at(-1)!.target).toBe('files');
		expect(audits.at(-1)!.metadata).toMatchObject({ count: 3 });
	});
});

describe('Storage-Konfiguration (Cache)', () => {
	it('Speichern der Einstellungen wirkt sofort', async () => {
		const sys = core.auth.systemContext('test');
		const put = () =>
			core.storage.upload(sys, {
				module: 'galleries',
				path: 'cache/x.txt',
				file: new Uint8Array([1]),
				contentType: 'text/plain'
			});
		await expect(put()).resolves.toBeTruthy();
		await setSetting(admin, 'core.storage.bucket', '');
		await expect(put()).rejects.toMatchObject({ code: 'unavailable' });
		await setSetting(admin, 'core.storage.bucket', 'test-bucket');
		await expect(put()).resolves.toBeTruthy();
	});
});

describe('principalKeysFor (Memo je Request-Kontext)', () => {
	it('berechnet je Kontext einmal; neuer Kontext sieht Änderungen', async () => {
		const ctx = await ctxOf(userIds.owner!);
		const first = await principalKeysFor(ctx, 'galleries');
		const roleId = await createRole(admin, { name: 'Später', permissions: [] });
		await getDb().insert(schema.userRole).values({ userId: userIds.owner!, roleId });

		const again = await principalKeysFor(ctx, 'galleries');
		expect(again.sort()).toEqual([...first].sort());
		// Rückgabe ist eine Kopie – Änderungen am Ergebnis wirken nicht auf das Memo
		again.push('user:fremd');
		expect(await principalKeysFor(ctx, 'galleries')).not.toContain('user:fremd');

		const fresh = await principalKeysFor(await ctxOf(userIds.owner!), 'galleries');
		expect(fresh).toContain(`role:${roleId}`);
	});
});
