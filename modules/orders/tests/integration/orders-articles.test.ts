/**
 * Modul `orders` – Artikel und Bilder: CRUD, Validierung, Preisspanne, Katalog vs. Verwaltung,
 * Varianten ersetzen inkl. Archivierung bestellter Größen, Löschen/Archivieren, Reihenfolge,
 * Bilder (Upload mit Fake-Storage, Abruf, Löschen, Sortieren), Audit, Modul aus → 404.
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
import membersModule from '$modules/members/module';
import ordersModule from '$modules/orders/module';
import type { Article, ArticleImage, ArticleInput } from '$modules/orders/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/orders';
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

function paths(res: Res): string[] {
	const details = res.body.error?.details;
	if (!Array.isArray(details)) return [];
	return details.map((d: { path?: (string | number)[] }) => (d.path ?? []).join('.'));
}

const articleBody = (over: Partial<ArticleInput> = {}): ArticleInput => ({
	title: 'Halstuch',
	description: 'Blau mit Stammeswappen',
	notes: 'Lieferant: Musterfirma',
	reorderUrl: 'https://shop.example.org/halstuch',
	active: true,
	variants: [{ label: '', priceCents: 1250 }],
	...over
});

const create = async (over: Partial<ArticleInput> = {}) =>
	ok<Article>(await call('manager', 'POST', '/articles', articleBody(over)), 201);

const odb = () => core.database.forModule('orders');

/** Bestellung mit einer Position der Variante direkt anlegen (simuliert Team-C-Bestellung) */
async function insertOrderItem(variantId: string, priceCents = 1250) {
	await odb().transaction(async (tx) => {
		const orderId = crypto.randomUUID();
		const seq = Math.floor(Math.random() * 1_000_000);
		await tx.execute(
			sql`INSERT INTO orders (id, number, year, seq, member_id, member_name)
				VALUES (${orderId}, ${`B-2026-${seq}`}, 2026, ${seq}, 'm-1', 'Mia Muster')`
		);
		await tx.execute(
			sql`INSERT INTO order_items (id, order_id, variant_id, article_title, variant_label,
					unit_price_cents, quantity)
				VALUES (${crypto.randomUUID()}, ${orderId}, ${variantId}, 'Halstuch', 'M', ${priceCents}, 2)`
		);
	});
}

async function orderItemPrices(variantId: string): Promise<number[]> {
	return odb().transaction(async (tx) => {
		const res = (await tx.execute(
			sql`SELECT unit_price_cents FROM order_items WHERE variant_id = ${variantId}`
		)) as unknown as { rows: { unit_price_cents: number }[] };
		return res.rows.map((r) => Number(r.unit_price_cents));
	});
}

async function plainJpeg(width = 640, height = 480, color = '#22aa55'): Promise<Uint8Array> {
	const buf = await sharp({ create: { width, height, channels: 3, background: color } })
		.jpeg()
		.withExif({ IFD0: { Make: 'TestCam', Copyright: 'Geheim' } })
		.toBuffer();
	return new Uint8Array(buf);
}

function form(bytes: Uint8Array | string, name = 'bild.jpg', type = 'image/jpeg') {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type }));
	return fd;
}

async function upload(articleId: string, fd: FormData, who = 'manager') {
	const res = await raw(who, 'POST', `/articles/${articleId}/images`, fd);
	return { status: res.status, body: await res.json() } as Res<ArticleImage>;
}

function filesOf(articleId: string): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const row of fakeFileRows.values()) {
		if (row.moduleId !== 'orders' || !row.path.startsWith(`${articleId}/`)) continue;
		const obj = fakeObjects.get(row.objectKey);
		if (obj) out.set(row.path, obj.body);
	}
	return out;
}

const ROLES: Record<string, string[]> = {
	manager: ['orders.order.view', 'orders.article.manage', 'core.api.manage'],
	stock: ['orders.order.view', 'orders.stock.manage', 'core.api.manage'],
	member: ['orders.order.view', 'orders.order.create', 'core.api.manage'],
	outsider: ['members.member.view', 'core.api.manage']
};

let jpeg: Uint8Array;

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(ordersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'orders');
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
	jpeg = await plainJpeg();
});

