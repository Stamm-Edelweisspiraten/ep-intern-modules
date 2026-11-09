import { expect, test, type Page } from '@playwright/test';

// Whiteboards (Basismodul aus atrium-basic-modules) zusammen mit `actions`: Whiteboard aus der Aktions-Übersicht
// anlegen (verschoben aus modules/whiteboard/e2e/whiteboard.spec.ts).

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

test('Whiteboard aus der Aktion anlegen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'actions', 'whiteboard']);
	const action = await api<{ id: string }>(page, 'POST', '/modules/actions/actions', {
		name: `Herbstfahrt ${run}`,
		startsOn: '2027-10-01'
	});
	await page.goto(`/modules/actions/${action.id}`);
	const card = page.locator('[data-slot="card"]', { hasText: 'Whiteboards' });
	await card.getByRole('button', { name: 'Whiteboard' }).click();
	await page.waitForURL(/\/modules\/whiteboard\/[0-9a-f-]{36}/);
	await expect(page.getByRole('heading', { name: `Herbstfahrt ${run}` })).toBeVisible();
	await page.goto(`/modules/actions/${action.id}`);
	await expect(card.getByRole('link', { name: new RegExp(`Herbstfahrt ${run}`) })).toBeVisible();
});
