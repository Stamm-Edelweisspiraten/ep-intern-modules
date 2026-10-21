/**
 * Objektbezogene Zugriffsprüfung für Aktionen. Alle Endpoints des Moduls gehen hier durch.
 *
 * Regeln (die Basisberechtigung `actions.action.view` prüft bereits der Router):
 *   - System-Kontext, `actions.action.edit-all`  -> bearbeiten + teilen
 *   - Eigentümer (`owner_id`)                     -> bearbeiten + teilen
 *   - Freigabe `edit`                              -> bearbeiten
 *   - Freigabe `read`, `actions.action.view-all`   -> lesen
 *   - sonst kein Zugriff (Aufrufer erhält 404, damit die Existenz nicht verraten wird)
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, rowsOf, type Tx } from '$lib/sdk/server';

export interface ActionAccess {
	level: 'edit' | 'read';
	isOwner: boolean;
	canShare: boolean;
}

/** Zugriff des Kontexts auf eine Aktion oder `null` (nicht vorhanden / kein Zugriff). */
export async function resolveAccess(
	tx: Tx,
	ctx: RequestContext,
	actionId: string
): Promise<ActionAccess | null> {
	const [action] = await rowsOf(tx, sql`SELECT owner_id FROM actions WHERE id = ${actionId}`);
	if (!action) return null;

	const isSystem = ctx.actor.type === 'system';
	const isOwner = !!ctx.userId && String(action.owner_id) === ctx.userId;

	if (isSystem || core.permissions.has(ctx, 'actions.action.edit-all')) {
		return { level: 'edit', isOwner, canShare: true };
	}
	if (isOwner) return { level: 'edit', isOwner: true, canShare: true };

	if (ctx.userId) {
		const [share] = await rowsOf(
			tx,
			sql`SELECT level FROM action_shares WHERE action_id = ${actionId} AND user_id = ${ctx.userId}`
		);
		if (share?.level === 'edit') return { level: 'edit', isOwner: false, canShare: false };
		if (share?.level === 'read') return { level: 'read', isOwner: false, canShare: false };
	}
	if (core.permissions.has(ctx, 'actions.action.view-all')) {
		return { level: 'read', isOwner: false, canShare: false };
	}
	return null;
}

/**
 * Wie `resolveAccess`, wirft aber `notFound` ohne Zugriff und `forbidden`, wenn mehr als der
 * vorhandene Zugriff verlangt wird (`edit` bzw. Freigaben ändern).
 */
export async function requireAccess(
	tx: Tx,
	ctx: RequestContext,
	actionId: string,
	need: 'read' | 'edit' | 'share' = 'read'
): Promise<ActionAccess> {
	const access = await resolveAccess(tx, ctx, actionId);
	if (!access) throw errors.notFound('Aktion nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieser Aktion');
	}
	if (need === 'share' && !access.canShare) {
		throw errors.forbidden('Nur Eigentümer*in darf Freigaben ändern');
	}
	return access;
}

/** SQL-Bedingung für Listen: alles sehen oder nur eigene + freigegebene Aktionen. */
export function visibleActionsFilter(ctx: RequestContext) {
	if (
		ctx.actor.type === 'system' ||
		core.permissions.has(ctx, 'actions.action.view-all') ||
		core.permissions.has(ctx, 'actions.action.edit-all')
	) {
		return sql`TRUE`;
	}
	const uid = ctx.userId ?? '';
	return sql`(a.owner_id = ${uid} OR EXISTS (
		SELECT 1 FROM action_shares s WHERE s.action_id = a.id AND s.user_id = ${uid}
	))`;
}

/**
 * SQL-Bedingung (Alias `a`) für Listen mit Bearbeiten-Zugriff: System/`edit-all` → alle,
 * sonst Eigentümer*in oder Freigabe `edit` (gleiche Regeln wie `resolveAccess`).
 */
export function editableActionsFilter(ctx: RequestContext) {
	if (ctx.actor.type === 'system' || core.permissions.has(ctx, 'actions.action.edit-all')) {
		return sql`TRUE`;
	}
	const uid = ctx.userId ?? '';
	return sql`(a.owner_id = ${uid} OR EXISTS (
		SELECT 1 FROM action_shares s WHERE s.action_id = a.id AND s.user_id = ${uid} AND s.level = 'edit'
	))`;
}