describe('Artikel anlegen und lesen', () => {
	it('legt einen Artikel ohne Größen an', async () => {
		const a = await create();
		expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(a.title).toBe('Halstuch');
		expect(a.notes).toBe('Lieferant: Musterfirma');
		expect(a.reorderUrl).toBe('https://shop.example.org/halstuch');
		expect(a.active).toBe(true);
		expect(a.archived).toBe(false);
		expect(a.hasSizes).toBe(false);
		expect(a.variants).toHaveLength(1);
		expect(a.variants[0]!.label).toBe('');
		expect(a.variants[0]!.stock).toBe(0);
		expect(a.variants[0]!.minStock).toBe(0);
		expect(a.priceMinCents).toBe(1250);
		expect(a.priceMaxCents).toBe(1250);
		expect(a.images).toEqual([]);
		expect(a.cover).toBeNull();
	});

	it('Größen: Preisspanne, Reihenfolge, hasSizes', async () => {
		const a = await create({
			title: 'Kluft',
			variants: [
				{ label: 'S', priceCents: 3000 },
				{ label: 'M', priceCents: 3200, minStock: 2 },
				{ label: 'XL', priceCents: 3800, reorderUrl: 'https://shop.example.org/xl' }
			]
		});
		expect(a.hasSizes).toBe(true);
		expect(a.variants.map((v) => v.label)).toEqual(['S', 'M', 'XL']);
		expect(a.variants.map((v) => v.position)).toEqual([0, 1, 2]);
		expect(a.priceMinCents).toBe(3000);
		expect(a.priceMaxCents).toBe(3800);
		expect(a.variants[1]!.minStock).toBe(2);
		expect(a.variants[2]!.reorderUrl).toBe('https://shop.example.org/xl');
	});

	it('eine einzelne Variante mit Bezeichnung gilt als Größe', async () => {
		const a = await create({
			title: 'Aufnäher',
			variants: [{ label: 'Einheitsgröße', priceCents: 300 }]
		});
		expect(a.hasSizes).toBe(true);
	});

	it('neue Artikel kommen ans Ende', async () => {
		const list = ok<Article[]>(await call('manager', 'GET', '/articles?scope=all'));
		const positions = list.map((a) => a.position);
		expect(positions).toEqual([...positions].sort((x, y) => x - y));
		expect(list.at(-1)!.title).toBe('Aufnäher');
	});

	it('Validierung → 422', async () => {
		let res = await call('manager', 'POST', '/articles', articleBody({ title: '  ' }));
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('title');

		res = await call(
			'manager',
			'POST',
			'/articles',
			articleBody({
				variants: [
					{ label: 'M', priceCents: 100 },
					{ label: 'm', priceCents: 100 }
				]
			})
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('variants.1.label');

		res = await call(
			'manager',
			'POST',
			'/articles',
			articleBody({
				variants: [
					{ label: 'M', priceCents: 100 },
					{ label: '', priceCents: 100 }
				]
			})
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('variants.1.label');

		res = await call(
			'manager',
			'POST',
			'/articles',
			articleBody({ reorderUrl: 'javascript:alert(1)' })
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('reorderUrl');

		res = await call(
			'manager',
			'POST',
			'/articles',
			articleBody({ variants: [{ label: '', priceCents: 100, reorderUrl: 'ftp://x' }] })
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('variants.0.reorderUrl');

		res = await call(
			'manager',
			'POST',
			'/articles',
			articleBody({ variants: [{ label: '', priceCents: -1 }] })
		);
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('variants.0.priceCents');

		res = await call(
			'manager',
			'POST',
			'/articles',
			articleBody({ variants: [{ label: '', priceCents: 12.5 }] })
		);
		fail(res, 422, 'validation_failed');

		res = await call('manager', 'POST', '/articles', articleBody({ variants: [] }));
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toContain('variants');
	});

	it('Rechte: Anlegen nur mit Artikelrecht, ohne Grundrecht 403', async () => {
		fail(await call('member', 'POST', '/articles', articleBody()), 403, 'forbidden');
		fail(await call('stock', 'POST', '/articles', articleBody()), 403, 'forbidden');
		fail(await call('outsider', 'GET', '/articles'), 403, 'forbidden');
	});
});

describe('Katalog und Verwaltung', () => {
	let inactiveId: string;
	let activeId: string;

	beforeAll(async () => {
		inactiveId = (await create({ title: 'Ausverkauft', active: false })).id;
		activeId = (await create({ title: 'Liederbuch', notes: 'Geheime Notiz' })).id;
	});

	it('Katalog: nur aktive Artikel, Verwaltungsfelder null', async () => {
		const list = ok<Article[]>(await call('member', 'GET', '/articles'));
		expect(list.some((a) => a.id === inactiveId)).toBe(false);
		const a = list.find((x) => x.id === activeId)!;
		expect(a).toBeDefined();
		expect(a.notes).toBeNull();
		expect(a.reorderUrl).toBeNull();
		expect(a.variants[0]!.stock).toBeNull();
		expect(a.variants[0]!.minStock).toBeNull();
		expect(a.variants[0]!.reorderUrl).toBeNull();
		expect(a.priceMinCents).toBe(1250);
	});

	it('scope=all ohne Artikel-/Lagerrecht → 403', async () => {
		fail(await call('member', 'GET', '/articles?scope=all'), 403, 'forbidden');
	});

	it('scope=all mit Artikel- oder Lagerrecht inkl. inaktiver, mit Notizen', async () => {
		for (const who of ['manager', 'stock']) {
			const list = ok<Article[]>(await call(who, 'GET', '/articles?scope=all'));
			const inactive = list.find((a) => a.id === inactiveId)!;
			expect(inactive.active).toBe(false);
			expect(list.find((a) => a.id === activeId)!.notes).toBe('Geheime Notiz');
		}
	});

	it('Katalog mit Lagerrecht zeigt Verwaltungsfelder', async () => {
		const list = ok<Article[]>(await call('stock', 'GET', '/articles'));
		expect(list.some((a) => a.id === inactiveId)).toBe(false);
		expect(list.find((a) => a.id === activeId)!.notes).toBe('Geheime Notiz');
	});

	it('Einzelabruf: inaktiv ohne Recht → 404, mit Recht 200', async () => {
		fail(await call('member', 'GET', `/articles/${inactiveId}`), 404, 'not_found');
		ok(await call('manager', 'GET', `/articles/${inactiveId}`));
		const a = ok<Article>(await call('member', 'GET', `/articles/${activeId}`));
		expect(a.notes).toBeNull();
		fail(await call('member', 'GET', `/articles/${crypto.randomUUID()}`), 404, 'not_found');
		fail(await call('member', 'GET', '/articles/kein-uuid'), 422, 'validation_failed');
	});
});

describe('Bearbeiten und Varianten ersetzen', () => {
	it('PATCH ändert nur übergebene Felder (active bleibt erhalten)', async () => {
		const a = await create({ title: 'Wimpel', active: false });
		const b = ok<Article>(
			await call('manager', 'PATCH', `/articles/${a.id}`, { title: 'Wimpel neu' })
		);
		expect(b.title).toBe('Wimpel neu');
		expect(b.active).toBe(false);
		expect(b.description).toBe('Blau mit Stammeswappen');
		expect(b.notes).toBe('Lieferant: Musterfirma');
		const c = ok<Article>(
			await call('manager', 'PATCH', `/articles/${a.id}`, { active: true, notes: null })
		);
		expect(c.active).toBe(true);
		expect(c.notes).toBeNull();
		fail(
			await call('manager', 'PATCH', `/articles/${a.id}`, { title: '' }),
			422,
			'validation_failed'
		);
		fail(await call('stock', 'PATCH', `/articles/${a.id}`, { title: 'x' }), 403, 'forbidden');
		fail(
			await call('manager', 'PATCH', `/articles/${crypto.randomUUID()}`, { title: 'x' }),
			404,
			'not_found'
		);
	});

	it('vorhandene aktualisieren, neue anlegen, ungenutzte löschen, bestellte archivieren', async () => {
		const a = await create({
			title: 'T-Shirt',
			variants: [
				{ label: 'S', priceCents: 1000 },
				{ label: 'M', priceCents: 1000 },
				{ label: 'L', priceCents: 1000 }
			]
		});
		const [s, m, l] = a.variants as [
			Article['variants'][0],
			Article['variants'][0],
			Article['variants'][0]
		];
		await insertOrderItem(m.id, 1000);

		const b = ok<Article>(
			await call('manager', 'PATCH', `/articles/${a.id}`, {
				variants: [
					{ id: l.id, label: 'L', priceCents: 1500, minStock: 3 },
					{ label: 'XL', priceCents: 1800 }
				]
			})
		);
		const active = b.variants.filter((v) => !v.archived);
		expect(active.map((v) => v.label)).toEqual(['L', 'XL']);
		expect(active[0]!.id).toBe(l.id);
		expect(active[0]!.priceCents).toBe(1500);
		expect(active[0]!.minStock).toBe(3);
		// S war unbenutzt → gelöscht; M ist bestellt → archiviert
		expect(b.variants.some((v) => v.id === s.id)).toBe(false);
		const archived = b.variants.find((v) => v.id === m.id)!;
		expect(archived.archived).toBe(true);
		expect(b.priceMinCents).toBe(1500);
		expect(b.priceMaxCents).toBe(1800);

		// Katalog zeigt archivierte Größen nicht
		const cat = ok<Article>(await call('member', 'GET', `/articles/${a.id}`));
		expect(cat.variants.map((v) => v.label)).toEqual(['L', 'XL']);

		// Bestellung behält ihren Preis
		expect(await orderItemPrices(m.id)).toEqual([1000]);

		// Preisänderung einer bestellten Variante ändert die Bestellung nicht
		await insertOrderItem(l.id, 1500);
		ok(
			await call('manager', 'PATCH', `/articles/${a.id}`, {
				variants: [
					{ id: l.id, label: 'L', priceCents: 2500 },
					{ id: active[1]!.id, label: 'XL', priceCents: 1800 }
				]
			})
		);
		expect(await orderItemPrices(l.id)).toEqual([1500]);

		// archivierte Variante wieder aufnehmen → aktiv
		const c = ok<Article>(
			await call('manager', 'PATCH', `/articles/${a.id}`, {
				variants: [
					{ id: l.id, label: 'L', priceCents: 2500 },
					{ id: m.id, label: 'M', priceCents: 1100 }
				]
			})
		);
		expect(c.variants.find((v) => v.id === m.id)!.archived).toBe(false);
	});

	it('unbekannte oder doppelte Varianten-ID → 422 variants.<i>.id', async () => {
		const a = await create({ title: 'Becher' });
		const other = await create({ title: 'Teller' });
		let res = await call('manager', 'PATCH', `/articles/${a.id}`, {
			variants: [
				{ id: a.variants[0]!.id, label: 'A', priceCents: 1 },
				{ id: other.variants[0]!.id, label: 'B', priceCents: 1 }
			]
		});
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toEqual(['variants.1.id']);
		res = await call('manager', 'PATCH', `/articles/${a.id}`, {
			variants: [
				{ id: a.variants[0]!.id, label: 'A', priceCents: 1 },
				{ id: a.variants[0]!.id, label: 'B', priceCents: 1 }
			]
		});
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toEqual(['variants.1.id']);
		// unverändert
		const still = ok<Article>(await call('manager', 'GET', `/articles/${a.id}`));
		expect(still.variants).toHaveLength(1);
		expect(still.variants[0]!.label).toBe('');
	});
});

describe('Löschen und Archivieren', () => {
	it('unbenutzter Artikel wird gelöscht', async () => {
		const a = await create({ title: 'Löschmich' });
		expect(ok(await call('manager', 'DELETE', `/articles/${a.id}`))).toEqual({ deleted: true });
		fail(await call('manager', 'GET', `/articles/${a.id}`), 404, 'not_found');
	});

	it('bestellter Artikel wird archiviert und deaktiviert', async () => {
		const a = await create({ title: 'Bestellt' });
		await insertOrderItem(a.variants[0]!.id);
		expect(ok(await call('manager', 'DELETE', `/articles/${a.id}`))).toEqual({
			deleted: false,
			archived: true
		});
		const b = ok<Article>(await call('manager', 'GET', `/articles/${a.id}`));
		expect(b.archived).toBe(true);
		expect(b.active).toBe(false);
		fail(await call('member', 'GET', `/articles/${a.id}`), 404, 'not_found');
		const cat = ok<Article[]>(await call('member', 'GET', '/articles'));
		expect(cat.some((x) => x.id === a.id)).toBe(false);
	});

	it('ohne Artikelrecht 403', async () => {
		const a = await create({ title: 'Geschützt' });
		fail(await call('stock', 'DELETE', `/articles/${a.id}`), 403, 'forbidden');
	});
});

describe('Reihenfolge', () => {
	it('alle nicht archivierten IDs genau einmal', async () => {
		const list = ok<Article[]>(await call('manager', 'GET', '/articles?scope=all'));
		const ids = list.filter((a) => !a.archived).map((a) => a.id);
		const reversed = [...ids].reverse();
		const out = ok<Article[]>(await call('manager', 'PUT', '/articles/order', { ids: reversed }));
		expect(out.filter((a) => !a.archived).map((a) => a.id)).toEqual(reversed);

		let res = await call('manager', 'PUT', '/articles/order', { ids: reversed.slice(1) });
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toEqual(['ids']);
		res = await call('manager', 'PUT', '/articles/order', {
			ids: [...reversed.slice(1), reversed[1]!]
		});
		fail(res, 422, 'validation_failed');
		res = await call('manager', 'PUT', '/articles/order', {
			ids: [...reversed.slice(1), crypto.randomUUID()]
		});
		fail(res, 422, 'validation_failed');
		const archived = list.find((a) => a.archived)!;
		res = await call('manager', 'PUT', '/articles/order', { ids: [...reversed, archived.id] });
		fail(res, 422, 'validation_failed');
		fail(await call('member', 'PUT', '/articles/order', { ids: reversed }), 403, 'forbidden');
	});
});

describe('Bilder ohne Storage', () => {
	it('Upload → 503 unavailable', async () => {
		const a = await create({ title: 'Ohne Speicher' });
		fail(await upload(a.id, form(jpeg)), 503, 'unavailable');
		const b = ok<Article>(await call('manager', 'GET', `/articles/${a.id}`));
		expect(b.images).toEqual([]);
	});
});

describe('Bilder mit Storage', () => {
	let article: Article;

	beforeAll(async () => {
		await installFakeStorage(admin);
		article = await create({ title: 'Mit Bildern' });
	});
	afterAll(() => uninstallFakeStorage());

	it('Upload erzeugt thumb und web (WebP, ohne Metadaten)', async () => {
		const img = ok(await upload(article.id, form(jpeg, 'geheim.jpg')), 201);
		expect(img.width).toBe(640);
		expect(img.height).toBe(480);
		expect(img.position).toBe(0);
		expect(img.thumbUrl).toBe(
			`/api/v1/modules/orders/articles/${article.id}/images/${img.id}/thumb`
		);
		const files = filesOf(article.id);
		expect([...files.keys()].sort()).toEqual(
			[`${article.id}/${img.id}-thumb.webp`, `${article.id}/${img.id}-web.webp`].sort()
		);
		for (const bytes of files.values()) {
			const meta = await sharp(Buffer.from(bytes)).metadata();
			expect(meta.format).toBe('webp');
			expect(meta.exif).toBeUndefined();
		}
		const thumb = await sharp(
			Buffer.from(files.get(`${article.id}/${img.id}-thumb.webp`)!)
		).metadata();
		expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(480);

		const a = ok<Article>(await call('member', 'GET', `/articles/${article.id}`));
		expect(a.images).toHaveLength(1);
		expect(a.cover?.id).toBe(img.id);
	});

	it('Abruf der Varianten', async () => {
		const a = ok<Article>(await call('member', 'GET', `/articles/${article.id}`));
		const img = a.images[0]!;
		for (const variant of ['thumb', 'web']) {
			const res = await raw('member', 'GET', `/articles/${article.id}/images/${img.id}/${variant}`);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('image/webp');
			expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		}
		fail(
			await call('member', 'GET', `/articles/${article.id}/images/${img.id}/full`),
			422,
			'validation_failed'
		);
		fail(
			await call('member', 'GET', `/articles/${article.id}/images/${crypto.randomUUID()}/thumb`),
			404,
			'not_found'
		);
	});

	it('Bilder inaktiver Artikel nur mit Recht', async () => {
		const a = await create({ title: 'Versteckt mit Bild' });
		const img = ok(await upload(a.id, form(jpeg)), 201);
		ok(await call('manager', 'PATCH', `/articles/${a.id}`, { active: false }));
		fail(await call('member', 'GET', `/articles/${a.id}/images/${img.id}/thumb`), 404, 'not_found');
		const res = await raw('stock', 'GET', `/articles/${a.id}/images/${img.id}/thumb`);
		expect(res.status).toBe(200);
	});

	it('Upload-Prüfungen: Recht, Typ, leer, kaputt', async () => {
		fail(await upload(article.id, form(jpeg), 'member'), 403, 'forbidden');
		// Typ/leer → 422 (einheitlich, #33); unlesbares Bild → 400 aus core.images
		fail(
			await upload(article.id, form(jpeg, 'x.pdf', 'application/pdf')),
			422,
			'validation_failed'
		);
		fail(await upload(article.id, form(new Uint8Array(), 'leer.jpg')), 422, 'validation_failed');
		fail(await upload(article.id, form('kein bild', 'x.jpg')), 400, 'bad_request');
		fail(await upload(crypto.randomUUID(), form(jpeg)), 404, 'not_found');
	});

	it('Reihenfolge der Bilder, Titelbild = erstes', async () => {
		const second = ok(await upload(article.id, form(await plainJpeg(200, 100, '#cc3333'))), 201);
		expect(second.position).toBe(1);
		const before = ok<Article>(await call('manager', 'GET', `/articles/${article.id}`));
		const ids = before.images.map((i) => i.id);
		const reversed = [...ids].reverse();
		const out = ok<ArticleImage[]>(
			await call('manager', 'PUT', `/articles/${article.id}/images/order`, { ids: reversed })
		);
		expect(out.map((i) => i.id)).toEqual(reversed);
		const after = ok<Article>(await call('manager', 'GET', `/articles/${article.id}`));
		expect(after.cover?.id).toBe(second.id);

		let res = await call('manager', 'PUT', `/articles/${article.id}/images/order`, {
			ids: reversed.slice(1)
		});
		fail(res, 422, 'validation_failed');
		expect(paths(res)).toEqual(['ids']);
		res = await call('manager', 'PUT', `/articles/${article.id}/images/order`, {
			ids: [reversed[0]!, reversed[0]!]
		});
		fail(res, 422, 'validation_failed');
	});

	it('Bild löschen entfernt Dateien', async () => {
		const a = ok<Article>(await call('manager', 'GET', `/articles/${article.id}`));
		const img = a.images[0]!;
		ok(await call('manager', 'DELETE', `/articles/${article.id}/images/${img.id}`));
		expect([...filesOf(article.id).keys()].some((p) => p.includes(img.id))).toBe(false);
		fail(
			await call('manager', 'DELETE', `/articles/${article.id}/images/${img.id}`),
			404,
			'not_found'
		);
		fail(
			await call('stock', 'DELETE', `/articles/${article.id}/images/${a.images[1]!.id}`),
			403,
			'forbidden'
		);
	});

	it('Höchstzahl je Artikel → 409', async () => {
		const a = await create({ title: 'Voll' });
		// direkt auffüllen, damit der Test schnell bleibt
		await odb().transaction(async (tx) => {
			for (let i = 0; i < 20; i++) {
				await tx.execute(
					sql`INSERT INTO article_images (id, article_id, position, width, height, thumb_path, web_path)
						VALUES (${crypto.randomUUID()}, ${a.id}, ${i}, 1, 1, 'x', 'y')`
				);
			}
		});
		fail(await upload(a.id, form(jpeg)), 409, 'conflict');
	});

	it('Löschen eines unbenutzten Artikels entfernt seine Bilddateien', async () => {
		const a = await create({ title: 'Weg mit Bild' });
		ok(await upload(a.id, form(jpeg)), 201);
		expect(filesOf(a.id).size).toBe(2);
		expect(ok(await call('manager', 'DELETE', `/articles/${a.id}`))).toEqual({ deleted: true });
		expect(filesOf(a.id).size).toBe(0);
	});
});

describe('Audit', () => {
	it('Einträge vorhanden, ohne personenbezogene Daten', async () => {
		const { rows } = await listAudit({ action: 'orders.article.', limit: 500 });
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'orders.article.created',
			'orders.article.updated',
			'orders.article.deleted',
			'orders.article.archived',
			'orders.article.reordered',
			'orders.article.image-uploaded',
			'orders.article.image-deleted'
		]) {
			expect(actions.has(a), a).toBe(true);
		}
		const meta = JSON.stringify(rows.map((r) => r.metadata));
		expect(meta).not.toContain('@example.test');
		expect(meta).not.toContain('Mia Muster');
		expect(meta).not.toContain('Geheime Notiz');
		expect(meta).not.toContain('geheim.jpg');
	});
});

describe('Modul deaktiviert', () => {
	it('→ 404 module_disabled', async () => {
		await disableModule(admin, 'orders');
		fail(await call('manager', 'GET', '/articles'), 404, 'module_disabled');
		fail(await call('manager', 'POST', '/articles', articleBody()), 404, 'module_disabled');
		await enableModule(admin, 'orders');
	});
});
