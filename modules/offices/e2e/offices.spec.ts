import { expect, test, type Page } from '@playwright/test';

// Ämter: Amt über den Dialog anlegen, Person zuordnen, Reihenfolge per Pfeiltasten ändern.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);

interface OfficeDto {
	id: string;
	name: string;
	holders: { userId: string; name: string }[];
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

const listOffices = (page: Page) => api<OfficeDto[]>(page, 'GET', '/modules/offices/offices');

test.describe.configure({ mode: 'serial' });

const personName = `Paula Amt ${run}`;
const officeName = `Stammesführung ${run}`;

test('Amt anlegen und Person zuordnen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['offices']);
	await api(page, 'POST', '/users', {
		name: personName,
		email: `paula-${run}@example.test`,
		password: 'e2e-paula-password-1'
	});

	await page.goto('/modules/offices');
	await expect(page.getByRole('heading', { name: 'Ämter', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Amt anlegen' }).first().click();

	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: 'Amt anlegen' })).toBeVisible();
	await dialog.locator('#office-name').fill(officeName);
	await dialog.locator('#office-description').fill('Leitet den Stamm');

	await dialog.getByRole('tab', { name: /Inhaber\*innen/ }).click();
	await dialog.locator('#office-holder-search').fill(personName.slice(0, 10));
	await dialog.getByRole('button', { name: new RegExp(personName) }).click();
	await expect(dialog.getByRole('button', { name: `${personName} entfernen` })).toBeVisible();

	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	await expect(dialog).toBeHidden();

	const holders = page.getByRole('region', { name: `Inhaber*innen von ${officeName}` });
	await expect(holders.getByText(personName, { exact: true }).last()).toBeVisible();

	const office = (await listOffices(page)).find((o) => o.name === officeName);
	expect(office?.holders.map((h) => h.name)).toEqual([personName]);
});

test('Reihenfolge ändern', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['offices']);
	const lastName = `Materialwart ${run}`;
	await api(page, 'POST', '/modules/offices/offices', { name: lastName });

	const before = await listOffices(page);
	expect(before.length).toBeGreaterThan(1);
	expect(before.at(-1)!.name).toBe(lastName);
	const previous = before.at(-2)!;

	await page.goto('/modules/offices');
	await page.getByRole('button', { name: 'Reihenfolge ändern' }).click();
	await page.getByRole('button', { name: `${lastName} nach oben` }).click();
	await page.getByRole('button', { name: 'Reihenfolge speichern' }).click();
	await expect(page.getByText('Reihenfolge gespeichert')).toBeVisible();

	const after = await listOffices(page);
	expect(after.map((o) => o.id)).toHaveLength(before.length);
	expect(after.at(-1)!.id).toBe(previous.id);
	expect(after.at(-2)!.name).toBe(lastName);
});
