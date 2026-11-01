import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { resetAllForTests } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import officesModule from '$modules/offices/module';
import { resetTemplateCacheForTests } from '$modules/offices/templates.service';
import { setTodayForTests } from '$lib/sdk/dates';
import type { Office } from '$modules/offices/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Amt „Kasse“ (Vorlage aus `treasury`): Mails bei neuer Auszahlung und bei Abrechnungsabschluss/Zwischenabrechnung.

const IBAN_PAYEE = 'DE02120300000000202051';
const IBAN_HOSTEL = 'DE89370400440532013000';
const KASSE_MAIL = 'kim.kasse@example.test';

const sent: { to: string; subject: string; text: string }[] = [];
let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let kimId = '';
let actionId = '';
let payeeId = '';

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
	resetAllForTests();
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
const O = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/offices${path}`, init);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

/** Mails an die Inhaberin des Amts „Kasse“ */
const kasseMails = () => sent.filter((m) => m.to === KASSE_MAIL);

async function sync() {
	await data(await T('/sync', { method: 'POST' }), 201);
}

async function createAction(name: string): Promise<{ actionId: string; payeeId: string }> {
	const id = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name, startsOn: '2026-06-05', endsOn: '2026-06-08' }
			}),
			201
		)
	).id;
	const payee = (
		await data<{ id: string }>(
			await A(`/actions/${id}/accounting/payees`, {
				method: 'POST',
				json: { name: 'Anna Auslage', iban: IBAN_PAYEE, bic: null, note: null }
			}),
			201
		)
	).id;
	return { actionId: id, payeeId: payee };
}

async function addPersonExpense(action: string, payee: string, amountCents: number) {
	await data(
		await A(`/actions/${action}/accounting/entries`, {
			method: 'POST',
			json: {
				type: 'expense',
				category: 'food',
				description: 'Einkauf',
				amountCents,
				entryDate: '2026-05-30',
				paidBy: 'person',
				payeeId: payee
			}
		}),
		201
	);
}

function expectNoBankData(m: { subject: string; text: string }) {
	const all = `${m.subject}\n${m.text}`.replace(/\s/g, '');
	for (const iban of [IBAN_PAYEE, IBAN_HOSTEL]) {
		expect(all).not.toContain(iban);
		expect(all).not.toContain(iban.slice(-4));
	}
	expect(all).not.toMatch(/IBAN/i);
}

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			sent.push({ to: m.to, subject: m.subject, text: m.text });
		}
	});
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury', 'offices']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setTodayForTests('2026-06-01');
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	const role = await createRole(admin, { name: 'Leserin', permissions: ['treasury.cash.view'] });
	kimId = await createUser(admin, {
		name: 'Kim Kasse',
		email: KASSE_MAIL,
		password: 'correct-horse-battery',
		roleIds: [role]
	});

	// Vorlagen-Amt „Kasse“ anlegen lassen und Kim eintragen
	resetTemplateCacheForTests();
	const offices = await data<Office[]>(await O('/offices'));
	const kasse = offices.find((o) => o.source?.module === 'treasury' && o.source.key === 'kasse');
	expect(kasse, JSON.stringify(offices)).toBeTruthy();
	await data(
		await O(`/offices/${kasse!.id}/holders`, {
			method: 'PUT',
			json: { holders: [{ userId: kimId }] }
		})
	);

	({ actionId, payeeId } = await createAction('Pfingstlager'));
	await sync();
	sent.length = 0;
});

afterAll(async () => {
	setTodayForTests(null);
	setMailTransportForTests(undefined);
	await close();
});

describe('Amt „Kasse“ – Benachrichtigungen', () => {
	it('Zwischenabrechnung → Mail an das Amt', async () => {
		await addPersonExpense(actionId, payeeId, 4250);
		sent.length = 0;
		await data(
			await A(`/actions/${actionId}/accounting/interims`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const mails = kasseMails().filter((m) => m.subject.includes('Zwischenabrechnung'));
		expect(mails).toHaveLength(1);
		expect(mails[0]!.subject).toContain('Zwischenabrechnung Nr. 1');
		expect(mails[0]!.subject).toContain('Pfingstlager');
		expect(mails[0]!.text).toContain('/modules/treasury?tab=outgoing&view=accountings');
	});

	it('freigegebene Auslage → sofort genau eine Mail mit Betrag, ohne IBAN (ohne Job)', async () => {
		// Die Zwischenabrechnung im Test davor hat den gezielten Abgleich der Aktion ausgelöst
		const mails = kasseMails().filter((m) => m.subject.startsWith('Neue Überweisung'));
		expect(mails).toHaveLength(1);
		const m = mails[0]!;
		expect(m.subject).toMatch(/^Neue Überweisung: 42,50\s€ an Anna Auslage$/);
		expect(m.text).toContain('Auslagenerstattung');
		expect(m.text).toContain('Aktion: Pfingstlager');
		expect(m.text).toContain('/modules/treasury?tab=outgoing&view=payables');
		expectNoBankData(m);
	});

	it('zweiter Abgleich ohne neue Auszahlung → keine Mail', async () => {
		sent.length = 0;
		await sync();
		expect(kasseMails()).toHaveLength(0);
	});

	it('Abschluss der Abrechnung → Mail „Abrechnung abgeschlossen“, Abgleich danach still', async () => {
		sent.length = 0;
		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const mails = kasseMails();
		expect(mails).toHaveLength(1);
		expect(mails[0]!.subject).toBe('Abrechnung abgeschlossen: Pfingstlager');
		expect(mails[0]!.text).toContain(`/modules/treasury/accountings/${actionId}`);

		// gleiche Auszahlung (je Aktion und Person) → kein neues Ereignis
		sent.length = 0;
		await sync();
		expect(kasseMails()).toHaveLength(0);

		// Wieder-Öffnen löst nichts aus
		await data(await A(`/actions/${actionId}/accounting/reopen`, { method: 'POST' }), 201);
		expect(kasseMails()).toHaveLength(0);
	});

	it('offene Stamm-Ausgabe → Mail mit Zweck, ohne IBAN', async () => {
		sent.length = 0;
		const other = await createAction('Herbstfahrt');
		await data(
			await A(`/actions/${other.actionId}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'lodging',
					description: 'Jugendherberge',
					amountCents: 48000,
					entryDate: '2026-06-10',
					paidBy: 'club',
					clubPaid: false,
					recipientName: 'Jugendherberge Bremen',
					purpose: 'Rechnung 4711 Herbstfahrt',
					iban: IBAN_HOSTEL,
					bic: 'COBADEFFXXX'
				}
			}),
			201
		);
		// Sofort nach dem Erfassen (gezielter Abgleich der Aktion); ein Vollabgleich meldet nichts doppelt
		await sync();
		const mails = kasseMails();
		expect(mails).toHaveLength(1);
		expect(mails[0]!.subject).toMatch(/^Neue Überweisung: 480,00\s€ an Jugendherberge Bremen$/);
		expect(mails[0]!.text).toContain('Rechnung 4711 Herbstfahrt');
		expect(mails[0]!.text).toContain('Aktion: Herbstfahrt');
		expectNoBankData(mails[0]!);
	});

	it('manuelle Eingangsrechnung → Mail', async () => {
		sent.length = 0;
		await data(
			await T('/payables', {
				method: 'POST',
				json: {
					recipientName: 'Zeltverleih Nord',
					description: 'Miete Zelte',
					amountCents: 12000,
					iban: IBAN_HOSTEL,
					bic: null,
					actionId,
					note: null
				}
			}),
			201
		);
		const mails = kasseMails();
		expect(mails).toHaveLength(1);
		expect(mails[0]!.subject).toMatch(/^Neue Überweisung: 120,00\s€ an Zeltverleih Nord$/);
		expect(mails[0]!.text).toContain('Eingangsrechnung');
		expect(mails[0]!.text).toContain('Aktion: Pfingstlager');
		expectNoBankData(mails[0]!);
	});

	it('Modul „Ämter“ deaktiviert → keine Fehler, keine Mail', async () => {
		await disableModule(admin, 'offices');
		const third = await createAction('Winterlager');
		await addPersonExpense(third.actionId, third.payeeId, 1500);
		sent.length = 0;
		await data(
			await A(`/actions/${third.actionId}/accounting/interims`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		await sync();
		await data(
			await A(`/actions/${third.actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		expect(kasseMails()).toHaveLength(0);
		// Auszahlung wurde trotzdem angelegt
		const list = await data<{ items: { recipientName: string; amountCents: number }[] }>(
			await T('/payables?status=all')
		);
		expect(list.items.some((p) => p.amountCents === 1500)).toBe(true);
	});
});
