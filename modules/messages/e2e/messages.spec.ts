import { expect, test, type Page } from '@playwright/test';

// Nachrichten: Verlauf lädt genau einmal (Regression: Endlosschleife → 429 „Zu viele Anfragen“),
// die Seitenleiste zeigt „Stamm“ nur einmal, und „Neue Nachricht“ hat ein Eingabefeld für Empfänger.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';

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

test('Verlauf lädt nur einmal je Aufruf, auch nach mehrfachem Neuladen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);

	let requests = 0;
	page.on('request', (r) => {
		if (/\/api\/v1\/modules\/messages\/messages(\?|$)/.test(r.url())) requests++;
	});
	for (let i = 0; i < 4; i++) {
		requests = 0;
		await page.goto('/modules/messages/sent');
		await expect(page.getByRole('heading', { name: 'Nachrichten', exact: true })).toBeVisible();
		await expect(
			page.getByText(/noch keine nachrichten/i).or(page.getByRole('row').nth(1))
		).toBeVisible();
		// Begründete feste Wartezeit (#75): Eine Effekt-Endlosschleife zeigt sich nur über die Zeit.
		await page.waitForTimeout(1500);
		expect(requests, `Aufruf ${i + 1}`).toBe(1);
		await expect(page.getByText('Zu viele Anfragen')).toHaveCount(0);
	}
});

test('Posteingang: Postfächer laden einmal, Hinweis ohne IMAP, Reiter zu „Gesendet“', async ({
	page
}) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);
	let requests = 0;
	page.on('request', (r) => {
		if (/\/api\/v1\/modules\/messages\/mailboxes(\?|$)/.test(r.url())) requests++;
	});
	await page.goto('/modules/messages');
	const tabs = page.getByRole('navigation', { name: 'Bereiche der Nachrichten' });
	await expect(tabs.getByRole('link', { name: 'Posteingang' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(page.getByText(/Posteingang ist noch nicht eingerichtet/)).toBeVisible();
	// Begründete feste Wartezeit (#75): Eine Effekt-Endlosschleife zeigt sich nur über die Zeit.
	await page.waitForTimeout(1500);
	expect(requests).toBe(1);
	await tabs.getByRole('link', { name: 'Gesendet' }).click();
	await page.waitForURL(/\/modules\/messages\/sent$/);
	await expect(tabs.getByRole('link', { name: 'Gesendet' })).toHaveAttribute(
		'aria-current',
		'page'
	);
});

test('Seitenleiste: flache Liste, Mitglieder vor Nachrichten, Administration zu', async ({
	page
}) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);
	await page.goto('/modules/messages');
	const nav = page.getByRole('navigation', { name: 'Hauptnavigation' }).first();
	await expect(nav.getByRole('button', { name: 'Stamm' })).toHaveCount(0);
	const labels = await nav.getByRole('link').allInnerTexts();
	const pos = (l: string) => labels.findIndex((t) => t.trim() === l);
	expect(pos('Mitglieder')).toBeGreaterThan(-1);
	expect(pos('Mitglieder')).toBeLessThan(pos('Gruppen'));
	expect(pos('Gruppen')).toBeLessThan(pos('Nachrichten'));
	// Konfigurationsseiten stehen nur in der (zugeklappten) Administration
	await expect(nav.getByRole('link', { name: 'Zusatzfelder' })).toHaveCount(0);
	const adminToggle = nav.getByRole('button', { name: 'Administration' });
	await expect(adminToggle).toHaveAttribute('aria-expanded', 'false');
	await adminToggle.click();
	await expect(nav.getByRole('link', { name: /Zusatzfelder/ })).toBeVisible();
	await expect(nav.getByRole('link', { name: /Löschfristen/ })).toBeVisible();
});

test('Neue Nachricht: ein Empfängerfeld, Gruppe als Chip, Aussehen wählbar', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);
	// Ohne Absender zeigt die Seite nur einen Hinweis: Stamm-Adresse als Absender hinterlegen
	const set = await page.request.fetch('/api/v1/settings', {
		method: 'PUT',
		headers: { origin: ORIGIN, 'content-type': 'application/json' },
		data: { values: { 'core.organization.email': 'stamm@example.test' } }
	});
	expect(set.ok()).toBe(true);
	await page.goto('/modules/messages/new');
	const to = page.getByRole('combobox', { name: 'An' });
	await expect(to).toBeVisible();
	await expect(page.getByLabel('Aussehen')).toBeVisible();
	await expect(page.getByLabel('Gruppen', { exact: true })).toHaveCount(0);
});

