/**
 * Kasse: bisher ungetestete, geldrelevante Endpunkte (#61) – Umbuchung, Erlass, Aktions-Einstellungen,
 * Kategorien/Konten, Belege, Exporte (CSV/PDF), Zahler, Auswahl- und Vorschlagslisten.
 * Je Endpunkt Erfolg, Rechte (403), unbekannt (404), Validierung (422), Konflikt (409) und Audit ohne
 * personenbezogene Details.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type {
	Account,
	ActionReceivables,
	Category,
	InvoiceDetail,
	InvoiceList,
	Transaction
} from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
const keys: Record<string, string> = {};
type Mail = { to: string; subject: string; text: string; attachments?: { filename: string }[] };
const mails: Mail[] = [];

function api(path: string, init: RequestInit & { json?: unknown; who?: string } = {}) {
	const { json, who = 'kasse', ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${keys[who]}`);
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
async function errorOf(res: Response, status: number): Promise<{ code: string; message: string }> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error;
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const tq = async (q: ReturnType<typeof sql>) =>
	(
		(await core.database.forModule('treasury').transaction((tx) => tx.execute(q))) as unknown as {
			rows: Record<string, unknown>[];
		}
	).rows;

async function auditOf(action: string) {
	return getDb()
		.select()
		.from(schema.auditLog)
		.where(and(eq(schema.auditLog.action, action)));
}
/** Audit-Metadaten ohne personenbezogene Details (keine E-Mail, keine IBAN, keine Namen) */
function expectClean(metadata: unknown, ...forbidden: string[]) {
	const s = JSON.stringify(metadata ?? {});
	expect(s).not.toContain('@');
	expect(s).not.toMatch(/DE\d{20}/);
	for (const f of forbidden) expect(s).not.toContain(f);
}

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
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m as Mail) });
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	setTodayForTests('2026-06-01');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const roles = {
		kasse: await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] }),
		leser: await createRole(admin, {
			name: 'Nur lesen',
			permissions: ['core.api.manage', 'treasury.cash.view', 'actions.action.view']
		}),
		ohne: await createRole(admin, { name: 'Ohne Kasse', permissions: ['core.api.manage'] })
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
		// Erster Einsatz eines Keys schreibt `lastUsedAt` ohne await – hier früh „aufwärmen“
		await api('/modules/treasury/accounts', { who: name });
	}
	giro = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: {
					name: 'Girokonto',
					kind: 'giro',
					openingDate: '2026-01-01',
					openingBalanceCents: 100000
				}
			}),
			201
		)
	).id;
	cash = (
		await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Barkasse', kind: 'cash', openingDate: '2026-01-01' }
			}),
			201
		)
	).id;
});

