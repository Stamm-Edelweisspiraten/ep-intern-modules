import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setMailTransportForTests } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type {
	Account,
	AllocationResult,
	InvoiceDetail,
	InvoiceList,
	MatchSuggestion,
	PayableList,
	Payer,
	Transaction,
	TreasurySettings
} from '$modules/treasury/schemas';

const IBAN_FAMILY = 'DE89370400440532013000';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
type Mail = { to: string; subject: string; text: string; html?: string };
const mails: Mail[] = [];
let pdfHtml = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${key}`);
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
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, init);

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

let actionId = '';
let giro = '';

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
	admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m as Mail) });
	setPdfRendererForTests(async (html) => {
		pdfHtml = html;
		return new TextEncoder().encode('%PDF-fake');
	});
	setTodayForTests('2026-06-01');
	const perms = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const role = await createRole(admin, {
		name: 'Kasse',
		permissions: ['core.api.manage', ...perms]
	});
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = (await contextForUser(id))!.ctx;
	key = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;

	for (const [firstName, birthDate] of [
		['Lena', '2015-03-12'],
		['Jonas', '2013-08-02']
	]) {
		await data(
			await api('/modules/members/members', {
				method: 'POST',
				json: {
					firstName,
					lastName: 'Müller',
					birthDate,
					street: 'Lindenweg 4',
					postalCode: '28195',
					city: 'Bremen',
					stage: 'woelfling',
					emails: [{ name: 'Eltern', value: 'familie.mueller@example.test' }]
				}
			}),
			201
		);
	}
	actionId = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name: 'Sommerlager', startsOn: '2026-07-20', endsOn: '2026-07-26' }
			}),
			201
		)
	).id;
	for (const [name, birthDate] of [
		['Lena Müller', '2015-03-12'],
		['Jonas Müller', '2013-08-02']
	]) {
		await data(
			await A(`/actions/${actionId}/participants`, { method: 'POST', json: { name, birthDate } }),
			201
		);
	}
	await core.database
		.forModule('actions')
		.transaction((tx) =>
			tx.execute(
				sql`UPDATE actions SET fee_cents = 18500, fee_applied_at = now() WHERE id = ${actionId}`
			)
		);
	giro = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;
	const settings = await data<TreasurySettings>(await T('/settings'));
	await data(
		await T('/settings', {
			method: 'PUT',
			json: {
				...settings,
				bankHolder: 'VCP Stamm Seeadler',
				bankIban: 'DE02 1203 0000 0000 2020 51',
				bankBic: 'BYLADEM1001',
				bankName: 'Testbank'
			}
		})
	);
	await data(await T('/sync', { method: 'POST' }), 201);
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Zahler aus Buchungen', () => {
	let payerId = '';
	it('legt beim Zuordnen einer Einnahme mit IBAN den Zahler an', async () => {
		const t = await data<Transaction>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: giro,
					bookedOn: '2026-06-02',
					amountCents: 37000,
					counterparty: 'Petra Müller',
					purpose: 'Sommerlager Lena und Jonas Mueller',
					counterpartyIban: 'DE89 3704 0044 0532 0130 00'
				}
			}),
			201
		);
		expect(t.counterpartyIbanLast4).toBe('3000');
		const s = await data<MatchSuggestion>(await T(`/transactions/${t.id}/suggestion`));
		mails.length = 0;
		const r = await data<AllocationResult>(
			await T(`/transactions/${t.id}/allocations`, {
				method: 'PUT',
				json: { allocations: s.allocations, notify: true }
			})
		);
		expect(r.payer).toMatchObject({ name: 'Familie Müller', created: true });
		payerId = r.payer!.id;
		const payer = (await data<Payer[]>(await T('/payers'))).find((p) => p.id === payerId)!;
		expect(payer.members.map((m) => m.name).sort()).toEqual(['Jonas Müller', 'Lena Müller']);
		expect(payer).toMatchObject({ ibanMasked: '•••• 3000', accountHolder: 'Petra Müller' });
		// Bestätigung als HTML mit Postentabelle, ohne Zahlungskasten
		expect(mails).toHaveLength(1);
		expect(mails[0]!.html).toContain('<table');
		expect(mails[0]!.html).toContain('Lena Müller');
		expect(mails[0]!.html).not.toContain('Zahlungsinformationen');
	});

	it('übernimmt die IBAN des gewählten Zahlers in neue Buchungen', async () => {
		const t = await data<Transaction>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: giro,
					bookedOn: '2026-06-05',
					amountCents: 1000,
					counterparty: 'Petra Müller',
					payerId
				}
			}),
			201
		);
		expect(t.payer?.id).toBe(payerId);
		expect(t.counterpartyIbanLast4).toBe('3000');
	});

	it('Guthaben wird auf das Herkunftskonto der Zahlung zurückgezahlt', async () => {
		const list = await data<InvoiceList>(await T('/invoices?status=all&search=Lena'));
		await data(
			await T(`/invoices/${list.items[0]!.id}/cancel`, { method: 'POST', json: { reason: null } }),
			201
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		const credit = (await data<PayableList>(await T('/payables'))).items.find(
			(p) => p.source === 'credit'
		)!;
		expect(credit).toMatchObject({ openCents: 18500, ibanMasked: '•••• 3000' });
		const iban = await data<{ iban: string }>(await T(`/payables/${credit.id}/iban`));
		expect(iban.iban.replace(/\s/g, '')).toBe(IBAN_FAMILY);
	});

	it('Sammelrechnung des Zahlers als PDF mit GiroCode', async () => {
		const members = await data<{ id: string; name: string }[]>(await T('/members'));
		await data<InvoiceDetail>(
			await T('/invoices', {
				method: 'POST',
				json: {
					payerId,
					recipientName: 'Familie Müller',
					issuedOn: '2026-06-01',
					dueOn: '2026-06-30',
					lines: [
						{
							description: 'Mitgliedsbeitrag Jonas',
							amountCents: 6000,
							memberId: members.find((m) => m.name === 'Jonas Müller')!.id
						}
					]
				}
			}),
			201
		);
		const res = await T(`/payers/${payerId}/statement.pdf`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(pdfHtml).toContain('Mitgliedsbeitrag Jonas');
		expect(pdfHtml).toContain('DE02 1203 0000 0000 2020 51');
		expect(pdfHtml).toContain('GiroCode');
	});
});

describe('Rechnungs-PDF und Erinnerung mit Zahlungsdaten', () => {
	it('PDF ohne doppelten Titel, mit Zahlungsangaben', async () => {
		const list = await data<InvoiceList>(await T('/invoices?status=unpaid&search=Jonas'));
		const inv = list.items.find((i) => i.source === 'manual')!;
		expect((await T(`/invoices/${inv.id}/pdf`)).status).toBe(200);
		// Titel genau einmal als Überschrift (Vorlage), nicht zusätzlich im Inhalt
		expect(pdfHtml.match(new RegExp(`<h[1-3][^>]*>Rechnung ${inv.number}</h`, 'g'))).toHaveLength(
			1
		);
		expect(pdfHtml).toContain('Verwendungszweck');
		expect(pdfHtml).toContain(`${inv.number} Familie Müller`);
	});

	it('Erinnerungsmail enthält den Zahlungskasten', async () => {
		mails.length = 0;
		setTodayForTests('2026-07-08');
		await data(await T('/reminders/run', { method: 'POST' }), 201);
		setTodayForTests('2026-06-01');
		const m = mails.find((x) => x.subject.includes('Zahlungserinnerung'))!;
		expect(m.html).toContain('Zahlungsinformationen');
		expect(m.html).toContain('DE02 1203 0000 0000 2020 51');
		expect(m.text).toContain('Verwendungszweck');
	});
});

describe('Zahlstand in der Teilnehmerliste', () => {
	it('zeigt je Teilnehmende*r Rechnung, offen und bezahlt', async () => {
		type P = { id: string; name: string; payment?: Record<string, unknown> | null };
		const list = async () => data<P[]>(await A(`/actions/${actionId}/participants`));
		const before = await list();
		// Jonas ist über die Sammelzahlung bezahlt, Lenas Rechnung wurde storniert
		expect(before.find((p) => p.name === 'Jonas Müller')!.payment).toMatchObject({
			status: 'paid',
			openCents: 0
		});
		expect(before.find((p) => p.name === 'Lena Müller')!.payment).toBeNull();

		const mia = await data<P>(
			await A(`/actions/${actionId}/participants`, {
				method: 'POST',
				json: { name: 'Mia Neu', birthDate: '2014-01-01' }
			}),
			201
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		const open = (await list()).find((p) => p.id === mia.id)!.payment!;
		expect(open).toMatchObject({ status: 'open', dueCents: 18500, openCents: 18500 });
		expect(String(open.invoiceNumber)).toMatch(/^R-2026-/);

		await data(
			await T(`/invoices/${String(open.invoiceId)}/mark-paid`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-01', amountCents: 10000, notify: false }
			}),
			201
		);
		expect((await list()).find((p) => p.id === mia.id)!.payment).toMatchObject({
			status: 'partial',
			paidCents: 10000,
			openCents: 8500
		});
	});
});

describe('Abgeschlossene Abrechnungen und Belege', () => {
	it('Belegliste einer Auslage (ohne Speicher leer)', async () => {
		const payee = await data<{ id: string }>(
			await A(`/actions/${actionId}/accounting/payees`, {
				method: 'POST',
				json: { name: 'Anna', iban: 'DE02120300000000202051', bic: null, note: null }
			}),
			201
		);
		await data(
			await A(`/actions/${actionId}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'food',
					description: 'Einkauf',
					amountCents: 2000,
					entryDate: '2026-05-30',
					paidBy: 'person',
					payeeId: payee.id
				}
			}),
			201
		);
		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		const p = (await data<PayableList>(await T('/payables'))).items.find(
			(x) => x.source === 'reimbursement'
		)!;
		expect(await data<unknown[]>(await T(`/payables/${p.id}/receipts`))).toEqual([]);
	});

	it('zeigt abgeschlossene Abrechnungen, PDF und Ablage', async () => {
		const list = await data<{ actionId: string; filedAt: string | null; expenseCents: number }[]>(
			await T('/closed-accountings')
		);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ actionId, filedAt: null, expenseCents: 2000 });
		const pdf = await T(`/closed-accountings/${actionId}/pdf`);
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toBe('application/pdf');
		await data(
			await T(`/closed-accountings/${actionId}/filed`, { method: 'PUT', json: { filed: true } })
		);
		const after = await data<{ filedAt: string | null; filedBy: string | null }[]>(
			await T('/closed-accountings')
		);
		expect(after[0]!.filedAt).not.toBeNull();
	});
});
