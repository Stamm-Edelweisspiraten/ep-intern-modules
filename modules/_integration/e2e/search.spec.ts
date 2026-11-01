import { expect, test, type Page } from '@playwright/test';

// Globale Suche (Befehlspalette) findet Daten aus Modulen; Sidebar scrollt auf kleinen Bildschirmen.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);
/** Optional: Screenshots für die visuelle Prüfung ablegen (`SEARCH_SHOTS=<Ordner>`) */
const SHOTS = process.env.SEARCH_SHOTS;

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

async function api(page: Page, method: string, path: string, body?: unknown) {
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
	return text ? (JSON.parse(text) as { data: unknown }).data : null;
}

async function setup(page: Page) {
	await login(page);
	const modules = (await api(page, 'GET', '/modules')) as {
		manifest: { id: string };
		enabled: boolean;
	}[];
	for (const id of ['members', 'actions', 'events', 'galleries', 'files', 'offices', 'orders']) {
		if (!modules.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/modules/${id}/enable`);
		}
	}
	await page.reload();
}

test('Suche findet ein Mitglied und öffnet es', async ({ page }) => {
	await setup(page);
	const lastName = `Sucher${run}`;
	await api(page, 'POST', '/modules/members/members', {
		firstName: 'Sina',
		lastName,
		birthDate: '2013-04-02',
		street: 'Am Wall 1',
		postalCode: '28195',
		city: 'Bremen',
		country: 'DE',
		stage: 'pfadfinder',
		emails: [{ name: 'Eltern', value: `sina-${run}@example.test` }]
	});

	await page.getByRole('button', { name: 'Suchen (Strg+K)' }).click();
	const box = page.getByRole('combobox', { name: /Suchen/ });
	await box.fill(lastName);
	const hit = page.getByRole('option', { name: new RegExp(`Sina ${lastName}`) });
	await expect(hit).toBeVisible();
	await expect(page.getByRole('listbox').getByText('Mitglied', { exact: true })).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/suche-mitglied.png` });

	await box.press('ArrowDown');
	await hit.click();
	await page.waitForURL(/\/modules\/members/);
	await expect(page.getByRole('dialog').getByText(lastName).first()).toBeVisible();
});

test('Suche findet Seiten und Benutzer*innen der Verwaltung', async ({ page }) => {
	await setup(page);
	await page.getByRole('button', { name: 'Suchen (Strg+K)' }).click();
	const box = page.getByRole('combobox', { name: /Suchen/ });
	await box.fill('admin@example');
	await expect(page.getByRole('option', { name: /Administrator/ }).first()).toBeVisible();
	await box.fill('Datensicherung');
	await expect(page.getByRole('option', { name: /Datensicherung/ }).first()).toBeVisible();
});

test('Sidebar scrollt auf kleinen Bildschirmen', async ({ page }) => {
	await setup(page);
	// Desktop mit wenig Höhe: Sidebar bleibt stehen und scrollt selbst
	await page.setViewportSize({ width: 1280, height: 420 });
	await page.goto('/dashboard');
	const nav = page.locator('aside > div.overflow-y-auto');
	await expect(nav).toBeVisible();
	// Administration aufklappen, damit die Liste länger als der Bildschirm wird
	const adminToggle = page.locator('aside').getByRole('button', { name: /Administration/ });
	if ((await adminToggle.getAttribute('aria-expanded')) !== 'true') await adminToggle.click();
	const overflow = await nav.evaluate((el) => el.scrollHeight > el.clientHeight);
	expect(overflow).toBe(true);
	await nav.evaluate((el) => el.scrollTo(0, el.scrollHeight));
	expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
	const aside = await page.locator('aside').boundingBox();
	expect(aside!.height).toBeLessThanOrEqual(420);

	// Handy: Menü öffnen, Liste scrollt bis zum letzten Eintrag
	await page.setViewportSize({ width: 390, height: 560 });
	await page.getByRole('button', { name: 'Navigation öffnen' }).click();
	const sheet = page.getByRole('dialog');
	const mobileNav = sheet.locator('div.overflow-y-auto');
	const mobileToggle = sheet.getByRole('button', { name: /Administration/ });
	if ((await mobileToggle.getAttribute('aria-expanded')) !== 'true') await mobileToggle.click();
	expect(await mobileNav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	const last = mobileNav.getByRole('link').last();
	await last.scrollIntoViewIfNeeded();
	await expect(last).toBeInViewport();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/sidebar-mobil.png` });
});
