import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { setMailTransportForTests } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type { InvoiceDetail, InvoiceList, Transaction } from '$modules/treasury/schemas';

const PW = 'parent-password-123';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
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
const M = (path: string, who: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys[who], ...init });
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, { token: keys.admin, ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

const memberBody = (firstName: string, over: Record<string, unknown> = {}) => ({
	firstName,
	lastName: 'Muster',
	scoutName: null,
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [],
	emails: [],
	stage: 'pfadfinder',
	groupIds: [],
	...over
});
async function mkMember(firstName: string, over: Record<string, unknown> = {}) {
	return (
		await data<{ id: string }>(
			await M('/members', 'admin', { method: 'POST', json: memberBody(firstName, over) }),
			201
		)
	).id;
}
async function link(member: string, user: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${member}, ${userIds[user]!}, 'Mutter')`
		);
	});
}
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
const rawRows = async (query: ReturnType<typeof sql>) =>
	(
		(await core.database
			.forModule('members')
			.transaction((tx) => tx.execute(query))) as unknown as {
			rows: Record<string, unknown>[];
		}
	).rows;

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
	userIds.admin = u!.id;
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	setTodayForTests('2026-06-01');
	await mkUser('mutter', ['core.api.manage', 'members.own.view', 'members.own.edit']);
	await mkUser('nurlesen', ['core.api.manage', 'members.own.view']);
	await mkUser('ohne', ['core.api.manage']);
});
afterAll(async () => {
	setMailTransportForTests(undefined);
	setTodayForTests(null);
	await close();
});
beforeEach(() => resetAllForTests());

describe('Eigene Mitglieder: Zugriff', () => {
	let kid = '';
	let fremd = '';

	it('Aufbau', async () => {
		kid = await mkMember('Kind', {
			phones: [{ name: 'Mutter', value: '+49 170 1234567' }],
			emails: [{ name: 'Mutter', value: 'mutter@example.test' }]
		});
		fremd = await mkMember('Fremd');
		await link(kid, 'mutter');
		await link(kid, 'nurlesen');
	});

	it('Rolle Mitglied erhält die Rechte automatisch ist Sache des Core; Recht ist deklariert', () => {
		expect(membersModule.manifest.permissions).toContain('members.own.view');
		expect(membersModule.manifest.permissions).toContain('members.own.edit');
	});

	it('GET /my/members liefert Kontakte, Gruppen, Felder, Abwahlen', async () => {
		const list = await data<Record<string, unknown>[]>(await M('/my/members', 'mutter'));
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: kid,
			firstName: 'Kind',
			lastName: 'Muster',
			relation: 'Mutter',
			birthDate: '2012-05-17',
			groups: [],
			phones: [{ name: 'Mutter', value: '+49 170 1234567' }],
			emails: [{ name: 'Mutter', value: 'mutter@example.test' }],
			custom: {},
			mailOptOut: []
		});
	});

	it('403 ohne Recht, 401 ohne Anmeldung', async () => {
		expect(await errCode(await M('/my/members', 'ohne'), 403)).toBe('forbidden');
		expect((await api('/modules/members/my/members')).status).toBe(401);
		expect(
			(
				await M(`/my/members/${kid}/contacts`, 'nurlesen', {
					method: 'PUT',
					json: { phones: [], emails: [{ name: null, value: 'x@example.test' }] }
				})
			).status
		).toBe(403);
	});

	it('GET /my/fields: aktive Felder mit sensitive', async () => {
		const { fields } = await data<{ fields: { key: string; sensitive: boolean }[] }>(
			await M('/my/fields', 'mutter')
		);
		const byKey = Object.fromEntries(fields.map((f) => [f.key, f.sensitive]));
		expect(byKey.allergien).toBe(true);
		expect(byKey.ernaehrung).toBe(true);
		expect(byKey.juleica).toBe(false);
		expect(byKey.schwimmen).toBe(false);
	});

	it('PUT fields: Werte speichern, unbekannt 422, fremd 404', async () => {
		const ok = await data<{ changed: string[] }>(
			await M(`/my/members/${kid}/fields`, 'mutter', {
				method: 'PUT',
				json: { values: { allergien: 'Nuesse' } }
			})
		);
		expect(ok.changed).toEqual(['allergien']);
		const list = await data<{ custom: Record<string, unknown> }[]>(
			await M('/my/members', 'mutter')
		);
		expect(list[0]!.custom.allergien).toBe('Nuesse');
		expect(
			(
				await M(`/my/members/${kid}/fields`, 'mutter', {
					method: 'PUT',
					json: { values: { gibtsnicht: 'x' } }
				})
			).status
		).toBe(422);
		expect(
			(
				await M(`/my/members/${fremd}/fields`, 'mutter', {
					method: 'PUT',
					json: { values: { allergien: 'x' } }
				})
			).status
		).toBe(404);
	});

	it('PUT contacts: ersetzt Telefone/E-Mails, nur Kontakttabellen, Audit ohne PII', async () => {
		const before = await rawRows(
			sql`SELECT first_name, last_name, to_char(birth_date,'YYYY-MM-DD') AS bd, stage, street, custom FROM members WHERE id = ${kid}`
		);
		const res = await data<{ phones: unknown[]; emails: unknown[] }>(
			await M(`/my/members/${kid}/contacts`, 'mutter', {
				method: 'PUT',
				json: {
					phones: [
						{ name: 'Mutter', value: '+49 170 1234567' },
						{ name: 'Vater', value: '+49 171 7654321' }
					],
					emails: [{ name: 'Vater', value: 'vater@example.test' }]
				}
			})
		);
		expect(res.phones).toHaveLength(2);
		const list = await data<{ emails: { value: string }[] }[]>(await M('/my/members', 'mutter'));
		expect(list[0]!.emails.map((e) => e.value)).toEqual(['vater@example.test']);
		const after = await rawRows(
			sql`SELECT first_name, last_name, to_char(birth_date,'YYYY-MM-DD') AS bd, stage, street, custom FROM members WHERE id = ${kid}`
		);
		expect(after).toEqual(before);
		const { rows } = await listAudit({ action: 'members.member.contacts' });
		expect(rows.length).toBeGreaterThan(0);
		const meta = rows.map((r) => r.metadata);
		expect(meta[0]).toMatchObject({
			phonesAdded: 1,
			phonesRemoved: 0,
			emailsAdded: 1,
			emailsRemoved: 1
		});
		const text = JSON.stringify(meta);
		expect(text).not.toContain('example.test');
		expect(text).not.toContain('1234567');
	});

	it('PUT contacts: Duplikate 422, letzte E-Mail 422, mehr als 10 422, fremd 404', async () => {
		const put = (id: string, json: unknown) =>
			M(`/my/members/${id}/contacts`, 'mutter', { method: 'PUT', json });
		expect(
			(
				await put(kid, {
					phones: [],
					emails: [
						{ name: null, value: 'a@example.test' },
						{ name: null, value: 'a@example.test' }
					]
				})
			).status
		).toBe(422);
		expect(
			(
				await put(kid, {
					phones: [
						{ name: null, value: '0170 1234567' },
						{ name: null, value: '0170-1234567' }
					],
					emails: [{ name: null, value: 'a@example.test' }]
				})
			).status
		).toBe(422);
		expect((await put(kid, { phones: [], emails: [] })).status).toBe(422);
		const many = Array.from({ length: 11 }, (_, i) => ({
			name: null,
			value: `m${i}@example.test`
		}));
		expect((await put(kid, { phones: [], emails: many })).status).toBe(422);
		expect(
			(await put(fremd, { phones: [], emails: [{ name: null, value: 'a@example.test' }] })).status
		).toBe(404);
		// Zustand unverändert
		const list = await data<{ emails: unknown[] }[]>(await M('/my/members', 'mutter'));
		expect(list[0]!.emails).toHaveLength(1);
	});

	it('Mitglied ohne bisherige E-Mail darf auch ohne E-Mail gespeichert werden', async () => {
		const lonely = await mkMember('Ohnemail');
		await link(lonely, 'mutter');
		await data(
			await M(`/my/members/${lonely}/contacts`, 'mutter', {
				method: 'PUT',
				json: { phones: [{ name: null, value: '0421 123456' }], emails: [] }
			})
		);
	});

	it('Rate-Limit: PUT 10 je 600 s', async () => {
		let last = 0;
		for (let i = 0; i < 12; i++) {
			last = (
				await M(`/my/members/${kid}/contacts`, 'mutter', {
					method: 'PUT',
					json: { phones: [], emails: [{ name: null, value: 'rl@example.test' }] }
				})
			).status;
		}
		expect(last).toBe(429);
	});

	it('Modul deaktiviert -> 404', async () => {
		resetAllForTests();
		await disableModule(admin, 'treasury');
		await disableModule(admin, 'actions');
		await disableModule(admin, 'members');
		expect((await M('/my/members', 'mutter')).status).toBe(404);
		await enableModule(admin, 'members');
		await enableModule(admin, 'actions');
		await enableModule(admin, 'treasury');
	});
});

describe('Mail-Einstellungen', () => {
	let lena = '';
	let jonas = '';
	let anna = '';
	let ben = '';
	const inv: Record<string, string> = {};

	it('Aufbau: Mitglieder, Aktion, Rechnungen', async () => {
		const mk = (n: string, birthDate: string, email: string) =>
			mkMember(n, { lastName: 'Mail', birthDate, emails: [{ name: 'Eltern', value: email }] });
		lena = await mk('Lena', '2015-03-12', 'familie@example.test');
		jonas = await mk('Jonas', '2013-08-02', 'familie@example.test');
		anna = await mk('Anna', '2014-01-05', 'anna@example.test');
		ben = await mk('Ben', '2014-02-06', 'ben@example.test');
		await link(lena, 'mutter');
		const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
			api(`/modules/actions${path}`, { token: keys.admin, ...init });
		const actionId = (
			await data<{ id: string }>(
				await A('/actions', {
					method: 'POST',
					json: { name: 'Lager', startsOn: '2026-07-20', endsOn: '2026-07-26' }
				}),
				201
			)
		).id;
		for (const [n, bd] of [
			['Lena Mail', '2015-03-12'],
			['Jonas Mail', '2013-08-02'],
			['Anna Mail', '2014-01-05'],
			['Ben Mail', '2014-02-06']
		] as const) {
			await data(
				await A(`/actions/${actionId}/participants`, {
					method: 'POST',
					json: { name: n, birthDate: bd, role: 'participant' }
				}),
				201
			);
		}
		await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(
					sql`UPDATE actions SET fee_cents = 10000, team_fee_cents = 5000, fee_applied_at = now() WHERE id = ${actionId}`
				)
			);
		await data(await T('/sync', { method: 'POST' }), 201);
		const list = await data<InvoiceList>(await T('/invoices'));
		for (const n of ['Lena', 'Jonas', 'Anna', 'Ben']) {
			inv[n] = list.items.find((i) => i.recipientName === `${n} Mail`)!.id;
		}
	});

	it('Standard: alles an; Opt-out wird gespeichert und ausgeliefert, an löscht die Zeile', async () => {
		const off = await data<{ mailOptOut: string[] }>(
			await M(`/my/members/${lena}/mail-prefs`, 'mutter', {
				method: 'PUT',
				json: { category: 'payment-confirmation', enabled: false }
			})
		);
		expect(off.mailOptOut).toEqual(['payment-confirmation']);
		const mine = await data<{ id: string; mailOptOut: string[] }[]>(
			await M('/my/members', 'mutter')
		);
		expect(mine.find((m) => m.id === lena)!.mailOptOut).toEqual(['payment-confirmation']);
		expect(
			(await rawRows(sql`SELECT 1 FROM member_mail_prefs WHERE member_id = ${lena}`)).length
		).toBe(1);
		const on = await data<{ mailOptOut: string[] }>(
			await M(`/my/members/${lena}/mail-prefs`, 'mutter', {
				method: 'PUT',
				json: { category: 'payment-confirmation', enabled: true }
			})
		);
		expect(on.mailOptOut).toEqual([]);
		expect(
			(await rawRows(sql`SELECT 1 FROM member_mail_prefs WHERE member_id = ${lena}`)).length
		).toBe(0);
	});

	it('verbindliche/unbekannte Kategorien 422; fremdes Mitglied 404; Verwaltung per member.edit', async () => {
		for (const category of ['invoice', 'annual-fee', 'reminder', 'registration', 'quatsch']) {
			expect(
				(
					await M(`/my/members/${lena}/mail-prefs`, 'mutter', {
						method: 'PUT',
						json: { category, enabled: false }
					})
				).status,
				category
			).toBe(422);
		}
		expect(
			(
				await M(`/my/members/${jonas}/mail-prefs`, 'mutter', {
					method: 'PUT',
					json: { category: 'action-info', enabled: false }
				})
			).status
		).toBe(404);
		expect(
			(
				await M(`/members/${jonas}/mail-prefs`, 'mutter', {
					method: 'PUT',
					json: { category: 'action-info', enabled: false }
				})
			).status
		).toBe(403);
		const res = await data<{ mailOptOut: string[] }>(
			await M(`/members/${jonas}/mail-prefs`, 'admin', {
				method: 'PUT',
				json: { category: 'action-info', enabled: false }
			})
		);
		expect(res.mailOptOut).toEqual(['action-info']);
		await data(
			await M(`/members/${jonas}/mail-prefs`, 'admin', {
				method: 'PUT',
				json: { category: 'action-info', enabled: true }
			})
		);
	});

	it('Zahlungsbestätigung: Lena abgewählt -> nur Jonas (gemeinsame Adresse bleibt)', async () => {
		await data(
			await M(`/my/members/${lena}/mail-prefs`, 'mutter', {
				method: 'PUT',
				json: { category: 'payment-confirmation', enabled: false }
			})
		);
		const t = await data<Transaction>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: (
						await data<{ id: string }>(
							await T('/accounts', {
								method: 'POST',
								json: {
									name: 'Giro',
									kind: 'giro',
									openingBalanceCents: 0,
									openingDate: '2026-01-01'
								}
							}),
							201
						)
					).id,
					bookedOn: '2026-06-02',
					amountCents: 20000,
					counterparty: 'Familie',
					purpose: 'Lager'
				}
			}),
			201
		);
		const lineOf = async (n: string) =>
			(await data<InvoiceDetail>(await T(`/invoices/${inv[n]}`))).lines[0]!.id;
		mails.length = 0;
		const r = await data<{ paidInvoices: number; mailsSent: number }>(
			await T(`/transactions/${t.id}/allocations`, {
				method: 'PUT',
				json: {
					allocations: [
						{ lineId: await lineOf('Lena'), amountCents: 10000 },
						{ lineId: await lineOf('Jonas'), amountCents: 10000 }
					],
					notify: true
				}
			})
		);
		expect(r).toMatchObject({ paidInvoices: 2, mailsSent: 1 });
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('familie@example.test');
		expect(mails[0]!.text).toContain('Jonas Mail');
		expect(mails[0]!.text).not.toContain('Lena Mail');
		// Lenas Rechnung ohne Adresse gilt als benachrichtigt
		expect(
			(await data<InvoiceDetail>(await T(`/invoices/${inv.Lena}`))).paidNotifiedAt
		).not.toBeNull();
	});

	it('Zahlungsbestätigung unterdrückt, Erinnerung bleibt verbindlich', async () => {
		await data(
			await M(`/members/${anna}/mail-prefs`, 'admin', {
				method: 'PUT',
				json: { category: 'payment-confirmation', enabled: false }
			})
		);
		await data(
			await M(`/members/${ben}/mail-prefs`, 'admin', {
				method: 'PUT',
				json: { category: 'payment-confirmation', enabled: false }
			})
		);
		const [acc] = (await data<{ items?: { id: string }[] } | { id: string }[]>(
			await T('/accounts')
		)) as unknown as { id: string }[];
		const t = await data<Transaction>(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: acc!.id,
					bookedOn: '2026-06-03',
					amountCents: 10000,
					counterparty: 'Anna',
					purpose: 'Lager Anna'
				}
			}),
			201
		);
		const annaLine = (await data<InvoiceDetail>(await T(`/invoices/${inv.Anna}`))).lines[0]!.id;
		mails.length = 0;
		const r = await data<{ paidInvoices: number; mailsSent: number }>(
			await T(`/transactions/${t.id}/allocations`, {
				method: 'PUT',
				json: { allocations: [{ lineId: annaLine, amountCents: 10000 }], notify: true }
			})
		);
		expect(r).toMatchObject({ paidInvoices: 1, mailsSent: 0 });
		expect(mails).toHaveLength(0);
		expect(
			(await data<InvoiceDetail>(await T(`/invoices/${inv.Anna}`))).paidNotifiedAt
		).not.toBeNull();

		// Erinnerung an Ben (hat die Zahlungsbestätigung abgewählt) geht trotzdem raus
		mails.length = 0;
		await data(await T(`/invoices/${inv.Ben}/remind`, { method: 'POST' }), 201);
		expect(mails.map((m) => m.to)).toEqual(['ben@example.test']);
	});

	it('Cascade: Mitglied löschen entfernt die Abwahlen', async () => {
		expect(
			(await rawRows(sql`SELECT 1 FROM member_mail_prefs WHERE member_id = ${anna}`)).length
		).toBe(1);
		await core.database.forModule('members').transaction(async (tx) => {
			await tx.execute(sql`DELETE FROM members WHERE id = ${anna}`);
		});
		expect(
			(await rawRows(sql`SELECT 1 FROM member_mail_prefs WHERE member_id = ${anna}`)).length
		).toBe(0);
	});
});
