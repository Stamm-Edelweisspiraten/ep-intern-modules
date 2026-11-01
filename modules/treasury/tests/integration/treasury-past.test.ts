/**
 * Vergangene Aktionen (`actions.is_past`, Migration 0012 von `actions`): Die Kasse legt keine
 * Rechnungen mehr an und fasst bestehende Posten nicht an; Auszahlungen bleiben unverändert.
 */
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
import type { ActionReceivables, InvoiceList, PayableList } from '$modules/treasury/schemas';

const IBAN_PAYEE = 'DE02120300000000202051';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
type Mail = { to: string; subject: string; text: string; attachments?: { filename: string }[] };
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

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const actionsSql = (q: ReturnType<typeof sql>) =>
	core.database.forModule('actions').transaction((tx) => tx.execute(q));
const setPast = (id: string, past: boolean) =>
	actionsSql(sql`UPDATE actions SET is_past = ${past} WHERE id = ${id}`);

async function newAction(name: string, fee = 18500): Promise<string> {
	const id = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name, startsOn: '2026-07-20', endsOn: '2026-07-26' }
			}),
			201
		)
	).id;
	await actionsSql(
		sql`UPDATE actions SET fee_cents = ${fee}, team_fee_cents = ${fee}, fee_applied_at = now() WHERE id = ${id}`
	);
	return id;
}

async function enableForm(actionId: string): Promise<string> {
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
	return (await data<FormConfig>(await A(`/actions/${actionId}/form`))).token!;
}

async function register(token: string, name: string, email: string) {
	resetAllForTests();
	const res = await api(`/modules/actions/public/forms/${token}/submit`, {
		method: 'POST',
		json: {
			values: {
				[STANDARD_FORM_KEYS.name]: name,
				[STANDARD_FORM_KEYS.group]: 'Wölflinge',
				[STANDARD_FORM_KEYS.birthDate]: '2016-05-04',
				[STANDARD_FORM_KEYS.bremenResident]: 'yes',
				[STANDARD_FORM_KEYS.diet]: 'vegetarian',
				[STANDARD_FORM_KEYS.allergies]: '',
				[STANDARD_FORM_KEYS.notes]: '',
				[STANDARD_FORM_KEYS.email]: email,
				[STANDARD_FORM_KEYS.privacy]: true,
				[STANDARD_FORM_KEYS.disclaimer]: true
			}
		}
	});
	expect(res.status).toBe(201);
	await confirmOptIn();
}

/** Double-Opt-in: Link aus der Bestätigungsbitte aufrufen; die Bitte selbst zählt nicht als Mail */
async function confirmOptIn() {
	const optIn = mails.find((m) => /anmeldung-bestaetigen\/[0-9a-f]{64}/.test(m.text));
	if (!optIn) return;
	const token = /anmeldung-bestaetigen\/([0-9a-f]{64})/.exec(optIn.text)![1]!;
	mails.splice(mails.indexOf(optIn), 1);
	resetAllForTests();
	const url = new URL(
		`http://localhost:5173/api/v1/modules/actions/public/registrations/${token}/confirm`
	);
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			body: '{}',
			headers: { 'content-type': 'application/json' }
		}),
		url,
		ip: '127.0.0.1'
	});
	expect(res.status, await res.clone().text()).toBe(201);
}

