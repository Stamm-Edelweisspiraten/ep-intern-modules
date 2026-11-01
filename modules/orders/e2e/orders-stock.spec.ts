import { expect, test, type Page } from '@playwright/test';

// Lager: Artikel mit Größen als eine Zeile mit Summen (aufklappbar), Seitenwechsel ab 20 Artikeln;
// Größen im Bearbeiten-Dialog verschieben.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);
/** Optional: Screenshots für die visuelle Prüfung ablegen (`STOCK_SHOTS=<Ordner>`) */
const SHOTS = process.env.STOCK_SHOTS;

interface ArticleDto {
	id: string;
	title: string;
	variants: { id: string; label: string }[];
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

test('Lager fasst Größen zusammen und blättert', async ({ page }) => {
	await login(page);
	const list = await api<{ manifest: { id: string }; enabled: boolean }[]>(page, 'GET', '/modules');
	for (const id of ['members', 'orders']) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/modules/${id}/enable`);
		}
	}
	await page.reload();

	const kluft = `Kluft ${run}`;
	const article = await api<ArticleDto>(page, 'POST', '/modules/orders/articles', {
		title: kluft,
		variants: [
			{ label: 'S', priceCents: 3500, minStock: 2 },
			{ label: 'M', priceCents: 3500, minStock: 2 },
			{ label: 'L', priceCents: 3800 }
		]
	});
	const [s, m, l] = article.variants;
	for (const [v, stock] of [
		[s!, 3],
		[m!, 1],
		[l!, 5]
	] as const) {
		await api(page, 'POST', '/modules/orders/stock/corrections', { variantId: v.id, stock });
	}
	// Genug Artikel für eine zweite Seite (20 je Seite)
	for (let i = 1; i <= 21; i++) {
		await api(page, 'POST', '/modules/orders/articles', {
			title: `Aufnäher ${run} ${String(i).padStart(2, '0')}`,
			variants: [{ label: '', priceCents: 300 }]
		});
	}

	await page.goto('/modules/orders?tab=lager');
	await expect(page.getByRole('button', { name: 'Weiter' })).toBeVisible();
	await expect(page.getByText(/Seite 1 von \d+/)).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/lager-seite1.png`, fullPage: true });

	await page.getByLabel('Lager durchsuchen').fill(kluft);
	const row = page.getByRole('row', { name: new RegExp(kluft) }).first();
	await expect(row.getByText('3 Größen')).toBeVisible();
	// Summen: Bestand 3 + 1 + 5, Mindestbestand 2 + 2
	await expect(row.getByRole('cell', { name: '9', exact: true })).toBeVisible();
	await expect(row.getByText('1 unter Mindestbestand')).toBeVisible();
	// Bei aktiver Suche sind die Größen aufgeklappt
	await expect(page.getByRole('row', { name: /Größe M/ })).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/lager-suche.png`, fullPage: true });

	await page.getByLabel('Lager durchsuchen').fill('');
	await page.getByRole('button', { name: 'Weiter' }).click();
	await expect(page.getByText(/Seite 2 von \d+/)).toBeVisible();
	await page.getByRole('button', { name: 'Zurück' }).click();

	// Zu- und aufklappen ohne Suche (Kluft steht auf Seite 1 oder 2)
	let toggle = page.getByRole('button', { name: `Größen zeigen: ${kluft}` });
	if (!(await toggle.isVisible())) {
		await page.getByRole('button', { name: 'Weiter' }).click();
		toggle = page.getByRole('button', { name: `Größen zeigen: ${kluft}` });
	}
	await expect(page.getByRole('row', { name: /Größe M/ })).toHaveCount(0);
	await toggle.click();
	await expect(page.getByRole('row', { name: new RegExp(`${kluft}, Größe M`) })).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/lager-offen.png`, fullPage: true });
	await page.getByRole('button', { name: `Größen ausblenden: ${kluft}` }).click();
	await expect(page.getByRole('row', { name: /Größe M/ })).toHaveCount(0);

	if (SHOTS) {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: `${SHOTS}/lager-mobil.png`, fullPage: true });
		await page.setViewportSize({ width: 1280, height: 900 });
	}

	// Größen im Bearbeiten-Dialog verschieben: L nach ganz oben
	await page.goto('/modules/orders?tab=artikel');
	await page.getByLabel('Artikel durchsuchen').fill(kluft);
	await page
		.getByRole('row', { name: new RegExp(kluft) })
		.first()
		.click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('tab', { name: /Größen/ }).click();
	await dialog.getByRole('button', { name: 'Größe L nach oben' }).click();
	await dialog.getByRole('button', { name: 'Größe L nach oben' }).click();
	await expect(dialog.getByRole('button', { name: 'Größe L nach oben' })).toBeDisabled();
	await expect(dialog.locator('#variant-label-0')).toHaveValue('L');
	// Ziehen am Griff: M (Position 3) auf Position 2 → L, M, S
	await dialog
		.locator('[data-variant-row="2"] [title="Ziehen zum Verschieben"]')
		.dragTo(dialog.locator('[data-variant-row="1"]'));
	await expect(dialog.locator('#variant-label-1')).toHaveValue('M');
	await dialog.getByRole('button', { name: 'Größe M nach unten' }).click();
	await expect(dialog.locator('#variant-label-2')).toHaveValue('M');
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/groessen-verschieben.png` });
	await dialog.getByRole('button', { name: 'Speichern' }).click();
	await expect(dialog).toBeHidden();

	const saved = await api<ArticleDto>(page, 'GET', `/modules/orders/articles/${article.id}`);
	expect(saved.variants.map((v) => v.label)).toEqual(['L', 'S', 'M']);
	// IDs bleiben erhalten (nur umsortiert, nichts archiviert)
	expect(saved.variants.map((v) => v.id)).toEqual([l!.id, s!.id, m!.id]);
});
