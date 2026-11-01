/**
 * Übersicht – Quelle `actions` (`ModuleDefinition.dashboard`): offene Abrechnungen nur mit Bearbeiten-Zugriff,
 * Rückzahlungs-Wahl nur zu eigenen/verknüpften Anmeldungen mit laufender Frist, Wochenstreifen mit sichtbaren
 * Aktionen und eigenen Anmeldungen (mehrtägig überlappend ja, außerhalb nein), Modul aus → nichts.
 * Heute = Mittwoch 2026-06-03, Woche 2026-06-01 … 2026-06-07.
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
import { getDb, schema } from '$testing';
import { collectDashboardFeed } from '$testing';
import { core } from '$lib/sdk/server';
import { setTodayForTests } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import { linkTokenValues } from '$modules/actions/link-tokens';
import type { RequestContext } from '$lib/sdk/types';

const TODAY = '2026-06-03';
const PW = 'dashboard-actions-pw-1';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const memberIds: Record<string, string> = {};
const actionIds: Record<string, string> = {};
const partIds: Record<string, string> = {};

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
const adb = () => core.database.forModule('actions');
async function exec(q: ReturnType<typeof sql>) {
	await adb().transaction(async (tx) => {
		await tx.execute(q);
	});
}

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
}

async function mkMember(firstName: string) {
	const id = crypto.randomUUID();
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO members (id, first_name, last_name, birth_date, street, postal_code, city, stage)
				VALUES (${id}, ${firstName}, 'Muster', '2013-05-17', 'Musterweg 1', '28195', 'Bremen', 'pfadfinder')`
		);
	});
	memberIds[firstName] = id;
}

async function mkAction(
	key: string,
	owner: string,
	startsOn: string,
	endsOn: string | null,
	times: { start?: string; end?: string } = {}
) {
	const id = crypto.randomUUID();
	actionIds[key] = id;
	await exec(
		sql`INSERT INTO actions (id, name, location, starts_on, starts_time, ends_on, ends_time, owner_id)
			VALUES (${id}, ${`Aktion ${key}`}, 'Zeltplatz', ${startsOn}::date, ${times.start ?? null},
				${endsOn}::date, ${times.end ?? null}, ${userIds[owner]!})`
	);
}

async function participant(
	key: string,
	actionKey: string,
	who: { member?: string; user?: string }
) {
	const id = crypto.randomUUID();
	partIds[key] = id;
	await exec(
		sql`INSERT INTO action_participants (id, action_id, name, role, member_id, user_id)
			VALUES (${id}, ${actionIds[actionKey]!}, ${key}, 'participant',
				${who.member ? memberIds[who.member]! : null}, ${who.user ? userIds[who.user]! : null})`
	);
}

async function booking(actionKey: string, deadline: string | null) {
	await exec(
		sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents, paying_count, remainder_cents, choice_deadline)
			VALUES (${actionIds[actionKey]!}, NULL, 10000, 2000, 5, 0, ${deadline}::date)`
	);
}

async function refundItem(
	actionKey: string,
	partKey: string | null,
	opts: { token?: boolean; decided?: boolean } = {}
) {
	const id = crypto.randomUUID();
	const t = opts.token === false ? null : linkTokenValues(`tok${id.replace(/-/g, '')}`);
	await exec(
		sql`INSERT INTO accounting_refunds (id, action_id, participant_id, name, amount_cents, token_hash, token_enc, decided_at)
			VALUES (${id}, ${actionIds[actionKey]!}, ${partKey ? partIds[partKey]! : null}, ${partKey ?? 'Manuell'}, 2000,
				${t?.hash ?? null}, ${t?.enc ?? null}, ${opts.decided ? sql`now()` : sql`NULL`})`
	);
	return id;
}

async function feed(who: string) {
	const f = await collectDashboardFeed(await ctxOf(userIds[who]!), { today: TODAY });
	return {
		todos: f.todos.filter((t) => t.moduleId === 'actions'),
		agenda: f.agenda.filter((a) => a.moduleId === 'actions'),
		failed: f.failed
	};
}

let refundOpen: string;

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
	userIds.admin = u!.id;
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	setTodayForTests(TODAY);

	await mkUser('leiter', ['actions.action.view', 'actions.own.view']);
	await mkUser('fremd', ['actions.action.view', 'actions.own.view']);
	await mkUser('eltern', ['actions.own.view']);
	await mkUser('norecht', ['core.api.manage']);

	await mkMember('Lena');
	await mkMember('Ole');
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${memberIds.Lena!}, ${userIds.eltern!}, 'Mutter')`
		);
	});

	// Abrechnung offen (vorbei), abgeschlossen, Zukunft
	await mkAction('vorbei', 'leiter', '2026-05-01', '2026-05-03');
	await mkAction('abgeschlossen', 'leiter', '2026-04-01', null);
	await exec(
		sql`INSERT INTO action_accounting (action_id, closed_at, closed_by) VALUES (${actionIds.abgeschlossen!}, now(), ${userIds.leiter!})`
	);
	await mkAction('zukunft', 'leiter', '2026-07-01', '2026-07-05');
	// Fremd: mit Bearbeiten-/Lese-Freigabe
	await mkAction('geteiltEdit', 'admin', '2026-05-10', null);
	await mkAction('geteiltRead', 'admin', '2026-05-11', null);
	// Woche: mehrtägig überlappend mit Uhrzeiten, eintägig in der Woche, danach
	await mkAction('woche', 'leiter', '2026-05-30', '2026-06-02', { start: '09:00', end: '16:00' });
	await mkAction('freitag', 'admin', '2026-06-05', null);
	await mkAction('danach', 'leiter', '2026-06-08', '2026-06-09');
	await exec(
		sql`INSERT INTO action_shares (action_id, principal_type, principal_id, level) VALUES
			(${actionIds.geteiltEdit!}, 'user', ${userIds.fremd!}, 'edit'),
			(${actionIds.geteiltRead!}, 'user', ${userIds.fremd!}, 'read'),
			(${actionIds.freitag!}, 'user', ${userIds.fremd!}, 'read')`
	);

	// Anmeldungen: Lena (Kind von eltern) bei „woche“ und „vorbei“, Ole fremd
	await participant('LenaWoche', 'woche', { member: 'Lena' });
	await participant('LenaVorbei', 'vorbei', { member: 'Lena' });
	await participant('OleVorbei', 'vorbei', { member: 'Ole' });
	await participant('LenaEntschieden', 'vorbei', { user: 'eltern' });
	await participant('LenaOhneLink', 'vorbei', { user: 'eltern' });
	await booking('vorbei', '2026-06-10');
	refundOpen = await refundItem('vorbei', 'LenaVorbei');
	await refundItem('vorbei', 'OleVorbei');
	await refundItem('vorbei', 'LenaEntschieden', { decided: true });
	await refundItem('vorbei', 'LenaOhneLink', { token: false });
	// Frist abgelaufen
	await mkAction('altfrist', 'admin', '2026-04-10', null);
	await participant('LenaAlt', 'altfrist', { member: 'Lena' });
	await booking('altfrist', '2026-06-02');
	await refundItem('altfrist', 'LenaAlt');
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Zu erledigen', () => {
	it('offene Abrechnungen nur mit Bearbeiten-Zugriff', async () => {
		const leiter = await feed('leiter');
		const acc = leiter.todos.filter((t) => t.id.startsWith('accounting:'));
		// „woche“ endete gestern → ebenfalls abzurechnen; „abgeschlossen“/„zukunft“ nicht
		expect(acc.map((t) => t.id)).toEqual([
			`accounting:${actionIds.vorbei}`,
			`accounting:${actionIds.woche}`
		]);
		expect(acc[0]).toMatchObject({
			title: 'Abrechnung Aktion vorbei abschließen',
			detail: 'Aktion endete am 3.5.',
			severity: 'due',
			action: { label: 'Abrechnen', href: `/modules/actions/${actionIds.vorbei}?tab=accounting` }
		});

		const fremd = await feed('fremd');
		expect(fremd.todos.map((t) => t.id)).toEqual([`accounting:${actionIds.geteiltEdit}`]);
		expect(fremd.failed).toEqual([]);
	});

	it('Rückzahlungs-Wahl nur für eigene Anmeldungen mit laufender Frist und Link', async () => {
		const eltern = await feed('eltern');
		expect(eltern.todos).toHaveLength(1);
		const t = eltern.todos[0]!;
		expect(t.id).toBe(`refund:${refundOpen}`);
		expect(t).toMatchObject({ severity: 'info', due: '2026-06-10', amountCents: 2000 });
		expect(t.title).toBe('Rückzahlung Aktion vorbei: spenden oder auszahlen?');
		expect(t.action.href).toMatch(/^\/p\/actions\/rueckzahlung\/tok[0-9a-f]+$/);

		// Leitung ohne eigene Anmeldung: keine Rückzahlungs-Zeile
		expect((await feed('leiter')).todos.some((x) => x.id.startsWith('refund:'))).toBe(false);
	});

	it('ohne Recht nichts', async () => {
		const f = await feed('norecht');
		expect(f.todos).toEqual([]);
		expect(f.agenda).toEqual([]);
	});
});

describe('Diese Woche', () => {
	it('sichtbare Aktionen im Zeitraum, mehrtägige überlappend, außerhalb nicht', async () => {
		const leiter = await feed('leiter');
		expect(leiter.agenda.map((a) => a.id)).toEqual([`action:${actionIds.woche}`]);
		expect(leiter.agenda[0]).toMatchObject({
			kind: 'action',
			title: 'Aktion woche',
			date: '2026-05-30',
			endDate: '2026-06-02',
			startTime: '09:00',
			endTime: '16:00',
			detail: 'Zeltplatz',
			href: `/modules/actions/${actionIds.woche}`
		});

		const fremd = await feed('fremd');
		expect(fremd.agenda.map((a) => a.id)).toEqual([`action:${actionIds.freitag}`]);
	});

	it('eigene Anmeldungen ohne Zugriff auf die Aktion: ohne Aktionslink', async () => {
		const eltern = await feed('eltern');
		expect(eltern.agenda).toHaveLength(1);
		expect(eltern.agenda[0]).toMatchObject({
			id: `action:${actionIds.woche}`,
			detail: 'Zeltplatz · Angemeldet: LenaWoche',
			href: '/dashboard'
		});
	});
});

describe('Modul deaktiviert', () => {
	it('liefert nichts', async () => {
		await disableModule(admin, 'actions');
		try {
			for (const who of ['leiter', 'eltern']) {
				const f = await feed(who);
				expect(f.todos).toEqual([]);
				expect(f.agenda).toEqual([]);
			}
		} finally {
			await enableModule(admin, 'actions');
		}
	});
});
