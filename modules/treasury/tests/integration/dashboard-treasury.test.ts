/**
 * Übersicht „Zu erledigen“ der Kasse (`ModuleDefinition.dashboard.todos`): eigene offene Rechnungen nur
 * für verknüpfte Konten (überfällig/fällig nach `today`, Zahlungsdaten aus den Kassen-Einstellungen),
 * Kassen-Aufgaben nur mit `treasury.cash.view`, Modul deaktiviert → keine Zeilen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setMailTransportForTests } from '$testing';
import { setSetting } from '$testing';
import { resetAllForTests } from '$testing';
import { collectDashboardFeed } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import { invoiceOccasion } from '$modules/treasury/my.endpoints';
import type { InvoiceDetail, InvoiceSummary } from '$modules/treasury/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'dashboard-treasury-password-1';
const TODAY = '2026-06-01';
let admin: RequestContext;
let close: () => Promise<void>;
const userIds: Record<string, string> = {};
const memberIds: Record<string, string> = {};
const inv: Record<string, InvoiceDetail> = {};

async function api(path: string, json?: unknown) {
	resetAllForTests();
	const key = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	const headers = new Headers({ authorization: `Bearer ${key}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	return handleApiRequest({
		request: new Request(url, {
			method: json === undefined ? 'GET' : 'POST',
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
}

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
const feedOf = async (name: string) =>
	(await collectDashboardFeed(await ctxOf(userIds[name]!), { today: TODAY })).todos.filter(
		(t) => t.moduleId === 'treasury'
	);

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
}

async function mkMember(firstName: string, lastName: string) {
	const m = await data<{ id: string }>(
		await api('/modules/members/members', {
			firstName,
			lastName,
			birthDate: '2014-03-12',
			street: 'Lindenweg 4',
			postalCode: '28195',
			city: 'Bremen',
			stage: 'woelfling',
			emails: [{ name: null, value: `${firstName.toLowerCase()}@familie.test` }]
		}),
		201
	);
	memberIds[firstName] = m.id;
}

async function link(memberId: string, user: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${memberId}, ${userIds[user]!}, 'Mutter')`
		);
	});
}

async function invoice(
	key: string,
	dueOn: string,
	lines: { description: string; amountCents: number; memberId: string | null }[]
) {
	inv[key] = await data<InvoiceDetail>(
		await api('/modules/treasury/invoices', {
			recipientName: `Familie ${key}`,
			issuedOn: '2026-05-01',
			dueOn,
			lines
		}),
		201
	);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	setMailTransportForTests({ sendMail: async () => undefined });
	setTodayForTests(TODAY);

	await mkUser('eltern', ['treasury.own.view']);
	await mkUser('fremd', ['treasury.own.view']);
	await mkUser('kasse', ['treasury.cash.view']);
	await mkUser('norecht', []);

	await mkMember('Mia', 'Müller');
	await mkMember('Lukas', 'Müller');
	await mkMember('Ole', 'Hansen');
	await link(memberIds.Mia!, 'eltern');
	await link(memberIds.Lukas!, 'eltern');

	// A: Mia + Lukas, überfällig · B: nur Mia, noch nicht fällig · C: nur Ole (fremd), überfällig
	await invoice('A', '2026-05-20', [
		{ description: 'Sommerlager Mia', amountCents: 12000, memberId: memberIds.Mia! },
		{ description: 'Sommerlager Lukas', amountCents: 12000, memberId: memberIds.Lukas! }
	]);
	await invoice('B', '2026-06-15', [
		{ description: 'Halstuch', amountCents: 800, memberId: memberIds.Mia! }
	]);
	await invoice('C', '2026-05-10', [
		{ description: 'Pfingsten', amountCents: 3000, memberId: memberIds.Ole! }
	]);
	await setSetting(admin, 'treasury.bank.holder', 'Stamm Test e.V.');
	await setSetting(admin, 'treasury.bank.iban', 'DE02120300000000202051');
	await setSetting(admin, 'treasury.bank.bic', 'BYLADEM1001');
});

afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	await close();
});

describe('Kasse: Zu erledigen', () => {
	it('eigene offene Rechnungen mit Fälligkeit, Betrag und Zahlungsdaten', async () => {
		const todos = await feedOf('eltern');
		expect(todos.map((t) => t.id)).toEqual([`invoice:${inv.A!.id}`, `invoice:${inv.B!.id}`]);
		const [a, b] = todos;
		expect(a).toMatchObject({
			title: `Rechnung ${inv.A!.number} bezahlen`,
			detail: `${inv.A!.number} · Lukas Müller und Mia Müller`,
			due: '2026-05-20',
			severity: 'overdue',
			amountCents: 24000,
			action: { label: 'Bezahlen', href: '/dashboard' },
			payment: {
				holder: 'Stamm Test e.V.',
				iban: 'DE02120300000000202051',
				bic: 'BYLADEM1001',
				amountCents: 24000,
				reference: `${inv.A!.number} Familie A`
			}
		});
		expect(b).toMatchObject({ severity: 'due', due: '2026-06-15', amountCents: 800 });
		// Keine Kassen-Aufgaben und nie fremde Mitglieder
		expect(todos.some((t) => t.id.startsWith('task:'))).toBe(false);
		expect(JSON.stringify(todos)).not.toContain('Ole');
	});

	it('Anlass im Titel je Herkunft der Rechnung', () => {
		const base = { issuedOn: '2026-02-01', action: null } as unknown as InvoiceSummary;
		expect(
			invoiceOccasion({
				...base,
				source: 'action',
				action: { id: 'x', name: 'Herbstfahrt 2026' }
			})
		).toBe('Herbstfahrt 2026');
		expect(invoiceOccasion({ ...base, source: 'annual' })).toBe('Jahresbeitrag 2026');
		expect(invoiceOccasion({ ...base, source: 'order' })).toBe('Bestellung');
		expect(invoiceOccasion({ ...base, source: 'manual' })).toBeNull();
	});

	it('andere Person ohne verknüpfte Mitglieder sieht nichts', async () => {
		expect(await feedOf('fremd')).toEqual([]);
	});

	it('ohne Recht keine Zeilen', async () => {
		expect(await feedOf('norecht')).toEqual([]);
	});

	it('Kassen-Aufgaben nur mit treasury.cash.view', async () => {
		const todos = await feedOf('kasse');
		const overdue = todos.find((t) => t.id === 'task:overdue');
		expect(overdue).toMatchObject({
			title: '2 Rechnungen sind überfällig',
			severity: 'overdue',
			amountCents: 24000 + 3000,
			action: { label: 'Offene Posten', href: '/modules/treasury?tab=open' }
		});
		// Keine eigenen Rechnungen ohne treasury.own.view
		expect(todos.some((t) => t.id.startsWith('invoice:'))).toBe(false);
		expect(todos.every((t) => ['overdue', 'due', 'info'].includes(t.severity))).toBe(true);
	});

	it('Modul deaktiviert → keine Zeilen', async () => {
		await disableModule(admin, 'treasury');
		try {
			expect(await feedOf('eltern')).toEqual([]);
			expect(await feedOf('kasse')).toEqual([]);
		} finally {
			await enableModule(admin, 'treasury');
		}
	});
});
