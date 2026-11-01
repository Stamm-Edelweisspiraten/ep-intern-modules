/**
 * Aktionen – Dashboard-Endpunkte: `GET /my/registrations` (kommende Anmeldungen des Kontos und der
 * verknüpften Mitglieder) und `GET /accounting/open` (vergangene Aktionen mit Bearbeiten-Zugriff und
 * offener Abrechnung). Daten werden direkt in der DB angelegt; geprüft werden Filter, Sortierung,
 * Zähler, Zugriff (nur eigene/verknüpfte bzw. edit), 403 ohne Recht und Modul deaktiviert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { MyRegistration, OpenAccounting } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'actions-my-password-1';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
const memberIds: Record<string, string> = {};
const actionIds: Record<string, string> = {};

function api(path: string, who: string) {
	resetAllForTests();
	const url = new URL(`http://localhost:5173/api/v1/modules/actions${path}`);
	return handleApiRequest({
		request: new Request(url, { headers: { authorization: `Bearer ${keys[who]}` } }),
		url,
		ip: '127.0.0.1'
	});
}

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

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

async function mkMember(firstName: string) {
	const res = await data<{ id: string }>(
		await (async () => {
			resetAllForTests();
			const url = new URL('http://localhost:5173/api/v1/modules/members/members');
			return handleApiRequest({
				request: new Request(url, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${keys.admin}`,
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						firstName,
						lastName: 'Muster',
						birthDate: '2013-05-17',
						street: 'Musterweg 1',
						postalCode: '28195',
						city: 'Bremen',
						stage: 'pfadfinder'
					})
				}),
				url,
				ip: '127.0.0.1'
			});
		})(),
		201
	);
	memberIds[firstName] = res.id;
}

const adb = () => core.database.forModule('actions');

interface ActionSeed {
	key: string;
	name: string;
	owner: string;
	startsOn: string;
	endsOn?: string | null;
	startsTime?: string | null;
	location?: string | null;
	feeCents?: number | null;
	teamFeeCents?: number | null;
	isPast?: boolean;
}

async function mkAction(a: ActionSeed) {
	const id = crypto.randomUUID();
	actionIds[a.key] = id;
	await adb().transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO actions (id, name, location, starts_on, starts_time, ends_on, owner_id, fee_cents, team_fee_cents, is_past)
				VALUES (${id}, ${a.name}, ${a.location ?? null}, ${a.startsOn}::date, ${a.startsTime ?? null},
					${a.endsOn ?? null}::date, ${userIds[a.owner]!}, ${a.feeCents ?? null}, ${a.teamFeeCents ?? null}, ${a.isPast ?? false})`
		);
	});
}

async function participant(
	actionKey: string,
	name: string,
	who: { memberId?: string; userId?: string },
	role: 'participant' | 'team' = 'participant'
) {
	await adb().transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO action_participants (id, action_id, name, role, member_id, user_id)
				VALUES (${crypto.randomUUID()}, ${actionIds[actionKey]!}, ${name}, ${role}, ${who.memberId ?? null}, ${who.userId ?? null})`
		);
	});
}

async function exec(q: ReturnType<typeof sql>) {
	await adb().transaction(async (tx) => {
		await tx.execute(q);
	});
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
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
	for (const m of ['members', 'actions']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	userIds.admin = u!.id;
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setTodayForTests('2026-06-01');

	await mkUser('eltern', ['core.api.manage', 'actions.own.view']);
	await mkUser('leiter', ['core.api.manage', 'actions.action.view', 'actions.own.view']);
	await mkUser('norecht', ['core.api.manage']);

	await mkMember('Lena');
	await mkMember('Ole');
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${memberIds.Lena!}, ${userIds.eltern!}, 'Mutter')`
		);
	});

	// Anmeldungen (heute = 2026-06-01)
	await mkAction({
		key: 'sommer',
		name: 'Sommerlager',
		owner: 'leiter',
		startsOn: '2026-07-10',
		endsOn: '2026-07-20',
		startsTime: '09:00',
		location: 'Dänemark',
		feeCents: 15000,
		teamFeeCents: 5000
	});
	await mkAction({
		key: 'laufend',
		name: 'Pfingstlager',
		owner: 'admin',
		startsOn: '2026-05-30',
		endsOn: '2026-06-02'
	});
	await mkAction({
		key: 'vorbei',
		name: 'Frühjahrsfahrt',
		owner: 'leiter',
		startsOn: '2026-05-01',
		endsOn: '2026-05-03'
	});
	await mkAction({
		key: 'nachgetragen',
		name: 'Nachgetragen',
		owner: 'admin',
		startsOn: '2026-08-01',
		isPast: true
	});
	await mkAction({ key: 'fremd', name: 'Fremde Fahrt', owner: 'admin', startsOn: '2026-07-01' });

	await participant('sommer', 'Lena Muster', { memberId: memberIds.Lena! });
	await participant('sommer', 'Eltern Selbst', { userId: userIds.eltern! }, 'team');
	await participant('sommer', 'Ole Muster', { memberId: memberIds.Ole! });
	await participant('laufend', 'Lena Muster', { memberId: memberIds.Lena! });
	await participant('vorbei', 'Lena Muster', { memberId: memberIds.Lena! });
	await participant('nachgetragen', 'Lena Muster', { memberId: memberIds.Lena! });
	await participant('fremd', 'Ole Muster', { memberId: memberIds.Ole! });

	// Abrechnungen: „vorbei“ (leiter, offen, mit Buchungen), „geteilt-edit“, „geteilt-read“,
	// „abgeschlossen“ (leiter), „heute“ (leiter, endet heute)
	await mkAction({
		key: 'geteiltEdit',
		name: 'Geteilt Bearbeiten',
		owner: 'admin',
		startsOn: '2026-04-01'
	});
	await mkAction({
		key: 'geteiltRead',
		name: 'Geteilt Lesen',
		owner: 'admin',
		startsOn: '2026-03-01'
	});
	await mkAction({
		key: 'abgeschlossen',
		name: 'Abgeschlossen',
		owner: 'leiter',
		startsOn: '2026-02-01'
	});
	await mkAction({ key: 'heute', name: 'Endet heute', owner: 'leiter', startsOn: '2026-06-01' });
	await exec(
		sql`INSERT INTO action_shares (action_id, principal_type, principal_id, level) VALUES
			(${actionIds.geteiltEdit!}, 'user', ${userIds.leiter!}, 'edit'),
			(${actionIds.geteiltRead!}, 'user', ${userIds.leiter!}, 'read')`
	);
	await exec(
		sql`INSERT INTO action_accounting (action_id, closed_at, closed_by) VALUES (${actionIds.abgeschlossen!}, now(), ${userIds.leiter!})`
	);
	const payee = crypto.randomUUID();
	const vorbei = actionIds.vorbei!;
	await exec(
		sql`INSERT INTO accounting_payees (id, action_id, name) VALUES (${payee}, ${vorbei}, 'Tessa')`
	);
	await exec(
		sql`INSERT INTO accounting_entries (id, action_id, type, category, description, amount_cents, entry_date, paid_by, payee_id, receipt_path)
			VALUES
			(${crypto.randomUUID()}, ${vorbei}, 'expense', 'food', 'Einkauf', 5000, '2026-05-02', 'club', NULL, NULL),
			(${crypto.randomUUID()}, ${vorbei}, 'expense', 'travel', 'Bahn', 3000, '2026-05-02', 'person', ${payee}, 'x/beleg.pdf'),
			(${crypto.randomUUID()}, ${vorbei}, 'expense', 'materials', 'Seile', 1000, '2026-05-02', 'person', ${payee}, NULL),
			(${crypto.randomUUID()}, ${vorbei}, 'income', 'misc', 'Spende', 2000, '2026-05-02', 'club', NULL, NULL)`
	);
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('GET /my/registrations', () => {
	it('kommende Anmeldungen von Konto und verknüpften Mitgliedern, nach Start sortiert', async () => {
		const list = await data<MyRegistration[]>(await api('/my/registrations', 'eltern'));
		expect(list.map((r) => r.name)).toEqual(['Pfingstlager', 'Sommerlager']);
		const [laufend, sommer] = list;
		expect(laufend).toMatchObject({
			actionId: actionIds.laufend,
			startsOn: '2026-05-30',
			endsOn: '2026-06-02',
			people: ['Lena Muster'],
			feeCents: null
		});
		// Fremde Teilnehmende (Ole) erscheinen nicht; Team zahlt den Team-Beitrag
		expect(sommer).toEqual({
			actionId: actionIds.sommer,
			name: 'Sommerlager',
			startsOn: '2026-07-10',
			endsOn: '2026-07-20',
			startsTime: '09:00',
			endsTime: null,
			location: 'Dänemark',
			people: ['Eltern Selbst', 'Lena Muster'],
			feeCents: 15000 + 5000
		});
		expect(JSON.stringify(list)).not.toContain('Ole');
	});

	it('ohne eigene Anmeldungen leer', async () => {
		expect(await data<MyRegistration[]>(await api('/my/registrations', 'leiter'))).toEqual([]);
	});

	it('ohne actions.own.view 403', async () => {
		expect((await api('/my/registrations', 'norecht')).status).toBe(403);
	});
});

describe('GET /accounting/open', () => {
	it('nur vergangene, offene Abrechnungen mit Bearbeiten-Zugriff, älteste zuerst, mit Zählern', async () => {
		const list = await data<OpenAccounting[]>(await api('/accounting/open', 'leiter'));
		expect(list.map((a) => a.name)).toEqual([
			'Geteilt Bearbeiten',
			'Frühjahrsfahrt',
			'Endet heute'
		]);
		expect(list[1]).toEqual({
			actionId: actionIds.vorbei,
			name: 'Frühjahrsfahrt',
			endsOn: '2026-05-03',
			entryCount: 4,
			missingReceipts: 2,
			openReimbursements: 2
		});
		expect(list[0]).toMatchObject({ endsOn: '2026-04-01', entryCount: 0, missingReceipts: 0 });
	});

	it('edit-all sieht alle offenen vergangenen Abrechnungen (ohne abgeschlossene)', async () => {
		const list = await data<OpenAccounting[]>(await api('/accounting/open', 'admin'));
		expect(list.map((a) => a.name)).toEqual([
			'Geteilt Lesen',
			'Geteilt Bearbeiten',
			'Frühjahrsfahrt',
			'Endet heute'
		]);
	});

	it('ohne actions.action.view 403', async () => {
		expect((await api('/accounting/open', 'eltern')).status).toBe(403);
	});
});

describe('Modul deaktiviert', () => {
	it('→ 404 module_disabled', async () => {
		await disableModule(admin, 'actions');
		try {
			for (const path of ['/my/registrations', '/accounting/open']) {
				const res = await api(path, 'leiter');
				expect(res.status).toBe(404);
				expect((await res.json()).error.code).toBe('module_disabled');
			}
		} finally {
			await enableModule(admin, 'actions');
		}
	});
});