afterAll(async () => {
	uninstallFakeStorage();
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

const balance = async (id: string) =>
	(await data<Account[]>(await T('/accounts'))).find((a) => a.id === id)!.balanceCents;

async function manualInvoice(name: string, amountCents: number, email = 'rechnung@example.test') {
	return data<InvoiceDetail>(
		await T('/invoices', {
			method: 'POST',
			json: {
				recipientName: name,
				recipientEmail: email,
				issuedOn: '2026-06-01',
				dueOn: '2026-06-30',
				lines: [{ description: `Beitrag ${name}`, amountCents }]
			}
		}),
		201
	);
}

describe('POST /transfers (Umbuchung)', () => {
	it('bucht zwei Gegenbuchungen mit gemeinsamer transfer_id, Salden stimmen', async () => {
		const before = { giro: await balance(giro), cash: await balance(cash) };
		const r = await data<{ transferId: string }>(
			await T('/transfers', {
				method: 'POST',
				json: { fromAccountId: giro, toAccountId: cash, bookedOn: '2026-06-02', amountCents: 25000 }
			}),
			201
		);
		const halves = await tq(
			sql`SELECT account_id, amount_cents FROM transactions WHERE transfer_id = ${r.transferId} ORDER BY amount_cents`
		);
		expect(halves.map((h) => [h.account_id, Number(h.amount_cents)])).toEqual([
			[giro, -25000],
			[cash, 25000]
		]);
		expect(await balance(giro)).toBe(before.giro - 25000);
		expect(await balance(cash)).toBe(before.cash + 25000);
		const [audit] = await auditOf('treasury.transfer.created');
		expect(audit!.metadata).toMatchObject({ amountCents: 25000 });

		// Löschen einer Hälfte löscht beide Seiten – Salden wieder wie vorher
		const tx = await data<{ items: Transaction[] }>(await T(`/transactions?accountId=${cash}`));
		const half = tx.items.find((t) => t.amountCents === 25000)!;
		await data(await T(`/transactions/${half.id}`, { method: 'DELETE' }));
		expect(await tq(sql`SELECT id FROM transactions WHERE transfer_id = ${r.transferId}`)).toEqual(
			[]
		);
		expect(await balance(giro)).toBe(before.giro);
		expect(await balance(cash)).toBe(before.cash);
	});

	it('Validierung, unbekanntes Konto, archiviertes Konto, Rechte', async () => {
		const body = {
			fromAccountId: giro,
			toAccountId: giro,
			bookedOn: '2026-06-02',
			amountCents: 100
		};
		expect((await errorOf(await T('/transfers', { method: 'POST', json: body }), 422)).code).toBe(
			'validation_failed'
		);
		await errorOf(
			await T('/transfers', {
				method: 'POST',
				json: { ...body, toAccountId: cash, amountCents: 0 }
			}),
			422
		);
		await errorOf(
			await T('/transfers', {
				method: 'POST',
				json: { ...body, toAccountId: crypto.randomUUID() }
			}),
			404
		);
		const archived = await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Altkonto', kind: 'other', openingDate: '2026-01-01', archived: true }
			}),
			201
		);
		await errorOf(
			await T('/transfers', { method: 'POST', json: { ...body, toAccountId: archived.id } }),
			409
		);
		await errorOf(
			await T('/transfers', {
				method: 'POST',
				who: 'leser',
				json: { ...body, toAccountId: cash }
			}),
			403
		);
	});
});

describe('PUT /invoices/:id/lines/:lineId (Ermäßigung/Erlass)', () => {
	it('Teil- und Voll-Erlass, nach Teilzahlung, zu hoch → 422, Rücksetzen', async () => {
		const inv = await manualInvoice('Familie Erlass', 10000);
		const lineId = inv.lines[0]!.id;
		const put = (waivedCents: number, who = 'kasse') =>
			T(`/invoices/${inv.id}/lines/${lineId}`, {
				method: 'PUT',
				who,
				json: { waivedCents, reason: 'Geschwisterrabatt' }
			});
		let d = await data<InvoiceDetail>(await put(3000));
		expect(d).toMatchObject({ totalCents: 7000, openCents: 7000, status: 'open' });
		// Teilzahlung 5000 → noch 2000 offen
		await data(
			await T(`/invoices/${inv.id}/mark-paid`, {
				method: 'POST',
				json: { accountId: cash, bookedOn: '2026-06-03', amountCents: 5000, notify: false }
			}),
			201
		);
		d = await data<InvoiceDetail>(await T(`/invoices/${inv.id}`));
		expect(d).toMatchObject({ openCents: 2000, status: 'partial' });
		// Erlass höher als Betrag − Bezahltes (10000 − 5000) → 422
		const tooHigh = await errorOf(await put(5001), 422);
		expect(tooHigh.code).toBe('validation_failed');
		// Rest erlassen → bezahlt
		d = await data<InvoiceDetail>(await put(5000));
		expect(d).toMatchObject({ totalCents: 5000, paidCents: 5000, openCents: 0, status: 'paid' });
		// Zurücksetzen → wieder 5000 offen
		d = await data<InvoiceDetail>(await put(0));
		expect(d).toMatchObject({ totalCents: 10000, openCents: 5000, status: 'partial' });
		expect(d.lines[0]!.waivedCents).toBe(0);
		await errorOf(await put(1000, 'leser'), 403);
		await errorOf(
			await T(`/invoices/${inv.id}/lines/${crypto.randomUUID()}`, {
				method: 'PUT',
				json: { waivedCents: 0 }
			}),
			404
		);
		const audits = await auditOf('treasury.invoice.line_updated');
		expect(audits.length).toBeGreaterThanOrEqual(3);
		for (const a of audits) expectClean(a.metadata, 'Geschwisterrabatt', 'Familie Erlass');
	});
});

