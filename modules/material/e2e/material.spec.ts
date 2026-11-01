import { expect, test, type Page } from '@playwright/test';

// Material v2: Lagertabelle und zentrierter Artikel-Dialog (auch über den QR-Link `/scan/<code>`),
// Reservieren wie „Bestellen“ (Katalog → Detail → Warenkorb → Reservieren), Etiketten-Kacheln und echtes PDF.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);
const M = '/modules/material';

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

interface Item {
	id: string;
	code: string;
	name: string;
}

async function setup(page: Page) {
	await login(page);
	const list = await api<{ manifest: { id: string }; enabled: boolean }[]>(page, 'GET', '/modules');
	if (!list.find((m) => m.manifest.id === 'material')?.enabled) {
		await api(page, 'POST', `${M}/enable`);
	}
	const cat = await api<{ id: string }>(page, 'POST', `${M}/categories`, {
		name: `Zelte ${run}`,
		icon: 'tent',
		color: '#92400e'
	});
	const loc = await api<{ id: string; code: string }>(page, 'POST', `${M}/locations`, {
		name: `Kiste ${run}`
	});
	const type = await api<{ id: string }>(page, 'POST', `${M}/types`, {
		name: `Kohtenbahn ${run}`,
		categoryId: cat.id
	});
	const items = await api<Item[]>(page, 'POST', `${M}/items`, {
		typeId: type.id,
		name: `K${run}.`,
		count: 3,
		locationId: loc.id
	});
	return { loc, type, items };
}

test('Reiter wechseln ohne Reload', async ({ page }) => {
	await setup(page);
	await page.goto(M);
	await page.getByRole('tab', { name: 'Lager' }).click();
	await expect(page.getByRole('textbox', { name: 'Lager durchsuchen' })).toBeVisible();
	await page.getByRole('tab', { name: 'Etiketten' }).click();
	await expect(page.getByRole('button', { name: /Erstellen/ })).toBeVisible();
	await page.getByRole('tab', { name: 'Reservieren' }).click();
	await expect(page.getByRole('searchbox', { name: 'Material suchen' })).toBeVisible();
	await page.getByRole('tab', { name: 'Meine Reservierungen' }).click();
	await expect(page).toHaveURL(/tab=meine/);
	await expect(page.getByRole('searchbox', { name: 'Material suchen' })).toBeHidden();
});

test('Lager: Tabelle, Artikel-Dialog zentriert, QR-Link öffnet den Artikel', async ({ page }) => {
	const { items } = await setup(page);
	const first = items[0]!;
	await page.goto(`${M}?tab=lager`);
	// Erst tippen, wenn die Tabelle im Browser geladen ist (sonst geht die Eingabe vor der Hydrierung verloren)
	await expect(page.getByRole('button', { name: `Kohtenbahn ${run}` }).first()).toBeVisible();
	await page.getByRole('textbox', { name: 'Lager durchsuchen' }).fill(first.code);
	await expect(page.getByText(first.name).first()).toBeVisible();

	await page.goto(`${M}/scan/${first.code}`);
	await page.waitForURL(/tab=lager/);
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText(first.code).first()).toBeVisible();
	// zentriert (kein Seitenblatt): Mitte des Dialogs ≈ Mitte des Fensters
	const box = (await dialog.boundingBox())!;
	const width = page.viewportSize()!.width;
	expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(40);
});

test('Reservieren: Katalog → konkreter Artikel → Warenkorb → Reservierung', async ({ page }) => {
	const { type, items } = await setup(page);
	const title = `E2E ${run}`;
	await page.goto(`${M}?from=2031-05-02&to=2031-05-03&title=${encodeURIComponent(title)}`);
	await page.getByRole('searchbox', { name: 'Material suchen' }).fill(`Kohtenbahn ${run}`);
	await page
		.getByRole('button', { name: `Kohtenbahn ${run} ansehen` })
		.first()
		.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await dialog
		.getByRole('checkbox', { name: new RegExp(items[1]!.name.replace('.', '\\.')) })
		.click();
	await dialog.getByRole('button', { name: 'In den Warenkorb' }).click();
	await expect(dialog).toBeHidden();

	await page.getByRole('button', { name: 'Reservieren', exact: true }).click();
	const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
	await confirm.getByRole('button', { name: 'Reservieren', exact: true }).click();
	await expect(page.getByText(title).first()).toBeVisible();

	const mine = await api<{ items: { title: string; itemSummary: string }[] }>(
		page,
		'GET',
		`${M}/reservations?state=all`
	);
	const r = mine.items.find((x) => x.title === title)!;
	expect(r.itemSummary).toBe(items[1]!.name);
	void type;
});

