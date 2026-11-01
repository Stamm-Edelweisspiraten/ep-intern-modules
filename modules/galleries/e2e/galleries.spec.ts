import { expect, test, type Page } from '@playwright/test';

// Galerien (ohne S3): anlegen über den Dialog, öffentlich/privat, Detailseite, Teilen-Menü mit Freigabe,
// Bearbeiten, Löschen; Upload ohne Dateispeicher zeigt eine verständliche Fehlermeldung.
// Upload, Varianten und Titelbild prüfen die Integrationstests (fake-storage).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);

// 1×1-PNG (rot)
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64'
);

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
	let changed = false;
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/modules/${id}/enable`);
			changed = true;
		}
	}
	// Neue Modulrechte (Navigation, „Neue Galerie“) erst nach dem Neuladen
	if (changed) await page.reload();
}

interface Detail {
	id: string;
	title: string;
	visibility: 'private' | 'public';
	publicConfirmation?: { at: string; by: { id: string; name: string } | null } | null;
	shares?: { type: string; id: string; level: string }[];
	events?: { id: string; title: string }[];
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe.configure({ mode: 'serial' });

test('Modul aktivieren und leere Galerie-Übersicht', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'events', 'galleries']);
	await page.goto('/modules/galleries');
	await expect(page.getByRole('heading', { name: 'Galerien', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Neue Galerie' }).first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'Galerien' }).first()).toBeVisible();
});

test('Galerie anlegen, teilen, bearbeiten, löschen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'events', 'galleries']);
	const title = `Sommerlager ${run}`;
	const renamed = `Sommerlager neu ${run}`;
	// Termin, dem die ganze Galerie zugeordnet wird
	const eventTitle = `Pfingstlager ${run}`;
	const event = await api<{ id: string }>(page, 'POST', '/modules/events/events', {
		title: eventTitle,
		startsOn: '2026-05-23',
		endsOn: '2026-05-25',
		shares: [{ type: 'everyone', id: '*', level: 'read' }]
	});

	// Anlegen über den Dialog, öffentlich
	await page.goto('/modules/galleries');
	await page.getByRole('button', { name: 'Neue Galerie' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Neue Galerie' });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Titel *').fill(title);
	await dialog.getByLabel('Beschreibung').fill('Zeltlager am See – Lagerbau und Singerunden');
	await dialog.getByRole('radio', { name: /Öffentlich/ }).check({ force: true });
	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	// Veröffentlichen verlangt die Bestätigung der Website-Einwilligungen (#27)
	const consent = page.getByRole('alertdialog', { name: 'Einwilligungen bestätigen' });
	await expect(consent).toBeVisible();
	await consent.getByRole('button', { name: 'Bestätigen und veröffentlichen' }).click();
	await expect(dialog).toBeHidden();

	// Weiterleitung auf die Detailseite
	await page.waitForURL(/\/modules\/galleries\/[0-9a-f-]{36}$/);
	const id = page.url().split('/').pop()!;
	await expect(page.getByRole('heading', { name: title })).toBeVisible();
	await expect(page.getByText('Öffentlich', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Noch keine Bilder')).toBeVisible();
	let detail = await api<Detail>(page, 'GET', `/modules/galleries/galleries/${id}`);
	expect(detail.visibility).toBe('public');
	expect(detail.publicConfirmation?.at).toBeTruthy();
	await expect(page.getByText(/Veröffentlichung bestätigt am/)).toBeVisible();

	// Übersicht: Karte mit Badge
	await page.goto('/modules/galleries');
	const card = page.getByRole('link', { name: new RegExp(escapeRe(title)) });
	await expect(card).toBeVisible();
	await expect(card).toContainText('Öffentlich');
	await expect(card).toContainText('0 Bilder');
	await card.click();
	await page.waitForURL(new RegExp(`/modules/galleries/${id}$`));

	// Teilen-Menü: Freigabe für den ganzen Stamm hinzufügen
	await page.getByRole('button', { name: /^Teilen/ }).click();
	const share = page
		.locator('[data-slot="popover-content"]')
		.filter({ hasText: 'Wer diese Galerie sehen' });
	await expect(share).toBeVisible();
	await share.getByRole('button', { name: /\(alle\) freigeben$/ }).click();
	await expect
		.poll(async () => {
			const d = await api<Detail>(page, 'GET', `/modules/galleries/galleries/${id}`);
			return (d.shares ?? []).map((s) => `${s.type}:${s.id}:${s.level}`);
		})
		.toEqual(['everyone:*:read']);
	await expect(share.getByRole('button', { name: /^Freigabe für .+ entfernen$/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(share).toBeHidden();

	// Bearbeiten: Titel ändern, auf privat stellen; Freigabe bleibt erhalten
	await page.getByRole('button', { name: 'Bearbeiten' }).click();
	const edit = page.getByRole('dialog', { name: 'Galerie bearbeiten' });
	await expect(edit).toBeVisible();
	await expect(edit.getByLabel('Titel *')).toHaveValue(title);
	await edit.getByLabel('Titel *').fill(renamed);
	await edit.getByRole('radio', { name: /Privat/ }).check({ force: true });
	// Termin zuordnen (gilt für die ganze Galerie)
	await edit.getByRole('combobox', { name: 'Termine auswählen' }).click();
	await page.getByRole('combobox', { name: 'Termine suchen' }).fill(eventTitle);
	await page.getByRole('option', { name: new RegExp(escapeRe(eventTitle)) }).click();
	await page.keyboard.press('Escape');
	await expect(edit.getByRole('list', { name: 'Gewählte Termine' })).toContainText(eventTitle);
	await edit.getByRole('button', { name: 'Speichern' }).click();
	await expect(edit).toBeHidden();
	await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
	await expect(page.getByText('Privat', { exact: true }).first()).toBeVisible();
	detail = await api<Detail>(page, 'GET', `/modules/galleries/galleries/${id}`);
	expect(detail.title).toBe(renamed);
	expect(detail.visibility).toBe('private');
	expect(detail.shares).toHaveLength(1);
	expect((detail.events ?? []).map((e) => e.id)).toEqual([event.id]);
	await expect(page.getByRole('list', { name: 'Termine' })).toContainText(eventTitle);

	// Filter „Privat“ in der Übersicht
	await page.goto('/modules/galleries?visibility=private');
	await expect(page.getByRole('link', { name: new RegExp(escapeRe(renamed)) })).toBeVisible();
	await page.goto('/modules/galleries?visibility=public');
	await expect(page.getByRole('link', { name: new RegExp(escapeRe(renamed)) })).toHaveCount(0);

	// Löschen über „Mehr“ → Bestätigung
	await page.goto(`/modules/galleries/${id}`);
	await page.getByRole('button', { name: 'Mehr Aktionen' }).click();
	await page.getByRole('menuitem', { name: 'Löschen' }).click();
	const confirm = page.getByRole('alertdialog');
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText(renamed);
	await confirm.getByRole('button', { name: 'Löschen' }).click();
	await page.waitForURL(/\/modules\/galleries$/);
	await expect(page.getByRole('link', { name: new RegExp(escapeRe(renamed)) })).toHaveCount(0);
	const res = await page.request.get(`/api/v1/modules/galleries/galleries/${id}`, {
		headers: { origin: ORIGIN }
	});
	expect(res.status()).toBe(404);
});

test('Upload ohne Dateispeicher zeigt eine verständliche Fehlermeldung', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['members', 'events', 'galleries']);
	const created = await api<Detail>(page, 'POST', '/modules/galleries/galleries', {
		title: `Upload ${run}`,
		description: null,
		visibility: 'private',
		shares: []
	});

	await page.goto(`/modules/galleries/${created.id}`);
	await expect(page.getByRole('group', { name: 'Bilder hochladen' })).toBeVisible();
	await page.locator('input[type="file"]').setInputFiles([
		{ name: 'bild.png', mimeType: 'image/png', buffer: PNG },
		{ name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('kein Bild') }
	]);

	const list = page.getByRole('list', { name: 'Hochgeladene Dateien' });
	await expect(list).toBeVisible();
	// Server ohne S3 → 503 → Hinweis; die Textdatei scheitert schon an der Vorprüfung
	await expect(list.getByText('Dateispeicher nicht eingerichtet')).toBeVisible();
	await expect(list.getByText(/Dateityp nicht unterstützt/)).toBeVisible();
	await expect(page.getByText('0 von 2 hochgeladen, 2 mit Fehler')).toBeVisible();
	await expect(page.getByText('1 fehlgeschlagen, 1 Datei abgelehnt')).toBeVisible();
	// Nur der Serverfehler lässt sich erneut versuchen
	await expect(page.getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();
	await expect(page.getByText('Noch keine Bilder')).toBeVisible();

	await api(page, 'DELETE', `/modules/galleries/galleries/${created.id}`);
});
