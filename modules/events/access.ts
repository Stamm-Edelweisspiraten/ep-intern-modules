/**
 * Objektbezogene Zugriffsprüfung für Termine. Alle Termin-Endpoints gehen hier durch.
 *
 * Regeln (die Basisberechtigung `events.event.view` prüft bereits der Router):
 *   - System-Kontext, `events.event.edit-all`        -> bearbeiten
 *   - Eigentümer*in (`owner_id`)                     -> bearbeiten
 *   - Freigabe `edit` an einen passenden Principal    -> bearbeiten
 *   - Freigabe `read`, `events.event.view-all`        -> lesen
 *   - sonst kein Zugriff (404, damit die Existenz nicht verraten wird)
 *
 * `keys` sind die Principal-Schlüssel des Aufrufers (`principalKeysFor(ctx, 'events')`),
 * immer VOR der Transaktion ermittelt.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, errors, principalMatchSql, type RequestContext, type Tx } from '$lib/sdk/server';
import type { EventAccess } from './schemas';

type Row = Record<string, unknown>;

export async function rowsOf(tx: Tx, query: SQL): Promise<Row[]> {
	const res = (await tx.execute(query)) as unknown as { rows: Row[] };
	return res.rows;
}

function canEditAll(ctx: RequestContext): boolean {
	return ctx.actor.type === 'system' || core.permissions.has(ctx, 'events.event.edit-all');
}

function canViewAll(ctx: RequestContext): boolean {
	return canEditAll(ctx) || core.permissions.has(ctx, 'events.event.view-all');
}

/** Zugriff des Kontexts auf einen Termin oder `null` (nicht vorhanden / kein Zugriff). */
export async function resolveAccess(
	tx: Tx,
	ctx: RequestContext,
	eventId: string,
	keys: readonly string[]
): Promise<EventAccess | null> {
	const [event] = await rowsOf(tx, sql`SELECT owner_id FROM events WHERE id = ${eventId}`);
	if (!event) return null;
	const isOwner = !!ctx.userId && String(event.owner_id) === ctx.userId;

	if (canEditAll(ctx)) return { level: 'edit', isOwner };
	if (isOwner) return { level: 'edit', isOwner: true };

	const shares = await rowsOf(
		tx,
		sql`SELECT s.level FROM event_shares s
			WHERE s.event_id = ${eventId} AND ${principalMatchSql('s', keys)}`
	);
	if (shares.some((s) => s.level === 'edit')) return { level: 'edit', isOwner: false };
	if (shares.length > 0 || core.permissions.has(ctx, 'events.event.view-all')) {
		return { level: 'read', isOwner: false };
	}
	return null;
}

/** Wie `resolveAccess`, wirft aber `notFound` ohne Zugriff und `forbidden` bei fehlendem `edit`. */
export async function requireAccess(
	tx: Tx,
	ctx: RequestContext,
	eventId: string,
	keys: readonly string[],
	need: 'read' | 'edit' = 'read'
): Promise<EventAccess> {
	const access = await resolveAccess(tx, ctx, eventId, keys);
	if (!access) throw errors.notFound('Termin nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieses Termins');
	}
	return access;
}

/** SQL-Bedingung für Listen (Alias `e` für `events`): alles oder eigene + freigegebene. */
export function visibleEventsFilter(ctx: RequestContext, keys: readonly string[]): SQL {
	if (canViewAll(ctx)) return sql`TRUE`;
	const uid = ctx.userId ?? '';
	return sql`(e.owner_id = ${uid} OR EXISTS (
		SELECT 1 FROM event_shares s WHERE s.event_id = e.id AND ${principalMatchSql('s', keys)}
	))`;
}

/**
 * Zugriffsstufe je Termin für Listen (ein Abfrageschritt für alle Zeilen). Termine ohne
 * Treffer bekommen `read` (sie sind nur über `view-all` sichtbar).
 */
export async function accessForMany(
	tx: Tx,
	ctx: RequestContext,
	rows: readonly { id: string; ownerId: string }[],
	keys: readonly string[]
): Promise<Map<string, EventAccess>> {
	const map = new Map<string, EventAccess>();
	if (rows.length === 0) return map;
	const editAll = canEditAll(ctx);
	const editShared = new Set<string>();
	if (!editAll) {
		const ids = rows.map((r) => r.id);
		const shareRows = await rowsOf(
			tx,
			sql`SELECT DISTINCT s.event_id FROM event_shares s
				WHERE s.level = 'edit'
					AND s.event_id IN (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `
					)})
					AND ${principalMatchSql('s', keys)}`
		);
		for (const r of shareRows) editShared.add(String(r.event_id));
	}
	for (const r of rows) {
		const isOwner = !!ctx.userId && r.ownerId === ctx.userId;
		const edit = editAll || isOwner || editShared.has(r.id);
		map.set(r.id, { level: edit ? 'edit' : 'read', isOwner });
	}
	return map;
}