describe('POST /invoices/:id/send', () => {
	it('verschickt Fassung 1 mit PDF; ohne Adresse kein Versand; Rechte', async () => {
		const inv = await manualInvoice('Familie Versand', 4200, 'versand@example.test');
		mails.length = 0;
		await data(await T(`/invoices/${inv.id}/send`, { method: 'POST' }), 201);
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('versand@example.test');
		expect(mails[0]!.attachments?.some((a) => a.filename.startsWith('Rechnung-'))).toBe(true);
		const d = await data<InvoiceDetail>(await T(`/invoices/${inv.id}`));
		expect(d.documents[0]).toMatchObject({ version: 1, reason: 'manual' });
		expect(d.documents[0]!.sentAt).not.toBeNull();
		await errorOf(await T(`/invoices/${inv.id}/send`, { method: 'POST', who: 'leser' }), 403);
		await errorOf(await T(`/invoices/${crypto.randomUUID()}/send`, { method: 'POST' }), 404);
		for (const a of await auditOf('treasury.invoice.sent')) expectClean(a.metadata);
	});
});

describe('PUT /actions/:id/settings', () => {
	it('feste Fälligkeit gilt für offene Rechnungen; Ausschließen storniert automatisch', async () => {
		const actionId = (
			await data<{ id: string }>(
				await api('/modules/actions/actions', {
					method: 'POST',
					json: { name: 'Einstellungslager', startsOn: '2026-08-20', endsOn: '2026-08-26' }
				}),
				201
			)
		).id;
		await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(
					sql`UPDATE actions SET fee_cents = 15000, fee_applied_at = now() WHERE id = ${actionId}`
				)
			);
		await data(
			await api(`/modules/actions/actions/${actionId}/participants`, {
				method: 'POST',
				json: { name: 'Ida Einstellung', birthDate: '2015-04-04' }
			}),
			201
		);
		const list = async () =>
			(await data<InvoiceList>(await T(`/invoices?status=all&actionId=${actionId}`))).items;
		expect(await list()).toHaveLength(1);

		const r = await data<ActionReceivables>(
			await T(`/actions/${actionId}/settings`, {
				method: 'PUT',
				json: { excluded: false, dueOn: '2026-07-31' }
			})
		);
		expect(r).toMatchObject({ dueOn: '2026-07-31', excluded: false, invoiceCount: 1 });
		expect((await list())[0]!.dueOn).toBe('2026-07-31');

		await data(
			await T(`/actions/${actionId}/settings`, {
				method: 'PUT',
				json: { excluded: true, dueOn: null }
			})
		);
		expect((await list())[0]!.status).toBe('cancelled');
		// Wieder aufnehmen → automatisch stornierte Rechnung wird reaktiviert
		await data(
			await T(`/actions/${actionId}/settings`, { method: 'PUT', json: { excluded: false } })
		);
		expect((await list())[0]!.status).toBe('open');

		await errorOf(
			await T(`/actions/${actionId}/settings`, {
				method: 'PUT',
				json: { excluded: false, dueOn: '31.07.2026' }
			}),
			422
		);
		await errorOf(
			await T(`/actions/${crypto.randomUUID()}/settings`, { method: 'PUT', json: {} }),
			404
		);
		await errorOf(
			await T(`/actions/${actionId}/settings`, { method: 'PUT', who: 'leser', json: {} }),
			403
		);
	});
});

