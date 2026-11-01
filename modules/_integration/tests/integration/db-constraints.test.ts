/**
 * #73 Datenbank-Rückhalt: CHECKs der Termine (07-11, Migration events/0003 inkl. Bereinigung des
 * Altbestands) und Indizes der Lagerbewegungen (07-10, Migration orders/0003).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, runModuleMigrations, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { getDb, schema } from '$testing';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import ordersModule from '$modules/orders/module';

let close: () => Promise<void>;

const q = async (query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as Record<string, unknown>[];

const insertEvent = (cols: string, values: string) =>
	q(
		sql.raw(
			`INSERT INTO mod_events.events (id, title, starts_on, owner_id${cols ? ', ' + cols : ''})
			 VALUES ('${crypto.randomUUID()}', 'T', '2026-05-10', 'u'${values ? ', ' + values : ''})`
		)
	);

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	registerModule(ordersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'Sehr-Sicheres-Passwort-1');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	const admin = (await contextForUser(u!.id))!.ctx;
	await enableModule(admin, 'members');
	await enableModule(admin, 'orders');
	// events: erst bis 0002, Altbestand mit ungültigen Werten, dann 0003 (Bereinigung + VALIDATE)
	await runModuleMigrations('events', undefined, {
		only: new Set(['0001_init', '0002_recurrence'])
	});
	await q(sql`INSERT INTO mod_events.events (id, title, starts_on, starts_at, ends_on, ends_at, owner_id) VALUES
		('legacy-1', 'Alt', '2026-05-10', '25:00', NULL, NULL, 'u'),
		('legacy-2', 'Alt', '2026-05-10', NULL, '2026-05-01', NULL, 'u'),
		('legacy-3', 'Alt', '2026-05-10', NULL, NULL, '10:00', 'u'),
		('legacy-4', 'Alt', '2026-05-10', '12:00', '2026-05-10', '09:00', 'u'),
		('legacy-5', 'Alt', '2026-05-10', '99:99', '2026-05-01', '7 Uhr', 'u'),
		('legacy-ok', 'Alt', '2026-05-10', '09:00', '2026-05-11', '08:00', 'u')`);
	await enableModule(admin, 'events');
});

afterAll(async () => {
	await close();
});

describe('events: CHECKs (Migration 0003)', () => {
	it('bereinigt ungültigen Altbestand und lässt gültige Zeilen unverändert', async () => {
		const rows = await q(
			sql`SELECT id, starts_at, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, ends_at
				FROM mod_events.events WHERE id LIKE 'legacy-%' ORDER BY id`
		);
		expect(rows).toEqual([
			{ id: 'legacy-1', starts_at: null, ends_on: null, ends_at: null },
			{ id: 'legacy-2', starts_at: null, ends_on: null, ends_at: null },
			{ id: 'legacy-3', starts_at: null, ends_on: null, ends_at: null },
			{ id: 'legacy-4', starts_at: '12:00', ends_on: '2026-05-10', ends_at: null },
			// mehrere ungültige Werte in einer Zeile (Bereinigung läuft vor dem Anlegen der CHECKs)
			{ id: 'legacy-5', starts_at: null, ends_on: null, ends_at: null },
			{ id: 'legacy-ok', starts_at: '09:00', ends_on: '2026-05-11', ends_at: '08:00' }
		]);
	});

	it('Constraints sind validiert', async () => {
		const rows = await q(
			sql`SELECT conname, convalidated FROM pg_constraint
				WHERE conrelid = 'mod_events.events'::regclass AND contype = 'c' AND conname LIKE 'events_%_check'
				ORDER BY conname`
		);
		const names = rows.map((r) => r.conname);
		for (const n of [
			'events_ends_at_check',
			'events_ends_on_check',
			'events_same_day_time_check',
			'events_starts_at_check'
		]) {
			expect(names).toContain(n);
		}
		expect(rows.every((r) => r.convalidated === true)).toBe(true);
	});

	it.each([
		['Uhrzeit im falschen Format', 'starts_at', "'9:00'"],
		['Uhrzeit 24:00', 'starts_at', "'24:00'"],
		['Enduhrzeit ohne Enddatum', 'ends_at', "'10:00'"],
		['Ende vor Start', 'ends_on', "'2026-05-09'"],
		[
			'gleicher Tag, Ende vor Beginn',
			'starts_at, ends_on, ends_at',
			"'12:00', '2026-05-10', '11:59'"
		]
	])('weist per Roh-SQL ab: %s', async (_label, cols, values) => {
		const err = await insertEvent(cols, values).then(
			() => null,
			(e: unknown) => e as { message?: string; cause?: { message?: string } }
		);
		expect(String(err?.cause?.message ?? err?.message)).toMatch(/check constraint/i);
	});

	it('nimmt gültige Werte per Roh-SQL an', async () => {
		await insertEvent('starts_at, ends_on, ends_at', "'12:00', '2026-05-10', '12:00'");
		await insertEvent('', '');
	});
});

describe('orders: Indizes auf Lagerbewegungen (Migration 0003)', () => {
	it('legt die Indizes an', async () => {
		const rows = await q(
			sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'mod_orders' AND tablename = 'stock_movements'`
		);
		const names = rows.map((r) => r.indexname);
		expect(names).toContain('stock_movements_order_item_idx');
		expect(names).toContain('stock_movements_supplier_item_idx');
	});
});
