import { expect, test, type Page } from '@playwright/test';

// Bestellungen: Artikel über den Dialog anlegen, für ein Mitglied bestellen (Warenkorb), Ware ausgeben,
// Einkauf mit Teillieferung sehen.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);

interface ArticleDto {
	id: string;
	title: string;
	variants: { id: string; label: string; priceCents: number }[];
}
interface OrderDto {
	id: string;
	number: string;
	status: string;
	member: { id: string; name: string };
	items: { id: string; quantity: number; deliveredQty: number }[];
}
interface SupplierOrderDto {
	id: string;
	number: string;
	status: string;
	items: { id: string; quantity: number }[];
}

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
	const res = await page.request.fetch(`/api/v1${path}`, {
		method,
		headers: {
			origin: ORIGIN,
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		data: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
	const text = await res.text();
	return (text ? (JSON.parse(text) as { data: T }).data : null) as T;
}

async function ensureModules(page: Page, ids: string[]) {
	const list = await api<{ manifest: { id: string }; enabled: boolean }[]>(page, 'GET', '/modules');
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/modules/${id}/enable`);
		}
	}
}

async function setup(page: Page) {
	await login(page);
	await ensureModules(page, ['members', 'orders']);
	// Neue Modulrechte wirken erst nach erneutem Laden der Sitzung
	await page.reload();
}

const articles = (page: Page) =>
	api<ArticleDto[]>(page, 'GET', '/modules/orders/articles?scope=all');

test.describe.configure({ mode: 'serial' });

const title = `Halstuch ${run}`;
const lastName = `Bestell${run}`;
const memberName = `Bea ${lastName}`;

test('Artikel anlegen', async ({ page }) => {
	await setup(page);
	await page.goto('/modules/orders?tab=artikel');
	await page.getByRole('button', { name: 'Artikel anlegen' }).first().click();

	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: 'Artikel anlegen' })).toBeVisible();
	await dialog.locator('#article-title').fill(title);
	await dialog.locator('#article-description').fill('Dunkelblau mit Wappen');
	await dialog.getByRole('tab', { name: /Größen/ }).click();
	await dialog.locator('#variant-price-0').fill('12,00');
	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	// Nach dem Anlegen bleibt der Dialog für Bilder offen
	await expect(dialog.getByRole('heading', { name: 'Artikel bearbeiten' })).toBeVisible();
	await page.keyboard.press('Escape');

	const article = (await articles(page)).find((a) => a.title === title);
	expect(article?.variants.map((v) => v.priceCents)).toEqual([1200]);
	await expect(page.getByText(title).first()).toBeVisible();
});

test('Für ein Mitglied bestellen und ausgeben', async ({ page }) => {
	await setup(page);
	const article = (await articles(page)).find((a) => a.title === title);
	expect(article).toBeTruthy();
	await api(page, 'POST', '/modules/orders/stock/corrections', {
		variantId: article!.variants[0]!.id,
		stock: 5,
		note: 'E2E'
	});
	await api(page, 'POST', '/modules/members/members', {
		firstName: 'Bea',
		lastName,
		birthDate: '2014-05-01',
		street: 'Am Wall 1',
		postalCode: '28195',
		city: 'Bremen',
		country: 'DE',
		stage: 'pfadfinder',
		emails: [{ name: 'Eltern', value: `bea-${run}@example.test` }]
	});

	// Kämmerer*in bestellt für ein beliebiges Mitglied über „Bestellung anlegen“
	await page.goto('/modules/orders?tab=bestellungen');
	await page.getByRole('button', { name: 'Bestellung anlegen' }).click();
	const create = page.getByRole('dialog');
	await create.getByLabel('Mitglied suchen').fill(lastName);
	await create.getByRole('button', { name: memberName }).click();
	await create.getByRole('button', { name: 'Artikel Position 1' }).click();
	await page.getByRole('option', { name: new RegExp(title) }).click();
	await create.getByRole('button', { name: 'Verbindlich bestellen' }).click();
	await expect(create).toBeHidden();
	await expect(page.getByText(/Bestellung B-\d{4}-\d{4}/).first()).toBeVisible();

	const list = await api<{ items: OrderDto[] }>(
		page,
		'GET',
		`/modules/orders/orders?scope=all&search=${encodeURIComponent(lastName)}`
	);
	const order = list.items[0]!;
	expect(order.member.name).toBe(memberName);
	expect(order.status).toBe('open');

	await page.goto('/modules/orders?tab=bestellungen');
	const row = page.getByRole('row', { name: new RegExp(order.number) });
	await row.getByRole('button', { name: /Ausgeben/ }).click();
	const handout = page.getByRole('dialog');
	await handout.getByRole('button', { name: /Stück ausgeben/ }).click();
	await expect(handout).toBeHidden();

	const after = await api<OrderDto>(page, 'GET', `/modules/orders/orders/${order.id}`);
	expect(after.status).toBe('delivered');
});

test('Einkauf mit Teillieferung', async ({ page }) => {
	await setup(page);
	const article = (await articles(page)).find((a) => a.title === title)!;
	const so = await api<SupplierOrderDto>(page, 'POST', '/modules/orders/supplier-orders', {
		supplier: `Stickerei ${run}`,
		orderedOn: new Date().toISOString().slice(0, 10),
		items: [{ variantId: article.variants[0]!.id, quantity: 10 }]
	});
	await api(page, 'POST', `/modules/orders/supplier-orders/${so.id}/receive`, {
		items: [{ itemId: so.items[0]!.id, quantity: 4 }]
	});

	await page.goto('/modules/orders?tab=einkauf');
	const row = page.getByRole('row', { name: new RegExp(so.number) });
	await expect(row.getByText('Teilweise geliefert')).toBeVisible();

	await page.goto('/modules/orders?tab=lager');
	// Lager blättert ab 20 Artikeln – über die Suche finden
	await page.getByLabel('Lager durchsuchen').fill(title);
	await expect(page.getByText(title).first()).toBeVisible();
});