describe('Kategorien und Konten', () => {
	it('GET/POST/PUT /categories: anlegen, umbenennen, archivieren, Duplikat 409, Rechte', async () => {
		const cat = await data<Category>(
			await T('/categories', { method: 'POST', json: { name: 'Zeltmaterial', kind: 'expense' } }),
			201
		);
		expect(cat).toMatchObject({ kind: 'expense' });
		const dup = await errorOf(
			await T('/categories', { method: 'POST', json: { name: 'zeltmaterial', kind: 'income' } }),
			409
		);
		expect(dup.message).toBe('Eine Kategorie mit diesem Namen existiert bereits');
		const upd = await data<Category>(
			await T(`/categories/${cat.id}`, {
				method: 'PUT',
				json: { name: 'Zelte', kind: 'both', archived: true }
			})
		);
		expect(upd).toMatchObject({ id: cat.id, name: 'Zelte', kind: 'both', archived: true });
		await errorOf(
			await T(`/categories/${crypto.randomUUID()}`, {
				method: 'PUT',
				json: { name: 'X', kind: 'both' }
			}),
			404
		);
		await errorOf(await T('/categories', { method: 'POST', json: { name: '', kind: 'x' } }), 422);
		await errorOf(
			await T('/categories', {
				method: 'POST',
				who: 'leser',
				json: { name: 'Fremd', kind: 'income' }
			}),
			403
		);
		const all = await data<Category[]>(await T('/categories', { who: 'leser' }));
		expect(all.some((x) => x.id === cat.id)).toBe(true);
	});

	it('DELETE /accounts/:id: ohne Buchungen löschbar, mit Buchungen 409, unbekannt 404', async () => {
		const empty = await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: { name: 'Leerkonto', kind: 'other', openingDate: '2026-01-01' }
			}),
			201
		);
		await errorOf(await T(`/accounts/${empty.id}`, { method: 'DELETE', who: 'leser' }), 403);
		await data(await T(`/accounts/${empty.id}`, { method: 'DELETE' }));
		expect((await data<Account[]>(await T('/accounts'))).some((a) => a.id === empty.id)).toBe(
			false
		);
		await errorOf(await T(`/accounts/${empty.id}`, { method: 'DELETE' }), 404);
		// Barkasse hat Buchungen (Zahlung erfassen) → nur archivierbar
		await errorOf(await T(`/accounts/${cash}`, { method: 'DELETE' }), 409);
	});
});

