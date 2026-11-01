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
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import { STANDARD_FORM_KEYS, type FormConfig } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';
import type {
	Account,
	ImportResult,
	InvoiceDetail,
	InvoiceList,
	MatchSuggestion,
	Payable,
	PayableList,
	Payer,
	Transaction
} from '$modules/treasury/schemas';

const IBAN_FAMILY = 'DE89370400440532013000';
const IBAN_PAYEE = 'DE02120300000000202051';

let admin: RequestContext;
let close: () => Promise<void>;
const keys: Record<string, string> = {};
type Mail = { to: string; subject: string; text: string; attachments?: { filename: string }[] };
const mails: Mail[] = [];

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
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, { token: keys.kasse, ...init });

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

let actionId = '';
let giro = '';
let cash = '';

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
	// Benachrichtigungen (core.notifications) prüft notifications-modules.test.ts
	setMailTransportForTests({
		sendMail: async (m) => {
			if (m.headers?.['X-Atrium'] !== 'notification') mails.push(m as Mail);
		}
	});
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	setTodayForTests('2026-06-01');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const roles = {
		kasse: await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] }),
		ohneBank: await createRole(admin, {
			name: 'Ohne Bank',
			permissions: ['core.api.manage', ...all.filter((p) => p !== 'treasury.bank.view')]
		})
	};
	for (const [name, role] of Object.entries(roles)) {
		const id = await createUser(admin, {
			name,
			email: `${name.toLowerCase()}@example.test`,
			password: 'correct-horse-battery',
			roleIds: [role]
		});
		const ctx = await ctxOf(id);
		keys[name] = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;
	}

	await data(
		await api('/modules/members/members', {
			token: keys.kasse,
			method: 'POST',
			json: {
				firstName: 'Lena',
				lastName: 'Müller',
				birthDate: '2015-03-12',
				street: 'Lindenweg 4',
				postalCode: '28195',
				city: 'Bremen',
				stage: 'woelfling',
				emails: [{ name: 'Eltern', value: 'familie.mueller@example.test' }]
			}
		}),
		201
	);
	actionId = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name: 'Sommerlager', startsOn: '2026-07-20', endsOn: '2026-07-26' }
			}),
			201
		)
	).id;
	await core.database
		.forModule('actions')
		.transaction((tx) =>
			tx.execute(
				sql`UPDATE actions SET fee_cents = 18500, team_fee_cents = 9000, fee_applied_at = now() WHERE id = ${actionId}`
			)
		);
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Standardkonto', () => {
	it('erstes Konto wird Standard, Wechsel ist eindeutig, Archivieren gesperrt', async () => {
		const g = await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		);
		const c = await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Barkasse', kind: 'cash', openingDate: '2026-01-01' }
			}),
			201
		);
		giro = g.id;
		cash = c.id;
		expect(g.isDefault).toBe(true);
		expect(c.isDefault).toBe(false);
		const list = await data<Account[]>(await T(`/accounts/${cash}/default`, { method: 'PUT' }));
		expect(list.filter((a) => a.isDefault).map((a) => a.id)).toEqual([cash]);
		const res = await T(`/accounts/${cash}`, {
			method: 'PUT',
			json: { name: 'Barkasse', kind: 'cash', openingDate: '2026-01-01', archived: true }
		});
		expect(res.status).toBe(409);
		await data(await T(`/accounts/${giro}/default`, { method: 'PUT' }));
	});
});

