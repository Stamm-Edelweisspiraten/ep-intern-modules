import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';
import type {
	AccountingState,
	ExpenseLinkConfig,
	ExpenseSubmission,
	PublicExpenseBatchResult,
	PublicExpenseLink
} from '$modules/actions/schemas';

const BASE = '/modules/actions';
const IBAN = 'DE89 3704 0044 0532 0130 00';
const keys: Record<string, string> = {};
let admin: RequestContext;

const PDF = new TextEncoder().encode('%PDF-1.4\n% Testbeleg\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const sent: { to: string; subject: string; text: string }[] = [];

type Item = {
	category: string;
	description: string;
	amountCents: number;
	expenseDate: string;
	note?: string | null;
};
const item = (over: Partial<Item> = {}): Item => ({
	category: 'food',
	description: 'Einkauf Supermarkt',
	amountCents: 4250,
	expenseDate: '2026-07-12',
	note: 'Quittung anbei',
	...over
});

const fields = (
	over: Record<string, string> = {},
	items: unknown[] = [item()]
): Record<string, string> => ({
	name: 'Erika Beispiel',
	email: 'erika@example.test',
	accountHolder: 'Erika Beispiel',
	iban: IBAN,
	bic: '',
	items: JSON.stringify(items),
	privacy: 'true',
	website: '',
	...over
});

type Upload = { name: string; bytes: Uint8Array };
const pdf = (name = 'quittung.pdf'): Upload => ({ name, bytes: PDF });

async function submit(
	token: string,
	f: Record<string, string>,
	files: Upload[] = [pdf()],
	opts: { contentType?: string; ip?: string; reset?: boolean } = {}
) {
	if (opts.reset !== false) resetAllForTests();
	const fd = new FormData();
	for (const [k, v] of Object.entries(f)) fd.append(k, v);
	for (const file of files) fd.append('file', new File([file.bytes as BlobPart], file.name));
	const encoded = new Response(fd);
	const body = new Uint8Array(await encoded.arrayBuffer());
	const headers = new Headers({
		'content-type': opts.contentType ?? encoded.headers.get('content-type')!,
		'content-length': String(body.byteLength)
	});
	const url = new URL(`http://localhost:5173/api/v1${BASE}/public/expense-links/${token}/submit`);
	return handleApiRequest({
		request: new Request(url, { method: 'POST', headers, body }),
		url,
		ip: opts.ip ?? '10.1.1.1'
	});
}

/** Eine Auslage einreichen und die angelegte Einreichung zurückgeben. */
async function submitOne(actionId: string, token: string, f = fields()) {
	const out = await data<PublicExpenseBatchResult>(await submit(token, f), 201);
	const row = (await list(actionId)).find((r) => r.batchId === out.batchId);
	expect(row).toBeTruthy();
	return row!;
}

const pubGet = (token: string) => {
	resetAllForTests();
	return api(`${BASE}/public/expense-links/${token}`);
};

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function newAction(name = 'Sommerlager') {
	const res = await as('owner', '/actions', {
		method: 'POST',
		json: { name, location: 'Cuxhaven', startsOn: '2026-07-10', endsOn: '2026-07-17' }
	});
	return (await data<{ id: string }>(res, 201)).id;
}

async function enableLink(id: string): Promise<string> {
	const cfg = await data<ExpenseLinkConfig>(
		await as('owner', `/actions/${id}/expense-link`, { method: 'PUT', json: { enabled: true } })
	);
	return cfg.publicPath!.split('/').pop()!;
}

const list = (id: string, who = 'owner') =>
	as(who, `/actions/${id}/expense-submissions`).then((r) => data<ExpenseSubmission[]>(r));

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			sent.push(m);
		}
	});
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

	const base = ['core.api.manage', 'actions.action.view', 'actions.storage.read'];
	const roles: Record<string, string[]> = {
		creator: [...base, 'actions.action.create'],
		viewer: base
	};
	const roleIds: Record<string, string> = {};
	for (const [n, perms] of Object.entries(roles)) {
		roleIds[n] = await createRole(admin, { name: `role-${n}`, permissions: perms });
	}
	for (const [name, role] of [
		['owner', 'creator'],
		['reader', 'viewer'],
		['stranger', 'viewer']
	] as const) {
		const uid = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		const ctx = await ctxOf(uid);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: roles[role]! })).key;
		if (name === 'reader') keys.readerId = uid;
	}
	await installFakeStorage(admin);
});

