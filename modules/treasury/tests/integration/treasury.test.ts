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
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type {
	Account,
	AllocationResult,
	ImportPreview,
	ImportResult,
	InvoiceDetail,
	InvoiceList,
	MatchSuggestion,
	OpenItems,
	PeriodReport,
	Transaction
} from '$modules/treasury/schemas';
import type { AccountingState } from '$modules/actions/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
const keys: Record<string, string> = {};
const mails: { to: string; subject: string; text: string }[] = [];

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
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
const T = (path: string, init: Parameters<typeof api>[1] = {}, who = 'kasse') =>
	api(`/modules/treasury${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const member = (firstName: string, lastName: string, birthDate: string, email: string) => ({
	firstName,
	lastName,
	birthDate,
	street: 'Lindenweg 4',
	postalCode: '28195',
	city: 'Bremen',
	country: 'DE',
	stage: 'woelfling',
	emails: [{ name: 'Eltern', value: email }]
});

let actionId = '';
let accountId = '';
const participants: Record<string, string> = {};

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
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	setTodayForTests('2026-06-01');

	const all = [...admin.permissions].filter(
		(p) => p.startsWith('treasury.') || p.startsWith('members.') || p.startsWith('actions.')
	);
	const roles = {
		kasse: await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] }),
		lesend: await createRole(admin, {
			name: 'Lesend',
			permissions: ['core.api.manage', 'treasury.cash.view']
		})
	};
	for (const [name, role] of Object.entries(roles)) {
		const id = await createUser(admin, {
			name,
			email: `${name}@example.test`,
			password: 'correct-horse-battery',
			roleIds: [role]
		});
		const ctx = await ctxOf(id);
		keys[name] = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;
	}

	const M = (path: string, json: unknown) =>
		api(`/modules/members${path}`, { token: keys.kasse, method: 'POST', json });
	await data(
		await M('/members', member('Lena', 'Müller', '2015-03-12', 'familie.mueller@example.test')),
		201
	);
	await data(
		await M('/members', member('Jonas', 'Müller', '2013-08-02', 'familie.mueller@example.test')),
		201
	);

	const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
		api(`/modules/actions${path}`, { token: keys.kasse, ...init });
	actionId = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name: 'Sommerlager', startsOn: '2026-07-20', endsOn: '2026-07-26' }
			}),
			201
		)
	).id;
	for (const [name, birthDate, role] of [
		['Lena Müller', '2015-03-12', 'participant'],
		['Jonas Müller', '2013-08-02', 'participant'],
		['Tim Becker', '2008-04-18', 'team']
	] as const) {
		const p = await data<{ id: string }>(
			await A(`/actions/${actionId}/participants`, {
				method: 'POST',
				json: { name, birthDate, role }
			}),
			201
		);
		participants[name] = p.id;
	}
	await core.database
		.forModule('actions')
		.transaction((tx) =>
			tx.execute(
				sql`UPDATE actions SET fee_cents = 18500, team_fee_cents = 9000, fee_applied_at = now() WHERE id = ${actionId}`
			)
		);
	accountId = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: {
					name: 'Girokonto',
					kind: 'giro',
					openingBalanceCents: 100000,
					openingDate: '2026-01-01'
				}
			}),
			201
		)
	).id;
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Abgleich mit Aktionen', () => {
	it('legt je Teilnehmende*r eine Rechnung an und verknüpft Mitglieder', async () => {
		const r = await data<{ created: number }>(await T('/sync', { method: 'POST' }), 201);
		expect(r.created).toBe(3);
		const list = await data<InvoiceList>(await T('/invoices'));
		expect(list.total).toBe(3);
		expect(list.totals.openCents).toBe(18500 * 2 + 9000);
		const lena = list.items.find((i) => i.recipientName === 'Lena Müller')!;
		// 14 Tage vor Beginn, aber mindestens 14 Tage nach heute
		expect(lena.dueOn).toBe('2026-07-06');
		const detail = await data<InvoiceDetail>(await T(`/invoices/${lena.id}`));
		expect(detail.lines[0]!.member?.name).toBe('Lena Müller');
		expect(detail.recipients).toEqual(['familie.mueller@example.test']);
		// Erneuter Abgleich ist idempotent
		const again = await data<{ created: number; updated: number }>(
			await T('/sync', { method: 'POST' }),
			201
		);
		expect(again).toMatchObject({ created: 0, updated: 0 });
	});

	it('übernimmt Beitragsänderungen', async () => {
		await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(sql`UPDATE actions SET fee_cents = 19000 WHERE id = ${actionId}`)
			);
		const r = await data<{ updated: number }>(await T('/sync', { method: 'POST' }), 201);
		expect(r.updated).toBe(2);
		const list = await data<InvoiceList>(await T('/invoices'));
		expect(list.totals.openCents).toBe(19000 * 2 + 9000);
	});
});

describe('Sammelzahlung für Geschwister', () => {
	let txId = '';

	it('schlägt beide Geschwister vor und verschickt EINE Bestätigung', async () => {
		const t = await data<Transaction>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId,
					bookedOn: '2026-06-02',
					amountCents: 38000,
					counterparty: 'Petra Mueller',
					purpose: 'Sommerlager Lena und Jonas Mueller'
				}
			}),
			201
		);
		txId = t.id;
		const s = await data<MatchSuggestion>(await T(`/transactions/${txId}/suggestion`));
		expect(s.confidence).toBe('high');
		expect(s.allocations).toHaveLength(2);
		expect(s.allocations.reduce((a, x) => a + x.amountCents, 0)).toBe(38000);

		mails.length = 0;
		const r = await data<AllocationResult>(
			await T(`/transactions/${txId}/allocations`, {
				method: 'PUT',
				json: { allocations: s.allocations, notify: true }
			})
		);
		expect(r).toMatchObject({
			allocatedCents: 38000,
			unallocatedCents: 0,
			paidInvoices: 2,
			mailsSent: 1
		});
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('familie.mueller@example.test');
		expect(mails[0]!.text).toContain('Lena Müller');
		expect(mails[0]!.text).toContain('Jonas Müller');
	});

	it('sendet die Bestätigung nur einmal', async () => {
		const t = await data<Transaction>(await T(`/transactions/${txId}`));
		// Zuordnung ergänzt fehlende Kategorie und Aktion
		expect(t.category?.id).toBe('cat-beitraege');
		expect(t.action?.id).toBe(actionId);
		expect(t.needsAllocation).toBe(false);
		mails.length = 0;
		await data(
			await T(`/transactions/${txId}/allocations`, {
				method: 'PUT',
				json: {
					allocations: t.allocations.map((a) => ({ lineId: a.lineId, amountCents: a.amountCents }))
				}
			})
		);
		expect(mails).toHaveLength(0);
	});

	it('verhindert Überzahlung eines Postens', async () => {
		const t2 = await data<Transaction>(
			await T('/transactions', {
				method: 'POST',
				json: { accountId, bookedOn: '2026-06-03', amountCents: 5000, purpose: 'Nochmal Lena' }
			}),
			201
		);
		const t = await data<Transaction>(await T(`/transactions/${txId}`));
		const res = await T(`/transactions/${t2.id}/allocations`, {
			method: 'PUT',
			json: { allocations: [{ lineId: t.allocations[0]!.lineId, amountCents: 5000 }] }
		});
		expect(res.status).toBe(422);
		await data(await T(`/transactions/${t2.id}`, { method: 'DELETE' }));
	});

	it('Aktions-Abrechnung zeigt die tatsächlichen Beiträge', async () => {
		const state = await data<AccountingState>(
			await api(`/modules/actions/actions/${actionId}/accounting`, { token: keys.kasse })
		);
		expect(state.autoIncome.contributions).toMatchObject({
			source: 'treasury',
			cents: 38000,
			dueCents: 47000,
			openCents: 9000
		});
	});
});

describe('Stornierung durch Abgleich', () => {
	it('storniert bei entfernter Teilnahme und führt Bezahltes als Guthaben', async () => {
		await data(
			await api(
				`/modules/actions/actions/${actionId}/participants/${participants['Lena Müller']}`,
				{
					token: keys.kasse,
					method: 'DELETE'
				}
			)
		);
		// Gezielter Abgleich der Aktion direkt nach dem Löschen – ohne Job/„Jetzt abgleichen“
		const open = await data<OpenItems>(await T('/open-items'));
		expect(open.totals.creditCents).toBe(19000);
		// Ein späterer Vollabgleich findet nichts mehr zu stornieren
		const r = await data<{ cancelled: number }>(await T('/sync', { method: 'POST' }), 201);
		expect(r.cancelled).toBe(0);
		expect(open.totals.creditCents).toBe(19000);
		expect(open.totals.openCents).toBe(9000);
	});
});

describe('Erinnerungen', () => {
	let invoiceId = '';
	it('legt eine manuelle Rechnung an', async () => {
		const inv = await data<InvoiceDetail>(
			await T('/invoices', {
				method: 'POST',
				json: {
					recipientName: 'Familie Schmidt',
					recipientEmail: 'schmidt@example.test',
					issuedOn: '2026-06-01',
					dueOn: '2026-06-15',
					lines: [
						{ description: 'Jahresbeitrag Paul', amountCents: 6000 },
						{ description: 'Jahresbeitrag Emma', amountCents: 6000 }
					]
				}
			}),
			201
		);
		invoiceId = inv.id;
		expect(inv.number).toMatch(/^R-2026-\d{4}$/);
		expect(inv.totalCents).toBe(12000);
	});

	it('Stufe 1 nach 7 Tagen, Stufe 2 nach weiteren 14, danach keine', async () => {
		const run = async () =>
			data<{ invoices: number }>(await T('/reminders/run', { method: 'POST' }), 201);
		mails.length = 0;
		setTodayForTests('2026-06-21');
		expect((await run()).invoices).toBe(0);
		setTodayForTests('2026-06-22');
		expect((await run()).invoices).toBe(1);
		expect((await run()).invoices).toBe(0);
		setTodayForTests('2026-07-05');
		expect((await run()).invoices).toBe(0);
		setTodayForTests('2026-07-06');
		expect((await run()).invoices).toBe(1);
		setTodayForTests('2026-09-01');
		// Team-Rechnung (ohne Adresse) fällig, Schmidt bereits Stufe 2
		const last = await data<{ invoices: number; withoutAddress: number }>(
			await T('/reminders/run', { method: 'POST' }),
			201
		);
		expect(last.invoices).toBe(0);
		expect(mails.filter((m) => m.to === 'schmidt@example.test')).toHaveLength(2);
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d.reminders.map((r) => r.level)).toEqual([1, 2]);
		setTodayForTests('2026-06-01');
	});

	it('Barzahlung als bezahlt markieren', async () => {
		const r = await data<AllocationResult>(
			await T(`/invoices/${invoiceId}/mark-paid`, {
				method: 'POST',
				json: { accountId, bookedOn: '2026-06-05', amountCents: 12000, notify: false }
			}),
			201
		);
		expect(r.allocatedCents).toBe(12000);
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d.status).toBe('paid');
		expect(d.paidNotifiedAt).not.toBeNull();
	});
});

describe('Import und Bericht', () => {
	const csv = [
		'"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"Betrag";"Währung"',
		'"DE001";"10.06.26";"10.06.26";"GUTSCHR.";"Spende Sommerfest";"Max Muster";"DE02";"50,00";"EUR"',
		'"DE001";"11.06.26";"11.06.26";"LASTSCHRIFT";"Kontofuehrung";"Sparkasse";"";"-4,90";"EUR"'
	].join('\r\n');
	const upload = (path: string) => {
		const fd = new FormData();
		fd.set('file', new Blob([csv], { type: 'text/csv' }), 'umsaetze.csv');
		fd.set('accountId', accountId);
		return T(path, { method: 'POST', body: fd });
	};

	it('erkennt Sparkasse-Spalten und Duplikate', async () => {
		const p = await data<ImportPreview>(await upload('/import/preview'), 201);
		expect(p.mapping).toMatchObject({
			date: 'Buchungstag',
			amount: 'Betrag',
			dateFormat: 'DD.MM.YY'
		});
		expect(p.rows.map((r) => r.amountCents)).toEqual([5000, -490]);
		expect(p.valid).toBe(2);
		const r = await data<ImportResult>(await upload('/import'), 201);
		expect(r).toMatchObject({ imported: 2, duplicates: 0 });
		const again = await data<ImportResult>(await upload('/import'), 201);
		expect(again).toMatchObject({ imported: 0, duplicates: 2 });
	});

	it('Bericht summiert Einnahmen und Ausgaben', async () => {
		const r = await data<PeriodReport>(await T('/report?from=2026-01-01&to=2026-12-31'));
		expect(r.totals.incomeCents).toBe(38000 + 12000 + 5000);
		expect(r.totals.expenseCents).toBe(490);
		expect(r.accounts[0]!.closingCents).toBe(100000 + 38000 + 12000 + 5000 - 490);
	});
});

describe('Rechte und Audit', () => {
	it('Lesende dürfen nichts ändern', async () => {
		expect((await T('/accounts', {}, 'lesend')).status).toBe(200);
		const res = await T(
			'/transactions',
			{ method: 'POST', json: { accountId, bookedOn: '2026-06-01', amountCents: 100 } },
			'lesend'
		);
		expect(res.status).toBe(403);
	});

	it('Audit enthält keine E-Mail-Adressen', async () => {
		const rows = await getDb().select().from(schema.auditLog);
		const treasury = rows.filter((r) => r.action.startsWith('treasury.'));
		expect(treasury.length).toBeGreaterThan(5);
		expect(JSON.stringify(treasury.map((r) => r.metadata))).not.toContain('@');
	});

	it('deaktiviertes Modul antwortet mit 404', async () => {
		await disableModule(admin, 'treasury');
		expect((await T('/accounts')).status).toBe(404);
		// Aktionen funktionieren weiter, rechnen dann wieder mit dem Soll
		const state = await data<AccountingState>(
			await api(`/modules/actions/actions/${actionId}/accounting`, { token: keys.kasse })
		);
		expect(state.autoIncome.contributions?.source).toBe('calculated');
		await enableModule(admin, 'treasury');
	});
});
