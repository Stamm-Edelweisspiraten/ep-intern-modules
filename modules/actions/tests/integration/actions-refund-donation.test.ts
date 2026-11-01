import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
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
import { setTodayForTests } from '$lib/sdk/dates';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { parseArchive } from '$modules/actions/action-archive';
import type { RequestContext } from '$lib/sdk/types';
import type { Account, Payable, PayableList } from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
let readerKey = '';

function api(
	path: string,
	init: RequestInit & { json?: unknown } = {},
	apiKey: string | null = key
) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
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
const A = (path: string, init: Parameters<typeof api>[1] = {}, apiKey: string | null = key) =>
	api(`/modules/actions${path}`, init, apiKey);
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, init);
const P = (token: string, init: Parameters<typeof api>[1] = {}) =>
	A(`/public/refund-choices/${token}`, init, null);

async function data<R>(res: Response, status?: number): Promise<R> {
	const body = await res.json();
	if (status) expect(res.status, JSON.stringify(body)).toBe(status);
	else expect([200, 201], JSON.stringify(body)).toContain(res.status);
	return body.data as R;
}

interface Item {
	id: string;
	name: string;
	amountCents: number;
	donatedCents: number;
	payoutCents: number;
	decidedVia: 'internal' | 'link' | null;
	hasLink: boolean;
	paidCents: number;
}
interface RefundDto {
	booked: null | {
		entryId: string | null;
		totalCents: number;
		donatedCents: number;
		payoutCents: number;
		deadline: string | null;
		deadlineRunning: boolean;
		items: Item[];
	};
	items: Item[];
}

const mdb = () => core.database.forModule('actions');
let giro = '';
let seq = 0;

/** Aktion mit drei Zahlenden (je 200 €) und 600 € Überschuss, Rückzahlung gebucht → 3 × 200 € */
async function bookedAction(): Promise<{ id: string; items: Record<string, Item> }> {
	const id = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name: `Herbstlager ${++seq}`, startsOn: '2026-05-01', endsOn: '2026-05-03' }
			}),
			201
		)
	).id;
	await mdb().transaction(async (tx) => {
		await tx.execute(sql`UPDATE actions SET fee_cents = 20000 WHERE id = ${id}`);
		for (const name of ['Anna Alt', 'Bert Bauer', 'Cleo Cramer']) {
			await tx.execute(
				sql`INSERT INTO action_participants (id, action_id, name, role)
					VALUES (${crypto.randomUUID()}, ${id}, ${name}, 'participant')`
			);
		}
		await tx.execute(
			sql`INSERT INTO accounting_entries (id, action_id, type, category, description, amount_cents,
					entry_date, paid_by)
				VALUES (${crypto.randomUUID()}, ${id}, 'income', 'contributions', 'Beiträge', 60000,
					'2026-05-04', 'club')`
		);
	});
	const r = await data<RefundDto>(
		await A(`/actions/${id}/accounting/refund`, { method: 'POST' }),
		201
	);
	const items = Object.fromEntries(r.booked!.items.map((i) => [i.name.split(' ')[0]!, i]));
	return { id, items };
}

async function getRefund(id: string): Promise<RefundDto> {
	return data<RefundDto>(await A(`/actions/${id}/accounting/refund`));
}
const donate = (id: string, itemId: string, donatedCents: number, apiKey: string = key) =>
	A(
		`/actions/${id}/accounting/refund/items/${itemId}/donation`,
		{ method: 'PUT', json: { donatedCents } },
		apiKey
	);

async function refundEntry(id: string) {
	const acc = await data<{
		entries: { category: string; amountCents: number; description: string }[];
	}>(await A(`/actions/${id}/accounting`));
	return acc.entries.find((e) => e.category === 'refund') ?? null;
}

async function refundPayables(actionId: string): Promise<Payable[]> {
	await data(await T('/sync', { method: 'POST' }), 201);
	const list = await data<PayableList>(await T('/payables?status=all'));
	return list.items.filter((p) => p.source === 'refund' && p.action?.id === actionId);
}

