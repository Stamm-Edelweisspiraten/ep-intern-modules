import { expect, test, type Page } from '@playwright/test';

// Aufgaben (Basismodul aus atrium-basic-modules) zusammen mit `actions`: Board aus einer Aktion mit Vorlage
// „Fahrt / Lager“ (verschoben aus modules/tasks/e2e/tasks.spec.ts).

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

test('Aktion: Board mit Vorlage „Fahrt / Lager“ anlegen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'actions', 'tasks']);
	const action = await api<{ id: string }>(page, 'POST', '/modules/actions/actions', {
		name: `Fahrt ${run}`,
		startsOn: '2027-05-14',
		endsOn: '2027-05-17'
	});
	await page.goto(`/modules/actions/${action.id}`);
	await page.getByRole('button', { name: 'Board anlegen' }).click();
	await page.getByRole('menuitem', { name: /Fahrt \/ Lager/ }).click();
	await page.waitForURL(/\/modules\/tasks\/[0-9a-f-]{36}/);
	await expect(page.getByRole('heading', { name: `Fahrt ${run}`, level: 1 })).toBeVisible();
	for (const name of ['Planung', 'Anmeldung', 'Vorbereitung', 'Lager', 'Nachbereitung']) {
		await expect(page.getByRole('button', { name: new RegExp(`^Phase ${name},`) })).toBeVisible();
	}
	await expect(page.getByRole('button', { name: /Anmeldeschluss/ }).first()).toBeVisible();
	await page.goto(`/modules/actions/${action.id}`);
	await expect(page.getByRole('link', { name: 'Board öffnen' })).toBeVisible();
});
