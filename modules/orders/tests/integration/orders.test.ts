import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { setMailTransportForTests } from '$testing';
import { runJobNow } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import ordersModule from '$modules/orders/module';
import { resetTemplateCacheForTests } from '$modules/offices/templates.service';
import type { Office } from '$modules/offices/schemas';
import type {
	MemberOption,
	Order,
	OrderCreated,
	OrderList,
	OrdersOverview,
	StockMovement,
	StockRow,
	SupplierOrder,
	SupplierSuggestion
} from '$modules/orders/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Modul „Bestellungen“: Bestellen, Rechte, Storno, Ausgabe, Lager, Einkauf mit Teillieferung,
// Fehlmengen-Meldung, Audit, Modul deaktiviert. Ohne Kasse (Rechnung steht aus).

const PW = 'orders-password-123';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
const mails: { to: string; subject: string; text: string }[] = [];

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
const O = (path: string, who: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/orders${path}`, { token: keys[who], ...init });
const post = (path: string, who: string, json: unknown = {}) =>
	O(path, who, { method: 'POST', json });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function fail(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error as { code: string; message: string; details?: { path: unknown[] }[] };
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
	userIds[name] = id;
	const ctx = await ctxOf(id);
	keys[name] = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
}

async function mkMember(firstName: string, over: Record<string, unknown> = {}) {
	const res = await api('/modules/members/members', {
		token: keys.admin,
		method: 'POST',
		json: {
			firstName,
			lastName: 'Muster',
			scoutName: null,
			birthDate: '2012-05-17',
			street: 'Musterweg 1',
			postalCode: '12345',
			city: 'Musterstadt',
			country: 'DE',
			phones: [],
			emails: [{ name: null, value: `${firstName.toLowerCase()}@familie.test` }],
			stage: 'pfadfinder',
			groupIds: [],
			...over
		}
	});
	return (await data<{ id: string }>(res, 201)).id;
}

async function link(memberId: string, user: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${memberId}, ${userIds[user]!}, 'Mutter')`
		);
	});
}

