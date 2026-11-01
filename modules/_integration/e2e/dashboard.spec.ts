import { expect, test, type Page } from '@playwright/test';

// Dashboard: „Zu erledigen“ und „Diese Woche“ aus allen Modulen, weitere Kacheln, „Anpassen“
// (ein-/ausblenden, Reihenfolge, Standard).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
/** Optional: Screenshots für die visuelle Prüfung ablegen (`DASH_SHOTS=<Ordner>`) */
const SHOTS = process.env.DASH_SHOTS;

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

async function api(page: Page, method: string, path: string, body?: unknown) {
	const res = await page.request.fetch(path, {
		method,
		headers: {
			origin: ORIGIN,
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		data: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
	return res.json();
}

const widgetOrder = (page: Page) =>
	page
		.locator('[data-testid="dashboard-grid"] > [data-widget]')
		.evaluateAll((els) => els.map((e) => e.getAttribute('data-widget')));

const saved = (page: Page) =>
	page.waitForResponse(
		(r) => r.url().endsWith('/dashboard/layout') && r.request().method() === 'PUT' && r.ok()
	);

test('Dashboard zeigt Kacheln und lässt sich anpassen', async ({ page }) => {
	await login(page);
	// Mindestens ein Modul aktiv, damit der Schnellzugriff Einträge hat; Anordnung auf Standard
	const { data: modules } = (await api(page, 'GET', '/api/v1/modules')) as {
		data: { manifest: { id: string }; enabled: boolean }[];
	};
	if (!modules.find((m) => m.manifest.id === 'members')?.enabled) {
		await api(page, 'POST', '/api/v1/modules/members/enable');
	}
	await api(page, 'PUT', '/dashboard/layout', { layout: null });
	await page.goto('/dashboard');

	await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
	// Neue Standardkacheln oben; Verwaltungskacheln sind standardmäßig aus
	let order = await widgetOrder(page);
	expect(order.slice(0, 2)).toEqual(['core:todos', 'core:week']);
	await expect(
		page.locator('[data-widget="core:todos"]').getByRole('heading', { name: 'Zu erledigen' })
	).toBeVisible();
	await expect(page.getByTestId('week-grid')).toBeVisible();
	const stats = page.locator('[data-widget="core:stats"]');
	await expect(stats).toHaveCount(0);
	await expect(page.locator('[data-widget="core:activity"]')).toHaveCount(0);

	if (SHOTS) {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.screenshot({ path: `${SHOTS}/dashboard-desktop.png`, fullPage: true });
	}

	// Kennzahlen und Aktivitäten einschalten → sichtbar, auch nach Reload
	await page.getByRole('button', { name: 'Anpassen' }).click();
	const sheet = page.getByRole('dialog', { name: 'Dashboard anpassen' });
	await expect(sheet).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-anpassen.png` });
	let save = saved(page);
	await sheet.getByRole('switch', { name: 'Kennzahlen anzeigen' }).click();
	await save;
	save = saved(page);
	await sheet.getByRole('switch', { name: 'Letzte Aktivitäten anzeigen' }).click();
	await save;
	await page.reload();
	await expect(stats.getByText('Aktive Benutzer*innen')).toBeVisible();

	// „Letzte Aktivitäten“ vor die Kennzahlen schieben
	await page.getByRole('button', { name: 'Anpassen' }).click();
	save = saved(page);
	await sheet.getByRole('button', { name: 'Letzte Aktivitäten nach oben' }).click();
	await save;
	await page.reload();
	await expect(page.locator('[data-widget="core:stats"]')).toBeVisible();
	order = await widgetOrder(page);
	expect(order.indexOf('core:activity')).toBeLessThan(order.indexOf('core:stats'));

	// Standard wiederherstellen
	await page.getByRole('button', { name: 'Anpassen' }).click();
	save = saved(page);
	await sheet.getByRole('button', { name: 'Standard wiederherstellen' }).click();
	await save;
	await page.reload();
	await expect(page.locator('[data-widget="core:todos"]')).toBeVisible();
	await expect(page.locator('[data-widget="core:stats"]')).toHaveCount(0);

	if (SHOTS) {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		await expect(page.getByTestId('week-list')).toBeVisible();
		await page.screenshot({ path: `${SHOTS}/dashboard-mobil.png`, fullPage: true });
	}
});

test('Mitglied sieht nur seine Kacheln; deaktiviertes Modul verschwindet', async ({
	page,
	browser
}) => {
	await login(page);
	const { data: modules } = (await api(page, 'GET', '/api/v1/modules')) as {
		data: { manifest: { id: string }; enabled: boolean }[];
	};
	for (const id of ['members', 'events', 'actions', 'treasury']) {
		if (!modules.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/api/v1/modules/${id}/enable`);
		}
	}
	const run = Date.now().toString(36);
	const today = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	const title = `Elternabend ${run}`;
	await api(page, 'POST', '/api/v1/modules/events/events', {
		title,
		startsOn: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
		groupIds: ['stamm'],
		shares: [{ type: 'everyone', id: '*', level: 'read' }]
	});
	// Rolle mit den Rechten eines Mitglieds (die Rolle „Mitglied“ enthält auch Rechte inaktiver Module,
	// die der Admin hier nicht vergeben darf)
	const role = (await api(page, 'POST', '/api/v1/roles', {
		name: `Mitglied ${run}`,
		permissions: ['events.event.view', 'actions.own.view', 'treasury.own.view']
	})) as { data: { id: string } };
	const memberRole = { id: role.data.id };
	const email = `mitglied-${run}@example.test`;
	const password = 'e2e-mitglied-passwort-1';
	await api(page, 'POST', '/api/v1/users', {
		name: `Mia ${run}`,
		email,
		password,
		roleIds: [memberRole!.id]
	});

	const ctx = await browser.newContext();
	const member = await ctx.newPage();
	await member.goto('/login');
	await member.getByLabel('E-Mail').fill(email);
	await member.getByLabel('Passwort').fill(password);
	await member.getByRole('button', { name: 'Anmelden' }).click();
	await member.waitForURL(/\/dashboard/);

	// Termin von heute steht in „Diese Woche“
	const week = member.getByTestId('week-grid');
	await expect(week.getByText(title)).toBeVisible();
	// Keine Verwaltungs- oder Kassen-Kacheln
	for (const key of ['core:stats', 'core:activity', 'treasury:tasks', 'actions:open-accounting']) {
		await expect(member.locator(`[data-widget="${key}"]`)).toHaveCount(0);
	}
	if (SHOTS) {
		await member.setViewportSize({ width: 1440, height: 900 });
		await member.screenshot({ path: `${SHOTS}/dashboard-mitglied.png`, fullPage: true });
	}

	// Modul deaktivieren → Termin weg; danach wieder aktivieren
	await api(page, 'POST', '/api/v1/modules/events/disable');
	try {
		await member.reload();
		await expect(member.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
		await expect(member.getByTestId('week-grid')).toBeVisible();
		await expect(member.getByTestId('week-grid').getByText(title)).toHaveCount(0);
	} finally {
		await api(page, 'POST', '/api/v1/modules/events/enable');
		await ctx.close();
	}
});
