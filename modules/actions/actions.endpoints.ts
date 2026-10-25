import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	core,
	defineEndpoint,
	errors,
	moduleDb,
	type RequestContext,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { actionKeysOf, requireAccess, visibleActionsFilter } from './access';
import { shareLevelsFor } from './shares.endpoints';
import {
	actionInput,
	actionListQuery,
	actionUpdateInput,
	idParams,
	type ActionList,
	type ActionSummary,
	type UserRef
} from './schemas';

const MODULE = 'actions';
const tags = ['Aktionen'];

const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

const COLUMNS = sql`a.id, a.name, a.description, a.location,
	to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on, a.starts_time,
	to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on, a.ends_time,
	a.owner_id, a.is_past, a.created_at, a.updated_at,
		a.fee_cents, a.team_fee_cents, a.fee_applied_at, a.fee_applied_by,
	(SELECT count(*)::int FROM action_participants p WHERE p.action_id = a.id) AS participant_count`;

/** Löst Benutzer-IDs in Namen/E-Mail auf (`core.users.byIds` stückelt selbst). */
async function resolveUsers(ctx: RequestContext, ids: string[]): Promise<Map<string, UserRef>> {
	const map = new Map<string, UserRef>();
	for (const u of (await core.users.byIds(ctx, ids)).values()) {
		map.set(u.id, { userId: u.id, name: u.name, email: u.email });
	}
	return map;
}

const userRef = (map: Map<string, UserRef>, userId: string): UserRef =>
	map.get(userId) ?? { userId, name: 'Unbekannt', email: null };

function hasEditAll(ctx: RequestContext): boolean {
	return ctx.actor.type === 'system' || core.permissions.has(ctx, 'actions.action.edit-all');
}

/**
 * Zusammenfassungen entstehen in zwei Schritten: Zeilen und eigene Freigaben werden INNERHALB
 * der Modul-Transaktion gelesen, Benutzernamen (Core-Verzeichnis) erst NACH der Transaktion
 * aufgelöst. Das Verzeichnis nutzt die Core-Verbindung; innerhalb einer offenen Transaktion
 * würde das auf Einzelverbindungs-Treibern (PGlite) blockieren.
 */
interface SummaryData {
	rows: Record<string, unknown>[];
	shareBy: Map<string, string>;
}

async function loadSummaryData(
	ctx: RequestContext,
	tx: Tx,
	rows: Record<string, unknown>[]
): Promise<SummaryData> {
	const ids = rows.map((r) => String(r.id));
	const keys = hasEditAll(ctx) || !ctx.userId ? [] : actionKeysOf(ctx);
	return { rows, shareBy: await shareLevelsFor(tx, ids, keys) };
}

async function buildSummaries(ctx: RequestContext, data: SummaryData): Promise<ActionSummary[]> {
	const { rows, shareBy } = data;
	if (!rows.length) return [];
	const owners = await resolveUsers(ctx, [
		...rows.map((r) => String(r.owner_id)),
		...rows.filter((r) => r.fee_applied_by != null).map((r) => String(r.fee_applied_by))
	]);
	const editAll = hasEditAll(ctx);

	return rows.map((r) => {
		const isOwner = !!ctx.userId && String(r.owner_id) === ctx.userId;
		let level: 'edit' | 'read' = 'read';
		if (editAll || isOwner || shareBy.get(String(r.id)) === 'edit') level = 'edit';
		return {
			id: String(r.id),
			name: String(r.name),
			description: strOrNull(r.description),
			location: strOrNull(r.location),
			startsOn: String(r.starts_on),
			startsTime: strOrNull(r.starts_time),
			endsOn: strOrNull(r.ends_on),
			endsTime: strOrNull(r.ends_time),
			owner: userRef(owners, String(r.owner_id)),
			access: { level, isOwner, canShare: editAll || isOwner },
			participantCount: Number(r.participant_count),
			isPast: r.is_past === true || r.is_past === 't',
			fee:
				r.fee_cents == null
					? null
					: {
							participantCents: Number(r.fee_cents),
							teamCents: Number(r.team_fee_cents ?? 0),
							appliedAt: toIso(r.fee_applied_at),
							appliedBy: r.fee_applied_by == null ? null : userRef(owners, String(r.fee_applied_by))
						},
			createdAt: toIso(r.created_at),
			updatedAt: toIso(r.updated_at)
		};
	});
}

/** Liest eine Aktion in der Transaktion; Aufbau der Antwort erfolgt danach mit `buildSummaries`. */
async function loadOne(ctx: RequestContext, tx: Tx, id: string): Promise<SummaryData> {
	const rows = await rowsOf(tx, sql`SELECT ${COLUMNS} FROM actions a WHERE a.id = ${id}`);
	if (!rows.length) throw errors.notFound('Aktion nicht gefunden');
	return loadSummaryData(ctx, tx, rows);
}