describe('Zahler mit Bankverbindung und IBAN-Abgleich', () => {
	let payerId = '';
	it('speichert die IBAN verschlüsselt, Klartext nur mit bank.view', async () => {
		const members = await data<{ id: string; name: string }[]>(await T('/members'));
		const p = await data<Payer>(
			await T('/payers', {
				method: 'POST',
				json: {
					name: 'Familie Müller',
					memberIds: members.map((m) => m.id),
					accountHolder: 'Petra Müller',
					iban: 'DE89 3704 0044 0532 0130 00',
					bic: 'COBADEFFXXX'
				}
			}),
			201
		);
		payerId = p.id;
		expect(p.ibanMasked).toBe('•••• 3000');
		expect(JSON.stringify(p)).not.toContain('0532013000');
		const iban = await data<{ iban: string }>(await T(`/payers/${payerId}/iban`));
		expect(iban.iban).toBe('DE89 3704 0044 0532 0130 00');
		expect((await T(`/payers/${payerId}/iban`, {}, 'ohneBank')).status).toBe(403);
		// Ungültige IBAN
		const bad = await T(`/payers/${payerId}`, {
			method: 'PUT',
			json: { name: 'Familie Müller', iban: 'DE00 1234' }
		});
		expect(bad.status).toBe(422);
		const rows = await core.database
			.forModule('treasury')
			.transaction((tx) => tx.execute(sql`SELECT iban_enc FROM payers WHERE id = ${payerId}`));
		expect(String((rows as unknown as { rows: { iban_enc: string }[] }).rows[0]!.iban_enc)).toMatch(
			/^enc:v1:/
		);
	});

	it('erkennt eine Zahlung über die IBAN des Zahlers (ohne Namen im Zweck)', async () => {
		await data(
			await A(`/actions/${actionId}/participants`, {
				method: 'POST',
				json: { name: 'Lena Müller', birthDate: '2015-03-12' }
			}),
			201
		);
		// Rechnung entsteht sofort (gezielter Abgleich nach dem Anlegen), der Vollabgleich findet nichts Neues
		const lena = await data<InvoiceList>(await T('/invoices?status=all&search=Lena'));
		expect(lena.total).toBe(1);
		const sync = await data<{ created: number }>(await T('/sync', { method: 'POST' }), 201);
		expect(sync.created).toBe(0);
		const csv = [
			'"Buchungstag";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"Betrag"',
			`"02.06.26";"Lager";"P. M.";"${IBAN_FAMILY}";"185,00"`
		].join('\n');
		const fd = new FormData();
		fd.set('file', new Blob([csv], { type: 'text/csv' }), 'a.csv');
		fd.set('accountId', giro);
		const r = await data<ImportResult>(await T('/import', { method: 'POST', body: fd }), 201);
		expect(r.imported).toBe(1);
		const list = await data<{ items: Transaction[] }>(await T('/transactions?search=Lager'));
		const t = list.items[0]!;
		expect(t.counterpartyIbanLast4).toBe('3000');
		const s = await data<MatchSuggestion>(await T(`/transactions/${t.id}/suggestion`));
		expect(s.confidence).toBe('high');
		expect(s.reason).toContain('Bankverbindung');
		// Kein Klartext der IBAN in der Datenbank
		const raw = await core.database
			.forModule('treasury')
			.transaction((tx) =>
				tx.execute(sql`SELECT counterparty_iban_hash FROM transactions WHERE id = ${t.id}`)
			);
		expect(JSON.stringify(raw)).not.toContain('0532013000');
	});
});

