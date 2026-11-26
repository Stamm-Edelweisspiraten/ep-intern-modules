/**
 * Doku-Drift der Fachmodule (#76, 10-07; aus `tests/unit/docs-drift.test.ts` herausgelöst): jede Top-Level-`.ts`
 * eines Moduls steht in seiner Regeldatei `.claude/rules/module-<id>.md` (kopierte Basismodule: im Repo `atrium-basic-modules`).
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { modulesDir as dirOf, moduleIds as installed } from '$testing';

describe('Doku-Abgleich der Module', () => {
	const modulesDir = dirOf();
	// Regeldateien liegen im Repo der Module (eine Ebene über `modules/`), nicht im Core
	const root = join(modulesDir, '..');
	const moduleIds = installed(modulesDir);
	/** Wurzel des Repos mit der Regeldatei: kopierte Basismodule (`.from-basic`) → Repo `atrium-basic-modules` */
	const rulesRoot = (id: string) => {
		const marker = join(modulesDir, id, '.from-basic');
		if (!existsSync(marker)) return root;
		const src = /^Kopie aus (.+) – /.exec(readFileSync(marker, 'utf8'))?.[1];
		if (!src) throw new Error(`${marker}: Quelle nicht lesbar`);
		return join(src, '..');
	};

	it.each(moduleIds)('.claude/rules/module-%s.md nennt jede Top-Level-.ts des Moduls', (id) => {
		const text = readFileSync(join(rulesRoot(id), '.claude', 'rules', `module-${id}.md`), 'utf8');
		const files = readdirSync(join(modulesDir, id)).filter(
			(f) => f.endsWith('.ts') && statSync(join(modulesDir, id, f)).isFile()
		);
		const missing = files.filter((f) => !text.includes(f));
		expect(missing).toEqual([]);
	});
});