test('Neue Nachricht: freie Adresse als Chip, Vorschau zeigt die Mail', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);
	await page.goto('/modules/messages/new');
	const to = page.getByRole('combobox', { name: 'An' });
	await to.fill('Gast@Extern.test');
	await expect(page.getByRole('option', { name: /gast@extern\.test/ })).toBeVisible();
	await to.press('Enter');
	const chips = page.getByRole('list', { name: 'Empfänger' });
	await expect(chips.getByText('gast@extern.test')).toBeVisible();
	await expect(page.getByText(/1\s+einzelne Adresse/)).toBeVisible();

	await page.getByLabel('Betreff').fill('Hallo Gäste');
	await page.getByRole('tab', { name: 'Vorschau' }).click();
	const frame = page.frameLocator('iframe[title="Vorschau der E-Mail"]');
	await expect(page.getByText('Hallo Gäste', { exact: true })).toBeVisible();
	await expect(frame.locator('body')).toBeVisible();
	await page.getByRole('tab', { name: 'Schreiben' }).click();
	await expect(page.getByLabel('Betreff')).toHaveValue('Hallo Gäste');
});

test('Posteingang: Ordner anlegen, per Rechtsklick umbenennen und löschen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);
	// Stamm-Adresse → Stamm-Postfach für die Verwaltung
	const set = await page.request.fetch('/api/v1/settings', {
		method: 'PUT',
		headers: { origin: ORIGIN, 'content-type': 'application/json' },
		data: { values: { 'core.organization.email': 'stamm@example.test' } }
	});
	expect(set.ok()).toBe(true);
	await page.goto('/modules/messages?mailbox=stamm');
	const tree = page.getByRole('navigation', { name: 'Postfächer und Ordner' });
	await tree.getByRole('button', { name: 'Ordner anlegen' }).click();
	const dialog = page.getByRole('dialog', { name: 'Ordner anlegen' });
	await expect(dialog.getByText(/Sichtbar für alle mit Zugriff/)).toBeVisible();
	await dialog.getByLabel('Name *').fill('Lager 2026');
	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	const folder = tree.getByRole('button', { name: /Lager 2026/ }).first();
	await expect(folder).toBeVisible();

	// Rechtsklick → Umbenennen
	await folder.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Umbenennen' }).click();
	const rename = page.getByRole('dialog', { name: 'Ordner umbenennen' });
	await rename.getByLabel('Name *').fill('Sommerlager 2026');
	await rename.getByRole('button', { name: 'Umbenennen' }).click();
	const renamed = tree.getByRole('button', { name: /Sommerlager 2026/ }).first();
	await expect(renamed).toBeVisible();

	// Ordner öffnen: Kopf zeigt den Namen, Leerzustand erklärt das Einsortieren
	await renamed.click();
	await expect(page).toHaveURL(/folder=/);
	await expect(page.getByText(/Dieser Ordner ist leer/)).toBeVisible();

	// Rechtsklick → Löschen mit Bestätigung
	await renamed.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Ordner löschen …' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Ordner löschen' }).click();
	await expect(tree.getByRole('button', { name: /Sommerlager 2026/ })).toHaveCount(0);
	await expect(page).not.toHaveURL(/folder=/);
});

test('Verwaltung „Postfächer“: Zusatzpostfach und Weiterleitung anlegen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'messages']);
	await page.goto('/modules/messages/admin');
	await expect(page.getByRole('heading', { name: 'Postfächer', exact: true })).toBeVisible();
	await expect(page.getByText(/Catch-all-Postfach/)).toBeVisible();

	await page.getByRole('button', { name: 'Postfach anlegen' }).click();
	const dialog = page.getByRole('dialog', { name: 'Postfach anlegen' });
	await dialog.getByLabel(/^Name/).fill('Herbstlager');
	await dialog.getByLabel(/^E-Mail-Adresse/).fill('herbstlager@example.test');
	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('cell', { name: 'herbstlager@example.test' })).toBeVisible();

	await page.getByRole('tab', { name: 'Weiterleitungen' }).click();
	await page.getByRole('button', { name: 'Weiterleitung anlegen' }).click();
	const alias = page.getByRole('dialog', { name: 'Weiterleitung anlegen' });
	await alias.getByLabel(/^E-Mail-Adresse/).fill('lager@example.test');
	await alias.getByRole('combobox', { name: 'Ziel-Postfach' }).click();
	await page.getByRole('option', { name: /Zusätzlich: Herbstlager/ }).click();
	await alias.getByRole('button', { name: 'Anlegen' }).click();
	await expect(alias).toHaveCount(0);
	await expect(page.getByRole('cell', { name: 'lager@example.test', exact: true })).toBeVisible();

	// Doppelte Adresse → Hinweis am Feld
	await page.getByRole('button', { name: 'Weiterleitung anlegen' }).click();
	await alias.getByLabel(/^E-Mail-Adresse/).fill('herbstlager@example.test');
	await alias.getByRole('combobox', { name: 'Ziel-Postfach' }).click();
	await page.getByRole('option', { name: /Zusätzlich: Herbstlager/ }).click();
	await alias.getByRole('button', { name: 'Anlegen' }).click();
	await expect(alias.getByText(/gehört schon zu einem Postfach/)).toBeVisible();
});
