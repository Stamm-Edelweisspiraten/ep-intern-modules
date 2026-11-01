/**
 * #64: Upgrade-Tests mit Bestandsdaten (Muster `module-data-migrations.test.ts`, eigene Datenbank, weil
 * dort `members`/`treasury` schon vollständig migriert sind):
 * - members 0012: `use_count` = Verknüpfungen seit Erzeugung des Codes (inkl. manueller), `max_uses` leer
 * - treasury 0008: doppelte automatische Erinnerungen gleicher Stufe → die späteren gelten als manuell,
 *   danach greift der Unique-Index; Bestand gilt als zugestellt (`status = 'sent'`)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { migrateModuleRest, migrateModuleTo, moduleSql } from '$testing';
import { registerModule } from '$testing';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import treasuryModule from '$modules/treasury/module';

let close: () => Promise<void>;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
});

afterAll(async () => {
	await close();
});

describe('members 0012_link_code_uses', () => {
	it('zählt Verknüpfungen seit Erzeugung des Codes als Nutzung', async () => {
		await migrateModuleTo('members', '0011_stage_jungpfadfinder');
		await moduleSql(
			'members',
			sql`INSERT INTO members (id, first_name, last_name, birth_date, stage) VALUES
				('m1', 'Ada', 'Alt', '2014-03-01', 'woelfling'),
				('m2', 'Bo', 'Bestand', '2012-07-15', 'knappe'),
				('m3', 'Cleo', 'Ohne', '2015-01-01', 'woelfling')`
		);
		// m1: Code vom 01.03.; eine Verknüpfung davor (zählt nicht), zwei danach (zählen, auch manuelle)
		// m2: Code ohne Verknüpfung → 0; m3: Verknüpfung ohne Code → keine Zeile
		await moduleSql(
			'members',
			sql`INSERT INTO member_link_codes (member_id, token, code_enc, expires_at, created_at) VALUES
				('m1', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'enc', '2026-06-01T00:00:00Z', '2026-03-01T10:00:00Z'),
				('m2', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'enc', '2026-06-01T00:00:00Z', '2026-03-01T10:00:00Z')`
		);
		await moduleSql(
			'members',
			sql`INSERT INTO member_user_links (member_id, user_id, relation, created_at, created_by) VALUES
				('m1', 'u-vorher', 'Oma', '2026-02-01T10:00:00Z', 'admin'),
				('m1', 'u-mutter', 'Mutter', '2026-03-01T10:00:00Z', NULL),
				('m1', 'u-vater', 'Vater', '2026-03-05T08:00:00Z', 'admin'),
				('m3', 'u-anders', NULL, '2026-03-05T08:00:00Z', NULL)`
		);

		expect(await migrateModuleTo('members', '0012_link_code_uses')).toEqual([
			'0012_link_code_uses'
		]);
		const rows = await moduleSql(
			'members',
			sql`SELECT member_id, use_count, max_uses FROM member_link_codes ORDER BY member_id`
		);
		expect(rows.map((r) => ({ ...r, use_count: Number(r.use_count) }))).toEqual([
			{ member_id: 'm1', use_count: 2, max_uses: null },
			{ member_id: 'm2', use_count: 0, max_uses: null }
		]);

		// Folgemigrationen (u. a. Token-Hash 0014) laufen auf dem Bestand durch, Zähler bleibt
		await migrateModuleRest('members');
		const [m1] = await moduleSql(
			'members',
			sql`SELECT use_count FROM member_link_codes WHERE member_id = 'm1'`
		);
		expect(Number(m1?.use_count)).toBe(2);
	});
});

describe('treasury 0008_reminder_claims', () => {
	it('markiert Alt-Dubletten automatischer Stufen als manuell und legt den Unique-Index an', async () => {
		await migrateModuleTo('treasury', '0007_orders');
		await moduleSql(
			'treasury',
			sql`INSERT INTO invoices (id, number, year, seq, source, recipient_name, issued_on, due_on) VALUES
				('i1', 'R-2026-0001', 2026, 1, 'manual', 'Familie Alt', '2026-01-01', '2026-01-15'),
				('i2', 'R-2026-0002', 2026, 2, 'manual', 'Familie Bestand', '2026-01-01', '2026-01-15')`
		);
		// i1 Stufe 1: drei automatische (parallele Läufe, zwei mit gleichem Zeitpunkt) + eine manuelle
		// i1 Stufe 2: eine automatische; i2 Stufe 1: eine automatische (keine Dublette)
		await moduleSql(
			'treasury',
			sql`INSERT INTO reminders (id, invoice_id, level, sent_at, sent_on, recipients, manual) VALUES
				('r-a', 'i1', 1, '2026-02-01T08:00:00Z', '2026-02-01', 1, false),
				('r-b', 'i1', 1, '2026-02-01T08:00:00Z', '2026-02-01', 1, false),
				('r-c', 'i1', 1, '2026-02-01T08:00:05Z', '2026-02-01', 1, false),
				('r-m', 'i1', 1, '2026-02-03T08:00:00Z', '2026-02-03', 1, true),
				('r-d', 'i1', 2, '2026-02-20T08:00:00Z', '2026-02-20', 1, false),
				('r-e', 'i2', 1, '2026-02-01T08:00:00Z', '2026-02-01', 1, false)`
		);

		expect(await migrateModuleTo('treasury', '0008_reminder_claims')).toEqual([
			'0008_reminder_claims'
		]);
		const rows = await moduleSql(
			'treasury',
			sql`SELECT id, manual, status FROM reminders ORDER BY id`
		);
		expect(rows).toEqual([
			// frühester Eintrag (bei gleichem Zeitpunkt die kleinere ID) bleibt automatisch
			{ id: 'r-a', manual: false, status: 'sent' },
			{ id: 'r-b', manual: true, status: 'sent' },
			{ id: 'r-c', manual: true, status: 'sent' },
			{ id: 'r-d', manual: false, status: 'sent' },
			{ id: 'r-e', manual: false, status: 'sent' },
			{ id: 'r-m', manual: true, status: 'sent' }
		]);

		// Unique-Index wirkt: zweite automatische Stufe 1 für i1 → Fehler, manuelle weiter erlaubt
		await expect(
			moduleSql(
				'treasury',
				sql`INSERT INTO reminders (id, invoice_id, level, sent_on, manual) VALUES ('r-x', 'i1', 1, '2026-03-01', false)`
			)
		).rejects.toThrow();
		await moduleSql(
			'treasury',
			sql`INSERT INTO reminders (id, invoice_id, level, sent_on, manual) VALUES ('r-y', 'i1', 1, '2026-03-01', true)`
		);
		// Neue Reservierungen nur mit gültigem Status
		await expect(
			moduleSql(
				'treasury',
				sql`INSERT INTO reminders (id, invoice_id, level, sent_on, status) VALUES ('r-z', 'i2', 2, '2026-03-01', 'unbekannt')`
			)
		).rejects.toThrow();

		await migrateModuleRest('treasury');
		const [count] = await moduleSql(
			'treasury',
			sql`SELECT count(*) AS n FROM reminders WHERE NOT manual`
		);
		expect(Number(count?.n)).toBe(3);
	});
});