test('Etiketten: Kacheln, Designer, echtes PDF', async ({ page }) => {
	const { items } = await setup(page);
	const tpl = await api<{ id: string }>(page, 'POST', `${M}/label-templates`, {
		name: `Bahn ${run}`,
		target: 'item',
		formatKey: 'brother-62x29',
		layout: {
			widthMm: 62,
			heightMm: 29,
			elements: [
				{
					id: 'n',
					type: 'text',
					x: 2,
					y: 2,
					w: 58,
					h: 6,
					text: '{type} {name}',
					fontSizePt: 11,
					bold: true,
					align: 'left',
					valign: 'top',
					maxLines: 1
				},
				{
					id: 'b',
					type: 'barcode',
					x: 2,
					y: 9,
					w: 58,
					h: 12,
					symbology: 'code128',
					value: '{code}'
				}
			]
		}
	});
	await page.goto(`${M}?tab=etiketten`);
	await expect(page.getByRole('button', { name: /Erstellen/ })).toBeVisible();
	await expect(page.getByText(`Bahn ${run}`).first()).toBeVisible();

	await page.goto(`${M}/labels/${tpl.id}`);
	await expect(page.locator('input').first()).toHaveValue(`Bahn ${run}`);

	const pdf = await page.request.post(`/api/v1${M}/labels.pdf`, {
		headers: { origin: ORIGIN, 'content-type': 'application/json' },
		data: JSON.stringify({ templateId: tpl.id, target: 'item', ids: items.map((i) => i.id) })
	});
	expect(pdf.status()).toBe(200);
	expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('Sets und Zelte: Zelt reservieren, Zuteilung im Detail, Ausgabe markieren', async ({
	page
}) => {
	const { type, items } = await setup(page);
	const set = await api<{ id: string; name: string }>(page, 'POST', `${M}/sets`, {
		name: `S${run}`,
		itemIds: items.map((i) => i.id)
	});
	const tent = await api<{ id: string }>(page, 'POST', `${M}/tents`, {
		name: `Mini-Kohte ${run}`,
		parts: [{ kind: 'type', typeId: type.id, label: 'Bahnen', quantity: 3, fromOneSet: true }]
	});

	// Lager → Sets und Zelte
	await page.goto(`${M}?tab=lager&view=sets`);
	await expect(page.getByRole('heading', { name: `Set ${set.name}` })).toBeVisible();
	await page.getByRole('tab', { name: /Zelte/ }).click();
	await expect(page.getByRole('heading', { name: `Mini-Kohte ${run}` })).toBeVisible();

	// Reservieren über die API, Zuteilung im Detail
	const from = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
	const r = await api<{ id: string }>(page, 'POST', `${M}/reservations`, {
		title: `Zeltlager ${run}`,
		startsOn: from,
		endsOn: from,
		lines: [{ kind: 'tent', tentId: tent.id, quantity: 1 }]
	});
	await page.goto(`${M}?tab=alle&open=${r.id}`);
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText(`Zelt 1 · Set ${set.name}:`)).toBeVisible();
	for (const i of items) await expect(dialog.getByText(i.name, { exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Ausgegeben' }).click();
	await expect(dialog.getByRole('button', { name: 'Ausgabe zurücknehmen' })).toBeVisible();
	await expect(dialog.getByText('Ausgegeben', { exact: true }).first()).toBeVisible();
});
