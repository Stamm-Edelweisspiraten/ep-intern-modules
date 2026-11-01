import { expect, test, type Page } from '@playwright/test';

// Mitglieder: Ansicht (gesperrter Dialog), Bearbeiten mit Tabs, Mitgliedschaft (Zweitmitglied, Eintritt/Austritt),
// Fehlerführung zum Tab „Mitgliedschaft“ und Statusfilter „Ausgetreten“.

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

/** Module in Reihenfolge aktivieren (Abhängigkeiten zuerst), falls noch nicht aktiv. */
async function ensureModules(page: Page, ids: string[]) {
	const list = await api<{ manifest: { id: string }; enabled: boolean }[]>(page, 'GET', '/modules');
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/modules/${id}/enable`);
		}
	}
}

test.describe.configure({ mode: 'serial' });

test('Mitglied: Ansicht, Bearbeiten mit Tabs, Austritt und Statusfilter', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members']);

	const firstName = 'Wanda';
	const lastName = `Wolf${run}`;
	const fullName = `${firstName} ${lastName}`;
	await api(page, 'POST', '/modules/members/members', {
		firstName,
		lastName,
		birthDate: '2016-04-12',
		street: 'Am Wall 1',
		postalCode: '28195',
		city: 'Bremen',
		country: 'DE',
		stage: 'woelfling',
		emails: [{ name: 'Mutter', value: `wolf-${run}@example.test` }],
		entryDate: '2020-09-01',
		secondaryMember: true,
		feeLevels: ['stamm']
	});

	// Liste auf das neue Mitglied eingrenzen (Suche ist ein URL-Parameter)
	await page.goto(`/modules/members?search=${encodeURIComponent(lastName)}`);
	const row = page.getByRole('row', { name: `${fullName} anzeigen` });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Zweitmitglied');

	// Klick auf die Zeile → Bearbeiten-Dialog als Ansicht mit gesperrten Feldern
	await row.getByText(lastName).click();
	const view = page.getByRole('dialog', { name: fullName });
	await expect(view).toBeVisible();
	await expect(view).toContainText('Nur Ansicht');
	await expect(view.getByText('Zweitmitglied').first()).toBeVisible();
	await expect(view.getByLabel('Vorname *')).toBeDisabled();
	await expect(view.getByLabel('Vorname *')).toHaveValue(firstName);
	await expect(view.getByRole('button', { name: 'Speichern' })).toHaveCount(0);
	await view.getByRole('tab', { name: /^Mitgliedschaft/ }).click();
	await expect(view.getByLabel('Eintritt', { exact: true })).toBeDisabled();
	await expect(view.getByLabel('Eintritt', { exact: true })).toHaveValue('2020-09-01');

	// Bearbeiten → derselbe Dialog wird freigeschaltet, Tab bleibt
	await view.getByRole('button', { name: 'Bearbeiten' }).click();
	const dialog = page.getByRole('dialog', { name: 'Mitglied bearbeiten' });
	await expect(dialog).toBeVisible();
	const personTab = dialog.getByRole('tab', { name: /^Person/ });
	const membershipTab = dialog.getByRole('tab', { name: /^Mitgliedschaft/ });
	await expect(personTab).toBeVisible();
	await expect(dialog.getByRole('tab', { name: /^Kontakt/ })).toBeVisible();
	await expect(membershipTab).toHaveAttribute('aria-selected', 'true');
	await expect(dialog.getByLabel('Eintritt', { exact: true })).toBeEnabled();

	await membershipTab.click();
	await expect(membershipTab).toHaveAttribute('aria-selected', 'true');
	await expect(dialog.getByRole('switch', { name: /Zweitmitglied/ })).toBeChecked();
	await expect(dialog.getByRole('checkbox', { name: 'Stamm', exact: true })).toBeChecked();
	await expect(dialog.getByRole('checkbox', { name: 'Bund', exact: true })).not.toBeChecked();
	await expect(dialog.getByLabel('Eintritt', { exact: true })).toHaveValue('2020-09-01');

	// Austritt vor dem Eintritt → Fehler; der Dialog springt zurück auf „Mitgliedschaft“
	const exitInput = dialog.getByLabel('Austritt', { exact: true });
	await exitInput.fill('2019-12-31');
	await personTab.click();
	await expect(personTab).toHaveAttribute('aria-selected', 'true');
	await dialog.getByRole('button', { name: 'Speichern' }).click();
	await expect(dialog.getByText('Austritt darf nicht vor dem Eintritt liegen')).toBeVisible();
	await expect(dialog.getByText('Bitte die markierten Felder prüfen.')).toBeVisible();
	await expect(membershipTab).toHaveAttribute('aria-selected', 'true');
	await expect(membershipTab).toContainText('enthält Fehler');
	await expect(dialog).toBeVisible();

	// Korrigieren: Austritt in der Vergangenheit, aber nach dem Eintritt
	await exitInput.fill('2024-06-30');
	await dialog.getByRole('button', { name: 'Speichern' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText('Mitglied gespeichert')).toBeVisible();

	// Standardfilter „Aktiv“: ausgetretenes Mitglied ist weg
	await expect(page.getByRole('row', { name: `${fullName} anzeigen` })).toHaveCount(0);

	// Filter „Ausgetreten“ zeigt es wieder, mit Badge
	await page.getByRole('button', { name: 'Nach Mitgliedschaft filtern' }).click();
	await page.getByRole('option', { name: 'Ausgetreten' }).click();
	await expect(page).toHaveURL(/status=left/);
	const leftRow = page.getByRole('row', { name: `${fullName} anzeigen` });
	await expect(leftRow).toBeVisible();
	await expect(leftRow).toContainText('ausgetreten');

	// Gespeicherte Werte per API gegenprüfen
	const list = await api<{ items: { lastName: string; exitDate: string | null }[] }>(
		page,
		'GET',
		`/modules/members/members?status=left&search=${encodeURIComponent(lastName)}`
	);
	expect(list.items.map((m) => m.exitDate)).toEqual(['2024-06-30']);
});

test('Mitglieder: alle Treffer auswählen und erweiterte Filter', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members']);

	// 25 Mitglieder (> 20 je Seite) mit eigenem Nachnamen; die letzten 5 sind Kreuzpfadfinder*innen
	const lastName = `Sammel${run}`;
	for (let i = 0; i < 25; i++) {
		await api(page, 'POST', '/modules/members/members', {
			firstName: `Person${String(i).padStart(2, '0')}`,
			lastName,
			birthDate: i < 20 ? '2016-04-12' : '2000-01-01',
			street: 'Am Wall 1',
			postalCode: '28195',
			city: 'Bremen',
			country: 'DE',
			stage: i < 20 ? 'woelfling' : 'kreuzpfadfinder',
			emails: [{ name: null, value: `p${i}-${run}@example.test` }]
		});
	}

	await page.goto(`/modules/members?search=${encodeURIComponent(lastName)}`);
	await expect(page.getByRole('row', { name: /Person00 .* anzeigen/ })).toBeVisible();

	// Kopf-Checkbox wählt die Seite; die Leiste bietet alle Treffer an
	await page.getByLabel('Alle Mitglieder dieser Seite auswählen').click();
	await expect(page.getByText('20 ausgewählt')).toBeVisible();
	await page.getByRole('button', { name: 'Alle 25 Treffer auswählen' }).click();
	await expect(page.getByText('Alle 25 Treffer sind ausgewählt.')).toBeVisible();
	await expect(page.getByText('25 ausgewählt')).toBeVisible();

	// Filterwechsel verwirft die Auswahl
	await page.getByRole('button', { name: 'Erweitert' }).click();
	await page.getByLabel('Alter von (Jahre)').fill('18');
	await page.getByLabel('Alter von (Jahre)').blur();
	await expect(page).toHaveURL(/ageMin=18/);
	await expect(page.getByRole('row', { name: /Person20 .* anzeigen/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Person00 .* anzeigen/ })).toHaveCount(0);
	await expect(page.getByText('25 ausgewählt')).toHaveCount(0);

	// Mehrfachauswahl bei Ständen
	await page.getByRole('button', { name: 'Filter zurücksetzen' }).click();
	await expect(page).not.toHaveURL(/ageMin/);
	await page.getByRole('combobox', { name: 'Nach Ständen filtern' }).click();
	await page.getByRole('option', { name: /Kreuzpfadfinder/ }).click();
	await expect(page).toHaveURL(/stages=kreuzpfadfinder/);
	await expect(page.getByRole('row', { name: /Person24 .* anzeigen/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Person00 .* anzeigen/ })).toHaveCount(0);
});

test('Mitglieder: Auswahl bleibt bei neuer Suche erhalten', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members']);

	// Vornamen eindeutig je Lauf, weil die Suche nur einzelne Namensfelder durchsucht
	const lastName = `Suche${run}`;
	const anna = `Anna${run}`;
	const bert = `Bert${run}`;
	for (const firstName of [anna, bert]) {
		await api(page, 'POST', '/modules/members/members', {
			firstName,
			lastName,
			birthDate: '2015-03-01',
			street: 'Am Wall 1',
			postalCode: '28195',
			city: 'Bremen',
			country: 'DE',
			stage: 'woelfling',
			emails: [{ name: null, value: `${firstName.toLowerCase()}-${run}@example.test` }]
		});
	}

	await page.goto(`/modules/members?search=${encodeURIComponent(anna)}`);
	await page.getByLabel(`${anna} ${lastName} auswählen`).click();
	await expect(page.getByText('1 ausgewählt')).toBeVisible();

	// Neue Suche: Anna bleibt ausgewählt, Bert kommt dazu
	const search = page.getByLabel('Mitglieder suchen');
	await search.fill(bert);
	await expect(page).toHaveURL(new RegExp(`search=${bert}`));
	await page.getByLabel(`${bert} ${lastName} auswählen`).click();
	await expect(page.getByText('2 ausgewählt')).toBeVisible();
	await expect(page.getByText('(davon 1 nicht in der aktuellen Liste)')).toBeVisible();
});
