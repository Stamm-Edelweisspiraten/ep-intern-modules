/**
 * Dienst `ActionsService.accessibleActions` (Vertrag `contract.ts`): Aktionen, die der Kontext sieht,
 * mit Zugriffsstufe – gleiche Regeln wie `GET /actions` (`access.ts`).
 */
import { sql } from 'drizzle-orm';
import { core, inList, moduleDb, type RequestContext, rowsOf } from '$lib/sdk/server';
import { editableActionsFilter, loadActionKeys, visibleActionsFilter } from './access';
import type { AccessibleAction } from './contract';
import { MODULE_ID } from './schemas';

export async function accessibleActions(
	ctx: RequestContext,
	query: { ids?: string[] } = {}
): Promise<AccessibleAction[]> {
	if (ctx.actor.type !== 'system' && !core.permissions.has(ctx, 'actions.action.view')) return [];
	if (query.ids && query.ids.length === 0) return [];
	await loadActionKeys(ctx);
	const only = query.ids ? sql`a.id IN (${inList(query.ids.slice(0, 1000))})` : sql`TRUE`;
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT a.id, a.name, to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
					to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, (${editableActionsFilter(ctx)}) AS can_edit
				FROM actions a
				WHERE ${only} AND ${visibleActionsFilter(ctx)}
				ORDER BY a.starts_on DESC, a.name
				LIMIT 1000`
		)
	);
	return rows.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		startsOn: String(r.starts_on),
		endsOn: r.ends_on == null ? null : String(r.ends_on),
		level: r.can_edit === true || r.can_edit === 't' ? 'edit' : 'read'
	}));
}