afterAll(() => {
	uninstallFakeStorage();
	setMailTransportForTests(undefined);
});

describe('Kosten-Link: Konfiguration', () => {
	it('legt den Link an, aktiviert, rotiert (alter Token 404)', async () => {
		const id = await newAction();
		const empty = await data<ExpenseLinkConfig>(await as('owner', `/actions/${id}/expense-link`));
		expect(empty).toMatchObject({ exists: false, enabled: false, publicPath: null });
		expect(
			(await as('owner', `/actions/${id}/expense-link/rotate`, { method: 'POST' })).status
		).toBe(404);

		const token = await enableLink(id);
		expect(token.length).toBeGreaterThanOrEqual(32);
		const pub = await data<PublicExpenseLink>(await pubGet(token));
		expect(pub.actionName).toBe('Sommerlager');
		expect(pub.categories.length).toBeGreaterThan(3);
		expect(JSON.stringify(pub)).not.toContain(id);

		const rotated = await data<ExpenseLinkConfig>(
			await as('owner', `/actions/${id}/expense-link/rotate`, { method: 'POST' }),
			201
		);
		const token2 = rotated.publicPath!.split('/').pop()!;
		expect(token2).not.toBe(token);
		expect((await pubGet(token)).status).toBe(404);
		expect((await pubGet(token2)).status).toBe(200);

		// deaktiviert → 404 (GET und Submit), gleiche Meldung
		await data(
			await as('owner', `/actions/${id}/expense-link`, { method: 'PUT', json: { enabled: false } })
		);
		const off = await pubGet(token2);
		expect(off.status).toBe(404);
		expect((await submit(token2, fields())).status).toBe(404);
	});

	it('Zugriff: Lesende sehen keinen Link und dürfen nichts ändern, Fremde 404', async () => {
		const id = await newAction();
		await data(
			await as('owner', `/actions/${id}/shares/${keys.readerId}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		await enableLink(id);
		const cfg = await data<ExpenseLinkConfig>(await as('reader', `/actions/${id}/expense-link`));
		expect(cfg.exists).toBe(true);
		expect(cfg.publicPath).toBeNull();
		expect(
			(
				await as('reader', `/actions/${id}/expense-link`, {
					method: 'PUT',
					json: { enabled: false }
				})
			).status
		).toBe(403);
		expect((await as('stranger', `/actions/${id}/expense-link`)).status).toBe(404);
		expect((await as('stranger', `/actions/${id}/expense-submissions`)).status).toBe(404);
	});
});

describe('Kosten-Link: öffentliche Einreichung', () => {
	it('nimmt eine gültige Auslage mit Beleg an (verschlüsselt, Mail ohne IBAN)', async () => {
		const id = await newAction('Herbstfahrt');
		const token = await enableLink(id);
		sent.length = 0;
		const before = fakeObjects.size;
		const res = await submit(token, fields());
		const out = await data<PublicExpenseBatchResult>(res, 201);
		expect(Object.keys(out).sort()).toEqual(['batchId', 'count', 'emailSent']);
		expect(out).toMatchObject({ count: 1, emailSent: true });
		expect(fakeObjects.size).toBe(before + 1);
		const toPerson = sent.filter((m) => m.to === 'erika@example.test');
		expect(toPerson).toHaveLength(1);
		expect(toPerson[0]!.text).not.toContain('DE89');
		expect(toPerson[0]!.text).not.toContain('013000');
		expect(toPerson[0]!.text).toContain('42,50');

		const items = await list(id);
		expect(items).toHaveLength(1);
		const sub = items[0]!;
		expect(sub).toMatchObject({
			status: 'pending',
			submitterName: 'Erika Beispiel',
			amountCents: 4250,
			category: 'food',
			batchId: out.batchId,
			receipt: { name: 'quittung.pdf', contentType: 'application/pdf' }
		});
		expect(sub.ibanMasked).toContain('0130 00');
		expect(JSON.stringify(items)).not.toContain('DE89');

		const rows = await core.database
			.forModule('actions')
			.transaction(async (tx) =>
				tx.execute(
					(await import('drizzle-orm'))
						.sql`SELECT iban_enc, iban_last4 FROM expense_submissions WHERE id = ${sub.id}`
				)
			);
		const row = (rows as unknown as { rows: Record<string, unknown>[] }).rows[0]!;
		expect(String(row.iban_enc)).not.toContain('DE89');
		expect(row.iban_last4).toBe('013000');

		const receipt = await as('owner', `/actions/${id}/expense-submissions/${sub.id}/receipt`);
		expect(receipt.status).toBe(200);
		expect(receipt.headers.get('x-content-type-options')).toBe('nosniff');
		expect(receipt.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
		expect(receipt.headers.get('content-disposition')).toContain('attachment');

		const cfg = await data<ExpenseLinkConfig>(await as('owner', `/actions/${id}/expense-link`));
		expect(cfg.pendingCount).toBe(1);
	});

	it('mehrere Auslagen in einem Durchgang: gleiche batchId, Mails an Person und Eigentümer*in', async () => {
		const id = await newAction('Pfingstlager');
		const token = await enableLink(id);
		sent.length = 0;
		const before = fakeObjects.size;
		const its = [
			item({ description: 'Brot', amountCents: 1000 }),
			item({ description: 'Bastelmaterial', category: 'materials', amountCents: 2550 }),
			item({ description: 'Fahrkarte', category: 'travel', amountCents: 830, note: null })
		];
		const out = await data<PublicExpenseBatchResult>(
			await submit(token, fields({}, its), [
				pdf('a.pdf'),
				{ name: 'b.png', bytes: PNG },
				pdf('c.pdf')
			]),
			201
		);
		expect(out).toMatchObject({ count: 3, emailSent: true });
		expect(fakeObjects.size).toBe(before + 3);

		const rows = await list(id);
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map((r) => r.batchId))).toEqual(new Set([out.batchId]));
		expect(rows.every((r) => r.status === 'pending')).toBe(true);
		// Reihenfolge wie eingereicht, Belege je Auslage
		expect(rows.map((r) => r.description)).toEqual(['Brot', 'Bastelmaterial', 'Fahrkarte']);
		expect(rows.map((r) => r.receipt?.name)).toEqual(['a.pdf', 'b.png', 'c.pdf']);
		expect(rows[1]!.receipt?.contentType).toBe('image/png');
		expect(rows.every((r) => r.ibanMasked?.includes('0130 00'))).toBe(true);

		const person = sent.find((m) => m.to === 'erika@example.test')!;
		expect(person).toBeTruthy();
		// Kein Freitext an die unbestätigte Adresse (Issue #17): nur Kategorie, Datum, Betrag
		for (const t of ['Verpflegung', '43,80', 'Pfingstlager']) {
			expect(person.text).toContain(t);
		}
		for (const t of ['Brot', 'Bastelmaterial', 'Fahrkarte', 'Erika']) {
			expect(person.text).not.toContain(t);
		}
		expect(person.text).not.toContain('DE89');
		expect(person.text).not.toContain('013000');

		const owner = sent.find((m) => m.to === 'owner@example.test')!;
		expect(owner).toBeTruthy();
		expect(owner.subject).toBe('Neue Auslagen für Pfingstlager');
		expect(owner.text).toContain('Erika Beispiel');
		expect(owner.text).toContain('Anzahl: 3');
		expect(owner.text).toContain('43,80');
		expect(owner.text).toContain(`/modules/actions/${id}`);
		expect(owner.text).not.toContain('DE89');
		expect(owner.text).not.toContain('013000');
		expect(owner.text).not.toContain('erika@example.test');

		const page = await listAudit({ limit: 500 });
		const audit = page.rows.find(
			(e) =>
				e.action === 'actions.expense.submitted' &&
				(e.metadata as Record<string, unknown> | null)?.batchId === out.batchId
		);
		expect(audit?.metadata).toMatchObject({ count: 3, totalCents: 4380, actionId: id });
		const raw = JSON.stringify(audit);
		expect(raw).not.toContain('Erika');
		expect(raw).not.toContain('DE89');
		expect(raw).not.toContain('erika@example.test');
	});

	it('Anzahl Dateien ungleich Auslagen → 422 (items), mehr als 5 Auslagen → 422', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const before = fakeObjects.size;
		const few = await submit(token, fields({}, [item(), item()]), [pdf()]);
		expect(few.status).toBe(422);
		expect(JSON.stringify((await few.json()).error.details)).toContain('items');
		const many = await submit(token, fields(), [pdf(), pdf()]);
		expect(many.status).toBe(422);
		const six = await submit(
			token,
			fields(
				{},
				Array.from({ length: 6 }, () => item())
			),
			[pdf()]
		);
		expect(six.status).toBe(422);
		expect(JSON.stringify((await six.json()).error.details)).toContain('items');
		expect((await submit(token, fields({}, []), [])).status).toBe(422);
		expect((await submit(token, fields({ items: 'kein json' }))).status).toBe(422);
		const badItem = await submit(token, fields({}, [item(), item({ amountCents: 0 })]), [
			pdf(),
			pdf()
		]);
		expect(badItem.status).toBe(422);
		expect(JSON.stringify((await badItem.json()).error.details)).toContain('amountCents');
		expect(fakeObjects.size).toBe(before);
		expect(await list(id)).toHaveLength(0);
	});

	it('falscher Beleg bei Auslage 2 → 422 items.1.file, nichts gespeichert', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const before = fakeObjects.size;
		sent.length = 0;
		const res = await submit(token, fields({}, [item(), item(), item()]), [
			pdf(),
			{ name: 'virus.pdf', bytes: new TextEncoder().encode('MZ not a pdf') },
			pdf()
		]);
		expect(res.status).toBe(422);
		const details = (await res.json()).error.details as Record<string, string>;
		expect(Object.keys(details)).toEqual(['items.1.file']);
		expect(fakeObjects.size).toBe(before);
		expect(await list(id)).toHaveLength(0);
		expect(sent).toHaveLength(0);

		const empty = await submit(token, fields({}, [item(), item()]), [
			pdf(),
			{ name: 'leer.pdf', bytes: new Uint8Array(0) }
		]);
		expect(empty.status).toBe(422);
		expect(JSON.stringify((await empty.json()).error.details)).toContain('items.1.file');
		expect(fakeObjects.size).toBe(before);
	});

	it('Honeypot: Erfolg vortäuschen, nichts speichern, keine Mails', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const before = fakeObjects.size;
		sent.length = 0;
		const res = await submit(token, fields({ website: 'http://spam.example' }, [item(), item()]), [
			pdf(),
			pdf()
		]);
		const out = await data<PublicExpenseBatchResult>(res, 201);
		expect(out.count).toBe(2);
		expect(fakeObjects.size).toBe(before);
		expect(await list(id)).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it('validiert IBAN, Pflichtfelder und Datenschutz (422)', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const before = fakeObjects.size;
		const iban = await submit(token, fields({ iban: 'DE00 1234 5678 9012 3456 78' }));
		expect(iban.status).toBe(422);
		expect(JSON.stringify((await iban.json()).error.details)).toContain('iban');
		expect((await submit(token, fields({ privacy: '' }))).status).toBe(422);
		expect((await submit(token, fields({}, [item({ amountCents: 0 })]))).status).toBe(422);
		expect((await submit(token, fields(), [])).status).toBe(422);
		expect(fakeObjects.size).toBe(before);
		// PNG wird akzeptiert
		expect((await submit(token, fields(), [{ name: 'foto.png', bytes: PNG }])).status).toBe(201);
		expect(fakeObjects.size).toBe(before + 1);
	});

	it('zu groß → 413, falscher Content-Type → 400', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const before = fakeObjects.size;
		// einzelner Beleg > 10 MB
		const big = new Uint8Array(10 * 1024 * 1024 + 10);
		big.set(PDF);
		expect((await submit(token, fields(), [{ name: 'gross.pdf', bytes: big }])).status).toBe(413);
		// gesamter Request > 30 MB (vier Belege zu je 8 MB)
		const part = new Uint8Array(8 * 1024 * 1024);
		part.set(PDF);
		const four = Array.from({ length: 4 }, () => ({ name: 'teil.pdf', bytes: part }));
		const res = await submit(
			token,
			fields(
				{},
				four.map(() => item())
			),
			four
		);
		expect(res.status).toBe(413);
		expect(fakeObjects.size).toBe(before);

		resetAllForTests();
		const json = await api(`${BASE}/public/expense-links/${token}/submit`, {
			method: 'POST',
			json: fields()
		});
		expect(json.status).toBe(400);
		expect((await submit(token, fields(), undefined, { contentType: 'text/plain' })).status).toBe(
			400
		);
	});

	it('abgeschlossene Abrechnung → 404, Modul aus → 404', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		await data(
			await as('owner', `/actions/${id}/accounting/close`, { method: 'POST', json: {} }),
			201
		);
		expect((await pubGet(token)).status).toBe(404);
		expect((await submit(token, fields())).status).toBe(404);
		const cfg = await data<ExpenseLinkConfig>(await as('owner', `/actions/${id}/expense-link`));
		expect(cfg.accountingClosed).toBe(true);

		const id2 = await newAction();
		const token2 = await enableLink(id2);
		await disableModule(admin, 'actions');
		try {
			expect((await pubGet(token2)).status).toBe(404);
		} finally {
			await enableModule(admin, 'actions');
		}
	});

	it('Rate-Limit greift (5 je 10 min und IP)', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		resetAllForTests();
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const r = await submit(token, fields({ privacy: '' }), undefined, {
				reset: false,
				ip: '10.9.9.9'
			});
			statuses.push(r.status);
		}
		expect(statuses.slice(0, 5)).toEqual([422, 422, 422, 422, 422]);
		expect(statuses[5]).toBe(429);
	});

	it('begrenzt offene Einreichungen je Aktion inkl. der neuen Anzahl (409)', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		await core.database.forModule('actions').transaction(async (tx) => {
			const { sql } = await import('drizzle-orm');
			for (let i = 0; i < 48; i++) {
				await tx.execute(
					sql`INSERT INTO expense_submissions (id, action_id, submitter_name, category, description,
							amount_cents, expense_date)
						VALUES (${crypto.randomUUID()}, ${id}, 'X', 'food', 'Y', 100, '2026-07-01')`
				);
			}
		});
		const before = fakeObjects.size;
		// 48 + 3 > 50 → 409, nichts hochgeladen
		const res = await submit(token, fields({}, [item(), item(), item()]), [pdf(), pdf(), pdf()]);
		expect(res.status).toBe(409);
		expect(fakeObjects.size).toBe(before);
		// 48 + 2 = 50 → erlaubt
		expect((await submit(token, fields({}, [item(), item()]), [pdf(), pdf()])).status).toBe(201);
		expect((await submit(token, fields())).status).toBe(409);
	});

	it('Tageslimit je Link (Issue #17): Einreichung gespeichert, aber keine Mails mehr', async () => {
		const id = await newAction('Limitlager');
		const token = await enableLink(id);
		const { sql } = await import('drizzle-orm');
		await core.database.forModule('actions').transaction((tx) =>
			tx.execute(
				sql`INSERT INTO public_mail_counters (action_id, kind, day, count)
					VALUES (${id}, 'expense-confirm', CURRENT_DATE, 30),
						(${id}, 'expense-owner', CURRENT_DATE, 30)`
			)
		);
		sent.length = 0;
		const out = await data<PublicExpenseBatchResult>(
			await submit(token, fields({}, [item()]), [pdf('a.pdf')]),
			201
		);
		expect(out.emailSent).toBe(false);
		expect(sent).toHaveLength(0);
		expect(await list(id)).toHaveLength(1);
	});
});

describe('Kosten-Link: Prüfen', () => {
	it('Übernehmen legt Buchung + Empfänger an und nutzt Empfänger wieder', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const a = await submitOne(id, token);
		const b = await submitOne(
			id,
			token,
			fields({ name: 'ERIKA BEISPIEL', accountHolder: 'erika beispiel' })
		);

		// Lesende dürfen nicht übernehmen (403), Fremde sehen nichts (404)
		await data(
			await as('owner', `/actions/${id}/shares/${keys.readerId}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		const acceptPath = (sid: string) => `/actions/${id}/expense-submissions/${sid}/accept`;
		expect((await as('reader', acceptPath(a.id), { method: 'POST', json: {} })).status).toBe(403);
		expect((await as('stranger', acceptPath(a.id), { method: 'POST', json: {} })).status).toBe(404);

		const r1 = await data<{
			submission: ExpenseSubmission;
			entryId: string;
			payeeCreated: boolean;
		}>(
			await as('owner', acceptPath(a.id), {
				method: 'POST',
				json: { amountCents: 4000, description: 'Einkauf (korrigiert)' }
			}),
			201
		);
		expect(r1.payeeCreated).toBe(true);
		expect(r1.submission.status).toBe('accepted');
		expect(r1.submission.decidedBy?.name).toBe('owner Test');
		expect(r1.submission.entryId).toBe(r1.entryId);
		expect(r1.submission.batchId).toBe(a.batchId);

		const r2 = await data<{ payeeCreated: boolean; payeeId: string }>(
			await as('owner', acceptPath(b.id), { method: 'POST', json: {} }),
			201
		);
		expect(r2.payeeCreated).toBe(false);

		// erneut → 409
		expect((await as('owner', acceptPath(a.id), { method: 'POST', json: {} })).status).toBe(409);

		const st = await data<AccountingState>(await as('owner', `/actions/${id}/accounting`));
		const entries = st.entries.filter((e) => e.paidBy === 'person');
		expect(entries).toHaveLength(2);
		const e1 = entries.find((e) => e.id === r1.entryId)!;
		expect(e1).toMatchObject({
			type: 'expense',
			category: 'food',
			amountCents: 4000,
			description: 'Einkauf (korrigiert)',
			entryDate: '2026-07-12',
			receipt: { name: 'quittung.pdf', contentType: 'application/pdf' }
		});
		expect(new Set(entries.map((e) => e.payee?.id)).size).toBe(1);

		// Beleg der Buchung ist abrufbar (gleicher Storage-Pfad)
		const rec = await as('owner', `/actions/${id}/accounting/entries/${r1.entryId}/receipt`);
		expect(rec.status).toBe(200);

		// payeeId einer fremden Aktion → 422
		const c = await submitOne(id, token);
		const other = await newAction();
		const otherToken = await enableLink(other);
		const o = await submitOne(other, otherToken);
		await data(
			await as('owner', `/actions/${other}/expense-submissions/${o.id}/accept`, {
				method: 'POST',
				json: {}
			}),
			201
		);
		const otherPayee = (
			await data<AccountingState>(await as('owner', `/actions/${other}/accounting`))
		).entries[0]!.payee!.id;
		expect(
			(await as('owner', acceptPath(c.id), { method: 'POST', json: { payeeId: otherPayee } }))
				.status
		).toBe(422);
		// eigener Empfänger per payeeId
		const r3 = await data<{ payeeId: string; payeeCreated: boolean }>(
			await as('owner', acceptPath(c.id), { method: 'POST', json: { payeeId: r2.payeeId } }),
			201
		);
		expect(r3).toMatchObject({ payeeId: r2.payeeId, payeeCreated: false });
	});

	it('einzelne Zeilen eines Batches annehmen bzw. ablehnen', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const out = await data<PublicExpenseBatchResult>(
			await submit(
				token,
				fields({}, [
					item({ description: 'Eins', amountCents: 1000 }),
					item({ description: 'Zwei', amountCents: 2000 })
				]),
				[pdf('eins.pdf'), pdf('zwei.pdf')]
			),
			201
		);
		const rows = await list(id);
		const one = rows.find((r) => r.description === 'Eins')!;
		const two = rows.find((r) => r.description === 'Zwei')!;
		expect(one.batchId).toBe(out.batchId);
		expect(two.batchId).toBe(out.batchId);
		const before = fakeObjects.size;

		const acc = await data<{ submission: ExpenseSubmission; entryId: string }>(
			await as('owner', `/actions/${id}/expense-submissions/${one.id}/accept`, {
				method: 'POST',
				json: {}
			}),
			201
		);
		expect(acc.submission.status).toBe('accepted');
		const rej = await data<{ submission: ExpenseSubmission }>(
			await as('owner', `/actions/${id}/expense-submissions/${two.id}/reject`, {
				method: 'POST',
				json: { reason: null, notify: false }
			}),
			201
		);
		expect(rej.submission.status).toBe('rejected');
		// nur der Beleg der abgelehnten Zeile ist gelöscht; die Buchung behält ihren Beleg
		expect(fakeObjects.size).toBe(before - 1);
		const rec = await as('owner', `/actions/${id}/accounting/entries/${acc.entryId}/receipt`);
		expect(rec.status).toBe(200);
		const after = await list(id);
		expect(after.map((r) => r.status).sort()).toEqual(['accepted', 'rejected']);
		expect(new Set(after.map((r) => r.batchId))).toEqual(new Set([out.batchId]));
	});

	it('Übernehmen bei abgeschlossener Abrechnung → 409', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const a = await submitOne(id, token);
		await data(
			await as('owner', `/actions/${id}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		const res = await as('owner', `/actions/${id}/expense-submissions/${a.id}/accept`, {
			method: 'POST',
			json: {}
		});
		expect(res.status).toBe(409);
	});

	it('Ablehnen löscht IBAN und Beleg, informiert optional per Mail', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		const a = await submitOne(id, token);
		const before = fakeObjects.size;
		sent.length = 0;
		const res = await data<{ submission: ExpenseSubmission; emailSent: boolean }>(
			await as('owner', `/actions/${id}/expense-submissions/${a.id}/reject`, {
				method: 'POST',
				json: { reason: 'Kein Bezug zur Aktion', notify: true }
			}),
			201
		);
		expect(res.emailSent).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.text).toContain('Kein Bezug zur Aktion');
		expect(res.submission).toMatchObject({
			status: 'rejected',
			receipt: null,
			accountHolder: null,
			bic: null,
			rejectReason: 'Kein Bezug zur Aktion'
		});
		expect(fakeObjects.size).toBe(before - 1);
		const { sql } = await import('drizzle-orm');
		const r = (await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(sql`SELECT iban_enc, receipt_path FROM expense_submissions WHERE id = ${a.id}`)
			)) as unknown as { rows: Record<string, unknown>[] };
		expect(r.rows[0]).toEqual({ iban_enc: null, receipt_path: null });
		expect(
			(
				await as('owner', `/actions/${id}/expense-submissions/${a.id}/reject`, {
					method: 'POST',
					json: {}
				})
			).status
		).toBe(409);
		expect((await as('owner', `/actions/${id}/expense-submissions/${a.id}/receipt`)).status).toBe(
			404
		);
	});

	it('Statusfilter und Audit ohne personenbezogene Daten', async () => {
		const id = await newAction();
		const token = await enableLink(id);
		await data(await submit(token, fields()), 201);
		const pending = await data<ExpenseSubmission[]>(
			await as('owner', `/actions/${id}/expense-submissions?status=pending`)
		);
		expect(pending).toHaveLength(1);
		const rejected = await data<ExpenseSubmission[]>(
			await as('owner', `/actions/${id}/expense-submissions?status=rejected`)
		);
		expect(rejected).toHaveLength(0);

		const page = await listAudit({ limit: 500 });
		const rows = page.rows.filter((e) => e.action.startsWith('actions.expense.'));
		const kinds = new Set(rows.map((e) => e.action));
		for (const k of ['submitted', 'accepted', 'rejected', 'link_updated', 'link_rotated']) {
			expect(kinds).toContain(`actions.expense.${k}`);
		}
		const raw = JSON.stringify(rows);
		expect(raw).not.toContain('Erika');
		expect(raw).not.toContain('erika@example.test');
		expect(raw).not.toContain('05320130');
		expect(raw).not.toContain('DE89');
	});
});
