import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesDir } from '$testing';
import { resetAreas, resetUsers } from '$modules/galleries/reset';

const dir = join(modulesDir(), 'galleries', 'migrations');
const sqlText = readdirSync(dir)
	.filter((f) => f.endsWith('.sql'))
	.map((f) => readFileSync(join(dir, f), 'utf8'))
	.join('\n')
	.replace(/--[^\n]*/g, '');

/** Von späteren Migrationen entfernte Tabellen (z. B. `gallery_image_events` in 0002) */
function droppedTables(): Set<string> {
	const out = new Set<string>();
	for (const m of sqlText.matchAll(/DROP TABLE(?: IF EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
		out.add(m[1]!.toLowerCase());
	}
	return out;
}

/** Tabellen nach allen Migrationen */
function tables(): Set<string> {
	const dropped = droppedTables();
	const out = new Set<string>();
	for (const m of sqlText.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
		const name = m[1]!.toLowerCase();
		if (!dropped.has(name)) out.add(name);
	}
	return out;
}

/** Fremdschlüssel je Statement; `ON DELETE SET NULL` (Titelbild) braucht keine Reihenfolge. */
function foreignKeys(): { child: string; parent: string; setNull: boolean }[] {
	const out: { child: string; parent: string; setNull: boolean }[] = [];
	for (const stmt of sqlText.split(';')) {
		const head = /(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([a-z_]+)/i.exec(stmt);
		if (!head) continue;
		const child = head[1]!.toLowerCase();
		if (droppedTables().has(child)) continue;
		for (const m of stmt.matchAll(/REFERENCES\s+([a-z_]+)\s*\([^)]*\)([^,\n]*)/gi)) {
			out.push({ child, parent: m[1]!.toLowerCase(), setNull: /SET NULL/i.test(m[2] ?? '') });
		}
	}
	return out;
}

describe('Reset-Bereiche galleries', () => {
	it('hat genau den Bereich all mit Neuaufbau und allen Dateien', () => {
		expect(resetAreas.map((a) => a.id)).toEqual(['all']);
		const all = resetAreas[0]!;
		expect(all.rebuild).toBe(true);
		expect(all.storagePrefixes).toBe('all');
		expect(all.label).toBe('Alle Galerien');
		expect(all.description.length).toBeGreaterThan(20);
		expect(all.implies ?? []).toEqual([]);
	});

	it('deckt alle Tabellen der Migrationen ab, ohne Duplikate', () => {
		const all = resetAreas[0]!;
		expect(new Set(all.tables).size).toBe(all.tables.length);
		expect(new Set(all.tables)).toEqual(tables());
		expect(tables().size).toBe(4);
		expect(tables().has('gallery_events')).toBe(true);
		expect(droppedTables()).toEqual(new Set(['gallery_image_events']));
	});

	it('löscht abhängige Tabellen vor ihren Eltern', () => {
		const fks = foreignKeys();
		expect(fks.filter((f) => !f.setNull).length).toBe(3);
		// Titelbild-FK galleries -> gallery_images ist ON DELETE SET NULL (sonst Zyklus)
		expect(fks).toContainEqual({ child: 'galleries', parent: 'gallery_images', setNull: true });
		const order = resetAreas[0]!.tables;
		for (const fk of fks.filter((f) => !f.setNull)) {
			expect(order.indexOf(fk.child), `${fk.child} -> ${fk.parent}`).toBeLessThan(
				order.indexOf(fk.parent)
			);
		}
	});

	it('bietet resetUsers an', () => {
		expect(typeof resetUsers).toBe('function');
	});
});
