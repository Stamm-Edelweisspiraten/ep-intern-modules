import { expect, test, type Page } from '@playwright/test';

// PDF-Listen: Dialog „Mitgliederliste (PDF)“ mit Voreinstellung „Fahrt“, Spalte ändern, Erzeugen
// (Request-Body mit `selection`), Auswahl wird im Browser gemerkt.

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

test.describe.configure({ mode: 'serial' });

test('Mitgliederliste (PDF): Dialog, Voreinstellung Fahrt, Spalte ändern, Erzeugen', async ({
	page
}) => {
	await login(page);
	await ensureModules(page, ['members']);
	const lastName = `Liste${run}`;
	await api(page, 'POST', '/modules/members/members', {
		firstName: 'Lena',
		lastName,
		birthDate: '2015-05-05',
		street: 'Am Wall 1',
		postalCode: '28195',
		city: 'Bremen',
		country: 'DE',
		stage: 'woelfling',
		phones: [{ name: 'Notfall', value: '+49 421 1234567' }],
		emails: []
	});

	// Filter direkt über die URL: Tippen vor der Hydration bzw. das verzögerte URL-Update der Suche konkurrierte
	// mit dem Anhaken (ein Filterwechsel leert die Auswahl) – die Suche selbst prüft search.spec.ts (#62)
	await page.goto(`/modules/members?search=${lastName}`);
	const pick = page.getByRole('checkbox', { name: `Lena ${lastName} auswählen` });
	await expect(pick).toHaveCount(1);
	await pick.check();
	await expect(pick).toBeChecked();

	await page.getByRole('button', { name: 'Mitgliederliste (PDF)' }).click();
	const dialog = page.getByRole('dialog', { name: 'Mitgliederliste (PDF)' });
	await expect(dialog).toBeVisible();

	// Voreinstellung „Fahrt“: Ernährung an, Anschrift aus
	await expect(dialog.getByRole('checkbox', { name: 'Ernährung' })).toBeChecked();
	await expect(dialog.getByRole('checkbox', { name: 'Anschrift' })).not.toBeChecked();

	// Spalte zuschalten → Erzeugen schickt die Auswahl mit
	await dialog.getByRole('checkbox', { name: 'Anschrift' }).check();
	const request = page.waitForRequest(
		(r) => r.url().includes('/members/sheets.pdf') && r.method() === 'POST'
	);
	await dialog.getByRole('button', { name: 'PDF erzeugen' }).click();
	const body = JSON.parse((await request).postData() ?? '{}') as {
		ids: string[];
		selection: { columns: string[]; hideEmpty: boolean };
	};
	expect(body.ids).toHaveLength(1);
	expect(body.selection.columns).toContain('address');
	expect(body.selection.columns).toContain('name');
	// PDF-Renderer (Chromium) ist im E2E nicht immer verfügbar: Antwort nur prüfen, wenn sie ankommt
	const res = await (await request).response();
	if (res?.ok()) expect(res.headers()['content-type']).toContain('application/pdf');

	// Auswahl wird gemerkt: Dialog erneut öffnen, Anschrift bleibt gewählt
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Mitgliederliste (PDF)' }).click();
	await expect(
		page.getByRole('dialog', { name: 'Mitgliederliste (PDF)' }).getByRole('checkbox', {
			name: 'Anschrift'
		})
	).toBeChecked();
});

test('Mitgliederliste (PDF): Dialog passt auf ein Handy-Display', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await ensureModules(page, ['members']);
	// eigenes Mitglied statt positionsbasierter Auswahl fremder Daten (#62)
	const lastName = `Handy${run}`;
	await api(page, 'POST', '/modules/members/members', {
		firstName: 'Mia',
		lastName,
		birthDate: '2014-04-04',
		street: 'Am Wall 2',
		postalCode: '28195',
		city: 'Bremen',
		country: 'DE',
		stage: 'woelfling',
		phones: [],
		emails: []
	});
	await page.goto(`/modules/members?search=${lastName}`);
	const pick = page.getByRole('checkbox', { name: `Mia ${lastName} auswählen` });
	await expect(pick).toHaveCount(1);
	await pick.check();
	await page.getByRole('button', { name: 'Mitgliederliste (PDF)' }).click();
	const dialog = page.getByRole('dialog', { name: 'Mitgliederliste (PDF)' });
	await expect(dialog).toBeVisible();
	const box = await dialog.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	expect(box!.y + box!.height).toBeLessThanOrEqual(844);
	await expect(dialog.getByRole('button', { name: 'PDF erzeugen' })).toBeVisible();
});
