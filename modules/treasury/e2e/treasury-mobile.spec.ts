import { expect, test, type Page } from '@playwright/test';

// Kasse auf Handy und Tablet: Bereichsleiste unten, Blätter von unten (Zurück schließt nur das Blatt),
// „Zahlung erfassen“ in drei Schritten, Liste | Details auf dem Tablet. Der Desktop bleibt unverändert.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const run = Date.now().toString(36);
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const TABLET = { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true };

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
			// gleiche Herkunft wie die geladene Seite (CSRF-Prüfung)
			origin: new URL(page.url()).origin,
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

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Konto + manuelle Rechnung über 12,34 € an „<name>“ anlegen */
async function seed(page: Page, name: string): Promise<{ invoiceId: string }> {
	await ensureModules(page, ['members', 'actions', 'treasury']);
	const accounts = await api<{ id: string; archived: boolean }[]>(
		page,
		'GET',
		'/modules/treasury/accounts'
	);
	if (!accounts.some((a) => !a.archived)) {
		await api(page, 'POST', '/modules/treasury/accounts', {
			name: `Barkasse ${run}`,
			kind: 'cash',
			openingBalanceCents: 0,
			openingDate: today()
		});
	}
	const inv = await api<{ id: string }>(page, 'POST', '/modules/treasury/invoices', {
		recipientName: name,
		issuedOn: today(),
		dueOn: today(),
		lines: [{ description: 'Halstuch', amountCents: 1234 }]
	});
	return { invoiceId: inv.id };
}

async function overflows(page: Page): Promise<boolean> {
	return page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
	);
}

test.describe('Kasse auf dem Handy', () => {
	test.use(PHONE);

	test('Bereichsleiste, Blätter und Zurück-Geste', async ({ page }) => {
		await login(page);
		await seed(page, `Blatt ${run}`);
		await page.goto('/modules/treasury');
		const bar = page.getByRole('navigation', { name: 'Bereiche der Kasse' });
		await expect(bar).toBeVisible();
		// Desktop-Kopf mit „Buchung“-Knopf gibt es auf dem Handy nicht
		await expect(page.getByRole('button', { name: /Neue Buchung/ })).toHaveCount(0);

		for (const [label, url] of [
			['Eingänge', /tab=income/],
			['Ausgänge', /tab=outgoing/],
			['Buchungen', /tab=transactions/],
			['Übersicht', /tab=overview/]
		] as const) {
			await bar.getByRole('button', { name: label }).click();
			await expect(page).toHaveURL(url);
			await page.waitForLoadState('networkidle');
			expect(await overflows(page), `${label} läuft seitlich über`).toBe(false);
		}

		// „Neu“ öffnet das Blatt; Zurück schließt nur das Blatt, die Seite bleibt
		await bar.getByRole('button', { name: 'Neu' }).click();
		const sheet = page.getByRole('dialog', { name: 'Neu erfassen' });
		await expect(sheet).toBeVisible();
		await page.goBack();
		await expect(sheet).toBeHidden();
		await expect(page).toHaveURL(/\/modules\/treasury/);
		await expect(bar).toBeVisible();

		// ⋯ öffnet Seltenes, ✕ schließt
		await page.getByRole('button', { name: 'Weitere Aktionen der Kasse' }).click();
		const more = page.getByRole('dialog', { name: 'Kasse' });
		await expect(more.getByRole('button', { name: /Jetzt abgleichen/ })).toBeVisible();
		await more.getByRole('button', { name: 'Schließen' }).click();
		await expect(more).toBeHidden();
	});

	test('Offene Posten: Aktionsblatt und Auswahl per langem Drücken', async ({ page }) => {
		const name = `Posten ${run}`;
		await login(page);
		await seed(page, name);
		await page.goto('/modules/treasury?tab=income&view=open');
		await page.getByRole('searchbox', { name: 'Offene Posten durchsuchen' }).fill(name);
		const row = page.getByRole('button', { name: new RegExp(name) }).first();
		await expect(row).toBeVisible();

		await row.click();
		const sheet = page.getByRole('dialog', { name });
		await expect(sheet.getByRole('button', { name: /Zahlung erfassen/ })).toBeVisible();
		await sheet.getByRole('button', { name: /Auswählen/ }).click();
		await expect(sheet).toBeHidden();
		await expect(page.getByText('1 ausgewählt')).toBeVisible();
		await page.getByRole('button', { name: 'Auswahl beenden' }).click();
		await expect(page.getByText('1 ausgewählt')).toBeHidden();

		// Lange drücken wählt direkt aus (unter Last ggf. erneut drücken)
		await expect(async () => {
			await row.hover();
			await page.mouse.down();
			await page.waitForTimeout(800); // Haltedauer der Geste (500 ms) abwarten
			await page.mouse.up();
			await expect(page.getByText('1 ausgewählt')).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 15_000 });
		await expect(page.getByRole('dialog', { name })).toBeHidden();
	});

	test('Zahlung erfassen in drei Schritten bucht und ordnet zu', async ({ page }) => {
		const name = `Zahlung ${run}`;
		await login(page);
		const { invoiceId } = await seed(page, name);
		await page.goto('/modules/treasury');
		await page
			.getByRole('navigation', { name: 'Bereiche der Kasse' })
			.getByRole('button', { name: 'Neu' })
			.click();
		await page
			.getByRole('dialog', { name: 'Neu erfassen' })
			.getByRole('button', { name: /Zahlung erfassen/ })
			.click();
		const sheet = page.getByRole('dialog', { name: 'Zahlung erfassen' });
		await expect(sheet).toBeVisible();
		for (const k of ['1', '2', '3', '4']) {
			await sheet.getByRole('button', { name: k, exact: true }).click();
		}
		await expect(sheet.locator('output')).toHaveText(/12,34/);
		await sheet.getByRole('button', { name: 'Weiter' }).click();
		await sheet.getByRole('searchbox', { name: 'Zahler*in suchen' }).fill(name);
		await sheet.getByRole('button', { name: new RegExp(name) }).click();
		await expect(sheet.getByText('Offene Posten')).toBeVisible();
		await sheet.getByRole('button', { name: /Zahlung buchen/ }).click();
		await expect(sheet).toBeHidden();
		await expect(page.getByText(new RegExp(`12,34.*${name} gebucht`))).toBeVisible();

		const inv = await api<{ status: string; openCents: number }>(
			page,
			'GET',
			`/modules/treasury/invoices/${invoiceId}`
		);
		expect(inv.status).toBe('paid');
		expect(inv.openCents).toBe(0);
	});

	test('Rechnung: feste Aktionsleiste unten, Seltenes hinter ⋯', async ({ page }) => {
		await login(page);
		const { invoiceId } = await seed(page, `Detail ${run}`);
		await page.goto(`/modules/treasury/invoices/${invoiceId}`);
		const bar = page.getByRole('toolbar', { name: 'Aktionen zur Rechnung' });
		await expect(bar.getByRole('button', { name: /Zahlung erfassen/ })).toBeVisible();
		await page.getByRole('button', { name: 'Rechnungsaktionen' }).click();
		await expect(
			page.getByRole('dialog').getByRole('button', { name: /Stornieren/ })
		).toBeVisible();
		expect(await overflows(page)).toBe(false);
	});
});

