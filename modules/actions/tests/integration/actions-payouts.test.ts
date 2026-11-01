import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { getDb, schema } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$lib/sdk/server';
import { eq, sql } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';
import type { AccountingPayee } from '$modules/actions/schemas';

const BASE = '/modules/actions';
const IBAN = 'DE89 3704 0044 0532 0130 00';
const IBAN_PLAIN = 'DE89370400440532013000';

let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};

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

const as = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status?: number): Promise<T> {
	const body = await res.json();
	if (status) expect(res.status, JSON.stringify(body)).toBe(status);
	else expect([200, 201], JSON.stringify(body)).toContain(res.status);
	return body.data as T;
}

const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	creator: [...BASE_PERMS, 'actions.action.create', 'actions.payout.view'],
	viewer: BASE_PERMS,
	filer: [...BASE_PERMS, 'actions.storage.read'],
	payer: [...BASE_PERMS, 'actions.payout.view'],
	editall: [...BASE_PERMS, 'actions.action.edit-all', 'actions.payout.view']
};
const USERS: [string, string][] = [
	['owner', 'creator'],
	['nopayout', 'viewer'],
	['filer', 'filer'],
	['reader', 'payer'],
	['editor', 'payer'],
	['stranger', 'payer'],
	['boss', 'editall']
];

const ctxOf = async (userId: string) => {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
};

const mdb = () => core.database.forModule('actions');

async function createAction(name = 'Sommerlager'): Promise<string> {
	const a = await data<{ id: string }>(
		await as('owner', '/actions', {
			method: 'POST',
			json: {
				name,
				description: null,
				location: 'Wald',
				startsOn: '2026-07-10',
				startsTime: null,
				endsOn: '2026-07-17',
				endsTime: null
			}
		}),
		201
	);
	for (const [who, level] of [
		['reader', 'read'],
		['editor', 'edit']
	] as const) {
		await data(
			await as('owner', `/actions/${a.id}/shares/${userIds[who]}`, {
				method: 'PUT',
				json: { level }
			})
		);
	}
	return a.id;
}