async function linkToken(id: string, itemId: string, rotate = false): Promise<string> {
	const { url } = await data<{ url: string }>(
		await A(`/actions/${id}/accounting/refund/items/${itemId}/link`, {
			method: 'POST',
			json: rotate ? { rotate: true } : {}
		}),
		201
	);
	expect(url).toContain('/p/actions/rueckzahlung/');
	return url.split('/').pop()!;
}

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
	admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setTodayForTests('2026-06-01');
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	const role = await createRole(admin, {
		name: 'Nur Aktionen ansehen',
		permissions: ['core.api.manage', 'actions.action.view']
	});
	const readerId = await createUser(admin, {
		name: 'Leser',
		email: 'leser@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const readerCtx = (await contextForUser(readerId))!.ctx;
	readerKey = (await createApiKey(readerCtx, { name: 'r', scopes: [...readerCtx.permissions] }))
		.key;

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
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Rückzahlung spenden', () => {
	it('intern: Spende verringert Buchung und Kassen-Auszahlung, Teilspende nur ganze Euro', async () => {
		const { id, items } = await bookedAction();
		expect(items.Anna!.donatedCents).toBe(0);
		expect((await refundPayables(id)).filter((p) => !p.cancelledAt)).toHaveLength(3);

		await data(await donate(id, items.Anna!.id, 20000));
		await data(await donate(id, items.Bert!.id, 5000));
		expect((await donate(id, items.Cleo!.id, 5050)).status).toBe(422);
		expect((await donate(id, items.Cleo!.id, 20100)).status).toBe(422);
		expect((await donate(id, crypto.randomUUID(), 0)).status).toBe(404);

		const r = await getRefund(id);
		expect(r.booked!.donatedCents).toBe(25000);
		expect(r.booked!.payoutCents).toBe(35000);
		const anna = r.booked!.items.find((i) => i.id === items.Anna!.id)!;
		expect(anna.payoutCents).toBe(0);
		expect(anna.decidedVia).toBe('internal');

		const entry = (await refundEntry(id))!;
		expect(entry.amountCents).toBe(35000);
		expect(entry.description).toContain('2 gespendet');

		const pays = await refundPayables(id);
		const open = pays.filter((p) => !p.cancelledAt);
		expect(open.map((p) => p.amountCents).sort()).toEqual([15000, 20000]);
		expect(pays.find((p) => p.recipientName === 'Anna Alt')?.cancelledAt ?? 'weg').toBeTruthy();

		// Zurück auf Auszahlen → Auszahlung wieder voll
		await data(await donate(id, items.Anna!.id, 0));
		expect((await refundEntry(id))!.amountCents).toBe(55000);
		const again = (await refundPayables(id)).filter((p) => !p.cancelledAt);
		expect(again.find((p) => p.recipientName === 'Anna Alt')!.amountCents).toBe(20000);
	});

	it('Rechte: Leser ohne Freigabe 404, Spende nach Überweisung durch die Kasse 409', async () => {
		const { id, items } = await bookedAction();
		expect((await donate(id, items.Anna!.id, 20000, readerKey)).status).toBe(404);

		const p = (await refundPayables(id)).find((x) => x.recipientName === 'Bert Bauer')!;
		await data(
			await T(`/payables/${p.id}/pay`, {
				method: 'POST',
				json: { accountId: giro, bookedOn: '2026-06-01', amountCents: 20000 }
			}),
			201
		);
		const res = await donate(id, items.Bert!.id, 20000);
		expect(res.status).toBe(409);
		const r = await getRefund(id);
		expect(r.booked!.items.find((i) => i.id === items.Bert!.id)!.paidCents).toBe(20000);
	});

	it('alles gespendet: Buchung entfällt, kommt bei Auszahlung zurück; Rücknahme löscht Spenden', async () => {
		const { id, items } = await bookedAction();
		for (const it of Object.values(items)) await data(await donate(id, it.id, it.amountCents));
		expect(await refundEntry(id)).toBeNull();
		const r = await getRefund(id);
		expect(r.booked).not.toBeNull();
		expect(r.booked!.entryId).toBeNull();
		expect(r.booked!.payoutCents).toBe(0);
		expect((await refundPayables(id)).filter((p) => !p.cancelledAt)).toHaveLength(0);

		await data(await donate(id, items.Cleo!.id, 0));
		expect((await refundEntry(id))!.amountCents).toBe(20000);

		await data(await A(`/actions/${id}/accounting/refund`, { method: 'DELETE' }));
		const rows = await mdb().transaction(async (tx) => {
			const res = (await tx.execute(
				sql`SELECT count(*) AS n FROM accounting_refunds WHERE action_id = ${id}`
			)) as unknown as { rows: { n: unknown }[] };
			return Number(res.rows[0]!.n);
		});
		expect(rows).toBe(0);
		expect(await refundEntry(id)).toBeNull();
	});

	it('Link: lesen, wählen, Honeypot, Teilspende, erneuern, Abschluss sperrt', async () => {
		const { id, items } = await bookedAction();
		const token = await linkToken(id, items.Cleo!.id);
		expect((await getRefund(id)).booked!.items.find((i) => i.id === items.Cleo!.id)!.hasLink).toBe(
			true
		);
		// Gleicher Link bei erneutem Abruf
		expect(await linkToken(id, items.Cleo!.id)).toBe(token);

		const view = await data<{ name: string; amountCents: number; choice: string; locked: boolean }>(
			await P(token)
		);
		expect(view).toMatchObject({
			name: 'Cleo Cramer',
			amountCents: 20000,
			choice: 'payout',
			locked: false
		});
		expect((await P('0'.repeat(64))).status).toBe(404);

		// Honeypot: Erfolg, aber nichts gespeichert
		await data(await P(token, { method: 'POST', json: { choice: 'donate', website: 'x' } }));
		expect((await data<{ donatedCents: number }>(await P(token))).donatedCents).toBe(0);

		expect(
			(
				await A(
					`/public/refund-choices/${token}`,
					{ method: 'POST', json: { choice: 'partial' } },
					null
				)
			).status
		).toBe(422);
		expect(
			(await P(token, { method: 'POST', json: { choice: 'partial', donatedCents: 1050 } })).status
		).toBe(422);
		const partial = await data<{ choice: string; donatedCents: number }>(
			await P(token, {
				method: 'POST',
				json: { choice: 'partial', donatedCents: 8000, note: 'Für neue Zelte' }
			})
		);
		expect(partial).toMatchObject({ choice: 'partial', donatedCents: 8000 });
		const it = (await getRefund(id)).booked!.items.find((i) => i.id === items.Cleo!.id)!;
		expect(it.decidedVia).toBe('link');
		expect(it.payoutCents).toBe(12000);
		const cleoPay = (await refundPayables(id)).find((p) => p.recipientName === 'Cleo Cramer')!;
		expect(cleoPay.amountCents).toBe(12000);

		// Erneuern: alter Link ungültig
		const fresh = await linkToken(id, items.Cleo!.id, true);
		expect(fresh).not.toBe(token);
		expect((await P(token)).status).toBe(404);
		expect((await P(fresh)).status).toBe(200);

		// Abschluss sperrt den Link und die interne Änderung
		await data(
			await A(`/actions/${id}/accounting/close`, {
				method: 'POST',
				json: { acceptMissingReceipts: true }
			}),
			201
		);
		expect((await P(fresh)).status).toBe(404);
		expect((await donate(id, items.Anna!.id, 20000)).status).toBe(409);

		const audit = (await listAudit({ limit: 500 })).rows.filter((x) =>
			String(x.action).startsWith('actions.accounting.refund')
		);
		expect(audit.some((a) => a.action === 'actions.accounting.refund-donation-set')).toBe(true);
		const text = JSON.stringify(audit);
		expect(text).not.toContain('Cleo');
		expect(text).not.toContain('Zelte');
	});

	it('Briefe als PDF mit QR-Link, Bericht mit Spendenblock, Archiv behält Spenden', async () => {
		const { id, items } = await bookedAction();
		await data(await donate(id, items.Anna!.id, 20000));
		await data(await donate(id, items.Bert!.id, 7000));

		let html = '';
		setPdfRendererForTests(async (h) => {
			html += h;
			const d = await PDFDocument.create();
			d.addPage([200, 300]);
			return d.save();
		});
		const letters = await A(`/actions/${id}/accounting/refund/letters.pdf`, {
			method: 'POST',
			json: {}
		});
		expect(letters.status).toBe(200);
		expect(letters.headers.get('content-type')).toBe('application/pdf');
		expect(html).toContain('/p/actions/rueckzahlung/');
		expect(html).toContain('Bert Bauer');
		expect((await getRefund(id)).booked!.items.every((i) => i.hasLink)).toBe(true);
		const one = await A(`/actions/${id}/accounting/refund/letters.pdf`, {
			method: 'POST',
			json: { itemIds: [crypto.randomUUID()] }
		});
		expect(one.status).toBe(404);

		html = '';
		expect((await A(`/actions/${id}/accounting/report.pdf`)).status).toBe(200);
		expect(html).toContain('An den Stamm gespendet');
		expect(html).toContain('Davon an den Stamm gespendet');

		const zip = new Uint8Array(await (await A(`/actions/${id}/export`)).arrayBuffer());
		const doc = parseArchive(zip).document;
		const donated = doc.refund!.items.map((i) => i.donatedCents ?? 0).sort((a, b) => a - b);
		expect(donated).toEqual([0, 7000, 20000]);
		const fd = new FormData();
		fd.set('file', new File([zip], 'export.zip', { type: 'application/zip' }));
		const imp = await data<{ id: string }>(
			await A('/actions/import', { method: 'POST', body: fd }),
			201
		);
		const r = await getRefund(imp.id);
		expect(r.booked!.donatedCents).toBe(27000);
		expect(r.booked!.items.every((i) => !i.hasLink)).toBe(true);
		expect((await refundEntry(imp.id))!.amountCents).toBe(33000);
	});
});

