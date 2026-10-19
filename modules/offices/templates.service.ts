/**
 * Ämter aus Modul-Vorlagen (`manifest.offices`): einmalig anlegen, solange das Vorlagen-Modul aktiv ist.
 * Der Marker in `office_templates_applied` verhindert, dass ein gelöschtes Vorlagen-Amt zurückkommt.
 */
import { sql } from 'drizzle-orm';
import { core, type ModuleOfficeTemplate, type RequestContext } from '$lib/sdk/server';
import { mdb, rowsOf } from './load';
import { MAX_DESCRIPTION, MAX_NAME, MAX_OFFICES } from './schemas';
import { registeredTemplates } from './templates';

/** Vorlage eines aktiven Moduls samt Anzeigename des Moduls */
export interface ActiveTemplate {
	module: string;
	moduleName: string;
	template: ModuleOfficeTemplate;
}

/** Vorlagen der registrierten **und aktiven** Module */
export async function activeTemplates(): Promise<ActiveTemplate[]> {
	const out: ActiveTemplate[] = [];
	for (const [module, info] of registeredTemplates()) {
		if (!(await core.modules.isEnabled(module))) continue;
		for (const template of info.templates.values()) {
			out.push({ module, moduleName: info.moduleName, template });
		}
	}
	return out;
}

const CACHE_MS = 60_000;
let cache: { signature: string; at: number } | null = null;

/** Für Tests: nächsten `applyTemplatesCached`-Aufruf erzwingen */
export function resetTemplateCacheForTests(): void {
	cache = null;
}

export interface ApplyResult {
	created: { id: string; name: string; module: string; key: string }[];
}

/**
 * Legt fehlende Vorlagen-Ämter an (idempotent). Core-Aufrufe (Audit) erst nach der Transaktion.
 * Wirft nicht bei Kapazitätsgrenze – die Vorlage wird dann beim nächsten Lauf erneut versucht.
 */
export async function applyTemplates(ctx: RequestContext): Promise<ApplyResult> {
	const templates = await activeTemplates();
	if (templates.length === 0) return { created: [] };
	const created = await mdb().transaction(async (tx) => {
		const done = new Set(
			(await rowsOf(tx, sql`SELECT module_id, office_key FROM office_templates_applied`)).map(
				(r) => `${String(r.module_id)}:${String(r.office_key)}`
			)
		);
		const result: ApplyResult['created'] = [];
		for (const t of templates) {
			if (done.has(`${t.module}:${t.template.key}`)) continue;
			const [stats] = await rowsOf(
				tx,
				sql`SELECT count(*)::int AS n, COALESCE(MAX(position), -1)::int AS max FROM offices`
			);
			if (Number(stats?.n ?? 0) >= MAX_OFFICES) {
				console.warn(
					`[offices] Vorlage ${t.module}.${t.template.key} nicht angelegt: höchstens ${MAX_OFFICES} Ämter`
				);
				continue;
			}
			// Marker zuerst: nur wer ihn setzt, legt das Amt an (gleichzeitige Läufe)
			const marked = await rowsOf(
				tx,
				sql`INSERT INTO office_templates_applied (module_id, office_key)
					VALUES (${t.module}, ${t.template.key})
					ON CONFLICT DO NOTHING RETURNING module_id`
			);
			if (marked.length === 0) continue;
			const id = crypto.randomUUID();
			const name = t.template.name.trim().slice(0, MAX_NAME);
			const description = t.template.description?.trim().slice(0, MAX_DESCRIPTION) || null;
			const inserted = await rowsOf(
				tx,
				sql`INSERT INTO offices (id, name, description, position, created_by, source_module, source_key)
					VALUES (${id}, ${name}, ${description}, ${Number(stats?.max ?? -1) + 1}, NULL,
						${t.module}, ${t.template.key})
					ON CONFLICT DO NOTHING RETURNING id`
			);
			if (inserted.length) result.push({ id, name, module: t.module, key: t.template.key });
		}
		return result;
	});
	for (const c of created) {
		await core.audit.logFromContext(ctx, 'offices.office.created', {
			target: c.id,
			metadata: { name: c.name, template: `${c.module}.${c.key}` }
		});
	}
	return { created };
}

/**
 * Wie `applyTemplates`, aber höchstens alle 60 s je Prozess – außer die Menge der aktiven Vorlagen
 * hat sich geändert (z. B. Modul aktiviert). Fehler werden nur geloggt (Lesepfade sollen nie scheitern).
 */
export async function applyTemplatesCached(ctx: RequestContext): Promise<void> {
	try {
		const signature = (await activeTemplates())
			.map((t) => `${t.module}:${t.template.key}`)
			.sort()
			.join(',');
		if (cache && cache.signature === signature && Date.now() - cache.at < CACHE_MS) return;
		await applyTemplates(ctx);
		cache = { signature, at: Date.now() };
	} catch (e) {
		console.warn('[offices] Vorlagen nicht angewendet:', e instanceof Error ? e.message : e);
	}
}
