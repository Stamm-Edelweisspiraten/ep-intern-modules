/**
 * Modul `members` – Gruppenbilder ohne Metadaten (#19): Upload über `core.images.process` (WebP, EXIF/GPS weg),
 * falscher Inhalt → 400, Website liefert nur die bereinigte Variante, Job `members.reprocess-group-images`
 * bereinigt den Bestand idempotent. Storage über `tests/helpers/fake-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { fakeFileRows, installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { runJobNow } from '$testing';
import { core } from '$testing';
import membersModule from '$modules/members/module';
import { isProcessedGroupImagePath } from '$modules/members/group-image.service';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/members';
let key: string;
let admin: RequestContext;
let close: () => Promise<void>;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function raw(method: string, path: string, body?: BodyInit): Promise<Response> {
	resetAllForTests();
	const url = new URL(ROOT + path);
	return handleApiRequest({
		request: new Request(url, {
			method,
			headers: { authorization: `Bearer ${key}` },
			body
		}),
		url,
		ip: '127.0.0.1'
	});
}

/** JPEG mit EXIF (Kamera, GPS-Aufnahmeort) */
async function gpsJpeg(): Promise<Uint8Array> {
	const buf = await sharp({
		create: { width: 900, height: 600, channels: 3, background: '#4477aa' }
	})
		.jpeg({ quality: 90 })
		.withExif({
			IFD0: { Make: 'Handykamera', Model: 'P9' },
			IFD3: {
				GPSLatitudeRef: 'N',
				GPSLatitude: '53/1 4/1 0/1',
				GPSLongitudeRef: 'E',
				GPSLongitude: '8/1 48/1 0/1'
			}
		})
		.toBuffer();
	return new Uint8Array(buf);
}

async function pngBytes(): Promise<Uint8Array> {
	const buf = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#000' } })
		.png()
		.toBuffer();
	return new Uint8Array(buf);
}

function form(bytes: Uint8Array, name: string, type: string): FormData {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type }));
	return fd;
}

/** Enthält die Datei einen EXIF-/GPS-Block? */
async function hasMetadata(bytes: Uint8Array): Promise<boolean> {
	const meta = await sharp(Buffer.from(bytes)).metadata();
	const text = Buffer.from(bytes).toString('latin1');
	return !!meta.exif || !!meta.xmp || text.includes('Exif') || text.includes('Handykamera');
}

async function groupRow(id: string): Promise<{ image_path: string | null }> {
	return core.database.forModule('members').transaction(async (tx) => {
		const res = (await tx.execute(
			sql`SELECT image_path FROM groups WHERE id = ${id}`
		)) as unknown as { rows: { image_path: string | null }[] };
		return res.rows[0]!;
	});
}

async function insertGroup(name: string, slug: string): Promise<string> {
	const id = crypto.randomUUID();
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO groups (id, name, type, on_website, slug) VALUES (${id}, ${name}, 'sippe', true, ${slug})`
		);
	});
	return id;
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);
	key = (await createApiKey(admin, { name: 'k', scopes: [...admin.permissions] })).key;
	await installFakeStorage(admin);
});

afterAll(async () => {
	uninstallFakeStorage();
	await close();
});

describe('Gruppenbild-Upload', () => {
	it('speichert nur eine bereinigte WebP-Variante; Website liefert sie ohne EXIF/GPS', async () => {
		const id = await insertGroup('Falken', 'falken');
		const original = await gpsJpeg();
		expect(await hasMetadata(original)).toBe(true);

		const up = await raw('POST', `/groups/${id}/image`, form(original, 'foto.jpg', 'image/jpeg'));
		expect(up.status, await up.clone().text()).toBe(201);

		const path = (await groupRow(id)).image_path!;
		expect(isProcessedGroupImagePath(path)).toBe(true);
		const stored = [...fakeFileRows.values()].find((r) => r.path === path)!;
		expect(stored.contentType).toBe('image/webp');

		const res = await raw('GET', '/website/groups/falken/image');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/webp');
		const served = new Uint8Array(await res.arrayBuffer());
		expect(await hasMetadata(served)).toBe(false);
		const meta = await sharp(Buffer.from(served)).metadata();
		expect(meta.format).toBe('webp');
		expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);

		const internal = await raw('GET', `/groups/${id}/image`);
		expect(internal.status).toBe(200);
		expect(await hasMetadata(new Uint8Array(await internal.arrayBuffer()))).toBe(false);
	});

	it('Inhalt passt nicht zum Typ → 400, nichts gespeichert', async () => {
		const id = await insertGroup('Möwen', 'moewen');
		const before = fakeFileRows.size;
		const res = await raw(
			'POST',
			`/groups/${id}/image`,
			form(await pngBytes(), 'x.jpg', 'image/jpeg')
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('bad_request');
		const junk = await raw(
			'POST',
			`/groups/${id}/image`,
			form(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'x.png', 'image/png')
		);
		expect(junk.status).toBe(400);
		expect(fakeFileRows.size).toBe(before);
		expect((await groupRow(id)).image_path).toBeNull();
	});
});

describe('Job members.reprocess-group-images', () => {
	it('bereinigt vorhandene Bilder, entfernt fehlende Verweise und ist idempotent', async () => {
		const sys = core.auth.systemContext('test');
		const legacy = await insertGroup('Dohlen', 'dohlen');
		const legacyPath = `groups/${legacy}/image-${crypto.randomUUID()}-foto.jpg`;
		await core.storage.upload(sys, {
			module: 'members',
			path: legacyPath,
			file: await gpsJpeg(),
			contentType: 'image/jpeg'
		});
		const missing = await insertGroup('Kraniche', 'kraniche');
		await core.database.forModule('members').transaction(async (tx) => {
			await tx.execute(sql`UPDATE groups SET image_path = ${legacyPath} WHERE id = ${legacy}`);
			await tx.execute(
				sql`UPDATE groups SET image_path = 'groups/x/image-fehlt.png' WHERE id = ${missing}`
			);
		});

		const info = await runJobNow(admin, 'members.reprocess-group-images');
		expect(info.lastStatus).toBe('ok');
		expect(info.lastMessage).toContain('1 Gruppenbild(er) bereinigt');
		expect(info.lastMessage).toContain('1 fehlende Datei(en) entfernt');

		const now = (await groupRow(legacy)).image_path!;
		expect(isProcessedGroupImagePath(now)).toBe(true);
		expect([...fakeFileRows.values()].some((r) => r.path === legacyPath)).toBe(false);
		const res = await raw('GET', '/website/groups/dohlen/image');
		expect(res.status).toBe(200);
		expect(await hasMetadata(new Uint8Array(await res.arrayBuffer()))).toBe(false);
		expect((await groupRow(missing)).image_path).toBeNull();

		const again = await runJobNow(admin, 'members.reprocess-group-images');
		expect(again.lastMessage).toBe('Alle Gruppenbilder sind bereinigt');
		expect((await groupRow(legacy)).image_path).toBe(now);
	});
});
