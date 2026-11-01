import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type { AccountingEntry, AccountingState } from '$modules/actions/schemas';
import type { Account, Payable, PayableList } from '$modules/treasury/schemas';
import type { ClosedAccountingDetailItem } from '$modules/treasury/closed-accountings';

// Gültige Test-IBANs (Prüfsumme korrekt)
const IBAN_HOSTEL = 'DE89370400440532013000';
const IBAN_PAYEE = 'DE02120300000000202051';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let keyNoReport = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}, apiKey = key) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${apiKey}`);
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
const T = (path: string, init: Parameters<typeof api>[1] = {}, apiKey = key) =>
	api(`/modules/treasury${path}`, init, apiKey);
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, init);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

let actionId = '';
let giro = '';

const expense = (extra: Record<string, unknown>) => ({
	type: 'expense',
	category: 'lodging',
	description: 'Jugendherberge',
	amountCents: 48000,
	entryDate: '2026-06-10',
	paidBy: 'club',
	...extra
});

async function payables(status = 'all'): Promise<Payable[]> {
	await data(await T('/sync', { method: 'POST' }), 201);
	return (await data<PayableList>(await T(`/payables?status=${status}`))).items;
}

async function entryOf(id: string): Promise<AccountingEntry> {
	const state = await data<AccountingState>(await A(`/actions/${actionId}/accounting`));
	return state.entries.find((e) => e.id === id)!;
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
	admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setTodayForTests('2026-06-01');
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	// Kasse ohne Berichtsrecht (Abrechnungs-Tab gesperrt)
	const perms = [...admin.permissions].filter(
		(p) => /^(treasury|actions)\./.test(p) && p !== 'treasury.report.view'
	);
	const role = await createRole(admin, {
		name: 'Ohne Bericht',
		permissions: ['core.api.manage', ...perms]
	});
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = (await contextForUser(id))!.ctx;
	keyNoReport = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;

	actionId = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name: 'Pfingstlager', startsOn: '2026-06-05', endsOn: '2026-06-08' }
			}),
			201
		)
	).id;
	giro = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Ausgaben bezahlt vom Stamm', () => {
	let entryId = '';

	it('verlangt Empfänger, IBAN und Verwendungszweck, solange nicht bezahlt', async () => {
		const res = await A(`/actions/${actionId}/accounting/entries`, {
			method: 'POST',
			json: expense({ clubPaid: false })
		});
		expect(res.status).toBe(422);
		const err = (await res.json()).error;
		expect(JSON.stringify(err.details)).toContain('recipientName');
		expect(JSON.stringify(err.details)).toContain('purpose');

		const noIban = await A(`/actions/${actionId}/accounting/entries`, {
			method: 'POST',
			json: expense({ clubPaid: false, recipientName: 'Jugendherberge Bremen', purpose: 'Rg 4711' })
		});
		expect(noIban.status).toBe(422);
		const bad = await A(`/actions/${actionId}/accounting/entries`, {
			method: 'POST',
			json: expense({
				clubPaid: false,
				recipientName: 'Jugendherberge Bremen',
				purpose: 'Rg 4711',
				iban: 'DE00 1234'
			})
		});
		expect(bad.status).toBe(422);
	});

	it('ohne Angabe gilt eine Stamm-Ausgabe als bezahlt und erzeugt keine Auszahlung', async () => {
		const e = await data<AccountingEntry>(
			await A(`/actions/${actionId}/accounting/entries`, {
				method: 'POST',
				json: expense({ description: 'Bus', amountCents: 9000, category: 'travel' })
			}),
			201
		);
		expect(e.clubPaidVia).toBe('manual');
		expect(e.clubPaidAt).not.toBeNull();
		expect((await payables()).some((p) => p.source === 'expense')).toBe(false);
	});

	it('offene Stamm-Ausgabe wird sofort Auszahlung in der Kasse', async () => {
		const e = await data<AccountingEntry>(
			await A(`/actions/${actionId}/accounting/entries`, {
				method: 'POST',
				json: expense({
					clubPaid: false,
					recipientName: 'Jugendherberge Bremen',
					purpose: 'Rechnung 4711 Pfingstlager',
					iban: 'DE89 3704 0044 0532 0130 00',
					bic: 'COBADEFFXXX'
				})
			}),
			201
		);
		entryId = e.id;
		expect(e.clubPaidAt).toBeNull();
		expect(e.recipient).toMatchObject({ name: 'Jugendherberge Bremen', bic: 'COBADEFFXXX' });
		expect(e.recipient!.ibanMasked).toContain('0130 00');
		expect(JSON.stringify(e)).not.toContain(IBAN_HOSTEL);

		const state = await data<AccountingState>(await A(`/actions/${actionId}/accounting`));
		expect(state.summary.openClubPayments).toEqual({ count: 1, cents: 48000 });

		const iban = await data<{ iban: string }>(
			await A(`/actions/${actionId}/accounting/entries/${entryId}/iban`)
		);
		expect(iban.iban).toBe(IBAN_HOSTEL);

		const p = (await payables('open')).find((x) => x.source === 'expense')!;
		expect(p).toMatchObject({
			recipientName: 'Jugendherberge Bremen',
			description: 'Rechnung 4711 Pfingstlager',
			openCents: 48000,
			dueOn: '2026-06-01',
			hasIban: true,
			bic: 'COBADEFFXXX'
		});
		const plain = await data<{ iban: string }>(await T(`/payables/${p.id}/iban`));
		expect(plain.iban.replace(/\s/g, '')).toBe(IBAN_HOSTEL);
		const csv = await (await T('/payables.csv')).text();
		expect(csv).toContain('Rechnung 4711 Pfingstlager');
	});

	it('Ändern ohne IBAN behält die gespeicherte IBAN, Betrag folgt in der Kasse', async () => {
		await data(
			await A(`/actions/${actionId}/accounting/entries/${entryId}`, {
				method: 'PUT',
				json: expense({
					amountCents: 50000,
					clubPaid: false,
					recipientName: 'Jugendherberge Bremen',
					purpose: 'Rechnung 4711 Pfingstlager'
				})
			})
		);
		const p = (await payables('open')).find((x) => x.source === 'expense')!;
		expect(p.amountCents).toBe(50000);
		expect(p.hasIban).toBe(true);
	});

	it('Überweisung in der Kasse markiert die Ausgabe als bezahlt und sperrt sie', async () => {
		const p = (await payables('open')).find((x) => x.source === 'expense')!;
		const paid = await data<Payable>(
			await T(`/payables/${p.id}/pay`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-12', amountCents: 50000 }
			}),
			201
		);
		expect(paid.openCents).toBe(0);
		const e = await entryOf(entryId);
		expect(e.clubPaidVia).toBe('treasury');
		expect(e.clubPaidAt).not.toBeNull();

		const put = await A(`/actions/${actionId}/accounting/entries/${entryId}`, {
			method: 'PUT',
			json: expense({ clubPaid: true })
		});
		expect(put.status).toBe(409);
		const del = await A(`/actions/${actionId}/accounting/entries/${entryId}`, {
			method: 'DELETE'
		});
		expect(del.status).toBe(409);

		// Abgleich storniert die bezahlte Auszahlung nicht
		const again = (await payables()).find((x) => x.id === p.id)!;
		expect(again.cancelledAt).toBeNull();

		// Zahlung löschen → in der Abrechnung wieder offen
		await data(await T(`/transactions/${paid.payments[0]!.transactionId}`, { method: 'DELETE' }));
		const reopened = await entryOf(entryId);
		expect(reopened.clubPaidAt).toBeNull();
		expect(reopened.clubPaidVia).toBeNull();
	});

	it('nachträglich „bereits bezahlt“ storniert die offene Auszahlung', async () => {
		await data(
			await A(`/actions/${actionId}/accounting/entries/${entryId}`, {
				method: 'PUT',
				json: expense({ amountCents: 50000, clubPaid: true })
			})
		);
		const e = await entryOf(entryId);
		expect(e.clubPaidVia).toBe('manual');
		const p = (await payables()).find((x) => x.source === 'expense')!;
		expect(p.cancelledAt).not.toBeNull();
		// wieder offen → Auszahlung wird reaktiviert (IBAN bleibt gespeichert)
		await data(
			await A(`/actions/${actionId}/accounting/entries/${entryId}`, {
				method: 'PUT',
				json: expense({
					amountCents: 50000,
					clubPaid: false,
					recipientName: 'Jugendherberge Bremen',
					purpose: 'Rechnung 4711 Pfingstlager'
				})
			})
		);
		const back = (await payables()).find((x) => x.id === p.id)!;
		expect(back.cancelledAt).toBeNull();
		expect(back.openCents).toBe(50000);
	});

	it('Audit ohne IBAN', async () => {
		const logs = await getDb().select().from(schema.auditLog);
		const text = JSON.stringify(logs.map((l) => l.metadata));
		expect(text).not.toContain(IBAN_HOSTEL);
		expect(text).not.toContain('Jugendherberge');
		expect(logs.some((l) => l.action === 'actions.accounting.club_paid')).toBe(true);
		expect(logs.some((l) => l.action === 'actions.accounting.club_paid_reverted')).toBe(true);
	});
});

describe('Auslagen erst mit Abschluss, Abrechnungen in der Kasse', () => {
	let payeeId = '';

	it('Auslage erscheint erst nach dem Abschluss, Wiederöffnen storniert sie', async () => {
		payeeId = (
			await data<{ id: string }>(
				await A(`/actions/${actionId}/accounting/payees`, {
					method: 'POST',
					json: { name: 'Anna Auslage', iban: IBAN_PAYEE, bic: null, note: null }
				}),
				201
			)
		).id;
		await data(
			await A(`/actions/${actionId}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'food',
					description: 'Einkauf',
					amountCents: 4250,
					entryDate: '2026-06-06',
					paidBy: 'person',
					payeeId
				}
			}),
			201
		);
		expect((await payables()).some((p) => p.source === 'reimbursement')).toBe(false);

		// Detail ist vor dem Abschluss nicht sichtbar
		expect((await T(`/closed-accountings/${actionId}`)).status).toBe(404);

		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const open = (await payables('open')).find((p) => p.source === 'reimbursement')!;
		expect(open).toMatchObject({ recipientName: 'Anna Auslage', openCents: 4250 });
		// offene Stamm-Ausgabe bleibt nach dem Abschluss offen
		expect((await payables('open')).some((p) => p.source === 'expense')).toBe(true);

		await data(await A(`/actions/${actionId}/accounting/reopen`, { method: 'POST' }), 201);
		const cancelled = (await payables()).find((p) => p.id === open.id)!;
		expect(cancelled.cancelledAt).not.toBeNull();

		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const back = (await payables()).find((p) => p.id === open.id)!;
		expect(back.cancelledAt).toBeNull();
	});

	it('Kasse sieht die abgeschlossene Abrechnung im Detail', async () => {
		const d = await data<ClosedAccountingDetailItem>(await T(`/closed-accountings/${actionId}`));
		expect(d).toMatchObject({ actionId, name: 'Pfingstlager', filedAt: null });
		expect(d.entries).toHaveLength(3);
		expect(d.summary.expenseCents).toBe(9000 + 50000 + 4250);
		expect(d.summary.openClubPayments).toEqual({ count: 1, cents: 50000 });
		expect(d.payees[0]).toMatchObject({ name: 'Anna Auslage', openCents: 4250 });
		expect(d.payables.map((p) => p.source).sort()).toEqual(['expense', 'reimbursement']);
		expect(JSON.stringify(d)).not.toContain(IBAN_HOSTEL);
		expect(JSON.stringify(d)).not.toContain(IBAN_PAYEE);

		const entry = d.entries.find((e) => e.paidBy === 'club' && e.clubPaidAt === null)!;
		expect((await T(`/closed-accountings/${actionId}/receipts/${entry.id}`)).status).toBe(404);
		expect((await T(`/closed-accountings/${crypto.randomUUID()}`)).status).toBe(404);
		expect((await T(`/closed-accountings/${actionId}`, {}, keyNoReport)).status).toBe(403);
		// lastUsedAt/Zugriffslog laufen ohne await: eine weitere Anfrage abwarten, sonst hängt close()
		await data(await T('/closed-accountings'));
	});
});
