/**
 * Kasse `GET /my/invoices` (Dashboard „Meine offenen Rechnungen“): nur offene/teilbezahlte Rechnungen der
 * verknüpften Mitglieder, keine Namen fremder Mitglieder, Summen, Bankdaten aus den Kassen-Einstellungen,
 * 403 ohne Recht, Modul deaktiviert → 404.
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
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { Account, InvoiceDetail, MyInvoices } from '$modules/treasury/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'treasury-my-password-1';
let admin: RequestContext;
let close: () => Promise<void>;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
const memberIds: Record<string, string> = {};
const inv: Record<string, InvoiceDetail> = {};
let giro = '';

function api(path: string, init: RequestInit & { json?: unknown; token?: string } = {}) {
	resetAllForTests();
	const { json, token, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${token ?? keys.admin}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, init);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	const id = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	userIds[name] = id;
	const ctx = await ctxOf(id);
	keys[name] = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
}

async function mkMember(firstName: string, lastName: string) {
	const m = await data<{ id: string }>(
		await api('/modules/members/members', {
			method: 'POST',
			json: {
				firstName,
				lastName,
				birthDate: '2014-03-12',
				street: 'Lindenweg 4',
				postalCode: '28195',
				city: 'Bremen',
				stage: 'woelfling',
				emails: [{ name: null, value: `${firstName.toLowerCase()}@familie.test` }]
			}
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
	number: string,
	dueOn: string,
	lines: { description: string; amountCents: number; memberId: string | null }[]
) {
	inv[number] = await data<InvoiceDetail>(
		await T('/invoices', {
			method: 'POST',
			json: { recipientName: `Familie ${number}`, issuedOn: '2026-05-01', dueOn, lines }
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
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setMailTransportForTests({ sendMail: async () => undefined });
	setTodayForTests('2026-06-01');

	await mkUser('eltern', ['core.api.manage', 'treasury.own.view']);
	await mkUser('ohne', ['core.api.manage', 'treasury.own.view']);
	await mkUser('norecht', ['core.api.manage']);

	await mkMember('Lena', 'Müller');
	await mkMember('Jonas', 'Müller');
	await mkMember('Ole', 'Hansen');
	await link(memberIds.Lena!, 'eltern');
	await link(memberIds.Jonas!, 'eltern');

	giro = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;

	// A: Lena, überfällig · B: Sammelrechnung Jonas + Ole (fremd) · C: nur Ole · D: Lena storniert
	// E: Jonas bezahlt · F: Lena teilbezahlt, noch nicht fällig
	await invoice('A', '2026-05-20', [
		{ description: 'Sommerlager', amountCents: 12000, memberId: memberIds.Lena! }
	]);
	await invoice('B', '2026-06-15', [
		{ description: 'Pfingsten Jonas', amountCents: 3000, memberId: memberIds.Jonas! },
		{ description: 'Pfingsten Ole', amountCents: 3000, memberId: memberIds.Ole! }
	]);
	await invoice('C', '2026-05-10', [
		{ description: 'Halstuch', amountCents: 800, memberId: memberIds.Ole! }
	]);
	await invoice('D', '2026-06-20', [
		{ description: 'Storniert', amountCents: 5000, memberId: memberIds.Lena! }
	]);
	await invoice('E', '2026-06-20', [
		{ description: 'Bezahlt', amountCents: 2000, memberId: memberIds.Jonas! }
	]);
	await invoice('F', '2026-07-01', [
		{ description: 'Herbstfahrt', amountCents: 9000, memberId: memberIds.Lena! }
	]);
	await data(await T(`/invoices/${inv.D!.id}/cancel`, { method: 'POST', json: {} }), 201);
	for (const [k, cents] of [
		['E', 2000],
		['F', 4000]
	] as const) {
		await data(
			await T(`/invoices/${inv[k]!.id}/mark-paid`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-05-25', amountCents: cents, notify: false }
			}),
			201
		);
	}
});

afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	await close();
});

describe('GET /my/invoices', () => {
	it('liefert nur offene/teilbezahlte Rechnungen der eigenen Mitglieder', async () => {
		const my = await data<MyInvoices>(await T('/my/invoices', { token: keys.eltern }));
		expect(my.invoices.map((i) => i.id)).toEqual([inv.A!.id, inv.B!.id, inv.F!.id]);
		const [a, b, f] = my.invoices;
		expect(a).toMatchObject({
			number: inv.A!.number,
			members: ['Lena Müller'],
			totalCents: 12000,
			openCents: 12000,
			dueDate: '2026-05-20',
			overdue: true,
			purpose: `${inv.A!.number} Familie A`
		});
		// Sammelrechnung: nur der eigene Name, nie der des fremden Mitglieds
		expect(b!.members).toEqual(['Jonas Müller']);
		expect(JSON.stringify(my)).not.toContain('Ole');
		expect(b!.overdue).toBe(false);
		expect(f).toMatchObject({ totalCents: 9000, openCents: 5000, overdue: false });
		expect(my.totals).toEqual({ openCents: 12000 + 6000 + 5000, overdueCents: 12000 });
	});

	it('Bankdaten nur, wenn Inhaber und IBAN in den Kassen-Einstellungen stehen', async () => {
		let my = await data<MyInvoices>(await T('/my/invoices', { token: keys.eltern }));
		expect(my.bank).toBeNull();
		await setSetting(admin, 'treasury.bank.holder', 'Stamm Test e.V.');
		await setSetting(admin, 'treasury.bank.iban', 'DE02120300000000202051');
		await setSetting(admin, 'treasury.bank.bic', 'BYLADEM1001');
		my = await data<MyInvoices>(await T('/my/invoices', { token: keys.eltern }));
		expect(my.bank).toEqual({
			holder: 'Stamm Test e.V.',
			iban: 'DE02120300000000202051',
			bic: 'BYLADEM1001'
		});
	});

	it('ohne verknüpfte Mitglieder leere Liste', async () => {
		const my = await data<MyInvoices>(await T('/my/invoices', { token: keys.ohne }));
		expect(my).toEqual({ invoices: [], totals: { openCents: 0, overdueCents: 0 }, bank: null });
	});

	it('ohne treasury.own.view 403', async () => {
		const res = await T('/my/invoices', { token: keys.norecht });
		expect(res.status).toBe(403);
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'treasury');
		try {
			const res = await T('/my/invoices', { token: keys.eltern });
			expect(res.status).toBe(404);
			expect((await res.json()).error.code).toBe('module_disabled');
		} finally {
			await enableModule(admin, 'treasury');
		}
	});
});
