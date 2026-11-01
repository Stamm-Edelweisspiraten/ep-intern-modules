import { expect, test, type Page } from '@playwright/test';

// Aktionsliste: lädt ohne Konsolenfehler (Regression `effect_update_depth_exceeded`) und
// Anlegen einer Aktion mit dem Häkchen „liegt bereits in der Vergangenheit“.

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

async function ensureModules(page: Page, ids: string[]) {
	const res = await page.request.fetch('/api/v1/modules', { headers: { origin: ORIGIN } });
	const list = ((await res.json()) as { data: { manifest: { id: string }; enabled: boolean }[] })
		.data;
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			const r = await page.request.fetch(`/api/v1/modules/${id}/enable`, {
				method: 'POST',
				headers: { origin: ORIGIN }
			});
			if (!r.ok()) throw new Error(`enable ${id}: ${r.status()} ${await r.text()}`);
		}
	}
}

test.describe.configure({ mode: 'serial' });

test('Aktionsliste lädt ohne Konsolenfehler', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(`console: ${m.text()}`);
	});
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

	await login(page);
	await ensureModules(page, ['members', 'actions']);
	await page.goto('/modules/actions');
	await expect(page.getByRole('heading', { name: 'Aktionen', exact: true })).toBeVisible();
	// Tabellenzeile oder Leerzustand (kein dauerhaftes Skeleton)
	await expect(
		page
			.getByRole('row')
			.nth(1)
			.or(page.getByText(/keine aktionen/i).first())
	).toBeVisible();
	// Begründete feste Wartezeit (#75): Eine Effekt-Endlosschleife zeigt sich nur über die Zeit –
	// es gibt kein Ereignis, auf das man warten könnte. 1 s Beobachtungsfenster.
	await page.waitForTimeout(1000);
	expect(errors.filter((e) => e.includes('effect_update_depth_exceeded'))).toEqual([]);
	expect(errors).toEqual([]);
});

test('Aktion mit Vergangenheit-Häkchen anlegen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'actions']);
	const name = `Vergangene Fahrt ${run}`;
	await page.goto('/modules/actions');
	await page.getByRole('button', { name: 'Aktion anlegen' }).click();
	await page.locator('#a-name').fill(name);
	await page.locator('#a-starts-on').fill('2026-03-01');
	await page.locator('#a-ends-on').fill('2026-03-03');
	// Vorbelegung: Ende liegt in der Vergangenheit
	const box = page.locator('#a-is-past');
	await expect(box).toHaveAttribute('data-state', 'checked');
	await page.getByRole('button', { name: 'Speichern' }).click();

	await page.goto(`/modules/actions?search=${encodeURIComponent(name)}`);
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toBeVisible();
	await expect(row.getByText('Vergangen', { exact: true })).toBeVisible();
});