describe('Rückmeldefrist', () => {
	const setDeadline = (id: string, deadline: string | null, apiKey: string = key) =>
		A(`/actions/${id}/accounting/refund/deadline`, { method: 'PUT', json: { deadline } }, apiKey);

	it('Kasse wartet bis zur Frist, danach Link zu und Auszahlung; intern weiter änderbar', async () => {
		setTodayForTests('2026-06-01');
		const { id, items } = await bookedAction();
		expect((await refundPayables(id)).filter((p) => !p.cancelledAt)).toHaveLength(3);

		expect((await setDeadline(id, '2026-05-31')).status).toBe(422);
		expect((await setDeadline(id, '2026-06-10', readerKey)).status).toBe(404);
		expect(await data<{ deadline: string }>(await setDeadline(id, '2026-06-10'))).toEqual({
			deadline: '2026-06-10'
		});
		const r = await getRefund(id);
		expect(r.booked).toMatchObject({ deadline: '2026-06-10', deadlineRunning: true });
		// Frist läuft: bestehende, unbezahlte Auszahlungen werden storniert, keine neuen
		expect((await refundPayables(id)).filter((p) => !p.cancelledAt)).toHaveLength(0);

		const token = await linkToken(id, items.Anna!.id);
		const view = await data<{ deadline: string; locked: boolean; lockedReason: null }>(
			await P(token)
		);
		expect(view).toMatchObject({ deadline: '2026-06-10', locked: false, lockedReason: null });
		await data(await P(token, { method: 'POST', json: { choice: 'donate' } }));

		// Letzter Tag der Frist zählt noch dazu
		setTodayForTests('2026-06-10');
		expect((await P(token)).status).toBe(200);
		expect((await refundPayables(id)).filter((p) => !p.cancelledAt)).toHaveLength(0);

		// Nach Ablauf: Kasse zahlt aus (ohne Annas Spende), Link gesperrt, intern geht es weiter
		setTodayForTests('2026-06-11');
		const open = (await refundPayables(id)).filter((p) => !p.cancelledAt);
		expect(open.map((p) => p.recipientName).sort()).toEqual(['Bert Bauer', 'Cleo Cramer']);
		const after = await data<{ locked: boolean; lockedReason: string; choice: string }>(
			await P(token)
		);
		expect(after).toMatchObject({ locked: true, lockedReason: 'deadline', choice: 'donate' });
		expect((await P(token, { method: 'POST', json: { choice: 'payout' } })).status).toBe(409);
		expect((await getRefund(id)).booked!.deadlineRunning).toBe(false);
		await data(await donate(id, items.Bert!.id, 20000));
		expect((await refundPayables(id)).filter((p) => !p.cancelledAt)).toHaveLength(1);

		// Frist entfernen ist erlaubt; Audit ohne Namen
		expect(await data<{ deadline: null }>(await setDeadline(id, null))).toEqual({ deadline: null });
		const audit = (await listAudit({ limit: 500 })).rows.filter(
			(x) => x.action === 'actions.accounting.refund-deadline-set'
		);
		expect(audit.length).toBeGreaterThanOrEqual(2);
		setTodayForTests('2026-06-01');
	});

	it('Frist im Brief und im Archiv', async () => {
		setTodayForTests('2026-06-01');
		const { id } = await bookedAction();
		await data(await setDeadline(id, '2026-06-20'));
		let html = '';
		setPdfRendererForTests(async (h) => {
			html += h;
			const d = await PDFDocument.create();
			d.addPage([200, 300]);
			return d.save();
		});
		expect(
			(await A(`/actions/${id}/accounting/refund/letters.pdf`, { method: 'POST', json: {} })).status
		).toBe(200);
		expect(html).toContain('20.06.2026');
		const zip = new Uint8Array(await (await A(`/actions/${id}/export`)).arrayBuffer());
		expect(parseArchive(zip).document.refund!.deadline).toBe('2026-06-20');
		const fd = new FormData();
		fd.set('file', new File([zip], 'export.zip', { type: 'application/zip' }));
		const imp = await data<{ id: string }>(
			await A('/actions/import', { method: 'POST', body: fd }),
			201
		);
		expect((await getRefund(imp.id)).booked!.deadline).toBe('2026-06-20');
	});
});
