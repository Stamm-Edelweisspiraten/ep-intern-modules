// Basismodule (`files`, `notes`, `tasks`, `whiteboard`, `events`) liegen im Repo `atrium-basic-modules`.
// Zum Entwickeln und Testen werden sie nach `modules/<id>/` KOPIERT (gitignored, markiert mit `.from-basic`), damit
// `$modules/<id>/…` auflöst und alles mit denselben Paketen aus `.core/node_modules` läuft (ein Link würde die Pakete
// des anderen Repos laden → doppelte Svelte-/Zod-Instanzen). Nie hier ändern – Änderungen im Repo `atrium-basic-modules`.
//
// Quelle (erste vorhandene): ATRIUM_BASIC_MODULES_DIR · Submodul `.basic` · Nachbarordner `../atrium-basic-modules`
//
// Eigenständig: `node scripts/basic-modules.mjs` (wird von `npm run setup` aufgerufen)
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = join(ROOT, 'modules');
export const MARKER = '.from-basic';

export function basicModulesSource() {
	const candidates = [
		process.env.ATRIUM_BASIC_MODULES_DIR?.trim(),
		join(ROOT, '.basic'),
		join(ROOT, '..', 'atrium-basic-modules')
	].filter(Boolean);
	for (const dir of candidates) {
		const abs = resolve(ROOT, dir);
		if (existsSync(join(abs, 'modules', 'atrium-modules.json'))) return join(abs, 'modules');
	}
	return null;
}

/** Kopiert alle Module des Basis-Katalogs nach `modules/`; vorher kopierte, nicht mehr vorhandene werden entfernt. */
export function syncBasicModules() {
	const src = basicModulesSource();
	if (!src) {
		console.error(
			'Basismodule nicht gefunden: Submodul `.basic` holen, ATRIUM_BASIC_MODULES_DIR setzen oder ' +
				'`atrium-basic-modules` neben dieses Repo klonen.'
		);
		process.exit(1);
	}
	const ids = readdirSync(src, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(src, d.name, 'atrium-module.json')))
		.map((d) => d.name);
	for (const d of readdirSync(MODULES, { withFileTypes: true })) {
		if (d.isDirectory() && existsSync(join(MODULES, d.name, MARKER)) && !ids.includes(d.name))
			rmSync(join(MODULES, d.name), { recursive: true, force: true });
	}
	for (const id of ids) {
		const target = join(MODULES, id);
		if (existsSync(target) && !existsSync(join(target, MARKER))) {
			console.error(
				`modules/${id} ist ein eigenes Modul dieses Repos – Basismodul ${id} nicht kopiert.`
			);
			process.exit(1);
		}
		rmSync(target, { recursive: true, force: true });
		cpSync(join(src, id), target, { recursive: true });
		writeFileSync(join(target, MARKER), `Kopie aus ${src} – nicht hier ändern.\n`);
	}
	console.log(`Basismodule aus ${src}: ${ids.join(', ')}`);
	return ids;
}

/** IDs der kopierten Basismodule in `modules/` */
export function copiedBasicModules() {
	if (!existsSync(MODULES)) return [];
	return readdirSync(MODULES, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(MODULES, d.name, MARKER)))
		.map((d) => d.name);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) syncBasicModules();