/** Artikel direkt in der DB anlegen (Artikelpflege gehört zu einem anderen Teil des Moduls) */
async function mkArticle(
	title: string,
	variants: { label: string; priceCents: number; stock?: number; minStock?: number }[],
	opts: { active?: boolean } = {}
): Promise<{ articleId: string; variantIds: string[] }> {
	const articleId = crypto.randomUUID();
	const variantIds = variants.map(() => crypto.randomUUID());
	await core.database.forModule('orders').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO articles (id, title, active, reorder_url) VALUES (${articleId}, ${title}, ${opts.active ?? true}, 'https://shop.example.test/artikel')`
		);
		for (const [i, v] of variants.entries()) {
			await tx.execute(
				sql`INSERT INTO article_variants (id, article_id, label, price_cents, stock, min_stock, position)
					VALUES (${variantIds[i]!}, ${articleId}, ${v.label}, ${v.priceCents}, ${v.stock ?? 0}, ${v.minStock ?? 0}, ${i})`
			);
		}
	});
	return { articleId, variantIds };
}

let kindId = '';
let otherId = '';
let halstuch: { articleId: string; variantIds: string[] };
let liederbuch: { articleId: string; variantIds: string[] };
let inactive: { articleId: string; variantIds: string[] };

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(officesModule);
	registerModule(ordersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'offices', 'orders']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	userIds.admin = u!.id;
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });

	await mkUser('eltern', ['core.api.manage', 'orders.order.view', 'orders.order.create']);
	await mkUser('fremd', ['core.api.manage', 'orders.order.view', 'orders.order.create']);
	await mkUser('lager', ['core.api.manage', 'orders.order.view', 'orders.stock.manage']);
	await mkUser('nurlesen', ['core.api.manage', 'orders.order.view']);

	kindId = await mkMember('Kira', { scoutName: 'Fuchs' });
	otherId = await mkMember('Otto');
	await mkMember('Alt', { entryDate: '2010-01-01', exitDate: '2020-01-01' }).then((id) =>
		link(id, 'eltern')
	);
	await link(kindId, 'eltern');

	halstuch = await mkArticle('Halstuch', [
		{ label: 'S', priceCents: 1200 },
		{ label: 'M', priceCents: 1200, minStock: 2 }
	]);
	liederbuch = await mkArticle('Liederbuch', [{ label: '', priceCents: 1550, stock: 3 }]);
	inactive = await mkArticle('Alter Aufnäher', [{ label: '', priceCents: 300 }], {
		active: false
	});

	// Amt „Kämmerer*in“ (Vorlage aus `orders`) mit der Admin-Person besetzen
	resetTemplateCacheForTests();
	const offices = await data<Office[]>(
		await api('/modules/offices/offices', { token: keys.admin })
	);
	const kaemmerer = offices.find(
		(o) => o.source?.module === 'orders' && o.source.key === 'kaemmerer'
	);
	expect(kaemmerer).toBeTruthy();
	await data(
		await api(`/modules/offices/offices/${kaemmerer!.id}/holders`, {
			token: keys.admin,
			method: 'PUT',
			json: { holders: [{ userId: userIds.admin }] }
		})
	);
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close();
});

describe('Mitglieder zur Auswahl', () => {
	it('liefert verknüpfte, nicht ausgetretene Mitglieder mit Pfadfindername', async () => {
		const list = await data<MemberOption[]>(await O('/my/members', 'eltern'));
		expect(list).toEqual([{ id: kindId, name: 'Kira Muster (Fuchs)' }]);
		expect(await data<MemberOption[]>(await O('/my/members', 'fremd'))).toEqual([]);
		await fail(await O('/my/members', 'nurlesen'), 403);
	});

	it('sucht Mitglieder nur mit Verwaltungsrecht und ab 2 Zeichen', async () => {
		const found = await data<MemberOption[]>(await O('/members?search=Ott', 'admin'));
		expect(found.map((m) => m.id)).toEqual([otherId]);
		expect(await data<MemberOption[]>(await O('/members?search=O', 'admin'))).toEqual([]);
		await fail(await O('/members?search=Ott', 'eltern'), 403);
	});
});

describe('Bestellen', () => {
	let order: Order;

	it('bestellt für ein verknüpftes Mitglied (Rechnung steht ohne Kasse aus)', async () => {
		mails.length = 0;
		const res = await data<OrderCreated>(
			await post('/orders', 'eltern', {
				memberId: kindId,
				items: [
					{ variantId: halstuch.variantIds[1], quantity: 2 },
					{ variantId: liederbuch.variantIds[0], quantity: 1 }
				],
				note: 'Bitte zur Gruppenstunde'
			}),
			201
		);
		order = res.order;
		expect(order.number).toMatch(/^B-\d{4}-0001$/);
		expect(order.member).toEqual({ id: kindId, name: 'Kira Muster' });
		expect(order.orderedBy?.id).toBe(userIds.eltern);
		expect(order.status).toBe('open');
		expect(order.totalCents).toBe(2 * 1200 + 1550);
		expect(order.items.map((i) => [i.articleTitle, i.variantLabel, i.quantity])).toEqual([
			['Halstuch', 'M', 2],
			['Liederbuch', '', 1]
		]);
		expect(order.items[0]!.stock).toBeNull(); // Lagerbestand nur für Verwaltung
		expect(order.canCancel).toBe(true);
		expect(res.invoicePending).toBe(true);
		expect(res.mailed).toBe(false);
		expect(order.payment).toBeNull();

		// Kämmerer*in benachrichtigt
		const m = mails.find((x) => x.to === 'admin@example.test');
		expect(m?.subject).toContain('Neue Bestellung');
		expect(m?.text).toContain(order.number);
		expect(m?.text).toContain('Kira Muster');
		expect(m?.text).toContain('Halstuch (Gr. M) × 2');
	});

	it('lehnt fremde Mitglieder und nicht bestellbare Artikel ab', async () => {
		const items = [{ variantId: liederbuch.variantIds[0], quantity: 1 }];
		await fail(await post('/orders', 'eltern', { memberId: otherId, items }), 404);
		await fail(await post('/orders', 'fremd', { memberId: kindId, items }), 404);
		await fail(await post('/orders', 'nurlesen', { memberId: kindId, items }), 403);
		const unknown = await fail(
			await post('/orders', 'admin', { memberId: crypto.randomUUID(), items }),
			422
		);
		expect(JSON.stringify(unknown.details)).toContain('memberId');
		const err = await fail(
			await post('/orders', 'eltern', {
				memberId: kindId,
				items: [
					{ variantId: liederbuch.variantIds[0], quantity: 1 },
					{ variantId: inactive.variantIds[0], quantity: 1 }
				]
			}),
			422
		);
		expect(err.details?.[0]?.path).toEqual(['items', 1, 'variantId']);
		const dup = await fail(
			await post('/orders', 'eltern', {
				memberId: kindId,
				items: [
					{ variantId: liederbuch.variantIds[0], quantity: 1 },
					{ variantId: liederbuch.variantIds[0], quantity: 1 }
				]
			}),
			422
		);
		expect(dup.code).toBe('validation_failed');
	});

	it('Verwaltung bestellt für jedes Mitglied', async () => {
		const res = await data<OrderCreated>(
			await post('/orders', 'admin', {
				memberId: otherId,
				items: [{ variantId: halstuch.variantIds[0], quantity: 1 }]
			}),
			201
		);
		expect(res.order.number).toMatch(/-0002$/);
		expect(res.order.items[0]!.stock).toBe(0);
	});

	it('listet eigene bzw. alle Bestellungen', async () => {
		const mine = await data<OrderList>(await O('/orders', 'eltern'));
		expect(mine.total).toBe(1);
		expect(mine.items[0]!.id).toBe(order.id);
		expect((await data<OrderList>(await O('/orders', 'fremd'))).total).toBe(0);
		await fail(await O('/orders?scope=all', 'eltern'), 403);
		const all = await data<OrderList>(await O('/orders?scope=all', 'admin'));
		expect(all.total).toBe(2);
		const search = await data<OrderList>(await O('/orders?scope=all&search=Otto', 'admin'));
		expect(search.items.map((o) => o.member.id)).toEqual([otherId]);
		await data(await O(`/orders/${order.id}`, 'eltern'));
		await fail(await O(`/orders/${order.id}`, 'fremd'), 404);
		await fail(await O(`/orders/${crypto.randomUUID()}`, 'admin'), 404);
	});

	it('storniert teilweise (eigene, solange nichts ausgegeben)', async () => {
		const item = order.items[0]!;
		const tooMuch = await fail(
			await post(`/orders/${order.id}/cancel`, 'eltern', {
				items: [{ itemId: item.id, quantity: 3 }]
			}),
			422
		);
		expect(tooMuch.details?.[0]?.path).toEqual(['items', 0, 'quantity']);
		await fail(await post(`/orders/${order.id}/cancel`, 'fremd', {}), 404);
		order = await data<Order>(
			await post(`/orders/${order.id}/cancel`, 'eltern', {
				items: [{ itemId: item.id, quantity: 1 }],
				reason: 'Eins reicht'
			}),
			201
		);
		expect(order.items[0]!.cancelledQty).toBe(1);
		expect(order.items[0]!.openQty).toBe(1);
		expect(order.totalCents).toBe(1200 + 1550);
		expect(order.status).toBe('open');
	});

	it('gibt Ware aus (Bestand geprüft, teilweise)', async () => {
		const [hal, lied] = order.items;
		await fail(
			await post(`/orders/${order.id}/handout`, 'eltern', {
				items: [{ itemId: lied!.id, quantity: 1 }]
			}),
			403
		);
		const noStock = await fail(
			await post(`/orders/${order.id}/handout`, 'admin', {
				items: [{ itemId: hal!.id, quantity: 1 }]
			}),
			409
		);
		expect(noStock.message).toContain('Nur 0 auf Lager');
		await fail(
			await post(`/orders/${order.id}/handout`, 'admin', {
				items: [{ itemId: lied!.id, quantity: 2 }]
			}),
			422
		);
		order = await data<Order>(
			await post(`/orders/${order.id}/handout`, 'admin', {
				items: [{ itemId: lied!.id, quantity: 1 }]
			}),
			201
		);
		expect(order.status).toBe('partial');
		expect(order.items[1]!.deliveredQty).toBe(1);
		expect(order.items[1]!.stock).toBe(2);
		expect(order.canCancel).toBe(true);
		// eigene Bestellung nach Ausgabe nicht mehr stornierbar
		const own = await data<Order>(await O(`/orders/${order.id}`, 'eltern'));
		expect(own.canCancel).toBe(false);
		await fail(await post(`/orders/${order.id}/cancel`, 'eltern', {}), 409);
	});
});

describe('Lager', () => {
	it('zeigt Nachfrage, Mindestbestand und Fehlmengen', async () => {
		await fail(await O('/stock', 'eltern'), 403);
		const stock = await data<StockRow[]>(await O('/stock', 'lager'));
		const row = (v: string) => stock.find((r) => r.variantId === v)!;
		// Halstuch M: 1 offen + Mindestbestand 2 − Bestand 0 = 3
		expect(row(halstuch.variantIds[1]!)).toMatchObject({ demand: 1, minStock: 2, deficit: 3 });
		// Halstuch S: Otto bestellt 1
		expect(row(halstuch.variantIds[0]!)).toMatchObject({ demand: 1, deficit: 1 });
		expect(row(liederbuch.variantIds[0]!)).toMatchObject({ stock: 2, demand: 0, deficit: 0 });
		// inaktive Artikel stehen im Lager
		expect(row(inactive.variantIds[0]!).articleActive).toBe(false);
		expect(row(halstuch.variantIds[0]!).reorderUrl).toBe('https://shop.example.test/artikel');
	});

	it('korrigiert den Bestand und protokolliert die Bewegung', async () => {
		const row = await data<StockRow>(
			await post('/stock/corrections', 'lager', {
				variantId: liederbuch.variantIds[0],
				stock: 5,
				note: 'Inventur'
			}),
			201
		);
		expect(row.stock).toBe(5);
		await fail(
			await post('/stock/corrections', 'lager', { variantId: crypto.randomUUID(), stock: 1 }),
			404
		);
		await fail(
			await post('/stock/corrections', 'lager', { variantId: liederbuch.variantIds[0], stock: -1 }),
			422
		);
		const moves = await data<{ items: StockMovement[]; total: number }>(
			await O(`/stock/movements?variantId=${liederbuch.variantIds[0]}`, 'lager')
		);
		expect(moves.total).toBe(2);
		expect(moves.items[0]).toMatchObject({ kind: 'correction', delta: 3, note: 'Inventur' });
		expect(moves.items[0]!.createdBy?.name).toBe('lager');
		expect(moves.items[1]).toMatchObject({ kind: 'handout', delta: -1 });
		expect(moves.items[1]!.orderNumber).toMatch(/^B-/);
	});

	it('Übersicht nur für Verwaltung/Lager', async () => {
		await fail(await O('/overview', 'eltern'), 403);
		const ov = await data<OrdersOverview>(await O('/overview', 'lager'));
		expect(ov).toMatchObject({
			openOrders: 2,
			openItems: 2,
			deficitVariants: 2,
			openSupplierOrders: 0,
			unpaidSupplierInvoices: 0,
			treasuryActive: false
		});
	});
});

describe('Einkauf beim Lieferanten', () => {
	let so: SupplierOrder;

	it('schlägt Fehlmengen vor und bestellt', async () => {
		const sug = await data<SupplierSuggestion>(await O('/supplier-orders/suggestion', 'lager'));
		expect(sug.items.map((i) => [i.variantId, i.quantity]).sort()).toEqual(
			[
				[halstuch.variantIds[0], 1],
				[halstuch.variantIds[1], 3]
			].sort()
		);
		so = await data<SupplierOrder>(
			await post('/supplier-orders', 'lager', {
				supplier: 'Ausrüster GmbH',
				orderedOn: '2026-10-01',
				items: [{ variantId: halstuch.variantIds[1], quantity: 3, unitCostCents: 800 }]
			}),
			201
		);
		expect(so.number).toBe('E-2026-0001');
		expect(so.status).toBe('ordered');
		expect(so.orderedOn).toBe('2026-10-01');
		expect(so.estimatedCents).toBe(2400);
		await fail(
			await post('/supplier-orders', 'lager', {
				supplier: 'X',
				orderedOn: '2026-10-01',
				items: [{ variantId: crypto.randomUUID(), quantity: 1 }]
			}),
			422
		);
		await fail(await post('/supplier-orders', 'eltern', {}), 403);
	});

	it('ändert Positionen, solange nichts eingegangen ist', async () => {
		so = await data<SupplierOrder>(
			await O(`/supplier-orders/${so.id}`, 'lager', {
				method: 'PATCH',
				json: {
					note: 'Lieferung bis Ende Oktober',
					items: [
						{ variantId: halstuch.variantIds[1], quantity: 4, unitCostCents: 800 },
						{ variantId: halstuch.variantIds[0], quantity: 1 }
					]
				}
			})
		);
		expect(so.items.map((i) => i.quantity)).toEqual([4, 1]);
		const stock = await data<StockRow[]>(await O('/stock', 'lager'));
		expect(stock.find((r) => r.variantId === halstuch.variantIds[1])).toMatchObject({
			inTransit: 4,
			deficit: 0
		});
	});

	it('bucht Teillieferungen, Rest stornieren, wieder öffnen, abschließen', async () => {
		const [m, s] = so.items;
		await fail(
			await post(`/supplier-orders/${so.id}/receive`, 'lager', {
				items: [{ itemId: m!.id, quantity: 5 }]
			}),
			422
		);
		so = await data<SupplierOrder>(
			await post(`/supplier-orders/${so.id}/receive`, 'lager', {
				items: [{ itemId: m!.id, quantity: 2 }],
				note: 'Erste Lieferung'
			}),
			201
		);
		expect(so.status).toBe('partial');
		expect(so.items[0]!.receivedQty).toBe(2);
		expect(so.items[0]!.openQty).toBe(2);
		const stock = await data<StockRow[]>(await O('/stock', 'lager'));
		expect(stock.find((r) => r.variantId === halstuch.variantIds[1])).toMatchObject({
			stock: 2,
			inTransit: 2,
			deficit: 0
		});
		await fail(
			await O(`/supplier-orders/${so.id}`, 'lager', {
				method: 'PATCH',
				json: { items: [{ variantId: halstuch.variantIds[1], quantity: 1 }] }
			}),
			409
		);
		so = await data<SupplierOrder>(
			await post(`/supplier-orders/${so.id}/receive`, 'lager', {
				items: [
					{ itemId: m!.id, quantity: 2 },
					{ itemId: s!.id, quantity: 1 }
				]
			}),
			201
		);
		expect(so.status).toBe('received');
		expect(so.closedAt).toBeNull();

		// zweite Bestellung: Rest stornieren
		const second = await data<SupplierOrder>(
			await post('/supplier-orders', 'lager', {
				supplier: 'Buchversand',
				orderedOn: '2026-10-05',
				items: [{ variantId: liederbuch.variantIds[0], quantity: 10 }]
			}),
			201
		);
		await data(
			await post(`/supplier-orders/${second.id}/receive`, 'lager', {
				items: [{ itemId: second.items[0]!.id, quantity: 4 }]
			}),
			201
		);
		const closed = await data<SupplierOrder>(
			await post(`/supplier-orders/${second.id}/cancel-rest`, 'lager'),
			201
		);
		expect(closed.status).toBe('closed');
		expect(closed.items[0]).toMatchObject({ receivedQty: 4, cancelledQty: 6, openQty: 0 });
		await fail(
			await post(`/supplier-orders/${second.id}/receive`, 'lager', {
				items: [{ itemId: second.items[0]!.id, quantity: 1 }]
			}),
			409
		);
		await fail(await post(`/supplier-orders/${second.id}/close`, 'lager'), 409);
		const reopened = await data<SupplierOrder>(
			await post(`/supplier-orders/${second.id}/reopen`, 'lager'),
			201
		);
		expect(reopened.status).toBe('received');
		await fail(await post(`/supplier-orders/${second.id}/reopen`, 'lager'), 409);
		await data(await post(`/supplier-orders/${second.id}/close`, 'lager'), 201);

		const active = await data<SupplierOrder[]>(await O('/supplier-orders', 'lager'));
		expect(active.map((o) => o.id)).toEqual([so.id]);
		const all = await data<SupplierOrder[]>(await O('/supplier-orders?status=all', 'lager'));
		expect(all.map((o) => o.id)).toEqual([so.id, second.id]);
		await fail(await O(`/supplier-orders/${crypto.randomUUID()}`, 'lager'), 404);
	});

	it('Lieferantenrechnung ohne aktive Kasse → 409', async () => {
		const form = new FormData();
		form.set('amountCents', '3200');
		form.set('recipientName', 'Ausrüster GmbH');
		const res = await O(`/supplier-orders/${so.id}/invoice`, 'lager', {
			method: 'PUT',
			body: form
		});
		const err = await fail(res, 409);
		expect(err.message).toContain('Kasse ist nicht aktiv');
		const bad = new FormData();
		bad.set('amountCents', '0');
		bad.set('recipientName', '');
		const v = await fail(
			await O(`/supplier-orders/${so.id}/invoice`, 'lager', { method: 'PUT', body: bad }),
			422
		);
		expect(JSON.stringify(v.details)).toContain('amountCents');
	});

	it('Ausgabe nach Wareneingang, Rest durch Verwaltung stornieren', async () => {
		let order = (await data<OrderList>(await O('/orders?scope=all&search=Kira', 'admin')))
			.items[0]!;
		order = await data<Order>(
			await post(`/orders/${order.id}/handout`, 'admin', {
				items: [{ itemId: order.items[0]!.id, quantity: 1 }]
			}),
			201
		);
		expect(order.status).toBe('delivered');
		expect(order.canCancel).toBe(false);
		await fail(await post(`/orders/${order.id}/cancel`, 'admin', {}), 409);

		const otto = (await data<OrderList>(await O('/orders?scope=all&search=Otto', 'admin')))
			.items[0]!;
		const cancelled = await data<Order>(await post(`/orders/${otto.id}/cancel`, 'admin', {}), 201);
		expect(cancelled.status).toBe('cancelled');
		expect(cancelled.cancelledAt).not.toBeNull();
		expect(cancelled.totalCents).toBe(0);
		const active = await data<OrderList>(await O('/orders?scope=all&status=active', 'admin'));
		expect(active.total).toBe(0);
	});
});

describe('Fehlmengen-Meldung', () => {
	it('meldet Fehlmengen einmal und erst bei Änderung erneut', async () => {
		// Halstuch M: Bestand 3 (4 eingegangen − 1 ausgegeben), Mindestbestand 2 → keine Fehlmenge
		await data(
			await post('/stock/corrections', 'lager', { variantId: halstuch.variantIds[1], stock: 0 }),
			201
		);
		mails.length = 0;
		const first = await runJobNow(admin, 'orders.deficit-digest');
		expect(first.lastMessage).toContain('gemeldet');
		const m = mails.find((x) => x.to === 'admin@example.test');
		expect(m?.subject).toContain('Nachbestellung');
		expect(m?.text).toContain('Halstuch (Gr. M): 2 fehlen');

		mails.length = 0;
		const second = await runJobNow(admin, 'orders.deficit-digest');
		expect(second.lastMessage).toContain('unverändert');
		expect(mails).toHaveLength(0);

		await data(
			await post('/stock/corrections', 'lager', { variantId: halstuch.variantIds[1], stock: 1 }),
			201
		);
		const third = await runJobNow(admin, 'orders.deficit-digest');
		expect(third.lastMessage).toContain('gemeldet');
		expect(mails.some((x) => x.text.includes('Halstuch (Gr. M): 1 fehlen'))).toBe(true);
	});

	it('Abgleich-Job ohne Kasse', async () => {
		const job = await runJobNow(admin, 'orders.sync-treasury');
		expect(job.lastMessage).toContain('Kasse nicht aktiv');
	});
});

describe('Audit und Modulstatus', () => {
	it('protokolliert ohne personenbezogene Details', async () => {
		const { rows } = await listAudit({ action: 'orders.', limit: 200 });
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'orders.order.created',
			'orders.order.cancelled',
			'orders.order.handed-out',
			'orders.stock.corrected',
			'orders.supplier-order.created',
			'orders.supplier-order.updated',
			'orders.supplier-order.received',
			'orders.supplier-order.closed',
			'orders.supplier-order.reopened'
		]) {
			expect(actions, a).toContain(a);
		}
		const all = JSON.stringify(rows.map((r) => r.metadata));
		expect(all).not.toContain('@');
		expect(all).not.toContain('Kira');
		expect(all).not.toContain('Otto');
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'orders');
		const err = await fail(await O('/orders', 'admin'), 404);
		expect(err.code).toBe('module_disabled');
	});
});
