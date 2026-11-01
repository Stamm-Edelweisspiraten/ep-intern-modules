/**
 * Endpunkt-Abgleich aller Fachmodule (#61): Jeder Endpunkt aus der Registry (`METHODE pfad`) muss in
 * mindestens einem Integrationstest aufgerufen werden – oder bewusst in `UNTESTED` seines Moduls stehen.
 * Neue Endpunkte ohne Test lassen diesen Test scheitern; ein Eintrag in `UNTESTED`, der inzwischen
 * getestet ist, ebenfalls (Liste schrumpft nur).
 *
 * Erkennung (Heuristik über den Quelltext von `tests/integration/*.test.ts`):
 * - Pfad als String/Template-Literal, optional mit Präfix `/api/v1` bzw. `/modules/<id>` oder einem
 *   führenden `${…}`; `:param` passt auf `${…}` oder einen Literalwert; danach Ende, `?` oder `${…}`.
 * - Methode: ein Methoden-String direkt vor dem Pfad (`send('owner', 'POST', '/x')`), ein Helfer
 *   `post|put|patch|del|remove|upload|sendAndWait(` direkt davor oder `method: 'X'` hinter dem Pfad (bis zum nächsten Pfad);
 *   sonst GET. Wird der Pfad einer Variablen zugewiesen (`const url = '/x'`), zählt er für alle Methoden.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesDir } from '$testing';
import type { ModuleDefinition } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import filesModule from '$modules/files/module';
import galleriesModule from '$modules/galleries/module';
import membersModule from '$modules/members/module';
import messagesModule from '$modules/messages/module';
import notesModule from '$modules/notes/module';
import officesModule from '$modules/offices/module';
import ordersModule from '$modules/orders/module';
import tasksModule from '$modules/tasks/module';
import treasuryModule from '$modules/treasury/module';
import websiteModule from '$modules/website/module';
import whiteboardModule from '$modules/whiteboard/module';

const MODULES: ModuleDefinition[] = [
	actionsModule,
	eventsModule,
	filesModule,
	galleriesModule,
	membersModule,
	messagesModule,
	notesModule,
	officesModule,
	ordersModule,
	tasksModule,
	treasuryModule,
	websiteModule,
	whiteboardModule
];

/** Grund für Endpunkte ohne Integrationstest beim Einführen des Abgleichs (2026-10-27) */
const LEGACY = 'Noch ohne Integrationstest (Bestand beim Einführen des Abgleichs, #61)';
/** Getestet, aber der Pfad wird im Test aus Variablen zusammengesetzt – die Heuristik erkennt ihn nicht */
const COMPOSED = 'Getestet über zusammengesetzten Pfad';

/**
 * Bewusst bzw. noch nicht per Integrationstest abgedeckt, je Modul: `METHODE pfad` → Grund.
 * Beim Ergänzen eines Tests den Eintrag löschen (der Test meldet veraltete Einträge).
 */
const UNTESTED: Record<string, Record<string, string>> = {
	actions: {
		'DELETE /actions/:id/calculation/apply': `${COMPOSED} (actions-calculation.test.ts: calcPath + /apply)`,
		'DELETE /actions/:id/accounting/entries/:entryId/receipt': `${COMPOSED} (actions-accounting.test.ts: entriesPath + /receipt)`,
		'PUT /actions/:id/subsidy-application': `${COMPOSED} (actions-subsidy-application.test.ts: appUrl())`,
		'GET /actions/:id/subsidy-application.pdf': `${COMPOSED} (actions-subsidy-application.test.ts: appUrl() + .pdf)`
	},
	events: {},
	files: {},
	galleries: {},
	members: {
		'GET /led/members/sheet-columns': LEGACY,
		'GET /led/members/ids': LEGACY,
		'GET /led/address/places': LEGACY,
		'POST /public/link/:token/claim': `${COMPOSED} (members-links.test.ts: Helfer post mit Präfix)`,
		'POST /public/link/:token/register': `${COMPOSED} (members-links.test.ts: Helfer post mit Präfix)`
	},
	messages: {
		'GET /mailboxes/all': LEGACY,
		'GET /mailboxes/details': LEGACY,
		'POST /inbox/test': LEGACY,
		'POST /inbox/:id/read': LEGACY
	},
	notes: {},
	offices: {},
	orders: {},
	tasks: {
		'POST /tasks/:id/checklist': LEGACY,
		'PUT /tasks/:id/checklist/order': LEGACY,
		'DELETE /tasks/:id/checklist/:itemId': LEGACY,
		'PATCH /boards/:id': LEGACY,
		'GET /boards/:id/shares': LEGACY,
		'GET /boards/:id/people': LEGACY
	},
	treasury: {
		'PUT /transactions/:id': LEGACY,
		'PUT /payables/:id': LEGACY
	},
	website: {
		'PUT /banners/order': LEGACY,
		'PUT /banners/:id': LEGACY,
		'DELETE /faqs/:id': LEGACY,
		'GET /refs/groups': LEGACY,
		'GET /refs/events': LEGACY,
		'GET /refs/galleries': LEGACY,
		'PUT /posts/:id/images/:imageId': LEGACY,
		'GET /posts/:id/images/:imageId/:variant': LEGACY
	},
	whiteboard: {
		'GET /boards/recent': LEGACY,
		'PATCH /boards/:id': LEGACY,
		'GET /boards/:id/shares': LEGACY,
		'DELETE /boards/:id/snapshots/:snapshotId': LEGACY
	}
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];
const HELPER_METHODS: Record<string, Method> = {
	post: 'POST',
	put: 'PUT',
	patch: 'PATCH',
	del: 'DELETE',
	remove: 'DELETE',
	upload: 'POST',
	sendandwait: 'POST'
};

