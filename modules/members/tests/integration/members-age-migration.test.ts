/**
 * #64: Upgrade-Test members 0017 – Freitext-Altersangaben der Gruppen werden zu Zahlen (von/bis),
 * nach denselben Regeln wie `messages/age-range.ts` (`parseAgeRange`); nicht lesbare Texte bleiben ohne Zahlen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { migrateModuleRest, migrateModuleTo, moduleSql } from '$testing';
import { registerModule } from '$testing';
import membersModule from '$modules/members/module';
import { parseAgeRange } from '$modules/messages/age-range';

let close: () => Promise<void>;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerModule(membersModule);
});

afterAll(async () => {
	await close();
});

const CASES: [string, string | null][] = [
	['g1', '6 bis 10 Jahre'],
	['g2', '11–14'],
	['g3', 'ab 15 Jahren'],
	['g4', 'bis 10'],
	['g5', 'für alle'],
	['g6', '16+'],
	['g7', 'Über 12 Jahre'],
	['g8', 'unter 10'],
	['g9', '12 Jahre'],
	['g10', '10 - 7'],
	['g11', null]
];

describe('members 0017_group_age', () => {
	it('liest die Freitext-Altersangaben wie parseAgeRange', async () => {
		await migrateModuleTo('members', '0016_leader_users');
		for (const [id, text] of CASES) {
			await moduleSql(
				'members',
				sql`INSERT INTO groups (id, name, type, age_range) VALUES (${id}, ${`Gruppe ${id}`}, 'sippe', ${text})`
			);
		}
		expect(await migrateModuleTo('members', '0017_group_age')).toEqual(['0017_group_age']);
		const rows = await moduleSql(
			'members',
			sql`SELECT id, age_range, age_min, age_max FROM groups ORDER BY id`
		);
		for (const [id, text] of CASES) {
			const row = rows.find((r) => r.id === id)!;
			const expected = parseAgeRange(text) ?? { min: null, max: null };
			expect({ id, min: row.age_min, max: row.age_max }).toEqual({
				id,
				min: expected.min,
				max: expected.max
			});
			// Anzeigetext bleibt unverändert, bis die Gruppe neu gespeichert wird
			expect(row.age_range).toBe(text);
		}
		// Bis < von wird abgelehnt
		await expect(
			moduleSql(
				'members',
				sql`INSERT INTO groups (id, name, type, age_min, age_max) VALUES ('bad', 'Kaputt', 'meute', 10, 6)`
			)
		).rejects.toThrow();
		await migrateModuleRest('members');
	});
});