describe('Rechnungs-PDF bei Anmeldung und geänderte Rechnung', () => {
	let token = '';
	let participantId = '';
	it('hängt die Rechnung an die Anmeldebestätigung', async () => {
		const cfg = await data<FormConfig>(await A(`/actions/${actionId}/form`));
		await data(
			await A(`/actions/${actionId}/form`, {
				method: 'PUT',
				json: {
					enabled: true,
					opensAt: null,
					closesAt: null,
					maxParticipants: null,
					intro: null,
					disclaimerTemplate: cfg.disclaimerTemplate,
					privacyUrl: 'https://example.org/datenschutz',
					definition: cfg.definition
				}
			})
		);
		token = (await data<FormConfig>(await A(`/actions/${actionId}/form`))).token!;
		mails.length = 0;
		resetAllForTests();
		const res = await api(`/modules/actions/public/forms/${token}/submit`, {
			method: 'POST',
			json: {
				values: {
					[STANDARD_FORM_KEYS.name]: 'Max Muster',
					[STANDARD_FORM_KEYS.group]: 'Wölflinge',
					[STANDARD_FORM_KEYS.birthDate]: '2016-05-04',
					[STANDARD_FORM_KEYS.bremenResident]: 'yes',
					[STANDARD_FORM_KEYS.diet]: 'vegetarian',
					[STANDARD_FORM_KEYS.allergies]: '',
					[STANDARD_FORM_KEYS.notes]: '',
					[STANDARD_FORM_KEYS.email]: 'max.eltern@example.test',
					[STANDARD_FORM_KEYS.privacy]: true,
					[STANDARD_FORM_KEYS.disclaimer]: true
				}
			}
		});
		expect(res.status).toBe(201);
		// Double-Opt-in: Link aus der Bestätigungsbitte aufrufen, erst dann entsteht die Anmeldung
		const optIn = mails.find((m) => /anmeldung-bestaetigen\/[0-9a-f]{64}/.test(m.text));
		if (optIn) {
			const confirmToken = /anmeldung-bestaetigen\/([0-9a-f]{64})/.exec(optIn.text)![1]!;
			mails.splice(mails.indexOf(optIn), 1);
			const ok = await api(`/modules/actions/public/registrations/${confirmToken}/confirm`, {
				method: 'POST',
				json: {}
			});
			expect(ok.status).toBe(201);
		}
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('max.eltern@example.test');
		expect(mails[0]!.text).toContain('im Anhang');
		expect(mails[0]!.attachments?.map((a) => a.filename)).toContain(
			mails[0]!.attachments!.find((a) => a.filename.startsWith('Rechnung-R-2026-'))!.filename
		);
		const list = await data<InvoiceList>(await T('/invoices?status=all&search=Max'));
		const inv = await data<InvoiceDetail>(await T(`/invoices/${list.items[0]!.id}`));
		expect(inv.documents).toHaveLength(1);
		expect(inv.documents[0]).toMatchObject({
			version: 1,
			reason: 'registration',
			totalCents: 18500
		});
		const parts = await data<{ id: string; name: string }[]>(
			await A(`/actions/${actionId}/participants`)
		);
		participantId = parts.find((p) => p.name === 'Max Muster')!.id;
	});

	it('verschickt bei Wechsel ins Team eine geänderte Rechnung (genau einmal)', async () => {
		mails.length = 0;
		await data(
			await A(`/actions/${actionId}/participants/${participantId}`, {
				method: 'PUT',
				json: { name: 'Max Muster', birthDate: '2016-05-04', role: 'team' }
			})
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(mails).toHaveLength(1);
		expect(mails[0]!.subject).toContain('Geänderte Rechnung');
		// Beträge über formatEuro (geschütztes Leerzeichen vor „€“, #34)
		expect(mails[0]!.text).toContain('185,00\u00a0€ auf 90,00\u00a0€');
		expect(mails[0]!.attachments!.some((a) => a.filename.endsWith('-v2.pdf'))).toBe(true);
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(mails).toHaveLength(1);
		const pdf = await T(
			`/invoices/${(await data<InvoiceList>(await T('/invoices?status=all&search=Max'))).items[0]!.id}/documents/1/pdf`
		);
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toBe('application/pdf');
	});
});

describe('Ausstehende Überweisungen', () => {
	let payeeId = '';
	it('übernimmt Auslagen aus der Abrechnung und markiert sie nach Zahlung als ausgezahlt', async () => {
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
					entryDate: '2026-05-30',
					paidBy: 'person',
					payeeId
				}
			}),
			201
		);
		// Auslagen gehen erst mit dem Abschluss der Abrechnung an die Kasse
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(
			(await data<PayableList>(await T('/payables'))).items.some(
				(x) => x.source === 'reimbursement'
			)
		).toBe(false);
		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		const list = await data<PayableList>(await T('/payables'));
		const p = list.items.find((x) => x.source === 'reimbursement')!;
		expect(p).toMatchObject({ recipientName: 'Anna Auslage', openCents: 4250, hasIban: true });
		const iban = await data<{ iban: string }>(await T(`/payables/${p.id}/iban`));
		expect(iban.iban.replace(/\s/g, '')).toBe(IBAN_PAYEE);

		const paid = await data<Payable>(
			await T(`/payables/${p.id}/pay`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-02', amountCents: 4250 }
			}),
			201
		);
		expect(paid.openCents).toBe(0);
		const reimbursed = await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(sql`SELECT reimbursed_at FROM accounting_entries WHERE payee_id = ${payeeId}`)
			);
		expect(
			(reimbursed as unknown as { rows: { reimbursed_at: unknown }[] }).rows[0]!.reimbursed_at
		).not.toBeNull();
		// Abgleich storniert die bezahlte Auszahlung nicht
		await data(await T('/sync', { method: 'POST' }), 201);
		const again = (await data<PayableList>(await T('/payables?status=all'))).items.find(
			(x) => x.id === p.id
		)!;
		expect(again.cancelledAt).toBeNull();
		expect(again.paidCents).toBe(4250);

		// Zahlung löschen → in der Abrechnung wieder offen
		await data(await T(`/transactions/${paid.payments[0]!.transactionId}`, { method: 'DELETE' }));
		const reverted = await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(sql`SELECT reimbursed_at FROM accounting_entries WHERE payee_id = ${payeeId}`)
			);
		expect(
			(reverted as unknown as { rows: { reimbursed_at: unknown }[] }).rows[0]!.reimbursed_at
		).toBeNull();
	});

	it('Eingangsrechnung anlegen, bezahlen, CSV ohne IBAN-Klartext ohne Recht', async () => {
		const p = await data<Payable>(
			await T('/payables', {
				method: 'POST',
				json: {
					recipientName: 'Zeltplatz Nord',
					description: 'Platzmiete Sommerlager',
					amountCents: 30000,
					dueOn: '2026-06-30',
					iban: IBAN_PAYEE,
					actionId
				}
			}),
			201
		);
		expect(p).toMatchObject({ source: 'manual', openCents: 30000, ibanMasked: '•••• 2051' });
		const csvNoBank = await (await T('/payables.csv', {}, 'ohneBank')).text();
		expect(csvNoBank).not.toContain('2051 30');
		expect(csvNoBank).toContain('•••• 2051');
		const csv = await (await T('/payables.csv')).text();
		expect(csv).toContain('DE02 1203 0000 0000 2020 51');
		const done = await data<Payable>(
			await T(`/payables/${p.id}/pay`, {
				method: 'POST',
				json: { accountId: cash, bookedOn: '2026-06-03', amountCents: 30000 }
			}),
			201
		);
		expect(done.openCents).toBe(0);
		expect((await T(`/payables/${p.id}`, { method: 'DELETE' })).status).toBe(409);
	});

	it('Audit ohne IBAN und Mailadressen', async () => {
		const rows = await getDb().select().from(schema.auditLog);
		const text = JSON.stringify(
			rows.filter((r) => r.action.startsWith('treasury.')).map((r) => r.metadata)
		);
		expect(text).not.toContain('@');
		expect(text).not.toContain('0532013000');
		expect(text).not.toContain('202051');
	});
});
