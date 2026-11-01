import { expect, test, type Page } from '@playwright/test';

// Benachrichtigungen: Profil-Reiter mit Regler je Typ, Admin-Reiter, PWA-Dateien (Manifest, Service Worker).
// Ein echtes Push-Abo braucht den Push-Dienst des Browsers (FCM) und ist hier nicht prüfbar.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
/** Optional: Screenshots für die visuelle Prüfung ablegen (`NOTIFY_SHOTS=<Ordner>`) */
const SHOTS = process.env.NOTIFY_SHOTS;

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

test('PWA: Manifest, Icons und Service Worker sind ohne Anmeldung erreichbar', async ({
	request
}) => {
	const manifest = await request.get('/manifest.webmanifest');
	expect(manifest.ok()).toBe(true);
	const json = await manifest.json();
	expect(json.display).toBe('standalone');
	expect(json.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
	expect((await request.get('/icons/icon-192.png')).ok()).toBe(true);
	expect((await request.get('/icons/apple-touch-icon.png')).ok()).toBe(true);
	const sw = await request.get('/service-worker.js');
	expect(sw.ok()).toBe(true);
	expect(await sw.text()).toContain('showNotification');
});

test('Profil: Kanal je Benachrichtigung wählen und behalten', async ({ page }) => {
	await login(page);
	for (const id of ['members', 'actions']) {
		const res = await page.request.post(`/api/v1/modules/${id}/enable`, {
			headers: { origin: ORIGIN }
		});
		expect([200, 201, 409], await res.text()).toContain(res.status());
	}

	await page.goto('/profile?tab=notifications');
	await expect(page.getByRole('heading', { name: 'Was bekomme ich wie?' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Dieses Gerät' })).toBeVisible();

	const group = page.getByRole('radiogroup', {
		name: 'Kanal für Neue Auslagen über den Kosten-Link'
	});
	await expect(group.getByRole('radio', { name: 'E-Mail' })).toHaveAttribute(
		'data-state',
		'checked'
	);
	const saved = page.waitForResponse(
		(r) =>
			r.url().endsWith('/api/v1/notifications/preferences') &&
			r.request().method() === 'PUT' &&
			r.ok()
	);
	await group.getByRole('radio', { name: 'Push' }).click();
	await saved;
	await expect(page.getByText('Solange kein Gerät für Push aktiv ist')).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/profile-notifications.png`, fullPage: true });
	if (SHOTS) {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.evaluate(() => document.documentElement.classList.add('dark'));
		await page.screenshot({
			path: `${SHOTS}/profile-notifications-mobile-dark.png`,
			fullPage: true
		});
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.emulateMedia({ colorScheme: 'light' });
		await page.evaluate(() => document.documentElement.classList.remove('dark'));
	}

	await page.reload();
	await expect(
		page
			.getByRole('radiogroup', { name: 'Kanal für Neue Auslagen über den Kosten-Link' })
			.getByRole('radio', { name: 'Push' })
	).toHaveAttribute('data-state', 'checked');

	// zurück auf den Standard
	const back = page.waitForResponse(
		(r) => r.url().endsWith('/api/v1/notifications/preferences') && r.request().method() === 'PUT'
	);
	await page
		.getByRole('radiogroup', { name: 'Kanal für Neue Auslagen über den Kosten-Link' })
		.getByRole('radio', { name: 'E-Mail' })
		.click();
	expect((await back).ok()).toBe(true);
});

test('Verwaltung: Reiter Benachrichtigungen mit Schalter und Schlüssel', async ({ page }) => {
	await login(page);
	await page.goto('/admin/settings/notifications');
	await expect(page.getByText('Push-Benachrichtigungen').first()).toBeVisible();
	await expect(page.getByText('Öffentlicher Schlüssel')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Schlüssel neu erzeugen' })).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-notifications.png`, fullPage: true });
});
