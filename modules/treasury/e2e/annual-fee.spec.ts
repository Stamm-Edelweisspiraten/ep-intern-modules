import { expect, test, type Page } from '@playwright/test';

// Kasse → Jahresbeitrag: Lauf anlegen, Betreff per Autosave, Empfänger/Summen, Mail-Vorschau,
// Versand planen und Planung aufheben. Es wird bewusst NICHT versendet (der E2E-Server hat kein SMTP).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);
const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtEuro = (cents: number) => euro.format(cents / 100);

type AnnualRun = { id: string; year: number; status: 'draft' | 'scheduled' | 'sent' };
type AnnualPreview = {
	invoices: { key: string; recipientName: string; totalCents: number }[];
	totalCents: number;
	memberCount: number;
};

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

/** Lokales Datum + n Tage als JJJJ-MM-TT bzw. TT.MM.JJJJ */
function dateIn(days: number) {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return { iso: `${y}-${m}-${day}`, de: `${day}.${m}.${y}` };
}

test.describe.configure({ mode: 'serial' });

test('Jahresbeitrag: Lauf anlegen, Texte, Empfänger, Vorschau, planen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'actions', 'treasury']);

	const year = new Date().getFullYear() + 1;
	const base = '/modules/treasury/annual-fees';

	// Wiederholbarkeit (reuseExistingServer): vorhandenen Entwurf für das Jahr entfernen
	const existing = (await api<AnnualRun[]>(page, 'GET', base)).find((r) => r.year === year);
	test.skip(existing?.status === 'sent', `Beitragslauf ${year} ist in dieser DB schon versendet`);
	if (existing) await api(page, 'DELETE', `${base}/${existing.id}`);

	// Zwei Geschwister + Zahler (Familie) → eine Sammelrechnung über 2 × 47 €
	const lastName = `Biber${run}`;
	const member = (firstName: string, birthDate: string) => ({
		firstName,
		lastName,
		birthDate,
		street: 'Schlachte 5',
		postalCode: '28195',
		city: 'Bremen',
		country: 'DE',
		stage: 'woelfling',
		emails: [{ name: 'Mutter', value: `biber-${run}@example.test` }],
		entryDate: '2020-01-15'
	});
	const a = await api<{ id: string }>(
		page,
		'POST',
		'/modules/members/members',
		member('Anna', '2015-03-01')
	);
	const b = await api<{ id: string }>(
		page,
		'POST',
		'/modules/members/members',
		member('Ben', '2017-07-20')
	);
	const payerName = `Familie ${lastName}`;
	await api(page, 'POST', '/modules/treasury/payers', {
		name: payerName,
		memberIds: [a.id, b.id]
	});

	await page.goto('/modules/treasury?tab=annual');
	// `?tab=annual` (Altlink) → Bereich „Eingänge“ mit der Unteransicht „Jahresbeitrag“ (#62)
	await expect(page.getByRole('tab', { name: 'Eingänge' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(
		page
			.getByRole('group', { name: 'Ansicht der Eingänge' })
			.getByRole('button', { name: 'Jahresbeitrag' })
	).toHaveAttribute('aria-pressed', 'true');

	// Lauf anlegen (Leerzustand „Lauf für … anlegen“ oder Kopf „Neuer Lauf für …“)
	await page.getByRole('button', { name: new RegExp(`Lauf für ${year}`) }).click();
	await expect(page.getByText(`Beitragslauf ${year} angelegt`)).toBeVisible();
	const yearSelect = page.getByRole('button', { name: 'Beitragsjahr' });
	await expect(yearSelect).toContainText(`Beitragsjahr ${year} · Entwurf`);

	// Der Lauf ist in Schritte gegliedert: Beiträge → Texte → Vorschau → Senden
	const step = (name: string) =>
		page
			.getByRole('navigation', { name: 'Schritte des Beitragslaufs' })
			.getByRole('button', { name });

	// Betreff ändern → Autosave
	await step('Texte').click();
	const subject = `Beitrag {jahr} E2E ${run}`;
	const subjectInput = page.getByRole('textbox', { name: /^Betreff/ });
	await subjectInput.fill(subject);
	await expect(page.getByText('Gespeichert', { exact: true })).toBeVisible({ timeout: 10_000 });

	const runs = await api<(AnnualRun & { mailSubject: string })[]>(page, 'GET', base);
	const created = runs.find((r) => r.year === year);
	expect(created?.mailSubject).toBe(subject);

	// Empfänger: eine Zeile für die Familie mit beiden Kindern und 94 €
	await step('Vorschau').click();
	const recipients = page.getByRole('table', { name: 'Empfänger des Jahresbeitrags' });
	const familyRow = recipients.getByRole('row').filter({ hasText: payerName });
	await expect(familyRow).toHaveCount(1);
	await expect(familyRow).toContainText('Anna');
	await expect(familyRow).toContainText('Ben');
	await expect(familyRow).toContainText(fmtEuro(4700));
	await expect(familyRow).toContainText(fmtEuro(9400));
	await expect(familyRow).toContainText(`biber-${run}@example.test`);

	// Kennzahlen = Vorschau der API (in der DB können weitere Mitglieder anderer Tests liegen)
	const preview = await api<AnnualPreview>(page, 'GET', `${base}/${created!.id}/preview?mode=run`);
	expect(preview.memberCount).toBeGreaterThanOrEqual(2);
	expect(preview.invoices.find((i) => i.recipientName === payerName)?.totalCents).toBe(9400);
	const stat = (label: string) =>
		page
			.locator('dt')
			.filter({ hasText: new RegExp(`^${label}$`) })
			.locator('xpath=following-sibling::dd[1]')
			.first();
	await expect(stat('Rechnungen')).toHaveText(String(preview.invoices.length));
	await expect(stat('Mitglieder')).toHaveText(String(preview.memberCount));
	await expect(stat('Summe')).toHaveText(fmtEuro(preview.totalCents));

	// Mail-Vorschau für die Familie
	await page.getByRole('button', { name: 'Familie für die Vorschau' }).click();
	await page.getByRole('option', { name: new RegExp(`^${payerName}`) }).click();
	const mailPreview = page.getByRole('region', { name: 'Mail-Vorschau' });
	await expect(mailPreview).toContainText(`Beitrag ${year} E2E ${run}`);
	await expect(mailPreview).toContainText(`biber-${run}@example.test`);
	await expect(page.frameLocator('iframe[title="Mail-Vorschau"]').locator('body')).toContainText(
		`Jahresbeitrag ${year}`
	);

	// Versand planen (nicht senden)
	await step('Senden').click();
	const sendOn = dateIn(7);
	await page.getByLabel('Oder Versand planen am').fill(sendOn.iso);
	await page.getByRole('button', { name: 'Versand planen' }).click();
	await expect(page.getByText(`Versand am ${sendOn.de} geplant`)).toBeVisible();
	await expect(yearSelect).toContainText(`Beitragsjahr ${year} · Versand geplant`);
	await expect(page.getByText(`Versand geplant am ${sendOn.de}.`)).toBeVisible();
	// Betreff bleibt bis zum Versand editierbar
	await step('Texte').click();
	await expect(subjectInput).toBeEditable();
	await step('Senden').click();

	// Planung aufheben → wieder Entwurf
	await page.getByRole('button', { name: 'Planung aufheben' }).click();
	await expect(page.getByText('Planung aufgehoben')).toBeVisible();
	await expect(yearSelect).toContainText(`Beitragsjahr ${year} · Entwurf`);
	await expect(page.getByRole('button', { name: 'Jetzt senden' })).toBeVisible();

	const after = (await api<AnnualRun[]>(page, 'GET', base)).find((r) => r.year === year);
	expect(after?.status).toBe('draft');

	// Aufräumen: Entwurf löschen, damit spätere Läufe sauber starten
	await api(page, 'DELETE', `${base}/${created!.id}`);
});
