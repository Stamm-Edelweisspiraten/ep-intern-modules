import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
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
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import ordersModule from '$modules/orders/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { InvoiceDetail, PayableList } from '$modules/treasury/schemas';
import type { Order, OrderCreated, OrdersOverview, SupplierOrder } from '$modules/orders/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Bestellungen ↔ Kasse: Rechnung sofort bei Bestellung (Mail), Anpassung bei Storno, Nachholen per Job,
// Lieferantenrechnung als Auszahlung mit Zahlstand.

const IBAN = 'DE89370400440532013000';
let close: () => Promise<void>;
let admin: RequestContext;
let key = '';
const mails: { to: unknown; subject: string; text: string }[] = [];
let kindId = '';
let variantM = '';
let variantBook = '';
let accountId = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
	resetAllForTests();
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${key}`);
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
const O = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/orders${path}`, init);
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, init);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}
async function fail(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error as { code: string; message: string };
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const mailsTo = (addr: string) => mails.filter((m) => JSON.stringify(m.to).includes(addr));

async function order(items: { variantId: string; quantity: number }[]): Promise<OrderCreated> {
	return data<OrderCreated>(
		await O('/orders', { method: 'POST', json: { memberId: kindId, items } }),
		201
	);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	registerModule(ordersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury', 'orders']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	key = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	setTodayForTests('2026-10-19');

	kindId = (
		await data<{ id: string }>(
			await api('/modules/members/members', {
				method: 'POST',
				json: {
					firstName: 'Kira',
					lastName: 'Muster',
					scoutName: null,
					birthDate: '2012-05-17',
					street: 'Musterweg 1',
					postalCode: '12345',
					city: 'Musterstadt',
					country: 'DE',
					phones: [],
					emails: [{ name: null, value: 'eltern@familie.test' }],
					stage: 'pfadfinder',
					groupIds: []
				}
			}),
			201
		)
	).id;

	const articleId = crypto.randomUUID();
	const bookId = crypto.randomUUID();
	variantM = crypto.randomUUID();
	variantBook = crypto.randomUUID();
	await core.database.forModule('orders').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO articles (id, title) VALUES (${articleId}, 'Halstuch'), (${bookId}, 'Liederbuch')`
		);
		await tx.execute(
			sql`INSERT INTO article_variants (id, article_id, label, price_cents, stock)
				VALUES (${variantM}, ${articleId}, 'M', 1200, 10), (${variantBook}, ${bookId}, '', 1550, 10)`
		);
	});

	accountId = (
		await data<{ id: string }>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Rechnung zur Bestellung', () => {
	let created: OrderCreated;

	it('legt sofort eine Rechnung mit Posten an und verschickt sie', async () => {
		mails.length = 0;
		created = await order([
			{ variantId: variantM, quantity: 2 },
			{ variantId: variantBook, quantity: 1 }
		]);
		expect(created.invoicePending).toBe(false);
		expect(created.mailed).toBe(true);
		const o = created.order;
		expect(o.invoiceNumber).toMatch(/^R-2026-\d{4}$/);
		expect(o.payment).toMatchObject({ status: 'open', dueCents: 3950, paidCents: 0 });
		const inv = await data<InvoiceDetail>(await T(`/invoices/${o.payment!.invoiceId}`));
		expect(inv.number).toBe(o.invoiceNumber);
		expect(inv.lines.map((l) => [l.description, l.amountCents])).toEqual([
			['Halstuch (Gr. M) × 2', 2400],
			['Liederbuch × 1', 1550]
		]);
		expect(mailsTo('eltern@familie.test').length).toBeGreaterThan(0);
	});

	it('passt die Rechnung bei Teil-Storno an und storniert sie bei Voll-Storno', async () => {
		const o = created.order;
		const after = await data<Order>(
			await O(`/orders/${o.id}/cancel`, {
				method: 'POST',
				json: { items: [{ itemId: o.items[0]!.id, quantity: 1 }] }
			}),
			201
		);
		expect(after.invoiceNumber).toBe(o.invoiceNumber);
		expect(after.payment?.dueCents).toBe(1200 + 1550);
		const inv = await data<InvoiceDetail>(await T(`/invoices/${o.payment!.invoiceId}`));
		expect(inv.lines.find((l) => l.description.startsWith('Halstuch'))).toMatchObject({
			description: 'Halstuch (Gr. M) × 1',
			amountCents: 1200
		});

		const all = await data<Order>(
			await O(`/orders/${o.id}/cancel`, { method: 'POST', json: {} }),
			201
		);
		expect(all.status).toBe('cancelled');
		expect(all.payment?.status).toBe('cancelled');
	});

	it('Kasse inaktiv: Bestellung gültig, Rechnung folgt über den Job', async () => {
		await disableModule(admin, 'treasury');
		const res = await order([{ variantId: variantBook, quantity: 2 }]);
		expect(res.invoicePending).toBe(true);
		expect(res.order.invoiceNumber).toBeNull();
		expect(res.order.payment).toBeNull();
		const ov = await data<OrdersOverview>(await O('/overview'));
		expect(ov.treasuryActive).toBe(false);

		await enableModule(admin, 'treasury');
		mails.length = 0;
		const job = await runJobNow(admin, 'orders.sync-treasury');
		expect(job.lastStatus).toBe('ok');
		expect(job.lastMessage).toContain('1 Bestellung');
		const o = await data<Order>(await O(`/orders/${res.order.id}`));
		expect(o.invoiceNumber).toMatch(/^R-2026-/);
		expect(o.payment).toMatchObject({ status: 'open', dueCents: 3100 });
		expect(mailsTo('eltern@familie.test').length).toBeGreaterThan(0);
		const again = await runJobNow(admin, 'orders.sync-treasury');
		expect(again.lastMessage).toContain('Alles abgeglichen');
	});
});

describe('Lieferantenrechnung', () => {
	let so: SupplierOrder;

	function invoiceForm(amountCents: number, extra: Record<string, string> = {}) {
		const form = new FormData();
		form.set('amountCents', String(amountCents));
		form.set('recipientName', 'Ausrüster GmbH');
		for (const [k, v] of Object.entries(extra)) form.set(k, v);
		return form;
	}

	it('wird als Auszahlung in der Kasse angelegt und zeigt den Zahlstand', async () => {
		so = await data<SupplierOrder>(
			await O('/supplier-orders', {
				method: 'POST',
				json: {
					supplier: 'Ausrüster GmbH',
					orderedOn: '2026-10-10',
					items: [{ variantId: variantM, quantity: 5, unitCostCents: 700 }]
				}
			}),
			201
		);
		so = await data<SupplierOrder>(
			await O(`/supplier-orders/${so.id}/invoice`, {
				method: 'PUT',
				body: invoiceForm(3600, { iban: IBAN, dueOn: '2026-11-01' })
			})
		);
		expect(so.invoice).toMatchObject({
			amountCents: 3600,
			recipientName: 'Ausrüster GmbH',
			inTreasury: true
		});
		expect(so.invoice?.payment).toMatchObject({ status: 'open', amountCents: 3600, paidCents: 0 });

		// Betrag ändern
		so = await data<SupplierOrder>(
			await O(`/supplier-orders/${so.id}/invoice`, { method: 'PUT', body: invoiceForm(3500) })
		);
		expect(so.invoice?.payment?.amountCents).toBe(3500);
		const ov = await data<OrdersOverview>(await O('/overview'));
		expect(ov.unpaidSupplierInvoices).toBe(1);
		expect(ov.treasuryActive).toBe(true);
	});

	it('bezahlt über die Kasse → paid; Entfernen dann 409', async () => {
		const list = await data<PayableList>(await T('/payables?status=all&source=order'));
		const payable = list.items.find((p) => p.description.includes(so.number));
		expect(payable).toBeTruthy();
		expect(payable!.hasIban).toBe(true);
		await data(
			await T(`/payables/${payable!.id}/pay`, {
				method: 'POST',
				json: { accountId, bookedOn: '2026-10-19', amountCents: 3500 }
			}),
			201
		);
		so = await data<SupplierOrder>(await O(`/supplier-orders/${so.id}`));
		expect(so.invoice?.payment?.status).toBe('paid');
		const ov = await data<OrdersOverview>(await O('/overview'));
		expect(ov.unpaidSupplierInvoices).toBe(0);
		await fail(await O(`/supplier-orders/${so.id}/invoice`, { method: 'DELETE' }), 409);
	});

	it('unbezahlte Lieferantenrechnung lässt sich entfernen', async () => {
		let other = await data<SupplierOrder>(
			await O('/supplier-orders', {
				method: 'POST',
				json: {
					supplier: 'Buchversand',
					orderedOn: '2026-10-12',
					items: [{ variantId: variantBook, quantity: 3 }]
				}
			}),
			201
		);
		other = await data<SupplierOrder>(
			await O(`/supplier-orders/${other.id}/invoice`, { method: 'PUT', body: invoiceForm(4000) })
		);
		other = await data<SupplierOrder>(
			await O(`/supplier-orders/${other.id}/invoice`, { method: 'DELETE' })
		);
		expect(other.invoice).toBeNull();
		const list = await data<PayableList>(await T('/payables?status=all&source=order'));
		const p = list.items.find((x) => x.description.includes(other.number));
		expect(p?.cancelledAt).not.toBeNull();
		await fail(await O(`/supplier-orders/${other.id}/invoice`, { method: 'DELETE' }), 404);
	});

	it('Audit ohne IBAN', async () => {
		const { rows } = await listAudit({ action: 'orders.', limit: 200 });
		expect(rows.some((r) => r.action === 'orders.supplier-order.invoice-set')).toBe(true);
		expect(rows.some((r) => r.action === 'orders.supplier-order.invoice-removed')).toBe(true);
		const all = JSON.stringify(rows.map((r) => r.metadata));
		expect(all).not.toContain(IBAN);
		expect(all).not.toContain(IBAN.slice(-4));
		expect(all).not.toContain('@');
	});
});

describe('Bearbeiten und Löschen mit Kasse', () => {
	let created: OrderCreated;

	it('Bearbeiten passt die Rechnung an', async () => {
		created = await order([
			{ variantId: variantM, quantity: 1 },
			{ variantId: variantBook, quantity: 1 }
		]);
		const o = created.order;
		expect(o.payment?.dueCents).toBe(1200 + 1550);
		const res = await O(`/orders/${o.id}`, {
			method: 'PATCH',
			json: {
				items: [
					{ itemId: o.items[0]!.id, quantity: 3, unitPriceCents: 1000 },
					{ itemId: o.items[1]!.id, quantity: 0 }
				]
			}
		});
		const after = await data<Order>(res);
		expect(after.invoiceNumber).toBe(o.invoiceNumber);
		expect(after.payment?.dueCents).toBe(3000);
		const inv = await data<InvoiceDetail>(await T(`/invoices/${o.payment!.invoiceId}`));
		const active = inv.lines.filter((l) => l.amountCents > 0);
		expect(active.map((l) => [l.description, l.amountCents])).toEqual([
			['Halstuch (Gr. M) × 3', 3000]
		]);
	});

	it('Löschen storniert die Rechnung, sie bleibt in der Kasse', async () => {
		const o = created.order;
		const res = await data<{ number: string; invoiceCancelled: boolean }>(
			await O(`/orders/${o.id}`, { method: 'DELETE' })
		);
		expect(res).toEqual({ number: o.number, invoiceCancelled: true });
		await fail(await O(`/orders/${o.id}`), 404);
		const inv = await data<InvoiceDetail>(await T(`/invoices/${o.payment!.invoiceId}`));
		expect(inv.number).toBe(o.invoiceNumber);
		expect(inv.cancelledAt).not.toBeNull();
	});

	it('Kasse inaktiv: Bestellung mit Rechnung lässt sich nicht löschen', async () => {
		const c = await order([{ variantId: variantBook, quantity: 1 }]);
		expect(c.order.invoiceNumber).toBeTruthy();
		await disableModule(admin, 'treasury');
		try {
			const err = await fail(await O(`/orders/${c.order.id}`, { method: 'DELETE' }), 409);
			expect(err.message).toContain('Kasse');
			await data<Order>(await O(`/orders/${c.order.id}`));
		} finally {
			await enableModule(admin, 'treasury');
		}
	});

	it('Audit für Bearbeiten und Löschen', async () => {
		const { rows } = await listAudit({ action: 'orders.order.', limit: 200 });
		const actions = new Set(rows.map((r) => r.action));
		expect(actions).toContain('orders.order.updated');
		expect(actions).toContain('orders.order.deleted');
	});
});
