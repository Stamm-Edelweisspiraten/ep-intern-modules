/** Vorlagen-Ämter aus den Manifesten registrierter Module (`manifest.offices`), ohne Datenbankzugriff. */
import { core, type ModuleOfficeTemplate } from '$lib/sdk/server';
import { MODULE_ID } from './schemas';

export interface RegisteredTemplates {
	moduleName: string;
	templates: Map<string, ModuleOfficeTemplate>;
}

/** Alle Vorlagen registrierter Module (aktiv oder nicht) – `module` → `key` → Vorlage */
export function registeredTemplates(): Map<string, RegisteredTemplates> {
	const out = new Map<string, RegisteredTemplates>();
	for (const m of core.modules.registered()) {
		if (!m.offices?.length || m.id === MODULE_ID) continue;
		out.set(m.id, { moduleName: m.name, templates: new Map(m.offices.map((o) => [o.key, o])) });
	}
	return out;
}