describe('Belege an Buchungen (POST/GET/DELETE /transactions/:id/receipt)', () => {
	it('hochladen, laden, ersetzen, löschen; Typ per Inhalt geprüft', async () => {
		const t = await data<{ id: string }>(
			await T('/transactions', {
				method: 'POST',
				json: { accountId: cash, bookedOn: '2026-06-04', amountCents: -1999, purpose: 'Klebeband' }
			}),
			201
		);
		const upload = (bytes: Uint8Array, type: string, who = 'kasse') => {
			const fd = new FormData();
			fd.set('file', new Blob([bytes as BlobPart], { type }), 'beleg.pdf');
			return T(`/transactions/${t.id}/receipt`, { method: 'POST', body: fd, who });
		};
		const pdf = new TextEncoder().encode('%PDF-1.4 Beleg');
		// Ohne Speicher → 503
		expect((await upload(pdf, 'application/pdf')).status).toBe(503);
		await installFakeStorage(admin);
		// Inhalt passt nicht zum Typ (HTML als PDF) → 422
		await errorOf(await upload(new TextEncoder().encode('<html>x</html>'), 'application/pdf'), 422);
		await errorOf(await upload(pdf, 'text/html'), 422); // Typ nicht erlaubt (#33)
		await errorOf(await upload(pdf, 'application/pdf', 'leser'), 403);
		const r = await data<{ name: string; contentType: string }>(
			await upload(pdf, 'application/pdf'),
			201
		);
		expect(r).toMatchObject({ name: 'beleg.pdf', contentType: 'application/pdf' });
		// Belege lesen braucht zusätzlich treasury.storage.read
		expect((await T(`/transactions/${t.id}/receipt`, { who: 'leser' })).status).toBe(403);
		const get = await T(`/transactions/${t.id}/receipt`);
		expect(get.status).toBe(200);
		expect(get.headers.get('content-type')).toBe('application/pdf');
		expect(get.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(pdf);
		// Ersetzen mit PNG
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		await data(await upload(png, 'image/png'), 201);
		expect((await T(`/transactions/${t.id}/receipt`)).headers.get('content-type')).toBe(
			'image/png'
		);
		await errorOf(
			await T(`/transactions/${t.id}/receipt`, { method: 'DELETE', who: 'leser' }),
			403
		);
		await data(await T(`/transactions/${t.id}/receipt`, { method: 'DELETE' }));
		await errorOf(await T(`/transactions/${t.id}/receipt`), 404);
		await errorOf(await T(`/transactions/${t.id}/receipt`, { method: 'DELETE' }), 404);
		await errorOf(await T(`/transactions/${crypto.randomUUID()}/receipt`), 404);
		for (const a of await auditOf('treasury.transaction.receipt_uploaded')) expectClean(a.metadata);
	});
});

describe('Exporte', () => {
	it('GET /open-items.csv: CSV mit BOM, Formelschutz, Rechte', async () => {
		await manualInvoice('=HYPERLINK("x")', 1234);
		const res = await T('/open-items.csv');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/csv');
		const raw = new Uint8Array(await res.arrayBuffer());
		expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const text = new TextDecoder().decode(raw);
		expect(text).toContain(`'=HYPERLINK`);
		expect(text).not.toMatch(/(^|;)"?=HYPERLINK/m);
		const leser = await T('/open-items.csv', { who: 'leser' });
		expect([200, 403]).toContain(leser.status);
	});

	it('GET /report.csv und /report.pdf: Zeitraum, Formelschutz, Rechte, Validierung', async () => {
		await data(
			await T('/transactions', {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-05', amountCents: 500, purpose: '+SUMME(A1)' }
			}),
			201
		);
		const csv = await T('/report.csv?from=2026-06-01&to=2026-06-30');
		expect(csv.status).toBe(200);
		expect(csv.headers.get('content-type')).toContain('text/csv');
		const text = await csv.text();
		expect(text).toContain(`'+SUMME(A1)`);
		expect(text.split('\r\n')[0]).toContain('Datum;Konto;Betrag');
		const pdf = await T('/report.pdf?from=2026-06-01&to=2026-06-30');
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toBe('application/pdf');
		await errorOf(await T('/report.csv?from=2026-06-30&to=2026-06-01'), 422);
		await errorOf(await T('/report.pdf?from=x&to=y'), 422);
		await errorOf(await T('/report.csv?from=2026-06-01&to=2026-06-30', { who: 'leser' }), 403);
		await errorOf(await T('/report.pdf?from=2026-06-01&to=2026-06-30', { who: 'leser' }), 403);
	});
});

describe('Zahler, Auswahl- und Vorschlagslisten', () => {
	it('DELETE /payers/:id: Rechnungen bleiben, unbekannt 404, Rechte', async () => {
		const p = await data<{ id: string }>(
			await T('/payers', { method: 'POST', json: { name: 'Familie Weg', memberIds: [] } }),
			201
		);
		const inv = await data<InvoiceDetail>(
			await T('/invoices', {
				method: 'POST',
				json: {
					payerId: p.id,
					recipientName: 'Familie Weg',
					issuedOn: '2026-06-01',
					dueOn: '2026-06-30',
					lines: [{ description: 'Beitrag', amountCents: 1000 }]
				}
			}),
			201
		);
		await errorOf(await T(`/payers/${p.id}`, { method: 'DELETE', who: 'leser' }), 403);
		await data(await T(`/payers/${p.id}`, { method: 'DELETE' }));
		await errorOf(await T(`/payers/${p.id}`, { method: 'DELETE' }), 404);
		const d = await data<InvoiceDetail>(await T(`/invoices/${inv.id}`));
		expect(d.payer).toBeNull();
		for (const a of await auditOf('treasury.payer.deleted')) expectClean(a.metadata, 'Familie Weg');
	});

	it('GET /payers/suggestions, /action-refs, /open-lines, /suggestions antworten mit Rechten', async () => {
		expect(Array.isArray(await data<unknown[]>(await T('/payers/suggestions')))).toBe(true);
		const refs = await data<{ id: string; name: string }[]>(
			await T('/action-refs?search=Einstellung')
		);
		expect(refs.map((r) => r.name)).toContain('Einstellungslager');
		const lines = await data<{ lineId: string; openCents: number }[]>(await T('/open-lines'));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((l) => l.openCents > 0)).toBe(true);
		expect(Array.isArray(await data<unknown[]>(await T('/suggestions')))).toBe(true);
		await errorOf(await T('/open-lines?transactionId=keine-uuid'), 422);
		resetAllForTests();
		// Ohne Kassenrecht: 403
		for (const path of ['/payers/suggestions', '/action-refs', '/open-lines', '/suggestions']) {
			expect((await T(path, { who: 'ohne' })).status, path).toBe(403);
		}
	});
});

describe('PUT /settings (#59)', () => {
	it('speichert atomar mit treasury.settings.manage; ein ungültiges Feld → nichts geschrieben', async () => {
		const before = await data<Record<string, unknown>>(await T('/settings'));
		// Kasse hat kein core.settings.manage – die Modul-Schlüssel brauchen nur treasury.settings.manage
		const saved = await data<Record<string, unknown>>(
			await T('/settings', {
				method: 'PUT',
				json: { ...before, bankHolder: 'Stamm Musterstadt', bankName: 'Musterbank' }
			})
		);
		expect(saved).toMatchObject({ bankHolder: 'Stamm Musterstadt', bankName: 'Musterbank' });
		await errorOf(
			await T('/settings', {
				method: 'PUT',
				json: { ...saved, bankHolder: 'Geändert', firstDays: 0 }
			}),
			422
		);
		expect(await data<Record<string, unknown>>(await T('/settings'))).toMatchObject({
			bankHolder: 'Stamm Musterstadt'
		});
		await errorOf(await T('/settings', { method: 'PUT', who: 'leser', json: { ...saved } }), 403);
		const [audit] = await auditOf('treasury.settings.updated');
		expectClean(audit!.metadata, 'Musterstadt');
	});
});

describe('Auszahlungen: Zuordnung und Belege', () => {
	it('PUT /transactions/:id/payable ordnet eine Ausgabe zu bzw. löst sie', async () => {
		const p = await data<{ id: string }>(
			await T('/payables', {
				method: 'POST',
				json: {
					recipientName: 'Zeltverleih Nord',
					description: 'Zeltmiete Sommerlager',
					amountCents: 5000,
					dueOn: '2026-06-20'
				}
			}),
			201
		);
		const tx = async (amountCents: number) =>
			data<{ id: string }>(
				await T('/transactions', {
					method: 'POST',
					json: { accountId: cash, bookedOn: '2026-06-06', amountCents, purpose: 'Zeltmiete' }
				}),
				201
			);
		const out = await tx(-3000);
		const link = (id: string, payableId: string | null, who = 'kasse') =>
			T(`/transactions/${id}/payable`, { method: 'PUT', who, json: { payableId } });
		await data(await link(out.id, p.id));
		const paidOf = async () =>
			(
				await data<{ items: { id: string; paidCents: number; openCents: number }[] }>(
					await T('/payables?status=all')
				)
			).items.find((x) => x.id === p.id)!;
		expect(await paidOf()).toMatchObject({ paidCents: 3000, openCents: 2000 });
		// Einnahme → 409, unbekannte Auszahlung → 404, unbekannte Buchung → 404, ohne Recht 403
		const income = await tx(1000);
		await errorOf(await link(income.id, p.id), 409);
		await errorOf(await link(out.id, crypto.randomUUID()), 404);
		await errorOf(await link(crypto.randomUUID(), p.id), 404);
		await errorOf(await link(out.id, null, 'leser'), 403);
		// Fehler oben haben nichts verändert
		expect(await paidOf()).toMatchObject({ paidCents: 3000 });
		await data(await link(out.id, null));
		expect(await paidOf()).toMatchObject({ paidCents: 0, openCents: 5000 });

		// Belege an der Auszahlung (Speicher ist seit dem Beleg-Test eingerichtet)
		const fd = (bytes: Uint8Array, type: string) => {
			const f = new FormData();
			f.set('file', new Blob([bytes as BlobPart], { type }), 'rechnung.pdf');
			return f;
		};
		const pdf = new TextEncoder().encode('%PDF-1.4 Zeltmiete');
		await errorOf(
			await T(`/payables/${p.id}/receipt`, {
				method: 'POST',
				body: fd(new TextEncoder().encode('kein pdf'), 'application/pdf')
			}),
			422
		);
		await errorOf(
			await T(`/payables/${p.id}/receipt`, {
				method: 'POST',
				who: 'leser',
				body: fd(pdf, 'application/pdf')
			}),
			403
		);
		await data(
			await T(`/payables/${p.id}/receipt`, { method: 'POST', body: fd(pdf, 'application/pdf') }),
			201
		);
		const get = await T(`/payables/${p.id}/receipt`);
		expect(get.status).toBe(200);
		expect(get.headers.get('content-type')).toBe('application/pdf');
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(pdf);
		// Belege aus der Abrechnung gibt es nur bei Auslagen/Ausgaben aus Aktionen
		await errorOf(await T(`/payables/${p.id}/receipts/${crypto.randomUUID()}`), 404);
		await errorOf(await T(`/payables/${crypto.randomUUID()}/receipt`), 404);
	});
});

describe('Belege einer Auslage nur der eigenen Person (#67)', () => {
	it('GET /payables/:id/receipts/:entryId liefert keine Belege anderer Personen derselben Aktion', async () => {
		const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
			api(`/modules/actions${path}`, init);
		const actionId = (
			await data<{ id: string }>(
				await A('/actions', {
					method: 'POST',
					json: { name: 'Belegfahrt', startsOn: '2026-05-01', endsOn: '2026-05-03' }
				}),
				201
			)
		).id;
		const payee = async (name: string, iban: string) =>
			(
				await data<{ id: string }>(
					await A(`/actions/${actionId}/accounting/payees`, {
						method: 'POST',
						json: { name, iban, bic: null, note: null }
					}),
					201
				)
			).id;
		const anna = await payee('Anna Auslage', 'DE02120300000000202051');
		const ben = await payee('Ben Beleg', 'DE89370400440532013000');
		const entry = async (payeeId: string, amountCents: number) => {
			const e = await data<{ id: string }>(
				await A(`/actions/${actionId}/accounting/entries`, {
					method: 'POST',
					json: {
						type: 'expense',
						category: 'food',
						description: 'Einkauf',
						amountCents,
						entryDate: '2026-05-02',
						paidBy: 'person',
						payeeId
					}
				}),
				201
			);
			const f = new FormData();
			f.set(
				'file',
				new Blob([new TextEncoder().encode('%PDF-1.4 Kassenbon') as BlobPart], {
					type: 'application/pdf'
				}),
				'bon.pdf'
			);
			await data(
				await A(`/actions/${actionId}/accounting/entries/${e.id}/receipt`, {
					method: 'POST',
					body: f
				}),
				201
			);
			return e.id;
		};
		const annaEntry = await entry(anna, 1500);
		const benEntry = await entry(ben, 2500);
		await data(
			await A(`/actions/${actionId}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const list = await data<{ items: { id: string; source: string; recipientName: string }[] }>(
			await T('/payables?status=all')
		);
		const annaPayable = list.items.find(
			(p) => p.source === 'reimbursement' && p.recipientName === 'Anna Auslage'
		)!;
		expect(annaPayable).toBeTruthy();
		const receipts = await data<{ id: string }[]>(await T(`/payables/${annaPayable.id}/receipts`));
		expect(receipts.map((r) => r.id)).toEqual([annaEntry]);
		const own = await T(`/payables/${annaPayable.id}/receipts/${annaEntry}`);
		expect(own.status).toBe(200);
		expect(own.headers.get('content-type')).toBe('application/pdf');
		expect(own.headers.get('x-content-type-options')).toBe('nosniff');
		// Beleg von Ben über die Auszahlung an Anna → 404
		await errorOf(await T(`/payables/${annaPayable.id}/receipts/${benEntry}`), 404);
	});
});
