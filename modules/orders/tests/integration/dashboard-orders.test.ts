/**
 * Übersicht „Zu erledigen“ der Bestellungen (`ModuleDefinition.dashboard.todos`): Zeilen nur für die
 * Verwaltung (Ausgeben mit `orders.order.manage`, Fehlmengen/Einkauf mit `orders.stock.manage`), nur
 * bei Anzahl > 0, Besteller*innen ohne Verwaltungsrecht sehen nichts, Modul deaktiviert → keine Zeilen.
 */
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
import { resetAllForTests } from '$testing';
import { setMailTransportForTests } from '$testing';
import { collectDashboardFeed } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import ordersModule from '$modules/orders/module';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'dashboard-orders-password-1';
const TODAY = '2026-06-01';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};

function api(path: string, token: string, json?: unknown) {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${token}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, {
			method: json === undefined ? 'GET' : 'POST',
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
}

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const feedOf = async (name: string) =>
	(await collectDashboardFeed(await ctxOf(userIds[name]!), { today: TODAY })).todos.filter(
		(t) => t.moduleId === 'orders'
	);

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

async function mkArticle(
	title: string,
	variants: { label: string; priceCents: number; stock?: number; minStock?: number }[]
): Promise<string[]> {
	const articleId = crypto.randomUUID();
	const variantIds = variants.map(() => crypto.randomUUID());
	await core.database.forModule('orders').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO articles (id, title, active) VALUES (${articleId}, ${title}, true)`
		);
		for (const [i, v] of variants.entries()) {
			await tx.execute(
				sql`INSERT INTO article_variants (id, article_id, label, price_cents, stock, min_stock, position)
					VALUES (${variantIds[i]!}, ${articleId}, ${v.label}, ${v.priceCents}, ${v.stock ?? 0}, ${v.minStock ?? 0}, ${i})`
			);
		}
	});
	return variantIds;
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
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
	for (const m of ['members', 'orders']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setMailTransportForTests({ sendMail: async () => undefined });

	await mkUser('eltern', ['core.api.manage', 'orders.order.view', 'orders.order.create']);
	await mkUser('kaemmerer', ['core.api.manage', 'orders.order.view', 'orders.order.manage']);
	await mkUser('lager', ['core.api.manage', 'orders.order.view', 'orders.stock.manage']);
	await mkUser('leer', ['core.api.manage', 'orders.order.view', 'orders.stock.manage']);
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close();
});

describe('Bestellungen: Zu erledigen', () => {
	it('ohne offene Vorgänge keine Zeilen', async () => {
		expect(await feedOf('kaemmerer')).toEqual([]);
		expect(await feedOf('leer')).toEqual([]);
	});

	it('Zeilen je Verwaltungsrecht, nur bei Anzahl > 0', async () => {
		const [halstuchS, halstuchM] = await mkArticle('Halstuch', [
			{ label: 'S', priceCents: 1200 },
			{ label: 'M', priceCents: 1200, minStock: 2 }
		]);
		const [liederbuch] = await mkArticle('Liederbuch', [{ label: '', priceCents: 1550, stock: 3 }]);
		const member = await data<{ id: string }>(
			await api('/modules/members/members', keys.admin!, {
				firstName: 'Kira',
				lastName: 'Muster',
				birthDate: '2012-05-17',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				stage: 'pfadfinder',
				emails: [{ name: null, value: 'kira@familie.test' }]
			}),
			201
		);
		await data(
			await api('/modules/orders/orders', keys.admin!, {
				memberId: member.id,
				items: [
					{ variantId: liederbuch!, quantity: 1 },
					{ variantId: halstuchM!, quantity: 1 }
				]
			}),
			201
		);
		await data(
			await api('/modules/orders/supplier-orders', keys.lager!, {
				supplier: 'Ausrüster',
				orderedOn: TODAY,
				items: [{ variantId: halstuchS!, quantity: 5, unitCostCents: 800 }]
			}),
			201
		);

		const k = await feedOf('kaemmerer');
		expect(k).toEqual([
			expect.objectContaining({
				id: 'handout',
				title: '1 Bestellung ausgeben',
				detail: '2 Stück aus dem Lager',
				severity: 'due',
				action: { label: 'Ausgeben', href: '/modules/orders?tab=bestellungen' }
			})
		]);

		const l = await feedOf('lager');
		expect(l.map((t) => t.id).sort()).toEqual(['deficit', 'supplier-open']);
		expect(l.find((t) => t.id === 'deficit')).toMatchObject({
			title: 'Fehlmengen nachbestellen',
			action: { href: '/modules/orders?tab=lager' }
		});
		expect(l.find((t) => t.id === 'supplier-open')).toMatchObject({
			title: '1 Einkauf offen',
			severity: 'info',
			action: { href: '/modules/orders?tab=einkauf' }
		});
		// Ohne Kasse keine Zeile zu Lieferantenrechnungen
		expect(l.some((t) => t.id === 'supplier-unpaid')).toBe(false);
	});

	it('Besteller*innen ohne Verwaltungsrecht sehen nichts', async () => {
		expect(await feedOf('eltern')).toEqual([]);
	});

	it('Modul deaktiviert → keine Zeilen', async () => {
		await disableModule(admin, 'orders');
		try {
			expect(await feedOf('kaemmerer')).toEqual([]);
			expect(await feedOf('lager')).toEqual([]);
		} finally {
			await enableModule(admin, 'orders');
		}
	});
});
