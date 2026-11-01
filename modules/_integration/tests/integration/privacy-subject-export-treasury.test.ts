/**
 * Datenauskunft der Kasse (#30): Rechnungen/Posten der Person, Zahlungen, Guthaben, Erinnerungen,
 * Fassungen (nur Liste), Zahler mit maskierter IBAN, Auszahlungen – bei Sammelrechnungen nur die
 * eigenen Posten; nie IBAN-Hash oder verschlüsselte Werte.
 */
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
import { setMailTransportForTests } from '$testing';
import { setPdfRendererForTests } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { Account, InvoiceDetail } from '$modules/treasury/schemas';

let close: () => Promise<void>;
let key = '';
const IBAN = 'DE89370400440532013000';

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
async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, init);

let lena = '';
let paul = '';

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
	let admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setMailTransportForTests({ sendMail: async () => undefined });
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
	const ctx = (await contextForUser(id))!.ctx;
	key = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;
	const member = async (firstName: string, birthDate: string) =>
		(
			await data<{ id: string }>(
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
			)
		).id;
	lena = await member('Lena', '2015-03-12');
	paul = await member('Paul', '2017-08-01');
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('subjectExport der Kasse', () => {
	it('liefert nur eigene Posten, maskierte IBAN, Zahlungen, Erinnerungen und Fassungen', async () => {
		const payer = await data<{ id: string }>(
			await T('/payers', {
				method: 'POST',
				json: {
					name: 'Familie Müller',
					memberIds: [lena, paul],
					accountHolder: 'Petra Müller',
					iban: IBAN
				}
			}),
			201
		);
		const account = await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Girokonto', kind: 'giro', openingDate: '2026-01-01' }
			}),
			201
		);
		const inv = await data<InvoiceDetail>(
			await T('/invoices', {
				method: 'POST',
				json: {
					payerId: payer.id,
					recipientName: 'Familie Müller',
					recipientEmail: 'familie.mueller@example.test',
					issuedOn: '2026-06-01',
					dueOn: '2026-06-10',
					lines: [
						{ description: 'Beitrag Lena', amountCents: 6000, memberId: lena },
						{ description: 'Beitrag Paul', amountCents: 4000, memberId: paul }
					]
				}
			}),
			201
		);
		await data(await T(`/invoices/${inv.id}/send`, { method: 'POST' }), 201);
		const lenaLine = inv.lines.find((l) => l.description === 'Beitrag Lena')!;
		await data(
			await T(`/invoices/${inv.id}/mark-paid`, {
				method: 'POST',
				json: { accountId: account.id, bookedOn: '2026-06-03', amountCents: 2500, notify: false }
			}),
			201
		);
		await data(await T(`/invoices/${inv.id}/remind`, { method: 'POST' }), 201);

		const out = await treasuryModule.subjectExport!.run({ userId: null, memberIds: [lena] });
		expect(out).not.toBeNull();
		const json = JSON.stringify(out);
		// Keine Daten des Geschwisterkinds, keine Hashes/Chiffrate, IBAN nur maskiert
		expect(json).not.toContain('Beitrag Paul');
		expect(json).not.toContain(paul);
		expect(json).not.toContain('enc:v1');
		expect(json).not.toContain('0532013000');
		expect(json).not.toMatch(/iban_?hash/i);
		const invoices = (out as { invoices: Record<string, unknown>[] }).invoices;
		expect(invoices).toHaveLength(1);
		const i = invoices[0] as {
			number: string;
			lines: { description: string; paidCents: number; payments: unknown[] }[];
			reminders: { level: number }[];
			documents: { version: number; sentAt: string | null }[];
		};
		expect(i.number).toBe(inv.number);
		expect(i.lines.map((l) => l.description)).toEqual(['Beitrag Lena']);
		expect(i.lines[0]!.paidCents).toBeGreaterThan(0);
		expect(i.lines[0]!.payments.length).toBeGreaterThan(0);
		expect(i.reminders.map((r) => r.level)).toEqual([1]);
		expect(i.documents[0]).toMatchObject({ version: 1 });
		expect(i.documents[0]!.sentAt).not.toBeNull();
		expect(Object.keys(i)).not.toContain('pdf');
		const payers = (out as { payers: { name: string; iban: string; memberCount: number }[] })
			.payers;
		expect(payers).toEqual([
			expect.objectContaining({ name: 'Familie Müller', iban: '•••• 3000', memberCount: 2 })
		]);
		expect(lenaLine).toBeTruthy();
	});

	it('ohne Bezug zur Kasse → null', async () => {
		expect(
			await treasuryModule.subjectExport!.run({ userId: null, memberIds: [crypto.randomUUID()] })
		).toBeNull();
		expect(await treasuryModule.subjectExport!.run({ userId: 'x', memberIds: [] })).toBeNull();
	});
});
