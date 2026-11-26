import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import materialModule from '$modules/material/module';
import { setOffFetchForTests } from '$modules/material/off.service';
import type {
	BarcodeResult,
	Catalog,
	CodeTarget,
	FoodProduct,
	ImageRef,
	Item,
	ItemDetail,
	MaterialType,
	ProductDetail,
	Reservation
} from '$modules/material/schemas';
import officesModule from '$modules/offices/module';
import type { Office } from '$modules/offices/schemas';
import { resetTemplateCacheForTests } from '$modules/offices/templates.service';
import {
	bootstrapAdmin,
	contextForUser,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	fakeFileRows,
	getDb,
	handleApiRequest,
	installFakeStorage,
	listAudit,
	registerCoreApi,
	registerModule,
	resetAllForTests,
	runJobNow,
	schema,
	setMailTransportForTests,
	syncModules,
	uninstallFakeStorage,
	useTestDatabase
} from '$testing';

// Material v2.2: Verbrauchsmaterial (Ausgabe → Rücknahme mit Verbrauch) und Vorrat (Lebensmittel mit Strichcode,
// Chargen mit MHD, Einlagern/Entnehmen nach „zuerst ablaufend“, Vorschlag aus Open Food Facts, Ablauf-Hinweis).

const PW = 'material-password-123';
const ADMIN_MAIL = 'admin@example.test';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const sent: { to: string; subject: string; text: string }[] = [];
let offCalls: string[] = [];
let jpeg: Buffer;
const OFF_IMAGE = 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.jpg';
/** OFF kennt das Produkt, Bild liegt aber auf einem fremden Host → wird nicht geladen */
const EVIL = '4000000000013';
/** OFF kennt das Produkt ohne Bild */
const NO_IMAGE = '4000000000020';
/** OFF liefert ein zu großes „Bild“ */
const HUGE = '4000000000037';
const NUDELN_CODE = '4006381333931';

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	resetAllForTests();
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
const M = (path: string, who: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/material${path}`, { token: keys[who], ...init });
const get = (path: string, who: string) => M(path, who);
const post = (path: string, who: string, json: unknown = {}) =>
	M(path, who, { method: 'POST', json });
const patch = (path: string, who: string, json: unknown) => M(path, who, { method: 'PATCH', json });
const del = (path: string, who: string) => M(path, who, { method: 'DELETE' });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function fail(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error as { code: string; message: string; details?: unknown };
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	const id = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	const ctx = await ctxOf(id);
	keys[name] = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
}

const itemQty = async (id: string) =>
	(await data<ItemDetail>(await get(`/items/${id}`, 'admin'))).quantity;

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			sent.push({ to: m.to, subject: m.subject, text: m.text });
		}
	});
	jpeg = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#c33' } })
		.jpeg()
		.toBuffer();
	const product = (p: Record<string, unknown>) =>
		new Response(JSON.stringify({ status: 1, product: p }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	setOffFetchForTests(async (input) => {
		const url = String(input);
		offCalls.push(url);
		if (url === OFF_IMAGE) {
			return new Response(new Uint8Array(jpeg), {
				status: 200,
				headers: { 'content-type': 'image/jpeg' }
			});
		}
		if (url === 'https://images.openfoodfacts.org/huge.jpg') {
			return new Response(new Uint8Array(16 * 1024 * 1024), {
				status: 200,
				headers: { 'content-type': 'image/jpeg' }
			});
		}
		if (url.includes(NUDELN_CODE)) {
			return product({
				product_name_de: 'Spaghetti No. 5',
				brands: 'Nudelwerk, Andere',
				quantity: '500 g',
				image_front_url: OFF_IMAGE
			});
		}
		if (url.includes(EVIL)) {
			return product({ product_name: 'Böse', image_front_url: 'https://evil.example/x.jpg' });
		}
		if (url.includes(NO_IMAGE)) return product({ product_name: 'Ohne Bild' });
		if (url.includes(HUGE)) {
			return product({
				product_name: 'Riesig',
				image_front_url: 'https://images.openfoodfacts.org/huge.jpg'
			});
		}
		return new Response(JSON.stringify({ status: 0 }), { status: 200 });
	});
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(materialModule);
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin(ADMIN_MAIL, 'correct-horse-battery');
	const [u] = await getDb().select().from(schema.user).where(eq(schema.user.email, ADMIN_MAIL));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'material');
	await enableModule(admin, 'offices');
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	await mkUser('leitung', [
		'core.api.manage',
		'material.inventory.view',
		'material.reservation.create'
	]);
	await mkUser('koch', ['core.api.manage', 'material.inventory.view', 'material.pantry.manage']);
	setTodayForTests('2026-06-01');

	resetTemplateCacheForTests();
	const offices = await data<Office[]>(
		await api('/modules/offices/offices', { token: keys.admin })
	);
	const mw = offices.find(
		(o) => o.source?.module === 'material' && o.source.key === 'materialwart'
	);
	expect(mw, JSON.stringify(offices)).toBeTruthy();
	await data(
		await api(`/modules/offices/offices/${mw!.id}/holders`, {
			token: keys.admin,
			method: 'PUT',
			json: { holders: [{ userId: u!.id }] }
		})
	);
});

afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	setOffFetchForTests(undefined);
	uninstallFakeStorage();
	await close();
});

describe('Verbrauchsmaterial', () => {
	let fackeln: MaterialType;
	let kiste: Item;
	let petroleum: Item;
	let res: Reservation;

	it('Typ und Artikel als Verbrauchsmaterial mit Einheit', async () => {
		fackeln = await data<MaterialType>(
			await post('/types', 'admin', { name: 'Fackel', consumable: true }),
			201
		);
		expect(fackeln).toMatchObject({ consumable: true, unit: '' });
		kiste = (
			await data<Item[]>(
				await post('/items', 'admin', { typeId: fackeln.id, name: 'Fackelkiste', quantity: 30 }),
				201
			)
		)[0]!;
		expect(kiste).toMatchObject({ consumable: true, quantity: 30 });
		petroleum = (
			await data<Item[]>(
				await post('/items', 'admin', {
					name: 'Petroleum',
					quantity: 20,
					consumable: true,
					unit: 'l'
				}),
				201
			)
		)[0]!;
		expect(petroleum).toMatchObject({ consumable: true, unit: 'l' });
		// 0 nur bei Verbrauchsmaterial
		await fail(await post('/items', 'admin', { name: 'Hammer', quantity: 0 }), 422);
		const leer = await data<Item[]>(
			await post('/items', 'admin', { name: 'Gas', quantity: 0, consumable: true }),
			201
		);
		expect(leer[0]!.quantity).toBe(0);
		// Einheit am Typ zieht auf die Artikel durch
		await data(await patch(`/types/${fackeln.id}`, 'admin', { unit: 'Stück' }));
		expect(await data<ItemDetail>(await get(`/items/${kiste.id}`, 'admin'))).toMatchObject({
			unit: 'Stück',
			consumable: true
		});
		const catalog = await data<Catalog>(
			await get('/catalog?from=2026-07-01&to=2026-07-03', 'leitung')
		);
		expect(catalog.entries.find((e) => e.id === petroleum.id)).toMatchObject({
			consumable: true,
			unit: 'l',
			free: 20
		});
	});

	it('reservieren, ausgeben, zurücknehmen mit Verbrauch → Bestand sinkt', async () => {
		res = await data<Reservation>(
			await post('/reservations', 'leitung', {
				title: 'Fackelwanderung',
				startsOn: '2026-07-01',
				endsOn: '2026-07-03',
				lines: [
					{ kind: 'type', typeId: fackeln.id, quantity: 20 },
					{ kind: 'item', itemId: petroleum.id, quantity: 5 }
				]
			}),
			201
		);
		expect(res.consumables.map((c) => [c.name, c.issued, c.consumed])).toEqual([
			['Fackelkiste', 20, null],
			['Petroleum', 5, null]
		]);
		await fail(await post(`/reservations/${res.id}/return`, 'admin', { consumed: [] }), 409);
		await fail(await post(`/reservations/${res.id}/return`, 'leitung', { consumed: [] }), 403);
		res = await data<Reservation>(await post(`/reservations/${res.id}/hand-out`, 'admin'), 201);

		// Nach dem Ende, ohne Rücknahme: Verbrauchsmaterial bleibt belegt
		setTodayForTests('2026-07-10');
		const later = await data<Catalog>(
			await get('/catalog?from=2026-07-20&to=2026-07-21', 'leitung')
		);
		expect(later.entries.find((e) => e.id === petroleum.id)!.free).toBe(15);
		expect(later.entries.find((e) => e.id === fackeln.id)!.free).toBe(10);

		await fail(
			await post(`/reservations/${res.id}/return`, 'admin', {
				consumed: [{ itemId: petroleum.id, quantity: 6 }]
			}),
			422
		);
		await fail(
			await post(`/reservations/${res.id}/return`, 'admin', {
				consumed: [{ itemId: crypto.randomUUID(), quantity: 1 }]
			}),
			422
		);
		res = await data<Reservation>(
			await post(`/reservations/${res.id}/return`, 'admin', {
				consumed: [
					{ itemId: kiste.id, quantity: 12 },
					{ itemId: petroleum.id, quantity: 3 }
				]
			}),
			201
		);
		expect(res.returnedAt).not.toBeNull();
		expect(res.returnedByName).toBeTruthy();
		expect(res.consumables.map((c) => [c.name, c.consumed])).toEqual([
			['Fackelkiste', 12],
			['Petroleum', 3]
		]);
		expect(await itemQty(kiste.id)).toBe(18);
		expect(await itemQty(petroleum.id)).toBe(17);
		const after = await data<Catalog>(
			await get('/catalog?from=2026-07-20&to=2026-07-21', 'leitung')
		);
		expect(after.entries.find((e) => e.id === petroleum.id)!.free).toBe(17);
		const detail = await data<ItemDetail>(await get(`/items/${petroleum.id}`, 'admin'));
		expect(detail.consumptions).toMatchObject([
			{ reservationTitle: 'Fackelwanderung', quantity: 3 }
		]);

		await fail(await post(`/reservations/${res.id}/return`, 'admin', { consumed: [] }), 409);
		await fail(await del(`/reservations/${res.id}/hand-out`, 'admin'), 409);
		const audit = await listAudit({ action: 'material.reservation.returned' });
		expect(audit.rows.map((a) => a.target)).toContain(res.id);
	});

	it('Rücknahme aufheben schreibt den Verbrauch wieder gut', async () => {
		res = await data<Reservation>(await del(`/reservations/${res.id}/return`, 'admin'));
		expect(res.returnedAt).toBeNull();
		expect(await itemQty(kiste.id)).toBe(30);
		expect(await itemQty(petroleum.id)).toBe(20);
		// erneut zurücknehmen ohne Verbrauch
		res = await data<Reservation>(await post(`/reservations/${res.id}/return`, 'admin', {}), 201);
		expect(res.consumables.every((c) => c.consumed === 0)).toBe(true);
		expect(await itemQty(petroleum.id)).toBe(20);
		setTodayForTests('2026-06-01');
	});
});

describe('Vorrat', () => {
	const NUDELN = NUDELN_CODE;
	let nudeln: FoodProduct;

	it('unbekannter Strichcode: Vorschlag aus Open Food Facts nur mit Vorratsrecht', async () => {
		await fail(await get('/pantry/barcode/12345', 'koch'), 422);
		offCalls = [];
		const viewOnly = await data<BarcodeResult>(await get(`/pantry/barcode/${NUDELN}`, 'leitung'));
		expect(viewOnly).toMatchObject({ barcode: NUDELN, product: null, suggestion: null });
		expect(offCalls).toHaveLength(0);
		const r = await data<BarcodeResult>(await get(`/pantry/barcode/${NUDELN}`, 'koch'));
		expect(r.suggestion).toEqual({
			found: true,
			name: 'Spaghetti No. 5',
			brand: 'Nudelwerk',
			packageSize: '500 g',
			hasImage: true
		});
		// Die Bild-URL selbst geht nie an den Client
		expect(JSON.stringify(r)).not.toContain('openfoodfacts');
		expect(offCalls).toHaveLength(1);
		// Zwischenspeicher: kein zweiter Abruf
		await data(await get(`/pantry/barcode/${NUDELN}`, 'koch'));
		expect(offCalls).toHaveLength(1);
		// UPC-A (12 Stellen) wird zu EAN-13
		const upc = await data<BarcodeResult>(await get('/pantry/barcode/036000291452', 'koch'));
		expect(upc).toMatchObject({ barcode: '0036000291452', suggestion: { found: false } });
	});

	it('Produkte anlegen, Strichcode eindeutig, Rechte', async () => {
		await fail(await post('/pantry/products', 'leitung', { name: 'X' }), 403);
		await fail(
			await post('/pantry/products', 'koch', { name: 'X', barcode: '4006381333932' }),
			422
		);
		nudeln = await data<FoodProduct>(
			await post('/pantry/products', 'koch', {
				name: 'Spaghetti',
				brand: 'Nudelwerk',
				barcode: NUDELN,
				unit: 'Packung',
				packageSize: '500 g'
			}),
			201
		);
		expect(nudeln).toMatchObject({ barcode: NUDELN, quantity: 0, state: 'none' });
		await fail(await post('/pantry/products', 'koch', { name: 'Doppelt', barcode: NUDELN }), 409);
		const hit = await data<BarcodeResult>(await get(`/pantry/barcode/${NUDELN}`, 'leitung'));
		expect(hit.product?.id).toBe(nudeln.id);
		const code = await data<CodeTarget>(await get(`/codes/${NUDELN}`, 'leitung'));
		expect(code).toEqual({ type: 'food', id: nudeln.id, code: NUDELN, name: 'Spaghetti' });
		nudeln = await data<FoodProduct>(
			await patch(`/pantry/products/${nudeln.id}`, 'koch', { notes: 'Regal oben' })
		);
		expect(nudeln.notes).toBe('Regal oben');
	});

	it('einlagern in Chargen, entnehmen nach „zuerst ablaufend“', async () => {
		const ci = (quantity: number, bestBefore: string | null) =>
			post(`/pantry/products/${nudeln.id}/check-in`, 'koch', { quantity, bestBefore });
		await data(await ci(4, '2026-12-01'), 201);
		await data(await ci(3, '2026-06-10'), 201);
		nudeln = await data<FoodProduct>(await ci(2, '2026-06-10'), 201);
		expect(nudeln.quantity).toBe(9);
		expect(nudeln.batches.map((b) => [b.bestBefore, b.quantity, b.state])).toEqual([
			['2026-06-10', 5, 'soon'],
			['2026-12-01', 4, 'ok']
		]);
		expect(nudeln).toMatchObject({ nextBestBefore: '2026-06-10', state: 'soon' });

		await fail(
			await post(`/pantry/products/${nudeln.id}/check-out`, 'koch', { quantity: 10 }),
			409
		);
		await fail(
			await post(`/pantry/products/${nudeln.id}/check-out`, 'leitung', { quantity: 1 }),
			403
		);
		nudeln = await data<FoodProduct>(
			await post(`/pantry/products/${nudeln.id}/check-out`, 'koch', {
				quantity: 6,
				note: 'Gruppenstunde'
			}),
			201
		);
		expect(nudeln.batches.map((b) => [b.bestBefore, b.quantity])).toEqual([['2026-12-01', 3]]);

		const batch = nudeln.batches[0]!;
		nudeln = await data<FoodProduct>(
			await patch(`/pantry/products/${nudeln.id}/batches/${batch.id}`, 'koch', {
				quantity: 2,
				bestBefore: '2026-11-30'
			})
		);
		expect(nudeln.batches.map((b) => [b.bestBefore, b.quantity])).toEqual([['2026-11-30', 2]]);

		const detail = await data<ProductDetail>(await get(`/pantry/products/${nudeln.id}`, 'leitung'));
		expect(detail.movements.map((m) => [m.kind, m.quantity])).toEqual([
			['correct', 1],
			['out', 1],
			['out', 5],
			['in', 2],
			['in', 3],
			['in', 4]
		]);
		expect(detail.movements[0]!.note).toContain('Anzahl 3 → 2');
	});

	it('Liste filtert nach Bestand und Ablauf, Suche über den Strichcode', async () => {
		const milch = await data<FoodProduct>(
			await post('/pantry/products', 'koch', { name: 'H-Milch', unit: 'Packung' }),
			201
		);
		await data(
			await post(`/pantry/products/${milch.id}/check-in`, 'koch', {
				quantity: 6,
				bestBefore: '2026-05-20'
			}),
			201
		);
		const names = async (q: string) =>
			(await data<FoodProduct[]>(await get(`/pantry${q}`, 'leitung'))).map((p) => p.name);
		expect(await names('')).toEqual(['H-Milch', 'Spaghetti']);
		expect(await names('?filter=expired')).toEqual(['H-Milch']);
		expect(await names('?filter=soon')).toEqual(['H-Milch']);
		expect(await names(`?search=${NUDELN}`)).toEqual(['Spaghetti']);
		// Entsorgen
		const after = await data<FoodProduct>(
			await post(`/pantry/products/${milch.id}/check-out`, 'koch', {
				quantity: 6,
				kind: 'discard'
			}),
			201
		);
		expect(after.quantity).toBe(0);
		await data(await del(`/pantry/products/${milch.id}`, 'koch'));
		await fail(await del(`/pantry/products/${nudeln.id}`, 'koch'), 409);
	});

	it('Ablauf-Hinweis geht einmal an das Amt', async () => {
		const bohnen = await data<FoodProduct>(
			await post('/pantry/products', 'koch', { name: 'Bohnen', brand: 'Dose & Co', unit: 'Dose' }),
			201
		);
		await data(
			await post(`/pantry/products/${bohnen.id}/check-in`, 'koch', {
				quantity: 3,
				bestBefore: '2026-06-05'
			}),
			201
		);
		sent.length = 0;
		const job = await runJobNow(admin, 'material.pantry-expiry');
		expect(job.lastStatus).toBe('ok');
		const mails = sent.filter((m) => m.to === ADMIN_MAIL);
		expect(mails).toHaveLength(1);
		expect(`${mails[0]!.subject}\n${mails[0]!.text}`).toContain(
			'Bohnen (Dose & Co): 3 Dose, MHD 05.06.2026'
		);
		const [n] = (
			await moduleDb('material').transaction((tx) =>
				tx.execute(
					sql`SELECT count(*)::int AS n FROM food_batches WHERE expiry_notified_at IS NOT NULL`
				)
			)
		).rows as { n: number }[];
		expect(n!.n).toBe(1);
		sent.length = 0;
		await runJobNow(admin, 'material.pantry-expiry');
		expect(sent.filter((m) => m.to === ADMIN_MAIL)).toHaveLength(0);
	});
});

describe('Vorrat: Bilder', () => {
	let p: FoodProduct;
	const upload = (id: string, who: string) => {
		const form = new FormData();
		form.append('file', new File([new Uint8Array(jpeg)], 'foto.jpg', { type: 'image/jpeg' }));
		return M(`/pantry/products/${id}/images`, who, { method: 'POST', body: form });
	};
	const imageRows = async (id: string) =>
		(
			await moduleDb('material').transaction((tx) =>
				tx.execute(sql`SELECT source, thumb_path, web_path FROM images WHERE product_id = ${id}`)
			)
		).rows as { source: string; thumb_path: string; web_path: string }[];

	it('eigene Bilder hochladen, sortieren, löschen; Rechte', async () => {
		p = await data<FoodProduct>(
			await post('/pantry/products', 'koch', { name: 'Haferflocken' }),
			201
		);
		expect(p.images).toEqual([]);
		await fail(await upload(p.id, 'leitung'), 403);
		const a = await data<ImageRef>(await upload(p.id, 'koch'), 201);
		const b = await data<ImageRef>(await upload(p.id, 'koch'), 201);
		expect(a).toMatchObject({ source: 'upload', width: 120, height: 90 });
		expect(a.thumbUrl).toBe(
			`/api/v1/modules/material/pantry/products/${p.id}/images/${a.id}/thumb`
		);
		// Abrufen mit Leserecht
		const img = await get(a.thumbUrl.replace('/api/v1/modules/material', ''), 'leitung');
		expect(img.status).toBe(200);
		expect(img.headers.get('content-type')).toBe('image/webp');
		const reorder = (who: string) =>
			M(`/pantry/products/${p.id}/images/order`, who, {
				method: 'PUT',
				json: { ids: [b.id, a.id] }
			});
		await fail(await reorder('leitung'), 403);
		const order = await data<ImageRef[]>(await reorder('koch'));
		expect(order.map((i) => i.id)).toEqual([b.id, a.id]);
		const [listed] = await data<FoodProduct[]>(await get('/pantry?search=Haferflocken', 'leitung'));
		expect(listed!.images.map((i) => i.id)).toEqual([b.id, a.id]);
		await data(await del(`/pantry/products/${p.id}/images/${a.id}`, 'koch'));
		expect(await imageRows(p.id)).toHaveLength(1);
	});

	it('Bild aus Open Food Facts lokal übernehmen', async () => {
		// ohne Strichcode
		await fail(await post(`/pantry/products/${p.id}/images/off`, 'koch'), 422);
		const [nudeln] = await data<FoodProduct[]>(await get(`/pantry?search=${NUDELN_CODE}`, 'koch'));
		await fail(await post(`/pantry/products/${nudeln!.id}/images/off`, 'leitung'), 403);
		offCalls = [];
		const img = await data<ImageRef>(
			await post(`/pantry/products/${nudeln!.id}/images/off`, 'koch'),
			201
		);
		expect(img).toMatchObject({ source: 'off', width: 120, height: 90 });
		expect(offCalls).toContain(OFF_IMAGE);
		const [row] = await imageRows(nudeln!.id);
		expect(row!.source).toBe('off');
		// lokal gespeichert (WebP-Varianten im Modul-Storage)
		const stored = [...fakeFileRows.values()].filter((r) =>
			r.path.startsWith(`products/${nudeln!.id}/`)
		);
		expect(stored).toHaveLength(2);
		// zweiter Import → 409
		await fail(await post(`/pantry/products/${nudeln!.id}/images/off`, 'koch'), 409);
	});

	it('fremder Bild-Host, kein Bild, zu groß → nichts gespeichert', async () => {
		for (const barcode of [EVIL, NO_IMAGE, HUGE]) {
			const prod = await data<FoodProduct>(
				await post('/pantry/products', 'koch', { name: `P ${barcode}`, barcode }),
				201
			);
			offCalls = [];
			await fail(await post(`/pantry/products/${prod.id}/images/off`, 'koch'), 404);
			expect(offCalls.some((u) => u.includes('evil.example'))).toBe(false);
			expect(await imageRows(prod.id)).toHaveLength(0);
		}
	});

	it('Produkt löschen entfernt Bilder samt Dateien', async () => {
		const paths = (await imageRows(p.id)).flatMap((r) => [r.thumb_path, r.web_path]);
		expect(paths).toHaveLength(2);
		await data(await del(`/pantry/products/${p.id}`, 'koch'));
		expect(await imageRows(p.id)).toHaveLength(0);
		const left = [...fakeFileRows.values()].filter(
			(r) => paths.includes(r.path) && r.status === 'ready'
		);
		expect(left).toHaveLength(0);
	});
});