const invoicesOf = async (search: string) =>
	(await data<InvoiceList>(await T(`/invoices?status=all&search=${encodeURIComponent(search)}`)))
		.items;

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
			if (m.headers?.['X-EP-Intern'] !== 'notification') mails.push(m as Mail);
		}
	});
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	setTodayForTests('2026-06-01');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const role = await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] });
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = await ctxOf(id);
	key = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Abgleich bei vergangenen Aktionen', () => {
	it('legt für eine vergangene Aktion keine Rechnungen an, Aktion bleibt in der Liste', async () => {
		const id = await newAction('Altfahrt');
		// Vergangen VOR der Anmeldung (Teilnehmende lösen sofort einen gezielten Abgleich aus)
		await setPast(id, true);
		await data(
			await A(`/actions/${id}/participants`, {
				method: 'POST',
				json: { name: 'Paula Alt', birthDate: '2015-01-01' }
			}),
			201
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(await invoicesOf('Paula')).toHaveLength(0);
		const list = await data<ActionReceivables[]>(await T('/actions'));
		const row = list.find((a) => a.actionId === id)!;
		expect(row).toMatchObject({ isPast: true, invoiceCount: 0, openCents: 0 });

		// Flag wieder entfernt: normaler Abgleich
		await setPast(id, false);
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(await invoicesOf('Paula')).toHaveLength(1);
		const again = await data<ActionReceivables[]>(await T('/actions'));
		expect(again.find((a) => a.actionId === id)).toMatchObject({ isPast: false, invoiceCount: 1 });
	});

	it('Anmeldung über Link: keine Rechnung, Bestätigung ohne PDF-Anhang', async () => {
		const id = await newAction('Vergangene Freizeit');
		await setPast(id, true);
		const token = await enableForm(id);
		mails.length = 0;
		await register(token, 'Vera Vergangen', 'vera.eltern@example.test');
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('vera.eltern@example.test');
		// Layout-Anhänge (Logo) sind erlaubt, aber keine Rechnung
		expect(
			(mails[0]!.attachments ?? []).filter((a) => a.filename.startsWith('Rechnung'))
		).toHaveLength(0);
		expect(mails[0]!.attachments?.some((a) => a.filename.endsWith('.pdf')) ?? false).toBe(false);
		expect(mails[0]!.text).not.toContain('im Anhang');
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(await invoicesOf('Vera')).toHaveLength(0);
	});

	it('bestehende Rechnung bleibt eingefroren: kein Update, kein Storno, keine Storno-Mail', async () => {
		const id = await newAction('Lager mit Rechnung');
		const token = await enableForm(id);
		mails.length = 0;
		await register(token, 'Fritz Frost', 'fritz.eltern@example.test');
		expect(mails).toHaveLength(1);
		expect(mails[0]!.attachments!.some((a) => a.filename.startsWith('Rechnung-R-2026-'))).toBe(
			true
		);
		const [inv] = await invoicesOf('Fritz');
		expect(inv).toBeTruthy();
		const before = await data<{ totalCents: number; status: string; cancelledAt: string | null }>(
			await T(`/invoices/${inv!.id}`)
		);
		expect(before.totalCents).toBe(18500);

		await setPast(id, true);
		// Beitrag ändern UND Teilnehmende*n entfernen: ohne Einfrieren gäbe es Update bzw. Storno
		await actionsSql(
			sql`UPDATE actions SET fee_cents = 9000, team_fee_cents = 9000 WHERE id = ${id}`
		);
		const parts = await data<{ id: string; name: string }[]>(
			await A(`/actions/${id}/participants`)
		);
		await data(
			await A(`/actions/${id}/participants/${parts.find((p) => p.name === 'Fritz Frost')!.id}`, {
				method: 'DELETE'
			})
		);
		mails.length = 0;
		const res = await data<{
			created: number;
			updated: number;
			cancelled: number;
			reactivated: number;
		}>(await T('/sync', { method: 'POST' }), 201);
		expect(res).toMatchObject({ updated: 0, cancelled: 0, reactivated: 0 });
		const after = await data<{ totalCents: number; status: string; cancelledAt: string | null }>(
			await T(`/invoices/${inv!.id}`)
		);
		expect(after.totalCents).toBe(18500);
		expect(after.status).not.toBe('cancelled');
		expect(after.cancelledAt).toBeNull();
		expect(mails).toHaveLength(0);

		// Flag entfernt: Teilnehmende*r fehlt, Rechnung wird wie gewohnt automatisch storniert
		await setPast(id, false);
		await data(await T('/sync', { method: 'POST' }), 201);
		const cancelled = await data<{ status: string }>(await T(`/invoices/${inv!.id}`));
		expect(cancelled.status).toBe('cancelled');
	});
});

describe('Auszahlungen bleiben bei vergangenen Aktionen', () => {
	it('Auslagen und Stamm-Ausgaben entstehen weiter, erstattete Auslagen nicht', async () => {
		const id = await newAction('Altlager Auszahlung');
		const payee = async (name: string) =>
			(
				await data<{ id: string }>(
					await A(`/actions/${id}/accounting/payees`, {
						method: 'POST',
						json: { name, iban: IBAN_PAYEE, bic: null, note: null }
					}),
					201
				)
			).id;
		const expense = (payeeId: string, amountCents: number, reimbursed: boolean) =>
			A(`/actions/${id}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'food',
					description: `Einkauf ${amountCents}`,
					amountCents,
					entryDate: '2026-05-30',
					paidBy: 'person',
					payeeId,
					reimbursed
				}
			});
		const anna = await payee('Anna Auslage');
		const bert = await payee('Bert Bezahlt');
		await data(await expense(anna, 1000, true), 201);
		await data(await expense(anna, 2500, false), 201);
		await data(await expense(bert, 700, true), 201);
		await data(
			await A(`/actions/${id}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'other',
					description: 'Zeltmiete',
					amountCents: 12000,
					entryDate: '2026-05-31',
					paidBy: 'club',
					clubPaid: false,
					recipientName: 'Zeltverleih Nord',
					iban: IBAN_PAYEE,
					purpose: 'Zeltmiete Altlager'
				}
			}),
			201
		);
		await data(
			await A(`/actions/${id}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		await setPast(id, true);
		await data(await T('/sync', { method: 'POST' }), 201);

		const items = (await data<PayableList>(await T('/payables'))).items.filter(
			(p) => p.action?.id === id
		);
		const reimb = items.filter((p) => p.source === 'reimbursement');
		expect(reimb).toHaveLength(1);
		expect(reimb[0]).toMatchObject({
			recipientName: 'Anna Auslage',
			amountCents: 2500,
			openCents: 2500
		});
		// Bert hat nur Erstattetes: keine offene Auszahlung
		const all = (await data<PayableList>(await T('/payables?status=all'))).items.filter(
			(p) => p.action?.id === id && p.source === 'reimbursement'
		);
		expect(all.every((p) => p.recipientName !== 'Bert Bezahlt' || p.openCents === 0)).toBe(true);
		expect(items.find((p) => p.source === 'expense')).toMatchObject({
			amountCents: 12000,
			openCents: 12000
		});
	});
});
