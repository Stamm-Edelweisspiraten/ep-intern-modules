import {
	expect,
	test,
	type APIRequestContext,
	type BrowserContext,
	type Page
} from '@playwright/test';
import { startAiMock, type AiMock } from '$testing/e2e';

// KI-Schreibhilfe: Knopf im Editor von „Neue Nachricht“, Vorschlag mit Änderungsansicht übernehmen,
// Betreff-Varianten, Schreibhilfe an der Aktionsbeschreibung. Der KI-Anbieter ist ein lokaler Ersatz.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';

let ai: AiMock;
let context: BrowserContext;
let page: Page;

async function call<T>(api: APIRequestContext, method: string, path: string, data?: unknown) {
	const res = await api.fetch(`/api/v1${path}`, {
		method,
		headers: { origin: ORIGIN, ...(data ? { 'content-type': 'application/json' } : {}) },
		data: data ? JSON.stringify(data) : undefined
	});
	if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
	return ((await res.json().catch(() => ({}))) as { data: T }).data;
}

test.describe.serial('Schreibhilfe', () => {
	test.beforeAll(async ({ browser }) => {
		ai = await startAiMock();
		context = await browser.newContext({ baseURL: ORIGIN });
		page = await context.newPage();
		await page.goto('/login');
		await page.getByLabel('E-Mail').fill(ADMIN.email);
		await page.getByLabel('Passwort').fill(ADMIN.password);
		await page.getByRole('button', { name: 'Anmelden' }).click();
		await page.waitForURL(/\/dashboard/);
		const api = page.request;
		// Basis-URL zuerst: ein Wechsel des Ziels verwirft den gebundenen Schlüssel
		await call(api, 'PUT', '/settings', { values: { 'core.ai.baseUrl': ai.baseUrl } });
		await call(api, 'PUT', '/settings', { values: { 'core.ai.apiKey': 'e2e-key' } });
		const modules = await call<{ manifest: { id: string }; enabled: boolean }[]>(
			api,
			'GET',
			'/modules'
		);
		for (const id of ['members', 'messages', 'actions']) {
			if (!modules.find((m) => m.manifest.id === id)?.enabled) {
				await call(api, 'POST', `/modules/${id}/enable`);
			}
		}
	});

	test.afterAll(async () => {
		try {
			await call(page.request, 'PUT', '/settings', {
				values: { 'core.ai.apiKey': null, 'core.ai.baseUrl': '' }
			});
		} finally {
			await context?.close();
			await ai?.close();
		}
	});

	test('Nachricht: Entwurf erzeugen, Änderungen ansehen und übernehmen', async () => {
		await page.goto('/modules/messages/new');
		const editor = page.getByRole('textbox', { name: 'Nachrichtentext' });
		await editor.click();
		await page.keyboard.type('Herbstfahrt bald, Schlafsack mitbringen');
		await page.getByRole('button', { name: 'Schreibhilfe', exact: true }).click();

		const sheet = page.getByRole('dialog', { name: 'Schreibhilfe' });
		await expect(sheet).toBeVisible();
		await sheet.getByRole('button', { name: 'Freundlicher' }).click();
		await sheet.getByRole('button', { name: 'Vorschlag erzeugen' }).click();
		await expect(sheet.getByText('Grün = neu, rot durchgestrichen = entfällt.')).toBeVisible();
		await expect(sheet.locator('ins').first()).toBeVisible();
		await sheet.getByRole('button', { name: 'Übernehmen' }).click();
		await expect(sheet).toBeHidden();
		await expect(editor).toContainText('Hallo ihr Lieben, die Herbstfahrt startet bald.');
		expect(ai.requests.at(-1)?.stream).toBe(true);
	});

	test('Nachricht: Betreff aus dem Text vorschlagen', async () => {
		const subjectField = page.getByLabel('Betreff');
		await page
			.locator('#m-subject')
			.locator('..')
			.getByRole('button', { name: 'Schreibhilfe' })
			.click();
		const sheet = page.getByRole('dialog', { name: 'Schreibhilfe' });
		await sheet.getByRole('button', { name: 'Vorschlag erzeugen' }).click();
		await sheet.getByRole('button', { name: 'Herbstfahrt: alle Infos' }).click();
		await expect(subjectField).toHaveValue('Herbstfahrt: alle Infos');
	});

	test('Aktion: Schreibhilfe an der Beschreibung', async () => {
		await page.goto('/modules/actions');
		await page.getByRole('button', { name: 'Aktion anlegen' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Aktion anlegen' });
		await dialog.getByLabel('Name').fill('Schreibhilfe-Test');
		await dialog
			.locator('#a-description')
			.locator('..')
			.getByRole('button', { name: 'Schreibhilfe' })
			.click();
		const sheet = page.getByRole('dialog', { name: 'Schreibhilfe' });
		await expect(sheet.getByRole('button', { name: 'Entwurf schreiben' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await sheet.getByRole('button', { name: 'Vorschlag erzeugen' }).click();
		await sheet.getByRole('button', { name: 'Übernehmen' }).click();
		await expect(dialog.locator('#a-description')).toHaveValue(/Herbstfahrt startet bald/);
		const sent = JSON.stringify(ai.requests.at(-1)?.messages);
		expect(sent).toContain('Schreibhilfe-Test');
	});
});
