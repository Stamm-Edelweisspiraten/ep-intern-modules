/**
 * #68 (02-09): Abgeschlossene Abrechnungen ohne N+1.
 * - Liste: ein gesammelter Kassen-Aufruf (`contributionsForActions`) und eine Modul-Transaktion für alle Summen
 * - PDF: Existenzprüfung über `isAccountingClosed` (eine Abfrage) statt der ganzen Liste
 * - Ist-Werte (Kasse) je Aktion wie beim Einzelabruf
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$lib/sdk/server';
import { setTodayForTests } from '$lib/sdk/dates';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { treasuryService } from '$modules/treasury/service';
import { actionsService } from '$modules/actions/service';
import type { ClosedAccountingItem } from '$modules/treasury/closed-accountings';

let close: () => Promise<void>;
let key = '';
const actionIds: string[] = [];

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

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
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
	let admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setTodayForTests('2026-06-01');
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	for (const [i, name] of ['Lager A', 'Lager B', 'Lager C'].entries()) {
		const { id } = await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name, startsOn: '2026-06-05', endsOn: '2026-06-08' }
			}),
			201
		);
		actionIds.push(id);
		await data(
			await A(`/actions/${id}/accounting/entries`, {
				method: 'POST',
				json: {
					type: 'expense',
					category: 'lodging',
					description: 'Herberge',
					amountCents: 10000 * (i + 1),
					entryDate: '2026-06-06',
					paidBy: 'club',
					clubPaid: true
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
	}
});

afterAll(async () => {
	vi.restoreAllMocks();
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Abgeschlossene Abrechnungen (#68)', () => {
	it('Liste: ein Kassen-Aufruf, eine Modul-Transaktion für alle Summen', async () => {
		const single = vi.spyOn(treasuryService, 'contributionsForAction');
		const many = vi.spyOn(treasuryService, 'contributionsForActions');
		const forModule = vi.spyOn(core.database, 'forModule');
		const list = await actionsService.listClosedAccountings();
		expect(list.map((a) => a.actionId).sort()).toEqual([...actionIds].sort());
		expect(single).not.toHaveBeenCalled();
		expect(many).toHaveBeenCalledTimes(1);
		expect(many.mock.calls[0]![0].sort()).toEqual([...actionIds].sort());
		// Liste der Abschlüsse + Summen: zwei Transaktionen, unabhängig von der Anzahl der Aktionen
		expect(forModule.mock.calls.filter(([id]) => id === 'actions')).toHaveLength(2);
		vi.restoreAllMocks();

		// Summen wie beim Einzelabruf
		for (const a of list) {
			const d = (await actionsService.getClosedAccounting(a.actionId))!;
			expect([a.incomeCents, a.expenseCents, a.balanceCents]).toEqual([
				d.incomeCents,
				d.expenseCents,
				d.balanceCents
			]);
		}
		expect(list.map((a) => a.expenseCents).sort((x, y) => x - y)).toEqual([10000, 20000, 30000]);

		const items = await data<ClosedAccountingItem[]>(await T('/closed-accountings'));
		expect(items.filter((i) => i.status === 'closed')).toHaveLength(3);
	});

	it('PDF: Existenzprüfung ohne Liste; offen/unbekannt → 404', async () => {
		const listSpy = vi.spyOn(actionsService, 'listClosedAccountings');
		const res = await T(`/closed-accountings/${actionIds[0]}/pdf`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(listSpy).not.toHaveBeenCalled();
		expect((await T(`/closed-accountings/${crypto.randomUUID()}/pdf`)).status).toBe(404);
		await data(await A(`/actions/${actionIds[1]}/accounting/reopen`, { method: 'POST' }), 201);
		expect((await T(`/closed-accountings/${actionIds[1]}/pdf`)).status).toBe(404);
		expect(await actionsService.isAccountingClosed(actionIds[2]!)).toBe(true);
		expect(await actionsService.isAccountingClosed(actionIds[1]!)).toBe(false);
	});

	it('contributionsForActions: leere Liste ohne Abfrage, Einzelabruf nutzt dieselbe Logik', async () => {
		expect((await treasuryService.contributionsForActions([])).size).toBe(0);
		expect(await treasuryService.contributionsForAction(actionIds[0]!)).toBeNull();
	});
});
