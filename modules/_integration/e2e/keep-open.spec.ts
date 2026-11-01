import { expect, test, type Page } from '@playwright/test';

// „Weiteres Mitglied anlegen“ / „Weitere Buchung erfassen“: Dialog bleibt nach dem Speichern offen,
// Formular wird für den nächsten Eintrag geleert, „Abbrechen“ heißt danach „Fertig“.

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

/** JSON-API mit der Session der Seite; liefert `data` der Antwort. */
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

test('Mitglied anlegen: „Weiteres Mitglied anlegen“ lässt den Dialog offen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members']);
	await page.goto('/modules/members');
	await page.getByRole('button', { name: 'Mitglied anlegen' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Weiteres Mitglied anlegen')).toBeVisible();
	await dialog.getByLabel('Weiteres Mitglied anlegen').click();
	await expect(dialog.getByRole('button', { name: 'Speichern & weiter' })).toBeVisible();
	await page.screenshot({ path: 'test-results/keep-open-member.png' });

	const lastName = `Weiter${run}`;
	await page.locator('#m-first').fill('Paula');
	await page.locator('#m-last').fill(lastName);
	await page.locator('#m-birth').fill('2015-05-05');
	await page.locator('#m-street').fill('Am Wall 1');
	await page.locator('#m-postal').fill('28195');
	await page.locator('#m-city').fill('Bremen');
	await dialog.getByRole('tab', { name: 'Mitgliedschaft' }).click();
	await page.locator('#m-stage').click();
	await page.getByRole('option').first().click();
	await dialog.getByRole('button', { name: 'Speichern & weiter' }).click();

	await expect(dialog.getByRole('button', { name: 'Fertig' })).toBeVisible();
	await expect(page.locator('#m-first')).toHaveValue('');
	await expect(page.locator('#m-first')).toBeFocused();
	await expect(page.locator('#m-last')).toHaveValue('');
	await expect(dialog.getByRole('tab', { name: 'Person' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(dialog.getByRole('tab', { name: 'Mitgliedschaft' })).toHaveAttribute(
		'aria-selected',
		'false'
	);
	// Animationen beim Screenshot beenden statt fest zu warten (#75)
	await page.screenshot({
		path: 'test-results/keep-open-member-after.png',
		animations: 'disabled'
	});

	await dialog.getByRole('button', { name: 'Fertig' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByText(lastName).first()).toBeVisible();
});

test('Abrechnung: „Weitere Buchung erfassen“ lässt den Dialog offen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'actions']);
	const action = await api<{ id: string }>(page, 'POST', '/modules/actions/actions', {
		name: `Weiterfahrt ${run}`,
		startsOn: '2026-12-01'
	});
	await page.goto(`/modules/actions/${action.id}`);
	await page.getByRole('tab', { name: 'Abrechnung' }).click();
	await page.getByRole('button', { name: 'Buchung hinzufügen' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Weitere Buchung erfassen').click();
	await page.screenshot({ path: 'test-results/keep-open-entry.png' });

	await page.locator('#acc-category').click();
	await page.getByRole('option').first().click();
	await page.locator('#acc-description').fill('Zeltmiete');
	await page.locator('#acc-amount').fill('12,50');
	// ohne Haken wären Empfänger/IBAN/Zweck Pflicht (offene Stamm-Ausgabe)
	await dialog.getByLabel('Bereits bezahlt').check();
	await dialog.getByRole('button', { name: 'Speichern & weiter' }).click();

	await expect(dialog.getByRole('button', { name: 'Fertig' })).toBeVisible();
	await expect(page.locator('#acc-description')).toHaveValue('');
	await expect(page.locator('#acc-description')).toBeFocused();
	await page.screenshot({ path: 'test-results/keep-open-entry-after.png' });

	await dialog.getByRole('button', { name: 'Fertig' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByText('Zeltmiete').first()).toBeVisible();
});
