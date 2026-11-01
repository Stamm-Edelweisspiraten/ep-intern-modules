/**
 * Übersicht – Quelle `material` (`ModuleDefinition.dashboard`): „Zu erledigen“ nur für Lager-Verwaltende
 * (gemeldete Schäden, in 7 Tagen beginnende, noch nicht ausgegebene Reservierungen), Wochenstreifen mit
 * eigenen Reservierungen bzw. allen für Verwaltende (Zeitraum überlappend, storniert nie), Modul aus → nichts.
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
import materialModule from '$modules/material/module';
import type { RequestContext } from '$lib/sdk/types';

const TODAY = '2026-06-03';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const resIds: Record<string, string> = {};
const TYPE = crypto.randomUUID();
let codeNo = 0;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
async function exec(q: ReturnType<typeof sql>) {
	await core.database.forModule('material').transaction(async (tx) => {
		await tx.execute(q);
	});
}

async function mkItem(condition: string, archived = false) {
	codeNo++;
	await exec(
		sql`INSERT INTO items (id, type_id, name, code, condition, condition_reported_at, archived_at)
			VALUES (${crypto.randomUUID()}, ${TYPE}, ${`Kohtenbahn ${codeNo}`}, ${`M-9${String(codeNo).padStart(5, '0')}`},
				${condition}, now(), ${archived ? sql`now()` : sql`NULL`})`
	);
}

async function mkReservation(
	key: string,
	owner: string,
	startsOn: string,
	endsOn: string,
	opts: { cancelled?: boolean; handedOut?: boolean; quantities?: number[] } = {}
) {
	const id = crypto.randomUUID();
	resIds[key] = id;
	await exec(
		sql`INSERT INTO reservations (id, title, starts_on, ends_on, status, created_by, handed_out_at)
			VALUES (${id}, ${`Fahrt ${key}`}, ${startsOn}::date, ${endsOn}::date,
				${opts.cancelled ? 'cancelled' : 'reserved'}, ${userIds[owner]!},
				${opts.handedOut ? sql`now()` : sql`NULL`})`
	);
	let pos = 0;
	for (const q of opts.quantities ?? [1]) {
		await exec(
			sql`INSERT INTO reservation_lines (id, reservation_id, type_id, quantity, position)
				VALUES (${crypto.randomUUID()}, ${id}, ${TYPE}, ${q}, ${pos++})`
		);
	}
}

async function feed(who: string) {
	const f = await collectDashboardFeed(await ctxOf(userIds[who]!), { today: TODAY });
	return {
		todos: f.todos.filter((t) => t.moduleId === 'material'),
		agenda: f.agenda.filter((a) => a.moduleId === 'material'),
		failed: f.failed
	};
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(materialModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'material');
	admin = await ctxOf(u!.id);
	setTodayForTests(TODAY);

	const roles = {
		wart: ['material.inventory.view', 'material.inventory.manage', 'material.reservation.create'],
		anna: ['material.inventory.view', 'material.reservation.create'],
		bert: ['material.inventory.view', 'material.reservation.create'],
		leser: ['material.inventory.view']
	};
	for (const [name, permissions] of Object.entries(roles)) {
		const role = await createRole(admin, { name: `r-${name}`, permissions });
		userIds[name] = await createUser(admin, {
			name,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [role]
		});
	}

	await exec(sql`INSERT INTO types (id, name) VALUES (${TYPE}, 'Kohtenbahn')`);
	await mkItem('damaged');
	await mkItem('defect');
	await mkItem('ok');
	await mkItem('damaged', true);

	await mkReservation('woche', 'anna', '2026-06-05', '2026-06-06', { quantities: [3, 1] });
	await mkReservation('ueberlappend', 'bert', '2026-05-28', '2026-06-01');
	await mkReservation('spaeter', 'anna', '2026-06-15', '2026-06-16');
	await mkReservation('storniert', 'anna', '2026-06-04', '2026-06-04', { cancelled: true });
	await mkReservation('ausgegeben', 'bert', '2026-06-09', '2026-06-09', { handedOut: true });
	await mkReservation('grenze', 'bert', '2026-06-10', '2026-06-12');
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Zu erledigen', () => {
	it('Verwaltung: anstehende Reservierungen und Schäden', async () => {
		const f = await feed('wart');
		expect(f.failed).toEqual([]);
		expect(f.todos.map((t) => t.id)).toEqual(['prepare', 'damages']);
		expect(f.todos[0]).toMatchObject({
			title: '2 Reservierungen vorbereiten',
			due: '2026-06-05',
			severity: 'due',
			action: { href: '/modules/material?tab=meine' }
		});
		expect(f.todos[0]!.detail).toContain('Fahrt woche, Fahrt grenze');
		expect(f.todos[1]).toMatchObject({
			title: '2 Schäden gemeldet',
			action: { label: 'Prüfen', href: '/modules/material?tab=lager' }
		});
	});

	it('ohne Lager-Verwaltung keine Zeilen', async () => {
		expect((await feed('anna')).todos).toEqual([]);
		expect((await feed('leser')).todos).toEqual([]);
	});

	it('nichts zu tun → keine Zeilen', async () => {
		await exec(sql`UPDATE items SET condition = 'ok'`);
		await exec(sql`UPDATE reservations SET handed_out_at = now()`);
		try {
			expect((await feed('wart')).todos).toEqual([]);
		} finally {
			await exec(sql`UPDATE items SET condition = 'damaged' WHERE name = 'Kohtenbahn 1'`);
			await exec(
				sql`UPDATE reservations SET handed_out_at = NULL WHERE id <> ${resIds.ausgegeben!}`
			);
		}
	});
});

describe('Diese Woche', () => {
	it('eigene Reservierungen im Zeitraum', async () => {
		const f = await feed('anna');
		expect(f.agenda).toEqual([
			{
				id: `reservation:${resIds.woche}`,
				moduleId: 'material',
				kind: 'material',
				title: 'Material: Fahrt woche',
				date: '2026-06-05',
				endDate: '2026-06-06',
				startTime: null,
				endTime: null,
				detail: '4 Artikel',
				href: `/modules/material?tab=meine&open=${resIds.woche}`,
				late: undefined
			}
		]);
		expect((await feed('bert')).agenda.map((a) => a.id)).toEqual([
			`reservation:${resIds.ueberlappend}`
		]);
		expect((await feed('leser')).agenda).toEqual([]);
	});

	it('Verwaltung sieht alle (ohne stornierte)', async () => {
		const f = await feed('wart');
		expect(f.agenda.map((a) => a.id)).toEqual([
			`reservation:${resIds.ueberlappend}`,
			`reservation:${resIds.woche}`
		]);
	});
});

describe('Modul deaktiviert', () => {
	it('liefert nichts', async () => {
		await disableModule(admin, 'material');
		try {
			const f = await feed('wart');
			expect(f.todos).toEqual([]);
			expect(f.agenda).toEqual([]);
		} finally {
			await enableModule(admin, 'material');
		}
	});
});
