/**
 * Objektbezogene Zugriffsprüfung für Aktionen. Alle Endpoints des Moduls gehen hier durch.
 *
 * Regeln (die Basisberechtigung `actions.action.view` prüft bereits der Router):
 *   - System-Kontext, `actions.action.edit-all`          -> bearbeiten + teilen
 *   - Eigentümer (`owner_id`)                             -> bearbeiten + teilen
 *   - Freigabe `edit` an einen passenden Principal         -> bearbeiten
 *   - Freigabe `read`, `actions.action.view-all`           -> lesen
 *   - sonst kein Zugriff (Aufrufer erhält 404, damit die Existenz nicht verraten wird)
 *
 * Freigaben gehen an Principals (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in, siehe
 * `$lib/sdk/server/sharing.ts`). Die Principal-Schlüssel des Aufrufers rufen Core und `members` auf
 * und müssen daher VOR der Transaktion feststehen: `loadActionKeys(ctx)`. Alle Endpoints des Moduls
 * erledigen das über `withActionKeys` (module.ts); andere Einstiege (Suche, Kalender) rufen
 * `loadActionKeys` selbst auf.
 */
import { sql } from 'drizzle-orm';
import {
	createShareAccess,
	errors,
	principalKeysFor,
	principalMatchSql,
	type ApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { MODULE_ID } from './schemas';

export interface ActionAccess {
	level: 'edit' | 'read';
	isOwner: boolean;
	canShare: boolean;
}

export const actionShareAccess = createShareAccess({
	table: 'actions',
	shareTable: 'action_shares',
	fk: 'action_id',
	perms: { viewAll: 'actions.action.view-all', editAll: 'actions.action.edit-all' },
	notFoundText: 'Aktion nicht gefunden',
	forbiddenText: 'Keine Berechtigung zum Bearbeiten dieser Aktion'
});

const keyStore = new WeakMap<RequestContext, readonly string[]>();

/** Principal-Schlüssel des Aufrufers ermitteln und für diesen Kontext merken (nie in einer Transaktion) */
export async function loadActionKeys(ctx: RequestContext): Promise<readonly string[]> {
	const keys = await principalKeysFor(ctx, MODULE_ID);
	keyStore.set(ctx, keys);
	return keys;
}

/** Gemerkte Schlüssel; fehlen sie, ist das ein Programmierfehler (Einstieg ohne `loadActionKeys`) */
export function actionKeysOf(ctx: RequestContext): readonly string[] {
	const keys = keyStore.get(ctx);
	if (!keys) {
		throw new Error(
			'actions: Principal-Schlüssel fehlen – loadActionKeys(ctx) vor der Transaktion'
		);
	}
	return keys;
}

/** Endpoints so einhüllen, dass die Principal-Schlüssel vor dem Handler feststehen */
export function withActionKeys(endpoints: ApiEndpoint[]): ApiEndpoint[] {
	return endpoints.map((endpoint) => {
		const handler = endpoint.handler;
		return {
			...endpoint,
			handler: async (args) => {
				await loadActionKeys(args.ctx);
				return handler(args);
			}
		} as ApiEndpoint;
	});
}

const canEditAll = (ctx: RequestContext) => actionShareAccess.canEditAll(ctx);

/** Zugriff des Kontexts auf eine Aktion oder `null` (nicht vorhanden / kein Zugriff). */
export async function resolveAccess(
	tx: Tx,
	ctx: RequestContext,
	actionId: string
): Promise<ActionAccess | null> {
	const keys = canEditAll(ctx) ? [] : actionKeysOf(ctx);
	const access = await actionShareAccess.resolveAccess(tx, ctx, actionId, keys);
	if (!access) return null;
	return { ...access, canShare: canEditAll(ctx) || access.isOwner };
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

/** SQL-Bedingung für Listen (Alias `a`): alles sehen oder nur eigene + freigegebene Aktionen. */
export function visibleActionsFilter(ctx: RequestContext) {
	if (actionShareAccess.canViewAll(ctx)) return sql`TRUE`;
	return actionShareAccess.visibleFilter(ctx, actionKeysOf(ctx), 'a');
}

/**
 * SQL-Bedingung (Alias `a`) für Listen mit Bearbeiten-Zugriff: System/`edit-all` → alle,
 * sonst Eigentümer*in oder Freigabe `edit` (gleiche Regeln wie `resolveAccess`).
 */
export function editableActionsFilter(ctx: RequestContext) {
	if (canEditAll(ctx)) return sql`TRUE`;
	const uid = ctx.userId ?? '';
	return sql`(a.owner_id = ${uid} OR EXISTS (
		SELECT 1 FROM action_shares s WHERE s.action_id = a.id AND s.level = 'edit'
			AND ${principalMatchSql('s', actionKeysOf(ctx))}
	))`;
}
