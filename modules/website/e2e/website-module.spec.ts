import { expect, test, type Page } from '@playwright/test';

// Modul „Website“ (ohne S3): Beitrag anlegen, Text schreiben, speichern (Hinweis „Alles gespeichert“ direkt nach dem Laden –
// Regression: setEditable löste ein Update aus), veröffentlichen, zurückziehen; Banner anlegen; Fragen sortieren.
// Bilder im Text prüfen die Integrationstests (fake-storage).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

async function ensureWebsiteModule(page: Page) {
	const res = await page.request.get('/api/v1/modules', { headers: { origin: ORIGIN } });
	const list = ((await res.json()) as { data: { manifest: { id: string }; enabled: boolean }[] })
		.data;
	if (!list.find((m) => m.manifest.id === 'website')?.enabled) {
		const r = await page.request.post('/api/v1/modules/website/enable', {
			headers: { origin: ORIGIN }
		});
		expect(r.ok()).toBe(true);
		await page.reload();
	}
}

test.describe.configure({ mode: 'serial' });

test('Beitrag schreiben, speichern, veröffentlichen und zurückziehen', async ({ page }) => {
	await login(page);
	await ensureWebsiteModule(page);
	await page.goto('/modules/website');
	await expect(page.getByRole('heading', { name: 'Website', exact: true })).toBeVisible();

	const title = `Herbstfahrt ${run}`;
	await page.getByRole('button', { name: 'Beitrag schreiben' }).click();
	await page.getByLabel('Titel').fill(title);
	await page.getByRole('button', { name: 'Anlegen' }).click();
	await page.waitForURL(/\/modules\/website\/posts\//);

	const status = page.getByRole('region', { name: 'Speichern' });
	await expect(status).toContainText('Alles gespeichert');
	await expect(page.getByLabel('Adresse')).toHaveValue(`herbstfahrt-${run}`);

	await page.getByLabel('Kurzbeschreibung').fill('Drei Tage an der Weser.');
	const editor = page.getByRole('textbox', { name: 'Text des Beitrags' });
	await editor.click();
	await editor.pressSequentially('Wir sind gepaddelt.');
	await expect(status).toContainText('Ungespeicherte Änderungen');
	await status.getByRole('button', { name: 'Speichern' }).click();
	await expect(status).toContainText('Alles gespeichert');

	// Nach dem Neuladen gilt der gespeicherte Text nicht als geändert
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Text des Beitrags' })).toContainText(
		'Wir sind gepaddelt.'
	);
	await expect(page.getByRole('region', { name: 'Speichern' })).toContainText('Alles gespeichert');

	await page.getByRole('button', { name: 'Veröffentlichen' }).click();
	await page.getByRole('button', { name: 'Jetzt veröffentlichen' }).click();
	await expect(page.getByText('Veröffentlicht', { exact: true }).first()).toBeVisible();
	await page.getByRole('button', { name: 'Zurückziehen' }).click();
	await expect(page.getByText('Entwurf', { exact: true }).first()).toBeVisible();
});

test('Banner anlegen und Fragen sortieren', async ({ page }) => {
	await login(page);
	await ensureWebsiteModule(page);
	await page.goto('/modules/website/banners');
	await page.getByRole('button', { name: 'Banner anlegen' }).click();
	await page
		.getByRole('textbox', { name: 'Text', exact: true })
		.fill(`Ferien ${run}: keine Gruppenstunden.`);
	await page.getByRole('button', { name: 'Speichern' }).click();
	await expect(page.getByText(`Ferien ${run}: keine Gruppenstunden.`)).toBeVisible();
	await expect(page.getByText('Läuft').first()).toBeVisible();

	await page.goto('/modules/website/faq');
	const first = page.locator('ol > li').first();
	const question = (await first.locator('p.font-medium').textContent())?.trim() ?? '';
	await first.getByRole('button', { name: 'Nach unten' }).click();
	await expect(page.locator('ol > li').nth(1).locator('p.font-medium')).toHaveText(question);
});
