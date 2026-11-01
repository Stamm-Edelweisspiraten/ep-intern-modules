/**
 * Upgrade-Test actions 0024_refund_donations: gebuchte Rückzahlungen aus der Zeit davor bleiben unverändert
 * (Spende 0, Buchung verknüpft); danach entfernt das Löschen der Buchung nicht mehr den Snapshot
 * (FK `action_refund_booking.entry_id` → SET NULL statt CASCADE).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { migrateModuleRest, migrateModuleTo, moduleSql } from '$testing';
import { registerModule } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';

let close: () => Promise<void>;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerModule(membersModule);
	registerModule(actionsModule);
});

afterAll(async () => {
	await close();
});

describe('actions 0024_refund_donations', () => {
	it('Bestand: keine Spende, Buchung bleibt verknüpft; Spende über den Anteil hinaus verboten', async () => {
		await migrateModuleTo('actions', '0023_subsidy_application');
		await moduleSql(
			'actions',
			sql`INSERT INTO actions (id, name, starts_on, owner_id)
				VALUES ('a1', 'Altlager', '2025-07-01', 'u1')`
		);
		await moduleSql(
			'actions',
			sql`INSERT INTO accounting_entries (id, action_id, type, category, description, amount_cents,
					entry_date, paid_by)
				VALUES ('e1', 'a1', 'expense', 'refund', 'Rückzahlung an Teilnehmende (2 × 50 €)', 10000,
					'2025-08-01', 'club')`
		);
		await moduleSql(
			'actions',
			sql`INSERT INTO accounting_refunds (id, action_id, entry_id, participant_id, name, amount_cents, position)
				VALUES ('r1', 'a1', 'e1', NULL, 'Anna', 5000, 0), ('r2', 'a1', 'e1', NULL, 'Bert', 5000, 1)`
		);
		await moduleSql(
			'actions',
			sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents,
					paying_count, remainder_cents, mode)
				VALUES ('a1', 'e1', 10000, 5000, 2, 0, 'auto')`
		);

		expect(await migrateModuleRest('actions')).toContain('0024_refund_donations');

		const items = await moduleSql(
			'actions',
			sql`SELECT id, donated_cents, decided_via, token_hash, entry_id FROM accounting_refunds ORDER BY id`
		);
		expect(items.map((r) => Number(r.donated_cents))).toEqual([0, 0]);
		expect(items.every((r) => r.decided_via == null && r.token_hash == null)).toBe(true);
		expect(items.every((r) => r.entry_id === 'e1')).toBe(true);

		await expect(
			moduleSql('actions', sql`UPDATE accounting_refunds SET donated_cents = 6000 WHERE id = 'r1'`)
		).rejects.toThrow();
		await expect(
			moduleSql('actions', sql`UPDATE accounting_refunds SET donated_cents = 2550 WHERE id = 'r1'`)
		).rejects.toThrow();
		await moduleSql(
			'actions',
			sql`UPDATE accounting_refunds SET donated_cents = 5000 WHERE id = 'r1'`
		);

		// Buchung weg (alles gespendet) → Snapshot bleibt, Verweise werden NULL
		await moduleSql('actions', sql`DELETE FROM accounting_entries WHERE id = 'e1'`);
		const booking = await moduleSql(
			'actions',
			sql`SELECT entry_id FROM action_refund_booking WHERE action_id = 'a1'`
		);
		expect(booking).toHaveLength(1);
		expect(booking[0]!.entry_id).toBeNull();
	});
});
