import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Rückzahlung spenden: interne Wahl je Person in der Abrechnung und öffentliche Seite hinter dem QR-Code.
// Screenshots für die visuelle Prüfung landen in `test-results/refund-donation-*.png`.

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const A = '/api/v1/modules/actions';
const run = Date.now().toString(36);

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

async function call<T>(req: APIRequestContext, method: string, path: string, body?: unknown) {
	const res = await req.fetch(path, {
		method,
		headers: { origin: ORIGIN, 'content-type': 'application/json' },
		data: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
	return ((await res.json()) as { data: T }).data;
}

async function ensureModules(req: APIRequestContext, ids: string[]) {
	const list = await call<{ manifest: { id: string }; enabled: boolean }[]>(
		req,
		'GET',
		'/api/v1/modules'
	);
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await call(req, 'POST', `/api/v1/modules/${id}/enable`, {});
		}
	}
}

interface Item {
	id: string;
	name: string;
	amountCents: number;
}

/** Aktion mit drei Zahlenden (Beitrag 100 € automatisch + 450 € Spende = 750 € Überschuss) → 3 × 250 € gebucht */
async function bookedAction(req: APIRequestContext) {
	const { id } = await call<{ id: string }>(req, 'POST', `${A}/actions`, {
		name: `Pfingstfahrt ${run}`,
		startsOn: '2026-05-23',
		endsOn: '2026-05-26'
	});
	for (const name of ['Anna Albers', 'Bent Brandt', 'Clara Cordes']) {
		await call(req, 'POST', `${A}/actions/${id}/participants`, { name });
	}
	await call(req, 'PUT', `${A}/actions/${id}/calculation`, {
		participants: 3,
		team: 0,
		teamPercent: 0,
		nights: 3,
		bufferPercent: 0,
		includeSubsidy: false,
		lodgingType: 'external',
		konfi: false,
		freizeitType: 'kids',
		bremenChildren: 0,
		bremenYouth: 0,
		teamWithJuleica: 0,
		teamWithoutJuleica: 0,
		teamYouth: 0,
		checklist: {},
		items: [{ id: 'a', category: 'food', label: 'Essen', amountCents: 30000, basis: 'flat' }]
	});
	await call(req, 'POST', `${A}/actions/${id}/calculation/apply`, {});
	await call(req, 'POST', `${A}/actions/${id}/accounting/entries`, {
		type: 'income',
		category: 'misc',
		description: 'Spende Gemeinde',
		amountCents: 45000,
		entryDate: '2026-05-20',
		paidBy: 'club'
	});
	const r = await call<{ booked: { items: Item[] } }>(
		req,
		'POST',
		`${A}/actions/${id}/accounting/refund`,
		{}
	);
	return { id, items: r.booked.items };
}

test.describe.configure({ mode: 'serial' });

test('Rückzahlung je Person spenden – intern und über den Link', async ({ page, browser }) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await login(page);
	await ensureModules(page.request, ['members', 'actions']);
	const { id, items } = await bookedAction(page.request);
	const anna = items.find((i) => i.name === 'Anna Albers')!;
	const clara = items.find((i) => i.name === 'Clara Cordes')!;
	await call(
		page.request,
		'PUT',
		`${A}/actions/${id}/accounting/refund/items/${anna.id}/donation`,
		{
			donatedCents: anna.amountCents
		}
	);

	await page.goto(`/modules/actions/${id}?tab=accounting`);
	await page.getByRole('tab', { name: /Rückzahlung/ }).click();
	await page.getByRole('button', { name: /^Details/ }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText('An den Stamm gespendet')).toBeVisible();
	await expect(dialog.getByText('Anna Albers')).toBeVisible();

	// Bent: Teilspende 50 € intern
	const bentGroup = dialog.getByRole('radiogroup', { name: 'Rückzahlung für Bent Brandt' });
	await bentGroup.getByText('Teilweise').click();
	const money = dialog.getByLabel('Spende von Bent Brandt in Euro');
	await money.fill('50');
	await money.blur();
	await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
	await expect(dialog.getByText(/· gespendet 300,00/)).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Speichern', exact: true })).toBeEnabled();

	// Frist setzen: Kasse wartet, Link bis dahin offen
	const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
	await dialog.getByLabel('Rückmeldung bis').fill(due);
	await dialog.getByRole('button', { name: 'Frist speichern' }).click();
	await expect(dialog.getByText(/Die Kasse zahlt erst/)).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Frist entfernen' })).toBeVisible();
	await page.screenshot({ path: 'test-results/refund-donation-deadline.png' });
	await page.screenshot({ path: 'test-results/refund-donation-dialog.png' });

	// Clara wählt über den Link (mobil)
	const { url } = await call<{ url: string }>(
		page.request,
		'POST',
		`${A}/actions/${id}/accounting/refund/items/${clara.id}/link`,
		{}
	);
	const path = new URL(url).pathname;
	const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const pub = await mobile.newPage();
	pub.on('pageerror', (e) => errors.push(e.message));
	await pub.goto(path);
	await expect(pub.getByRole('heading', { name: /Rückzahlung – Pfingstfahrt/ })).toBeVisible();
	await expect(pub.getByText('Rückzahlung für Clara Cordes')).toBeVisible();
	await expect(pub.getByText(/Bitte wähle bis zum/)).toBeVisible();
	await pub.getByRole('radio', { name: /Einen Teil spenden/ }).click();
	await expect(pub.getByRole('radio', { name: /Einen Teil spenden/ })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await pub.screenshot({ path: 'test-results/refund-donation-public.png', fullPage: true });
	const amount = pub.getByLabel('Spendenbetrag in Euro');
	await amount.fill('40');
	await amount.blur();
	await pub.getByRole('button', { name: 'Auswahl speichern' }).click();
	await expect(pub.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();
	await expect(pub.getByText(/Du spendest 40,00/)).toBeVisible();
	await pub.screenshot({ path: 'test-results/refund-donation-public-done.png' });
	await mobile.close();

	const state = await call<{ booked: { donatedCents: number; payoutCents: number } }>(
		page.request,
		'GET',
		`${A}/actions/${id}/accounting/refund`
	);
	expect(state.booked.donatedCents).toBe(25000 + 5000 + 4000);
	expect(state.booked.payoutCents).toBe(75000 - 34000);
	expect(errors).toEqual([]);
});
