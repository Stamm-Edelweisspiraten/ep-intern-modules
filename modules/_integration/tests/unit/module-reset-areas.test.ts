import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesDir } from '$testing';
import type { ResetArea } from '$testing';
import * as actionsReset from '$modules/actions/reset';
import * as membersReset from '$modules/members/reset';
import * as treasuryReset from '$modules/treasury/reset';

const MODULES: Record<string, ResetArea[]> = {
	members: membersReset.resetAreas,
	actions: actionsReset.resetAreas,
	treasury: treasuryReset.resetAreas
};

function migrationTables(moduleId: string): Set<string> {
	const dir = join(modulesDir(), moduleId, 'migrations');
	const tables = new Set<string>();
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
		const text = readFileSync(join(dir, file), 'utf8');
		for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
			tables.add(m[1]!.toLowerCase());
		}
	}
	return tables;
}

/** Fremdschlüssel `kind -> eltern` aus den Migrationen (Spalten- und ALTER-TABLE-Definitionen). */
function foreignKeys(moduleId: string): { child: string; parent: string; cascade: boolean }[] {
	const dir = join(modulesDir(), moduleId, 'migrations');
	const out: { child: string; parent: string; cascade: boolean }[] = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
		const text = readFileSync(join(dir, file), 'utf8');
		const re =
			/(CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([a-z_]+)|REFERENCES\s+([a-z_]+)[^,\n;]*?(ON DELETE (CASCADE|SET NULL|RESTRICT))?[,\n;]/gi;
		let current = '';
		for (const m of text.matchAll(re)) {
			if (m[2]) current = m[2].toLowerCase();
			else if (m[3] && current) {
				out.push({
					child: current,
					parent: m[3].toLowerCase(),
					cascade: !!m[5] && m[5] !== 'RESTRICT'
				});
			}
		}
	}
	return out;
}

describe('Reset-Bereiche der Module', () => {
	for (const [moduleId, areas] of Object.entries(MODULES)) {
		describe(moduleId, () => {
			const existing = migrationTables(moduleId);

			it('hat eindeutige, gültige Bereichs-IDs und einen Bereich all mit Neuaufbau', () => {
				const ids = areas.map((a) => a.id);
				expect(new Set(ids).size).toBe(ids.length);
				for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
				const all = areas.find((a) => a.id === 'all');
				expect(all).toBeDefined();
				expect(all!.rebuild).toBe(true);
				expect(all!.storagePrefixes).toBe('all');
			});

			it('nennt nur Tabellen, die in den Migrationen angelegt werden', () => {
				for (const area of areas) {
					for (const table of area.tables) {
						expect(existing, `${moduleId}:${area.id} -> ${table}`).toContain(table);
					}
					expect(new Set(area.tables).size).toBe(area.tables.length);
				}
			});

			it('deckt im Bereich all jede Tabelle des Moduls ab', () => {
				const all = areas.find((a) => a.id === 'all')!;
				expect(new Set(all.tables)).toEqual(existing);
			});

			it('löscht abhängige Tabellen vor ihren Eltern', () => {
				const fks = foreignKeys(moduleId);
				expect(fks.length).toBeGreaterThan(3);
				for (const area of areas) {
					for (const fk of fks) {
						const childIdx = area.tables.indexOf(fk.child);
						const parentIdx = area.tables.indexOf(fk.parent);
						if (childIdx === -1 || parentIdx === -1) continue;
						expect(childIdx, `${moduleId}:${area.id} ${fk.child} -> ${fk.parent}`).toBeLessThan(
							parentIdx
						);
					}
				}
			});

			it('beschreibt jeden Bereich und begründet Abhängigkeiten', () => {
				const known = new Set(
					Object.entries(MODULES).flatMap(([m, list]) => list.map((a) => `${m}:${a.id}`))
				);
				for (const area of areas) {
					expect(area.label.length).toBeGreaterThan(0);
					expect(area.description.length).toBeGreaterThan(20);
					for (const imp of area.implies ?? []) {
						expect(known, `${moduleId}:${area.id} impliziert ${imp.area}`).toContain(imp.area);
						expect(imp.area).not.toBe(`${moduleId}:${area.id}`);
						expect(imp.reason.length).toBeGreaterThan(10);
					}
				}
			});
		});
	}

	it('kennt die erwarteten Bereiche', () => {
		expect(MODULES.members!.map((a) => a.id)).toEqual(['all', 'links']);
		expect(MODULES.actions!.map((a) => a.id)).toEqual(['all', 'accounting', 'participants']);
		expect(MODULES.treasury!.map((a) => a.id)).toEqual([
			'all',
			'transactions',
			'invoices',
			'payables',
			'annual',
			'payers'
		]);
	});

	it('bietet resetUsers in jedem Modul an', () => {
		expect(typeof membersReset.resetUsers).toBe('function');
		expect(typeof actionsReset.resetUsers).toBe('function');
		expect(typeof treasuryReset.resetUsers).toBe('function');
	});
});
