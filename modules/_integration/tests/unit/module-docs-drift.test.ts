/**
 * Doku-Drift der Fachmodule (#76, 10-07; aus `tests/unit/docs-drift.test.ts` herausgelöst): jede Top-Level-`.ts`
 * eines Moduls steht in seiner Regeldatei `.claude/rules/module-<id>.md`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moduleIds as installed, modulesDir as dirOf } from '$testing';

describe('Doku-Abgleich der Module', () => {
	const modulesDir = dirOf();
	// Regeldateien liegen im Repo der Module (eine Ebene über `modules/`), nicht im Core
	const root = join(modulesDir, '..');
	const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
	const moduleIds = installed(modulesDir);

	it.each(moduleIds)('.claude/rules/module-%s.md nennt jede Top-Level-.ts des Moduls', (id) => {
		const text = read('.claude', 'rules', `module-${id}.md`);
		const files = readdirSync(join(modulesDir, id)).filter(
			(f) => f.endsWith('.ts') && statSync(join(modulesDir, id, f)).isFile()
		);
		const missing = files.filter((f) => !text.includes(f));
		expect(missing).toEqual([]);
	});
});