test.describe('Kasse auf dem Tablet', () => {
	test.use(TABLET);

	test('Liste links, Details rechts; „Neu“ als Menü', async ({ page }) => {
		const name = `Tablet ${run}`;
		await login(page);
		await seed(page, name);
		await page.goto('/modules/treasury?tab=income&view=open');
		await expect(page.getByRole('navigation', { name: 'Bereiche der Kasse' })).toHaveCount(0);
		await page.getByRole('searchbox', { name: 'Offene Posten durchsuchen' }).fill(name);
		await page
			.getByRole('button', { name: new RegExp(name) })
			.first()
			.click();
		// Details-Bereich mit Hauptaktion, kein Blatt
		await expect(page.getByRole('heading', { name })).toBeVisible();
		await expect(page.getByRole('dialog')).toHaveCount(0);

		await page.getByRole('button', { name: 'Neu', exact: true }).click();
		await expect(page.getByRole('menuitem', { name: /Zahlung erfassen/ })).toBeVisible();
		await page.getByRole('menuitem', { name: /Zahlung erfassen/ }).click();
		await expect(page.getByRole('dialog', { name: 'Zahlung erfassen' })).toBeVisible();
		await expect(page.getByText('Zuordnen zu offenen Posten')).toBeVisible();
	});
});

test.describe('Kasse auf dem Desktop', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('bleibt unverändert (Kopf mit Buchung/Import, Reiter oben)', async ({ page }) => {
		await login(page);
		await ensureModules(page, ['members', 'actions', 'treasury']);
		await page.goto('/modules/treasury');
		await expect(page.getByRole('button', { name: /Buchung/ }).first()).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Eingänge' })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Bereiche der Kasse' })).toHaveCount(0);
	});
});
