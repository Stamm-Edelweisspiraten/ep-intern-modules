/**
 * Kasse ↔ Bestellungen (`orders`): Rechnungen und Auszahlungen per Push über `treasuryService`
 * (`upsertOrderInvoice`, `upsertOrderPayable`, `cancelOrderPayable`, `invoiceStatus`, `payableStatus`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
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
import { treasuryService } from '$modules/treasury/service';
import type { RequestContext } from '$lib/sdk/types';
import type { Account, InvoiceDetail, Payable, PayableList } from '$modules/treasury/schemas';

const IBAN_SUPPLIER = 'DE02120300000000202051';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let memberId = '';
let giro = '';
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

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function q(query: ReturnType<typeof sql>) {
	return (
		(await core.database
			.forModule('treasury')
			.transaction((tx) => tx.execute(query))) as unknown as {
			rows: Record<string, unknown>[];
		}
	).rows;
}

const ORDER = 'order:11111111-1111-4111-8111-111111111111';
const line = (item: string, description: string, amountCents: number) => ({
	ref: `${ORDER}:${item}`,
	description,
	amountCents
});

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
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m as Mail) });
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	setTodayForTests('2026-06-01');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const role = await createRole(admin, {
		name: 'Kasse',
		permissions: ['core.api.manage', ...all]
	});
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = await ctxOf(id);
	key = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;

	memberId = (
		await data<{ id: string }>(
			await api('/modules/members/members', {
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
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	uninstallFakeStorage();
	await close();
});

describe('Rechnungen aus Bestellungen', () => {
	let invoiceId = '';

	it('unbekanntes Mitglied → 422, leere Bestellung ohne Rechnung → nichts', async () => {
		await expect(
			treasuryService.upsertOrderInvoice(admin, {
				sourceKey: ORDER,
				memberId: crypto.randomUUID(),
				orderNumber: 'B-2026-0001',
				lines: [line('a', 'Halstuch', 800)],
				send: false
			})
		).rejects.toMatchObject({ status: 422 });
		const none = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [],
			send: true
		});
		expect(none).toEqual({
			invoiceId: null,
			number: null,
			totalCents: 0,
			cancelled: false,
			mailed: false
		});
	});

	it('legt eine neue Rechnung an und verschickt sie mit PDF', async () => {
		mails.length = 0;
		const r = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			note: 'Abholung beim Stammesabend',
			lines: [line('a', 'Halstuch (Gr. M) × 2', 1600), line('b', 'Liederbuch', 1200)],
			send: true
		});
		expect(r.number).toMatch(/^R-2026-\d{4}$/);
		expect(r).toMatchObject({ totalCents: 2800, cancelled: false, mailed: true });
		invoiceId = r.invoiceId!;
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d).toMatchObject({
			source: 'order',
			recipientName: 'Lena Müller',
			totalCents: 2800,
			dueOn: '2026-06-15',
			status: 'open'
		});
		expect(d.note).toContain('Bestellung B-2026-0001');
		expect(d.lines.map((l) => [l.description, l.amountCents, l.member?.id])).toEqual([
			['Halstuch (Gr. M) × 2', 1600, memberId],
			['Liederbuch', 1200, memberId]
		]);
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('familie.mueller@example.test');
		expect(mails[0]!.attachments?.some((a) => a.filename.endsWith('.pdf'))).toBe(true);
		expect(d.documents.map((x) => x.reason)).toEqual(['order']);

		// Gleicher Aufruf erneut: keine Änderung, keine Mail
		const again = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [line('a', 'Halstuch (Gr. M) × 2', 1600), line('b', 'Liederbuch', 1200)],
			send: true
		});
		expect(again).toMatchObject({ invoiceId, totalCents: 2800, mailed: false });
		expect(mails).toHaveLength(1);
	});

	it('geänderter Betrag → genau eine „Geänderte Rechnung“', async () => {
		mails.length = 0;
		const r = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [line('a', 'Halstuch (Gr. M) × 3', 2400), line('b', 'Liederbuch', 1200)],
			send: false
		});
		expect(r).toMatchObject({ invoiceId, totalCents: 3600, mailed: true });
		expect(mails).toHaveLength(1);
		expect(mails[0]!.subject + mails[0]!.text).toContain('Geänderte Rechnung');
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d.documents.map((x) => x.reason).sort()).toEqual(['changed', 'order']);
	});

	it('Posten entfernen und neu hinzufügen', async () => {
		const r = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [line('a', 'Halstuch (Gr. M) × 3', 2400), line('c', 'Aufnäher', 300)],
			send: false
		});
		expect(r.totalCents).toBe(2700);
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d.lines.map((l) => l.description)).toEqual(['Halstuch (Gr. M) × 3', 'Aufnäher']);
	});

	it('Endpunkte schützen die Bestell-Rechnung (Posten fest, Löschen 409)', async () => {
		const res = await T(`/invoices/${invoiceId}`, {
			method: 'PUT',
			json: {
				payerId: null,
				recipientName: 'Familie Müller',
				recipientEmail: null,
				dueOn: '2026-06-30',
				note: 'Abholung',
				remindersPaused: false,
				lines: [{ description: 'Anders', amountCents: 1, memberId: null, actionId: null }]
			}
		});
		const d = await data<InvoiceDetail>(res);
		expect(d.recipientName).toBe('Familie Müller');
		expect(d.dueOn).toBe('2026-06-30');
		expect(d.totalCents).toBe(2700);
		expect(d.lines).toHaveLength(2);
		expect((await T(`/invoices/${invoiceId}`, { method: 'DELETE' })).status).toBe(409);
		// Empfänger/Frist der Kasse bleiben beim nächsten Push erhalten
		await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [line('a', 'Halstuch (Gr. M) × 3', 2400), line('c', 'Aufnäher', 300)],
			send: false
		});
		const after = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(after).toMatchObject({ recipientName: 'Familie Müller', dueOn: '2026-06-30' });
	});

	it('Abgleich (`POST /sync`) lässt die Bestell-Rechnung unberührt', async () => {
		await data(await T('/sync', { method: 'POST' }), 201);
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d.status).toBe('open');
		expect(d.cancelledAt).toBeNull();
		expect(d.totalCents).toBe(2700);
	});

	it('invoiceStatus: offen, teilweise bezahlt, überfällig', async () => {
		let s = await treasuryService.invoiceStatus([invoiceId, crypto.randomUUID()]);
		expect(Object.keys(s)).toEqual([invoiceId]);
		expect(s[invoiceId]).toMatchObject({
			status: 'open',
			dueCents: 2700,
			paidCents: 0,
			openCents: 2700,
			dueOn: '2026-06-30',
			overdue: false
		});
		await data(
			await T(`/invoices/${invoiceId}/mark-paid`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-02', amountCents: 1000, notify: false }
			}),
			201
		);
		setTodayForTests('2026-07-05');
		s = await treasuryService.invoiceStatus([invoiceId]);
		expect(s[invoiceId]).toMatchObject({
			status: 'partial',
			paidCents: 1000,
			openCents: 1700,
			overdue: true
		});
		setTodayForTests('2026-06-01');
	});

	it('entfallener bezahlter Posten bleibt mit 0 € stehen (Zahlung wird Guthaben)', async () => {
		// Zahlung (1000) liegt auf dem ältesten Posten „Halstuch“; der entfällt jetzt
		const r = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [line('c', 'Aufnäher', 300)],
			send: false
		});
		expect(r.totalCents).toBe(300);
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		const halstuch = d.lines.find((l) => l.description.startsWith('Halstuch'))!;
		expect(halstuch).toMatchObject({ amountCents: 0, paidCents: 1000 });
		expect(d.creditCents).toBe(1000);
	});

	it('leere Liste → storniert, Bezahltes wird Guthaben; neue Posten → reaktiviert', async () => {
		mails.length = 0;
		const r = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [],
			send: false
		});
		expect(r).toMatchObject({ invoiceId, cancelled: true, mailed: true });
		expect(mails[0]!.subject + mails[0]!.text).toContain('Stornierung');
		const d = await data<InvoiceDetail>(await T(`/invoices/${invoiceId}`));
		expect(d).toMatchObject({ status: 'cancelled', cancelReason: 'Bestellung storniert' });
		expect((await treasuryService.invoiceStatus([invoiceId]))[invoiceId]).toMatchObject({
			status: 'cancelled',
			dueCents: 0,
			openCents: 0,
			paidCents: 1000
		});
		await data(await T('/sync', { method: 'POST' }), 201);
		const credit = (await data<PayableList>(await T('/payables'))).items.find(
			(p) => p.source === 'credit' && p.description.includes(d.number)
		);
		expect(credit).toMatchObject({ amountCents: 1000, openCents: 1000 });

		mails.length = 0;
		const back = await treasuryService.upsertOrderInvoice(admin, {
			sourceKey: ORDER,
			memberId,
			orderNumber: 'B-2026-0001',
			lines: [line('c', 'Aufnäher', 300), line('d', 'Kluft', 4500)],
			send: false
		});
		expect(back).toMatchObject({ invoiceId, cancelled: false, mailed: true });
		expect(mails[0]!.subject + mails[0]!.text).toContain('Geänderte Rechnung');
		const s = (await treasuryService.invoiceStatus([invoiceId]))[invoiceId]!;
		// Halstuch 0 € (1000 bezahlt → Guthaben), Aufnäher 300, Kluft 4500 offen
		expect(s).toMatchObject({ status: 'partial', dueCents: 4800, openCents: 4800 });
	});

	it('Posten-Schlüssel muss zur Bestellung passen (422)', async () => {
		await expect(
			treasuryService.upsertOrderInvoice(admin, {
				sourceKey: ORDER,
				memberId,
				orderNumber: 'B-2026-0001',
				lines: [{ ref: 'order:andere:x', description: 'X', amountCents: 100 }],
				send: false
			})
		).rejects.toMatchObject({ status: 422 });
	});
});

describe('Auszahlungen aus Bestellungen (Lieferant)', () => {
	const REF = 'order-supplier:22222222-2222-4222-8222-222222222222';
	let payableId = '';

	it('legt an, aktualisiert und lädt einen Beleg hoch', async () => {
		await installFakeStorage(admin);
		await expect(
			treasuryService.upsertOrderPayable(admin, {
				ref: REF,
				recipientName: 'Ausrüster GmbH',
				description: 'Halstücher',
				amountCents: 10000,
				iban: 'DE00 kaputt'
			})
		).rejects.toMatchObject({ status: 422 });

		const r = await treasuryService.upsertOrderPayable(admin, {
			ref: REF,
			recipientName: 'Ausrüster GmbH',
			description: 'Halstücher (50 Stück)',
			amountCents: 25000,
			iban: IBAN_SUPPLIER,
			receipt: {
				bytes: new TextEncoder().encode('%PDF-1.4 Rechnung'),
				contentType: 'application/pdf',
				name: 'rechnung.pdf'
			}
		});
		payableId = r.payableId;
		const list = await data<PayableList>(await T('/payables?source=order'));
		expect(list.items).toHaveLength(1);
		expect(list.items[0]).toMatchObject({
			id: payableId,
			source: 'order',
			amountCents: 25000,
			dueOn: '2026-06-01',
			ibanMasked: '•••• 2051',
			receipt: { name: 'rechnung.pdf', contentType: 'application/pdf' },
			automatic: true
		});

		const same = await treasuryService.upsertOrderPayable(admin, {
			ref: REF,
			recipientName: 'Ausrüster GmbH',
			description: 'Halstücher (60 Stück)',
			amountCents: 30000,
			dueOn: '2026-06-20'
		});
		expect(same.payableId).toBe(payableId);
		const p = (await data<PayableList>(await T('/payables?source=order'))).items[0]!;
		expect(p).toMatchObject({
			amountCents: 30000,
			description: 'Halstücher (60 Stück)',
			dueOn: '2026-06-20',
			ibanMasked: '•••• 2051'
		});
	});

	it('Abgleich storniert sie nicht; Zahlung buchen → paid; Storno danach 409', async () => {
		await data(await T('/sync', { method: 'POST' }), 201);
		expect((await treasuryService.payableStatus([REF]))[REF]).toMatchObject({
			payableId,
			status: 'open',
			amountCents: 30000,
			paidCents: 0
		});
		await data<Payable>(
			await T(`/payables/${payableId}/pay`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-03', amountCents: 10000 }
			}),
			201
		);
		expect((await treasuryService.payableStatus([REF]))[REF]!.status).toBe('partial');
		// Betrag unter Gezahltes → 409
		await expect(
			treasuryService.upsertOrderPayable(admin, {
				ref: REF,
				recipientName: 'Ausrüster GmbH',
				description: 'Halstücher',
				amountCents: 5000
			})
		).rejects.toMatchObject({ status: 409 });
		await expect(treasuryService.cancelOrderPayable(admin, REF)).rejects.toMatchObject({
			status: 409
		});
		await data<Payable>(
			await T(`/payables/${payableId}/pay`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-04', amountCents: 20000 }
			}),
			201
		);
		await data(await T('/sync', { method: 'POST' }), 201);
		expect(await treasuryService.payableStatus([REF, 'order-supplier:fehlt'])).toEqual({
			[REF]: { payableId, status: 'paid', amountCents: 30000, paidCents: 30000 }
		});
		const p = (await data<PayableList>(await T('/payables?status=all&source=order'))).items[0]!;
		expect(p.cancelledAt).toBeNull();
	});

	it('cancelOrderPayable: unbekannt → No-op, unbezahlt → storniert, Upsert reaktiviert', async () => {
		await treasuryService.cancelOrderPayable(admin, 'order-supplier:unbekannt');
		const ref = 'order-supplier:33333333-3333-4333-8333-333333333333';
		await treasuryService.upsertOrderPayable(admin, {
			ref,
			recipientName: 'Druckerei',
			description: 'Liederbücher',
			amountCents: 8000
		});
		await treasuryService.cancelOrderPayable(admin, ref);
		expect((await treasuryService.payableStatus([ref]))[ref]!.status).toBe('cancelled');
		await treasuryService.upsertOrderPayable(admin, {
			ref,
			recipientName: 'Druckerei',
			description: 'Liederbücher',
			amountCents: 9000
		});
		expect((await treasuryService.payableStatus([ref]))[ref]).toMatchObject({
			status: 'open',
			amountCents: 9000
		});
	});
});

describe('Audit', () => {
	it('enthält keine Mailadressen und keine IBAN', async () => {
		const rows = await getDb().select().from(schema.auditLog);
		const relevant = rows.filter((r) => r.action.startsWith('treasury.'));
		expect(relevant.some((r) => (r.metadata as { source?: string })?.source === 'order')).toBe(
			true
		);
		const text = JSON.stringify(relevant.map((r) => r.metadata));
		expect(text).not.toContain('@');
		expect(text).not.toContain('202051');
	});

	it('Migration: Quelle „order“ ist in allen Tabellen erlaubt', async () => {
		const inv = await q(sql`SELECT count(*)::int AS n FROM invoices WHERE source = 'order'`);
		expect(inv[0]!.n).toBe(1);
		const pay = await q(sql`SELECT count(*)::int AS n FROM payables WHERE source = 'order'`);
		expect(pay[0]!.n).toBe(2);
	});
});
