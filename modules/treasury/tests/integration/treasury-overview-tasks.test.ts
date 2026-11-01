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
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import type { Account, Overview, OverviewTask } from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
const keys: Record<string, string> = {};

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
const T = (path: string, init: Parameters<typeof api>[1] = {}, who = 'kasse') =>
	api(`/modules/treasury${path}`, { token: keys[who], ...init });

async function data<D>(res: Response, status = 200): Promise<D> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as D;
}

async function tasks(who = 'kasse'): Promise<OverviewTask[]> {
	return (await data<Overview>(await T('/overview', {}, who))).tasks;
}
const kinds = (list: OverviewTask[]) => list.map((t) => t.kind);

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
	const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	setTodayForTests('2026-10-16');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const roles = {
		kasse: await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] }),
		ohne: await createRole(admin, {
			name: 'Ohne',
			permissions: ['core.api.manage', 'treasury.cash.view']
		})
	};
	for (const [name, role] of Object.entries(roles)) {
		const id = await createUser(admin, {
			name,
			email: `${name.toLowerCase()}@example.test`,
			password: 'correct-horse-battery',
			roleIds: [role]
		});
		const ctx = await ctxOf(id);
		keys[name] = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;
	}
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Kasse: Aufgabenliste der Übersicht', () => {
	it('meldet fehlende Kontodaten und den fehlenden Beitragslauf', async () => {
		const list = await tasks();
		expect(kinds(list)).toEqual(expect.arrayContaining(['bank-missing', 'annual-missing']));
		const annual = list.find((t) => t.kind === 'annual-missing')!;
		expect(annual).toMatchObject({ year: 2026, tab: 'annual', severity: 'info' });
		expect(list.find((t) => t.kind === 'bank-missing')!.tab).toBeNull();
	});

	it('zeigt den Beitragslauf nur mit Recht annual-fee.view', async () => {
		const list = await tasks('ohne');
		expect(kinds(list).some((k) => k.startsWith('annual-'))).toBe(false);
		expect(kinds(list)).toContain('bank-missing');
	});

	it('Entwurf mit naher Frist ist eine Warnung, geplanter Versand nur ein Hinweis', async () => {
		await core.settings.set(admin, 'treasury.bank.holder', 'Stamm Test');
		await core.settings.set(admin, 'treasury.bank.iban', 'DE89370400440532013000');
		const run = await data<{ id: string; dueOn: string }>(
			await T('/annual-fees', { method: 'POST', json: { year: 2026 } }),
			201
		);
		let list = await tasks();
		expect(kinds(list)).not.toContain('bank-missing');
		expect(kinds(list)).not.toContain('annual-missing');
		// Frist = heute + 14 Tage → höchstens 14 Tage entfernt → Warnung
		expect(list.find((t) => t.kind === 'annual-draft')).toMatchObject({
			severity: 'warning',
			year: 2026,
			date: run.dueOn
		});

		await data(
			await T(`/annual-fees/${run.id}/schedule`, {
				method: 'POST',
				json: { sendOn: '2026-11-01' }
			}),
			201
		);
		list = await tasks();
		expect(list.find((t) => t.kind === 'annual-scheduled')).toMatchObject({
			severity: 'info',
			date: '2026-11-01'
		});
		expect(kinds(list)).not.toContain('annual-draft');
	});

	it('unzugeordnete Einnahmen erscheinen mit Anzahl und Summe, Kritisches zuerst', async () => {
		const account = await data<Account>(
			await T('/accounts', {
				method: 'POST',
				json: {
					name: 'Girokonto',
					kind: 'giro',
					openingBalanceCents: 0,
					openingDate: '2026-01-01'
				}
			}),
			201
		);
		await data(
			await T('/transactions', {
				method: 'POST',
				json: {
					accountId: account.id,
					bookedOn: '2026-10-10',
					amountCents: 4200,
					counterparty: 'Eltern',
					purpose: 'Sommerlager'
				}
			}),
			201
		);
		const list = await tasks();
		const open = list.find((t) => t.kind === 'unallocated')!;
		expect(open).toMatchObject({ count: 1, cents: 4200, tab: 'transactions', severity: 'warning' });
		// Reihenfolge: critical → warning → info
		const order = list.map((t) => t.severity);
		expect(order).toEqual([...order].sort((a, b) => 'cwi'.indexOf(a[0]!) - 'cwi'.indexOf(b[0]!)));
	});
});
