import { expect, test, type Page } from '@playwright/test';

// Zuschussantrag (Abrechnung → Zuschussantrag): Leitungen setzen, speichern, PDF herunterladen.

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

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
	const res = await page.request.fetch(`/api/v1${path}`, {
		method: 'POST',
		headers: { origin: ORIGIN, 'content-type': 'application/json' },
		data: JSON.stringify(data)
	});
	if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
	return ((await res.json()) as { data: T }).data;
}

async function ensureModules(page: Page, ids: string[]) {
	const res = await page.request.fetch('/api/v1/modules', { headers: { origin: ORIGIN } });
	const list = ((await res.json()) as { data: { manifest: { id: string }; enabled: boolean }[] })
		.data;
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await post(page, `/modules/${id}/enable`, {});
		}
	}
}

test('Zuschussantrag: Leitungen festlegen und PDF herunterladen', async ({ page }, info) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await login(page);
	await ensureModules(page, ['members', 'actions']);

	const action = await post<{ id: string }>(page, '/modules/actions/actions', {
		name: `Sommerlager ${run}`,
		description: null,
		location: 'Zeltplatz',
		startsOn: '2026-07-10',
		startsTime: null,
		endsOn: '2026-07-16',
		endsTime: null
	});
	const base = `/modules/actions/actions/${action.id}/participants`;
	await post(page, base, { name: 'Kind Eins', birthDate: '2017-03-01', bremenResident: true });
	await post(page, base, { name: 'Jugend Eins', birthDate: '2011-03-01', bremenResident: true });
	for (const name of ['Anna Leitung', 'Ben Leitung']) {
		await post(page, base, {
			name,
			role: 'team',
			juleica: true,
			birthDate: '2004-01-01',
			bremenResident: true
		});
	}

	await page.goto(`/modules/actions/${action.id}?tab=accounting`);
	await page.getByRole('tab', { name: 'Zuschussantrag' }).click();
	await expect(page.getByRole('heading', { name: 'Leitungsteam' })).toBeVisible();
	await expect(page.getByText(/weibliche und\/oder männliche Leitung/)).toBeVisible();

	await page.locator('#sa-art').fill('Zeltlager');
	await page
		.getByRole('radiogroup', { name: 'Leitung Anna Leitung' })
		.getByRole('radio', { name: 'weiblich' })
		.click();
	await page
		.getByRole('radiogroup', { name: 'Leitung Ben Leitung' })
		.getByRole('radio', { name: 'männlich' })
		.click();
	await page.getByRole('button', { name: 'Speichern' }).click();
	await expect(page.getByText('Zuschussantrag gespeichert')).toBeVisible();
	await expect(page.getByText(/weibliche und\/oder männliche Leitung/)).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Ein Antrag' })).toBeVisible();

	await page.screenshot({ path: info.outputPath('zuschussantrag.png'), fullPage: true });
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: info.outputPath('zuschussantrag-mobil-dunkel.png'),
		fullPage: true
	});
	await page.emulateMedia({ colorScheme: 'light' });
	await page.setViewportSize({ width: 1280, height: 800 });

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Antrag als PDF' }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^Zuschussantrag-.*\.pdf$/);
	expect(errors).toEqual([]);
});