// Integrationstests aller Module (`<modul>/tests/integration`) und die modulübergreifenden (`_integration`)
const dirs = readdirSync(modulesDir())
	.map((d) => join(modulesDir(), d, 'tests', 'integration'))
	.filter((d) => existsSync(d));
const sources = dirs.flatMap((dir) =>
	readdirSync(dir)
		.filter((f) => f.endsWith('.test.ts'))
		.map((f) => readFileSync(join(dir, f), 'utf8'))
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMPLATE_EXPR = '\\$\\{[^}]+\\}';
/** Beginn eines beliebigen Pfad-Literals (Grenze für die Suche nach `method:`) */
const NEXT_PATH = /['`](?:\$\{[^}]+\})?\//g;

function pathPattern(moduleId: string, path: string): RegExp {
	const body = path
		.split('/')
		.map((seg) => (seg.startsWith(':') ? `(?:${TEMPLATE_EXPR}|[A-Za-z0-9_.@:-]+)` : escape(seg)))
		.join('/');
	const prefix = `(?:${TEMPLATE_EXPR})?(?:/api/v1)?(?:/modules/${escape(moduleId)})?`;
	return new RegExp(`['\`]${prefix}${body}(?=[?'\`]|${TEMPLATE_EXPR})`, 'g');
}

/** Methoden, mit denen ein Pfad-Treffer an Position `index` (Länge `length`) aufgerufen wird */
function methodsAt(src: string, index: number, length: number): Method[] | 'any' {
	const before = src.slice(Math.max(0, index - 80), index);
	if (/(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*$/.test(before)) return 'any';
	const quoted = before.match(/['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*$/);
	if (quoted) return [quoted[1] as Method];
	const helper = before.match(
		/\b(post|put|patch|del|remove|upload|sendAndWait)\s*(?:<[^>]*>)?\(\s*$/i
	);
	if (helper) return [HELPER_METHODS[helper[1]!.toLowerCase()]!];
	const rest = src.slice(index + length, index + length + 600);
	NEXT_PATH.lastIndex = 1;
	const next = NEXT_PATH.exec(rest);
	const window = next ? rest.slice(0, next.index) : rest;
	const named = window.match(/method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/);
	return [named ? (named[1] as Method) : 'GET'];
}

/** Alle Methoden, mit denen ein Pfad in den Integrationstests vorkommt */
function testedMethods(moduleId: string, path: string): Set<Method> {
	const found = new Set<Method>();
	const re = pathPattern(moduleId, path);
	for (const src of sources) {
		for (const m of src.matchAll(re)) {
			const methods = methodsAt(src, m.index, m[0].length);
			for (const method of methods === 'any' ? METHODS : methods) found.add(method);
		}
	}
	return found;
}

const keyOf = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

describe('Endpunkt-Abgleich aller Module (#61)', () => {
	it('jedes Modul hat eine UNTESTED-Liste und umgekehrt', () => {
		expect(Object.keys(UNTESTED).sort()).toEqual(MODULES.map((m) => m.manifest.id).sort());
	});

	for (const mod of MODULES) {
		const id = mod.manifest.id;
		const endpoints = mod.endpoints ?? [];
		const untested = UNTESTED[id] ?? {};
		const isTested = (e: { method: string; path: string }) =>
			testedMethods(id, e.path).has(e.method as Method);

		describe(id, () => {
			it('jeder Endpunkt erscheint (mit Methode) in einem Integrationstest oder steht in UNTESTED', () => {
				const missing = endpoints.filter((e) => !untested[keyOf(e)] && !isTested(e)).map(keyOf);
				expect(missing).toEqual([]);
			});

			it('UNTESTED enthält nur existierende, noch ungetestete Endpunkte', () => {
				const byKey = new Map(endpoints.map((e) => [keyOf(e), e]));
				const unknown = Object.keys(untested).filter((k) => !byKey.has(k));
				const nowTested = Object.keys(untested).filter((k) => {
					const e = byKey.get(k);
					return e ? isTested(e) : false;
				});
				expect({ unknown, nowTested }).toEqual({ unknown: [], nowTested: [] });
			});
		});
	}
});