async function summaryOf(ctx: RequestContext, data: SummaryData): Promise<ActionSummary> {
	const [summary] = await buildSummaries(ctx, data);
	if (!summary) throw errors.notFound('Aktion nicht gefunden');
	return summary;
}

async function listActions(
	ctx: RequestContext,
	q: { search?: string; limit: number; offset: number }
): Promise<ActionList> {
	const { data, total } = await moduleDb(MODULE).transaction(async (tx) => {
		const visible = visibleActionsFilter(ctx);
		const term = q.search?.replace(/[%_\\]/g, '');
		const search = term
			? sql`(a.name ILIKE ${`%${term}%`} OR a.location ILIKE ${`%${term}%`})`
			: sql`TRUE`;
		const [t] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM actions a WHERE ${visible} AND ${search}`
		);
		const rows = await rowsOf(
			tx,
			sql`SELECT ${COLUMNS} FROM actions a WHERE ${visible} AND ${search}
				ORDER BY a.starts_on DESC, a.name LIMIT ${q.limit} OFFSET ${q.offset}`
		);
		return { data: await loadSummaryData(ctx, tx, rows), total: Number(t?.n ?? 0) };
	});
	return { items: await buildSummaries(ctx, data), total };
}

function requireUserId(ctx: RequestContext): string {
	if (!ctx.userId) throw errors.unauthenticated();
	return ctx.userId;
}

export const actionEndpoints: ApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/actions',
		summary: 'Aktionen auflisten',
		tags,
		permission: 'actions.action.view',
		query: actionListQuery,
		handler: ({ ctx, query }) => listActions(ctx, query)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/actions/:id',
		summary: 'Aktion abrufen',
		tags,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const data = await moduleDb(MODULE).transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, 'read');
				return loadOne(ctx, tx, params.id);
			});
			return summaryOf(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/actions',
		summary: 'Aktion anlegen',
		tags,
		permission: 'actions.action.create',
		body: actionInput,
		handler: async ({ ctx, body }) => {
			const ownerId = requireUserId(ctx);
			const id = crypto.randomUUID();
			const data = await moduleDb(MODULE).transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO actions (id, name, description, location, starts_on, starts_time,
							ends_on, ends_time, owner_id, is_past)
						VALUES (${id}, ${body.name}, ${body.description}, ${body.location}, ${body.startsOn},
							${body.startsTime}, ${body.endsOn}, ${body.endsTime}, ${ownerId}, ${body.isPast})`
				);
				return loadOne(ctx, tx, id);
			});
			const result = await summaryOf(ctx, data);
			await core.audit.logFromContext(ctx, 'actions.action.created', {
				target: id,
				metadata: { name: result.name, isPast: result.isPast }
			});
			return result;
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/actions/:id',
		summary: 'Aktion ändern',
		tags,
		permission: 'actions.action.view',
		params: idParams,
		body: actionUpdateInput,
		handler: async ({ ctx, params, body }) => {
			const data = await moduleDb(MODULE).transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, 'edit');
				await tx.execute(
					sql`UPDATE actions SET name = ${body.name}, description = ${body.description},
							location = ${body.location}, starts_on = ${body.startsOn},
							starts_time = ${body.startsTime}, ends_on = ${body.endsOn},
							ends_time = ${body.endsTime},
							is_past = COALESCE(${body.isPast ?? null}::boolean, is_past), updated_at = now()
						WHERE id = ${params.id}`
				);
				return loadOne(ctx, tx, params.id);
			});
			const result = await summaryOf(ctx, data);
			await core.audit.logFromContext(ctx, 'actions.action.updated', {
				target: params.id,
				metadata: { name: result.name, isPast: result.isPast }
			});
			return result;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/actions/:id',
		summary: 'Aktion löschen',
		description: 'Nur Eigentümer*in oder Benutzer mit actions.action.edit-all.',
		tags,
		permission: 'actions.action.delete',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const name = await moduleDb(MODULE).transaction(async (tx) => {
				const access = await requireAccess(tx, ctx, params.id, 'edit');
				if (!access.isOwner && !hasEditAll(ctx)) {
					throw errors.forbidden('Nur Eigentümer*in darf die Aktion löschen');
				}
				const [row] = await rowsOf(tx, sql`SELECT name FROM actions WHERE id = ${params.id}`);
				await tx.execute(sql`DELETE FROM actions WHERE id = ${params.id}`);
				return String(row?.name ?? '');
			});
			await core.audit.logFromContext(ctx, 'actions.action.deleted', {
				target: params.id,
				metadata: { name }
			});
			return { id: params.id };
		}
	})
] as ApiEndpoint[];
