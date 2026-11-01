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
	MatchPreview,
	PayableList,
	Payer,
	Transaction,
	TransactionCreated,
	TreasurySettings
} from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
type Mail = { to: string; subject: string; text: string; html?: string };
const mails: Mail[] = [];

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
		void html;
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

async function transactionCount(): Promise<number> {
	const r = await core.database
		.forModule('treasury')
		.transaction((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM transactions`));
	return Number((r.rows[0] as { n: number }).n);
}

describe('Neue Buchung direkt zuordnen', () => {
	let preview: MatchPreview;

	it('schlägt für eine Einnahme die passenden Rechnungen vor', async () => {
		preview = await data<MatchPreview>(
			await T('/match-preview', {
				method: 'POST',
				json: {
					amountCents: 37000,
					counterparty: 'Petra Müller',
					purpose: 'Sommerlager Lena und Jonas Mueller',
					counterpartyIban: 'DE89 3704 0044 0532 0130 00'
				}
			}),
			201
		);
		expect(preview.lines.length).toBeGreaterThanOrEqual(2);
		expect(preview.suggestion?.confidence).toBe('high');
		expect(preview.suggestion?.allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(37000);
		expect(preview.payables).toEqual([]);
	});

	it('lehnt eine Zuordnung über dem Buchungsbetrag ab und legt nichts an', async () => {
		const before = await transactionCount();
		const res = await T('/transactions', {
			method: 'POST',
			json: {
				accountId: giro,
				bookedOn: '2026-06-02',
				amountCents: 10000,
				allocations: preview.suggestion!.allocations
			}
		});
		expect(res.status).toBe(422);
		expect(await transactionCount()).toBe(before);
		// Ausgaben können keinen Rechnungen zugeordnet werden
		const neg = await T('/transactions', {
			method: 'POST',
			json: {
				accountId: giro,
				bookedOn: '2026-06-02',
				amountCents: -37000,
				allocations: preview.suggestion!.allocations
			}
		});
		expect(neg.status).toBe(422);
	});

	it('bucht und ordnet in einem Schritt zu, lernt den Zahler und bestätigt', async () => {
		mails.length = 0;
		const t = await data<TransactionCreated>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: giro,
					bookedOn: '2026-06-02',
					amountCents: 37000,
					counterparty: 'Petra Müller',
					purpose: 'Sommerlager Lena und Jonas Mueller',
					counterpartyIban: 'DE89 3704 0044 0532 0130 00',
					allocations: preview.suggestion!.allocations,
					notify: true
				}
			}),
			201
		);
		expect(t.allocation).toMatchObject({ allocatedCents: 37000, unallocatedCents: 0 });
		expect(t.allocation?.payer).toMatchObject({ name: 'Familie Müller', created: true });
		expect(t.allocation?.paidInvoices).toBe(2);
		expect(t.allocatedCents).toBe(37000);
		expect(t.category?.id).toBe('cat-beitraege');
		expect(t.payer?.name).toBe('Familie Müller');
		expect(mails).toHaveLength(1);
		const list = await data<InvoiceList>(await T('/invoices?status=open'));
		expect(list.items.filter((i) => i.recipientName.includes('Müller'))).toEqual([]);
	});
});

describe('Ausgabe direkt einer Auszahlung zuordnen', () => {
	let payableId = '';
	it('schlägt die passende Eingangsrechnung vor (Name + Betrag)', async () => {
		payableId = (
			await data<{ id: string }>(
				await T('/payables', {
					method: 'POST',
					json: {
						recipientName: 'Zeltplatz Waldblick',
						description: 'Platzmiete Sommerlager',
						amountCents: 12000,
						dueOn: '2026-07-01',
						iban: 'DE02 1203 0000 0000 2020 51'
					}
				}),
				201
			)
		).id;
		await data(
			await T('/payables', {
				method: 'POST',
				json: { recipientName: 'Busreisen Nord', description: 'Bus', amountCents: 12000 }
			}),
			201
		);
		const p = await data<MatchPreview>(
			await T('/match-preview', {
				method: 'POST',
				json: { amountCents: -12000, counterparty: 'Zeltplatz Waldblick GmbH', purpose: 'RE 42' }
			}),
			201
		);
		expect(p.lines).toEqual([]);
		expect(p.payableSuggestion).toMatchObject({ payableId, confidence: 'high' });
		// IBAN allein genügt ebenfalls
		const byIban = await data<MatchPreview>(
			await T('/match-preview', {
				method: 'POST',
				json: { amountCents: -12000, counterpartyIban: 'DE02120300000000202051' }
			}),
			201
		);
		expect(byIban.payableSuggestion).toMatchObject({ payableId, confidence: 'high' });
	});

	it('bucht die Ausgabe und verbucht die Auszahlung als bezahlt', async () => {
		const t = await data<TransactionCreated>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: giro,
					bookedOn: '2026-06-03',
					amountCents: -12000,
					counterparty: 'Zeltplatz Waldblick',
					payableId
				}
			}),
			201
		);
		expect(t.payableLinked).toBe(true);
		expect(t.allocation).toBeNull();
		const p = (await data<PayableList>(await T('/payables'))).items.find((x) => x.id === payableId);
		expect(p?.openCents ?? 0).toBe(0);
		// Einnahmen können keiner Auszahlung zugeordnet werden
		const res = await T('/transactions', {
			method: 'POST',
			json: { accountId: giro, bookedOn: '2026-06-03', amountCents: 500, payableId }
		});
		expect(res.status).toBe(422);
	});
});

describe('Zahlung erfassen mit Bankdaten', () => {
	it('legt aus der IBAN den Zahler an und hinterlegt Mitglied und Konto', async () => {
		const members = await data<{ id: string; name: string }[]>(await T('/members'));
		const inv = await data<InvoiceDetail>(
			await T('/invoices', {
				method: 'POST',
				json: {
					recipientName: 'Jonas Müller',
					issuedOn: '2026-06-01',
					dueOn: '2026-06-30',
					lines: [
						{
							description: 'Jahresbeitrag Jonas',
							amountCents: 6000,
							memberId: members.find((m) => m.name === 'Jonas Müller')!.id
						}
					]
				}
			}),
			201
		);
		const r = await data<AllocationResult>(
			await T(`/invoices/${inv.id}/mark-paid`, {
				method: 'POST',
				json: {
					accountId: giro,
					bookedOn: '2026-06-04',
					amountCents: 6000,
					counterparty: 'Petra Müller',
					counterpartyIban: 'DE89370400440532013000',
					notify: false
				}
			}),
			201
		);
		// Familie Mueller existiert schon (IBAN-Treffer) → ergänzt, nicht doppelt angelegt
		expect(r.payer).toMatchObject({ name: 'Familie Müller', created: false });
		const payers = await data<Payer[]>(await T('/payers'));
		expect(payers.filter((p) => p.name === 'Familie Müller')).toHaveLength(1);
		const t = await data<Transaction>(await T(`/transactions/${r.transactionId}`));
		expect(t.counterpartyIbanLast4).toBe('3000');
	});

	it('lehnt eine ungültige IBAN ab', async () => {
		const list = await data<InvoiceList>(await T('/invoices?status=all'));
		const res = await T(`/invoices/${list.items[0]!.id}/mark-paid`, {
			method: 'POST',
			json: {
				accountId: giro,
				bookedOn: '2026-06-04',
				amountCents: 100,
				counterpartyIban: 'DE00 1234'
			}
		});
		expect(res.status).toBe(422);
		expect(JSON.stringify(await res.json())).toContain('counterpartyIban');
	});
});