async function addEntry(
	actionId: string,
	e: { payeeId?: string | null; cents: number; receipt?: boolean; type?: 'expense' | 'income' }
): Promise<string> {
	const id = crypto.randomUUID();
	const type = e.type ?? 'expense';
	const category = type === 'income' ? 'contributions' : 'food';
	const paidBy = e.payeeId ? 'person' : 'club';
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO accounting_entries (id, action_id, type, category, description, amount_cents,
					entry_date, paid_by, payee_id, receipt_path, receipt_name, receipt_content_type)
				VALUES (${id}, ${actionId}, ${type}, ${category}, 'Einkauf', ${e.cents}, '2026-07-11',
					${paidBy}, ${e.payeeId ?? null}, ${e.receipt ? 'x/beleg.pdf' : null},
					${e.receipt ? 'beleg.pdf' : null}, ${e.receipt ? 'application/pdf' : null})`
		);
	});
	return id;
}

async function dbRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
	return mdb().transaction(async (tx) => {
		const res = (await tx.execute(query)) as unknown as { rows: Record<string, unknown>[] };
		return res.rows;
	});
}

async function newPayee(actionId: string, name = 'Anna Auslage'): Promise<AccountingPayee> {
	return data<AccountingPayee>(
		await as('owner', `/actions/${actionId}/accounting/payees`, {
			method: 'POST',
			json: { name, iban: IBAN, bic: 'COBADEFFXXX', note: null }
		}),
		201
	);
}

let seq = 0;
const nextAction = () => createAction(`Lager ${++seq}`);

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf(u!.id);

	const roleIds: Record<string, string> = {};
	for (const [name, perms] of Object.entries(ROLES)) {
		roleIds[name] = await createRole(admin, { name: `role-${name}`, permissions: perms });
	}
	for (const [name, role] of USERS) {
		userIds[name] = await createUser(admin, {
			name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: [...ROLES[role]!] })).key;
	}
});

afterAll(() => setPdfRendererForTests(undefined));

describe('Empfänger', () => {
	it('legt an, speichert verschlüsselt und liefert nur die Maske', async () => {
		const id = await nextAction();
		const res = await as('owner', `/actions/${id}/accounting/payees`, {
			method: 'POST',
			json: { name: 'Anna', iban: IBAN, bic: 'cobadeffxxx', note: 'Konto der Mutter' }
		});
		const text = await res.text();
		expect(res.status, text).toBe(201);
		expect(text).not.toContain(IBAN_PLAIN);
		expect(text).not.toContain(IBAN);
		const p = JSON.parse(text).data as AccountingPayee;
		expect(p.ibanMasked).toContain('3000'.slice(0, 2));
		expect(p.ibanMasked).toMatch(/•/);
		expect(p.bic).toBe('COBADEFFXXX');
		expect(p.openCents).toBe(0);

		const [row] = await dbRows(
			sql`SELECT iban_enc, iban_last4 FROM accounting_payees WHERE id = ${p.id}`
		);
		expect(row!.iban_last4).toBe('013000');
		expect(String(row!.iban_enc)).not.toContain(IBAN_PLAIN);
		expect(String(row!.iban_enc)).not.toContain('3704');
	});

	it('lehnt ungültige IBAN mit 422 ab', async () => {
		const id = await nextAction();
		const res = await as('owner', `/actions/${id}/accounting/payees`, {
			method: 'POST',
			json: { name: 'Anna', iban: 'DE00 1234', bic: null, note: null }
		});
		expect(res.status).toBe(422);
	});

	it('Rechte: ohne payout.view 403, Leser 403, Fremde 404', async () => {
		const id = await nextAction();
		const p = await newPayee(id);
		const body = { name: 'X', iban: IBAN, bic: null, note: null };
		const url = `/actions/${id}/accounting/payees`;
		expect((await as('nopayout', url, { method: 'POST', json: body })).status).toBe(403);
		expect((await as('nopayout', `${url}/${p.id}/iban`)).status).toBe(403);
		expect((await as('nopayout', `/actions/${id}/accounting/payouts.csv`)).status).toBe(403);
		expect((await as('reader', url, { method: 'POST', json: body })).status).toBe(403);
		expect((await as('reader', `${url}/${p.id}`, { method: 'DELETE' })).status).toBe(403);
		expect((await as('reader', `${url}/${p.id}/iban`)).status).toBe(403);
		expect((await as('stranger', url, { method: 'POST', json: body })).status).toBe(404);
		expect((await as('stranger', `/actions/${id}/accounting/payouts.csv`)).status).toBe(404);
		expect((await as('editor', url, { method: 'POST', json: body })).status).toBe(201);
	});

	it('Update ohne IBAN lässt sie unverändert; IBAN-Abruf ist no-store und auditiert', async () => {
		const id = await nextAction();
		const p = await newPayee(id);
		const upd = await data<AccountingPayee>(
			await as('owner', `/actions/${id}/accounting/payees/${p.id}`, {
				method: 'PUT',
				json: { name: 'Anna Neu', bic: null, note: 'x' }
			})
		);
		expect(upd.name).toBe('Anna Neu');
		expect(upd.bic).toBeNull();
		expect(upd.ibanMasked).toBe(p.ibanMasked);

		const res = await as('owner', `/actions/${id}/accounting/payees/${p.id}/iban`);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect((await data<{ iban: string }>(res)).iban).toBe(IBAN_PLAIN);

		const ev = (await listAudit({ limit: 100 })).rows.find(
			(e) => e.action === 'actions.accounting.iban_viewed'
		);
		expect(ev).toBeTruthy();
		expect(JSON.stringify(ev)).not.toContain(IBAN_PLAIN);

		const changed = await data<AccountingPayee>(
			await as('owner', `/actions/${id}/accounting/payees/${p.id}`, {
				method: 'PUT',
				json: { name: 'Anna Neu', iban: 'AT61 1904 3002 3457 3201', bic: null, note: null }
			})
		);
		expect(changed.ibanMasked).not.toBe(p.ibanMasked);
	});

	it('Löschen: mit Buchungen 409, ohne Buchungen ok', async () => {
		const id = await nextAction();
		const used = await newPayee(id, 'Mit');
		const free = await newPayee(id, 'Ohne');
		await addEntry(id, { payeeId: used.id, cents: 1000, receipt: true });
		const r = await as('owner', `/actions/${id}/accounting/payees/${used.id}`, {
			method: 'DELETE'
		});
		expect(r.status).toBe(409);
		expect((await r.json()).error.message).toContain('Es gibt noch Buchungen');
		const ok = await data<{ id: string }>(
			await as('owner', `/actions/${id}/accounting/payees/${free.id}`, { method: 'DELETE' })
		);
		expect(ok.id).toBe(free.id);
	});
});

describe('Auszahlung', () => {
	it('reimburse und Rückname mit Summen; payouts.csv nur offene, ohne IBAN im Audit', async () => {
		const id = await nextAction();
		const a = await newPayee(id, 'Anna');
		const b = await newPayee(id, 'Berta');
		await addEntry(id, { payeeId: a.id, cents: 1250, receipt: true });
		await addEntry(id, { payeeId: a.id, cents: 750, receipt: true });
		await addEntry(id, { payeeId: b.id, cents: 500, receipt: true });
		await addEntry(id, { cents: 9999, receipt: true });

		const csvRes = await as('owner', `/actions/${id}/accounting/payouts.csv`);
		expect(csvRes.status).toBe(200);
		expect(csvRes.headers.get('content-type')).toContain('text/csv');
		expect(csvRes.headers.get('content-disposition')).toContain('attachment');
		expect(csvRes.headers.get('cache-control')).toBe('no-store');
		const bytes = new Uint8Array(await csvRes.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		let csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
		expect(csv).toContain('Anna');
		expect(csv).toContain('Berta');
		expect(csv).toContain(IBAN_PLAIN);
		expect(csv).toContain('Auslagenerstattung');

		const done = await data<{ payeeId: string; count: number; amountCents: number }>(
			await as('owner', `/actions/${id}/accounting/payees/${a.id}/reimburse`, { method: 'POST' })
		);
		expect(done).toEqual({ payeeId: a.id, count: 2, amountCents: 2000 });

		csv = await (await as('owner', `/actions/${id}/accounting/payouts.csv`)).text();
		expect(csv).not.toContain('Anna');
		expect(csv).toContain('Berta');

		const back = await data<{ count: number; amountCents: number }>(
			await as('owner', `/actions/${id}/accounting/payees/${a.id}/reimburse`, {
				method: 'DELETE'
			})
		);
		expect(back.count).toBe(2);
		expect(back.amountCents).toBe(2000);
		csv = await (await as('owner', `/actions/${id}/accounting/payouts.csv`)).text();
		expect(csv).toContain('Anna');

		const audit = (await listAudit({ limit: 200 })).rows.filter((e) =>
			String(e.action).startsWith('actions.accounting.')
		);
		expect(audit.some((e) => e.action === 'actions.accounting.exported')).toBe(true);
		expect(audit.some((e) => e.action === 'actions.accounting.reimbursed')).toBe(true);
		expect(audit.some((e) => e.action === 'actions.accounting.reimbursement_reverted')).toBe(true);
		expect(JSON.stringify(audit)).not.toContain(IBAN_PLAIN);
	});

	it('reimburse braucht Bearbeiten', async () => {
		const id = await nextAction();
		const a = await newPayee(id);
		const url = `/actions/${id}/accounting/payees/${a.id}/reimburse`;
		expect((await as('reader', url, { method: 'POST' })).status).toBe(403);
		expect((await as('stranger', url, { method: 'POST' })).status).toBe(404);
	});
});

describe('Abschluss', () => {
	it('409 bei fehlenden Belegen, mit acceptMissingReceipts ok, danach gesperrt; reopen-Rechte', async () => {
		const id = await nextAction();
		const a = await newPayee(id);
		await addEntry(id, { payeeId: a.id, cents: 1000, receipt: false });
		await addEntry(id, { cents: 500, receipt: true });

		const close = `/actions/${id}/accounting/close`;
		const r = await as('editor', close, { method: 'POST', json: {} });
		expect(r.status).toBe(409);
		expect((await r.json()).error.message).toContain('1 Ausgabe hat keinen Beleg');
		expect((await as('reader', close, { method: 'POST', json: {} })).status).toBe(403);

		const ok = await data<{ closedAt: string }>(
			await as('editor', close, { method: 'POST', json: { acceptMissingReceipts: true } })
		);
		expect(ok.closedAt).toMatch(/^\d{4}-/);

		const blocked = await as('owner', `/actions/${id}/accounting/payees`, {
			method: 'POST',
			json: { name: 'Neu', iban: IBAN, bic: null, note: null }
		});
		expect(blocked.status).toBe(409);
		expect(
			(await as('owner', `/actions/${id}/accounting/payees/${a.id}/reimburse`, { method: 'POST' }))
				.status
		).toBe(409);

		// Editor (nur Freigabe) darf nicht wieder öffnen
		expect(
			(await as('editor', `/actions/${id}/accounting/reopen`, { method: 'POST' })).status
		).toBe(403);
		expect((await as('owner', `/actions/${id}/accounting/reopen`, { method: 'POST' })).status).toBe(
			201
		);
		expect(
			(
				await as('owner', `/actions/${id}/accounting/payees`, {
					method: 'POST',
					json: { name: 'Neu', iban: IBAN, bic: null, note: null }
				})
			).status
		).toBe(201);

		// edit-all darf ebenfalls wieder öffnen
		await data(await as('owner', close, { method: 'POST', json: { acceptMissingReceipts: true } }));
		expect((await as('boss', `/actions/${id}/accounting/reopen`, { method: 'POST' })).status).toBe(
			201
		);
	});

	it('schließt ohne fehlende Belege direkt', async () => {
		const id = await nextAction();
		await addEntry(id, { cents: 500, receipt: true });
		await data(await as('owner', `/actions/${id}/accounting/close`, { method: 'POST', json: {} }));
	});
});

describe('Bericht', () => {
	const report = (who: string, id: string) => as(who, `/actions/${id}/accounting/report.pdf`);
	const share = async (id: string, who: string) =>
		data(
			await as('owner', `/actions/${id}/shares/${userIds[who]}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);

	it('liefert ein PDF; IBAN voll mit Auszahlungsrecht, Nummern und Abschluss', async () => {
		const id = await nextAction();
		const a = await newPayee(id, 'Anna');
		await addEntry(id, { payeeId: a.id, cents: 1250, receipt: true });
		await addEntry(id, { cents: 5000, type: 'income' });
		let html = '';
		setPdfRendererForTests(async (h) => {
			html = h;
			return new TextEncoder().encode('%PDF-fake');
		});
		const res = await report('reader', id);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-disposition')).toContain('inline');
		expect(res.headers.get('cache-control')).toContain('no-store');
		expect(await res.text()).toBe('%PDF-fake');
		expect(html).toContain('Anna');
		expect(html).toContain(IBAN_PLAIN);
		expect(html).toContain('Abschluss');
		expect(html).toContain('Beleg-Nr.');
		expect((await report('stranger', id)).status).toBe(404);
	});

	it('ohne Auszahlungsrecht nur maskierte IBAN', async () => {
		const id = await nextAction();
		const a = await newPayee(id, 'Anna');
		await addEntry(id, { payeeId: a.id, cents: 1250, receipt: false });
		await share(id, 'nopayout');
		let html = '';
		setPdfRendererForTests(async (h) => {
			html = h;
			return new TextEncoder().encode('%PDF-fake');
		});
		expect((await report('nopayout', id)).status).toBe(200);
		expect(html).toContain('Anna');
		expect(html).not.toContain(IBAN_PLAIN);
		expect(html).not.toContain('3704');
		expect(html).toContain('•');
	});

	it('hängt Belege in Nummernreihenfolge an, nur mit storage.read', async () => {
		await installFakeStorage(admin);
		try {
			const id = await nextAction();
			await share(id, 'nopayout');
			await share(id, 'filer');
			const paths: string[] = [];
			for (const [cat, date, name] of [
				['lodging', '2026-07-02', 'Zweiter'],
				['food', '2026-07-05', 'Erster']
			] as const) {
				const path = `${id}/${name}.pdf`;
				paths.push(path);
				await core.storage.upload(admin, {
					module: 'actions',
					path,
					file: new TextEncoder().encode('%PDF-1.4 fake'),
					contentType: 'application/pdf',
					name: `${name}.pdf`
				});
				await mdb().transaction(async (tx) => {
					await tx.execute(
						sql`INSERT INTO accounting_entries (id, action_id, type, category, description,
								amount_cents, entry_date, paid_by, receipt_path, receipt_name, receipt_content_type)
							VALUES (${crypto.randomUUID()}, ${id}, 'expense', ${cat}, ${name}, 1000, ${date},
								'club', ${path}, ${name + '.pdf'}, 'application/pdf')`
					);
				});
			}
			setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
			const spy = vi.spyOn(core.pdf, 'generate').mockResolvedValue({
				buffer: new Uint8Array([37, 80, 68, 70]),
				fileName: 'x.pdf'
			} as never);
			expect((await report('filer', id)).status).toBe(200);
			const call = spy.mock.calls.at(-1)![1];
			expect(call.title).toBe('Abrechnung – ' + `Lager ${seq}`);
			expect(call.attachments!.map((x) => x.label)).toEqual(['Beleg Nr. 1', 'Beleg Nr. 2']);
			expect(call.attachments![0]!.caption).toContain('Erster');
			expect(call.attachments![0]!.contentType).toBe('application/pdf');

			expect((await report('nopayout', id)).status).toBe(200);
			expect(spy.mock.calls.at(-1)![1].attachments).toEqual([]);
			spy.mockRestore();
		} finally {
			uninstallFakeStorage();
		}
	});
});
