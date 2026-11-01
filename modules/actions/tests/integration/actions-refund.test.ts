import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const BASE = '/modules/actions';

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

async function setup(opts: { fee?: number | null; team?: number | null } = {}) {
	const id = await nextAction();
	const fee = opts.fee === undefined ? 20000 : opts.fee;
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE actions SET fee_cents = ${fee}, team_fee_cents = ${opts.team ?? null} WHERE id = ${id}`
		);
		for (const [name, role] of [
			['Anna', 'participant'],
			['Bert', 'participant'],
			['Cleo', 'participant'],
			['Teamer', 'team']
		] as const) {
			await tx.execute(
				sql`INSERT INTO action_participants (id, action_id, name, role)
					VALUES (${crypto.randomUUID()}, ${id}, ${name}, ${role})`
			);
		}
	});
	return id;
}

interface RefundDto {
	surplusCents: number;
	payingCount: number;
	perHeadCents: number;
	items: { participantId: string; name: string; amountCents: number }[];
	totalCents: number;
	remainderCents: number;
	booked: null | { entryId: string; totalCents: number; items: unknown[] };
	canBook: boolean;
	blockers: string[];
	mode: 'auto' | 'manual';
	count: number;
	autoCount: number;
	minPerHeadCents: number;
	thresholdOk: boolean;
}

const getRefund = async (who: string, id: string, count?: number) =>
	data<RefundDto>(
		await as(who, `/actions/${id}/accounting/refund${count == null ? '' : `?count=${count}`}`)
	);

describe('Rückzahlung', () => {
	it('berechnet: gleicher Betrag, abgerundet; Team ohne Beitrag zahlt nicht', async () => {
		const id = await setup();
		await addEntry(id, { type: 'income', cents: 60000 });
		await addEntry(id, { cents: 10001, receipt: true });
		// Überschuss 499,99 EUR / 3 = 166,66 -> 166 EUR
		const r = await getRefund('owner', id);
		expect(r.surplusCents).toBe(49999);
		expect(r.payingCount).toBe(3);
		expect(r.perHeadCents).toBe(16600);
		expect(r.totalCents).toBe(49800);
		expect(r.remainderCents).toBe(199);
		expect(r.items.map((i) => i.name)).toEqual(['Anna', 'Bert', 'Cleo']);
		expect(r.canBook).toBe(true);
		expect(r.blockers).toEqual([]);
		expect(r.mode).toBe('auto');
		expect(r.count).toBe(3);
		expect(r.autoCount).toBe(3);
		expect(r.minPerHeadCents).toBe(500);
		expect(r.thresholdOk).toBe(true);
		// Leser: sieht Berechnung, kann aber nicht buchen
		expect((await getRefund('reader', id)).canBook).toBe(false);
	});

	it('Zugriff: Fremde 404, Leser 403 beim Buchen/Zurücknehmen', async () => {
		const id = await setup();
		await addEntry(id, { type: 'income', cents: 60000 });
		const url = `/actions/${id}/accounting/refund`;
		expect((await as('stranger', url)).status).toBe(404);
		expect((await as('stranger', url, { method: 'POST' })).status).toBe(404);
		expect((await as('reader', url, { method: 'POST' })).status).toBe(403);
		expect((await as('reader', url, { method: 'DELETE' })).status).toBe(403);
		expect((await as('editor', url, { method: 'POST' })).status).toBe(201);
	});

	it('bucht, Saldo = Rest, Doppelbuchung 409, Entry-PUT/DELETE 409, Audit ohne Namen', async () => {
		const id = await setup();
		await addEntry(id, { type: 'income', cents: 60000 });
		const url = `/actions/${id}/accounting/refund`;
		const booked = await data<RefundDto>(await as('owner', url, { method: 'POST' }), 201);
		expect(booked.booked).not.toBeNull();
		expect(booked.totalCents).toBe(60000);
		expect(booked.remainderCents).toBe(0);
		expect(booked.canBook).toBe(false);
		expect(booked.surplusCents).toBe(60000);

		const acc = await data<{
			entries: { id: string; category: string; amountCents: number; description: string }[];
			summary: { balanceCents: number; missingReceipts: number };
		}>(await as('owner', `/actions/${id}/accounting`));
		const e = acc.entries.find((x) => x.category === 'refund')!;
		expect(e.amountCents).toBe(60000);
		expect(e.description).toContain('3 × 200 €');
		expect(acc.summary.balanceCents).toBe(0);
		expect(acc.summary.missingReceipts).toBe(0);

		expect((await as('owner', url, { method: 'POST' })).status).toBe(409);
		const entryUrl = `/actions/${id}/accounting/entries/${e.id}`;
		expect((await as('owner', entryUrl, { method: 'DELETE' })).status).toBe(409);
		const put = await as('owner', entryUrl, {
			method: 'PUT',
			json: {
				type: 'expense',
				category: 'food',
				description: 'x',
				amountCents: 100,
				entryDate: '2026-07-11',
				paidBy: 'club',
				payeeId: null
			}
		});
		expect(put.status).toBe(409);

		const audit = (await listAudit({ limit: 200 })).rows.filter((x) =>
			String(x.action).startsWith('actions.accounting.refund')
		);
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain('Anna');

		const back = await data<RefundDto>(await as('owner', url, { method: 'DELETE' }));
		expect(back.booked).toBeNull();
		expect(back.canBook).toBe(true);
		expect(
			(
				await dbRows(
					sql`SELECT id FROM accounting_entries WHERE category = 'refund' AND action_id = ${id}`
				)
			).length
		).toBe(0);
		expect((await as('owner', url, { method: 'DELETE' })).status).toBe(404);
	});

	it('manuelle refund-Buchung 422', async () => {
		const id = await setup();
		const res = await as('owner', `/actions/${id}/accounting/entries`, {
			method: 'POST',
			json: {
				type: 'expense',
				category: 'refund',
				description: 'x',
				amountCents: 100,
				entryDate: '2026-07-11',
				paidBy: 'club',
				payeeId: null
			}
		});
		expect(res.status).toBe(422);
	});

	it('Blocker: kein Überschuss, kein Beitrag, abgeschlossen -> 409', async () => {
		const none = await setup();
		// Automatik: 3 x 200 EUR Beiträge = 600 EUR Einnahmen, gleich hohe Ausgabe -> kein Überschuss
		await addEntry(none, { cents: 60000, receipt: true });
		let r = await getRefund('owner', none);
		expect(r.canBook).toBe(false);
		expect(r.blockers.join(' ')).toContain('Überschuss');
		expect(
			(await as('owner', `/actions/${none}/accounting/refund`, { method: 'POST' })).status
		).toBe(409);

		const nofee = await setup({ fee: null });
		await addEntry(nofee, { type: 'income', cents: 60000 });
		r = await getRefund('owner', nofee);
		expect(r.blockers.join(' ')).toContain('Beitrag');

		const closed = await setup();
		await addEntry(closed, { type: 'income', cents: 60000 });
		await data(
			await as('owner', `/actions/${closed}/accounting/close`, { method: 'POST', json: {} })
		);
		r = await getRefund('owner', closed);
		expect(r.canBook).toBe(false);
		expect(r.blockers.join(' ')).toContain('abgeschlossen');
		expect(
			(await as('owner', `/actions/${closed}/accounting/refund`, { method: 'POST' })).status
		).toBe(409);
	});

	it('Abschluss nach Rückzahlung ohne acceptMissingReceipts; Bericht ohne Refund-Posten', async () => {
		const id = await setup();
		await addEntry(id, { type: 'income', cents: 60000 });
		await addEntry(id, { cents: 10000, receipt: true });
		await data<RefundDto>(
			await as('owner', `/actions/${id}/accounting/refund`, { method: 'POST' }),
			201
		);
		let html = '';
		setPdfRendererForTests(async (h) => {
			html = h;
			return new TextEncoder().encode('%PDF-fake');
		});
		expect((await as('owner', `/actions/${id}/accounting/report.pdf`)).status).toBe(200);
		expect(html).toContain('Rückzahlung an Teilnehmende');
		expect(html).toContain('erst, sobald alle Zahlungen');
		expect(html).not.toContain('ohne Beleg');
		await data(await as('owner', `/actions/${id}/accounting/close`, { method: 'POST', json: {} }));
	});

	it('manuelle Namen: Vorschau per count, Validierung, Buchung, Snapshot, Bericht', async () => {
		const id = await setup();
		await addEntry(id, { type: 'income', cents: 100000 });
		const url = `/actions/${id}/accounting/refund`;
		// 1000 EUR / 7 = 142,86 -> 142 EUR; Summe 994 EUR; Rest 6 EUR
		const pre = await getRefund('owner', id, 7);
		expect(pre.mode).toBe('manual');
		expect(pre.count).toBe(7);
		expect(pre.autoCount).toBe(3);
		expect(pre.items).toEqual([]);
		expect(pre.perHeadCents).toBe(14200);
		expect(pre.totalCents).toBe(99400);
		expect(pre.remainderCents).toBe(600);
		expect(pre.thresholdOk).toBe(true);
		expect(pre.canBook).toBe(true);
		expect((await getRefund('owner', id)).mode).toBe('auto');

		for (const bad of [0, -1, 1001]) {
			expect((await as('owner', `${url}?count=${bad}`)).status).toBe(422);
		}
		const post = (json: unknown) => as('owner', url, { method: 'POST', json });
		expect((await post({ count: 3 })).status).toBe(422);
		expect((await post({ names: [] })).status).toBe(422);
		expect((await post({ names: ['   '] })).status).toBe(422);
		expect((await post({ names: ['x'.repeat(81)] })).status).toBe(422);
		expect((await post({ names: ['Anna'] })).status).toBe(422);
		expect((await post({ names: Array.from({ length: 301 }, (_, i) => `P${i}`) })).status).toBe(
			422
		);
		expect((await post({ names: ['Anna'], extra: 1 })).status).toBe(422);

		const names = ['  Zoe Zander ', 'Anna Alt', 'Zoe Zander', 'Max'];
		// 1000 EUR / 4 = 250 EUR je Person
		const booked = await data<RefundDto>(await post({ names }), 201);
		expect(booked.booked).not.toBeNull();
		expect(booked.mode).toBe('manual');
		expect(booked.count).toBe(4);
		expect(booked.perHeadCents).toBe(25000);
		expect(booked.items.map((i) => i.name)).toEqual([
			'Zoe Zander',
			'Anna Alt',
			'Zoe Zander',
			'Max'
		]);
		expect(booked.items.every((i) => i.amountCents === 25000 && i.participantId)).toBe(true);
		expect(booked.booked!.items.map((i) => (i as { name: string }).name)).toEqual([
			'Zoe Zander',
			'Anna Alt',
			'Zoe Zander',
			'Max'
		]);
		expect(booked.totalCents).toBe(100000);
		expect(booked.remainderCents).toBe(0);
		const acc = await data<{ entries: { category: string; description: string }[] }>(
			await as('owner', `/actions/${id}/accounting`)
		);
		expect(acc.entries.find((x) => x.category === 'refund')!.description).toBe(
			'Rückzahlung an Teilnehmende (4 × 250 €)'
		);
		// GET nach Buchung zeigt Snapshot, auch mit abweichendem count
		const after = await getRefund('owner', id, 2);
		expect(after.mode).toBe('manual');
		expect(after.count).toBe(4);
		expect(after.items.map((i) => i.name)).toEqual(['Zoe Zander', 'Anna Alt', 'Zoe Zander', 'Max']);

		const audit = (await listAudit({ limit: 200 })).rows.filter(
			(x) => String(x.target) === id && String(x.action).startsWith('actions.accounting.refund')
		);
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain('Zander');

		let html = '';
		setPdfRendererForTests(async (h) => {
			html = h;
			return new TextEncoder().encode('%PDF-fake');
		});
		expect((await as('owner', `${url.replace('/refund', '')}/report.pdf`)).status).toBe(200);
		expect(html).toContain('Anna Alt');
		expect(html).toContain('Max');
		expect(html.indexOf('Zoe Zander')).toBeLessThan(html.indexOf('Anna Alt'));
		expect(html).not.toContain('Personen ×');
		expect(html).toContain('erst, sobald alle Zahlungen');

		const back = await data<RefundDto>(await as('owner', url, { method: 'DELETE' }));
		expect(back.booked).toBeNull();
		expect(back.mode).toBe('auto');
	});

	it('Schwelle: höchstens 5 EUR je Person -> Blocker und 409', async () => {
		const id = await setup();
		await addEntry(id, { type: 'income', cents: 5000 });
		const url = `/actions/${id}/accounting/refund`;
		const blocker = 'Pro Person bleiben höchstens 5 € – eine Rückzahlung lohnt sich nicht.';
		// 50 EUR / 10 = genau 5 EUR -> nicht ok
		const m = await getRefund('owner', id, 10);
		expect(m.thresholdOk).toBe(false);
		expect(m.canBook).toBe(false);
		expect(m.blockers).toContain(blocker);
		expect(
			(
				await as('owner', url, {
					method: 'POST',
					json: { names: Array.from({ length: 10 }, (_, i) => `P${i}`) }
				})
			).status
		).toBe(409);
		// 50 EUR / 3 = 16 EUR -> ok (Standardmodus: kleinster Betrag 16 EUR)
		expect((await getRefund('owner', id)).thresholdOk).toBe(true);
		// 50 EUR / 9 = 5 EUR (abgerundet) -> nicht ok; 50 / 8 = 6 EUR -> ok
		expect((await getRefund('owner', id, 9)).thresholdOk).toBe(false);
		expect((await getRefund('owner', id, 8)).thresholdOk).toBe(true);
		// Standardmodus: 10 EUR Überschuss / 3 = 3 EUR -> Blocker
		const low = await setup();
		await addEntry(low, { type: 'income', cents: 1000 });
		const r = await getRefund('owner', low);
		expect(r.canBook).toBe(false);
		expect(r.blockers).toContain(blocker);
		expect(r.blockers.join(' ')).not.toContain('Eingang');
	});
});
