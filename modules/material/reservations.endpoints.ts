/**
 * Reservierungen: Liste, Detail, Anlegen/Ändern mit Verfügbarkeitsprüfung, Stornieren, je Aktion,
 * Verfügbarkeit, eigene Reservierungen. Ausgabe/Rückgabe in `handout.endpoints.ts`.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	errors,
	type AnyApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { freeQuantity, freeUnitCount } from './availability';
import { actionsService, canHandleAll, dateStr, mdb, num, rows, today, userNames } from './db';
import { isUsable, loadPlaceIndex } from './inventory';
import { effectivePlace } from './places';
import { addDays } from '$lib/sdk/dates';
import { notifyReservationCreated } from './notify';
import {
	assertLinesAvailable,
	checkLines,
	loadBookings,
	loadReservation,
	replaceLines,
	requireEdit,
	setBulkLines,
	withSetBulk,
	requireReservationRow
} from './reservations.service';
import {
	PERMISSIONS,
	actionParams,
	availabilityInput,
	availabilityQuery,
	idParams,
	reservationInput,
	reservationListQuery,
	reservationUpdateInput,
	type ArticleAvailability,
	type Reservation,
	type ReservationListItem,
	type ReservationStatus
} from './schemas';

const tags = ['Modul: material'];

/** Aktion prüfen (sichtbar für `ctx`), vor der Transaktion; liefert den Namen */
async function checkAction(ctx: RequestContext, actionId: string | null): Promise<string | null> {
	if (!actionId) return null;
	const service = await actionsService();
	if (!service)
		throw errors.validation([{ path: ['actionId'], message: 'Aktionen sind nicht aktiv' }]);
	const [a] = await service.accessibleActions(ctx, { ids: [actionId] });
	if (!a) throw errors.validation([{ path: ['actionId'], message: 'Aktion nicht gefunden' }]);
	return a.name;
}

async function actionNames(ids: (string | null)[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((x): x is string => !!x))];
	if (!unique.length) return new Map();
	const service = await actionsService();
	if (!service) return new Map();
	return new Map((await service.listActionRefs({ ids: unique })).map((a) => [a.id, a.name]));
}

export async function fullReservation(ctx: RequestContext, id: string): Promise<Reservation> {
	const r = await mdb().transaction((tx) => loadReservation(tx, ctx, id));
	const [names, actions] = await Promise.all([
		userNames(ctx, [r.createdBy]),
		actionNames([r.actionId])
	]);
	return {
		...r,
		createdByName: r.createdBy ? (names.get(r.createdBy) ?? 'Unbekannt') : 'Unbekannt',
		actionName: r.actionId ? (actions.get(r.actionId) ?? null) : null
	};
}

async function listReservations(
	tx: Tx,
	ctx: RequestContext,
	filter: {
		status?: string;
		mine?: boolean;
		from?: string;
		to?: string;
		search?: string;
		actionId?: string;
	}
): Promise<
	(Omit<ReservationListItem, 'createdByName' | 'actionName'> & { createdBy: string | null })[]
> {
	const where = [sql`TRUE`];
	const status = filter.status ?? 'open';
	if (status === 'open') where.push(sql`r.status IN ('reserved', 'issued')`);
	else if (status !== 'all') where.push(sql`r.status = ${status}`);
	if (filter.mine) where.push(sql`r.created_by = ${ctx.userId ?? ''}`);
	if (filter.from) where.push(sql`r.ends_on >= ${filter.from}::date`);
	if (filter.to) where.push(sql`r.starts_on <= ${filter.to}::date`);
	if (filter.actionId) where.push(sql`r.action_id = ${filter.actionId}`);
	if (filter.search) {
		const like = `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		where.push(sql`r.title ILIKE ${like}`);
	}
	const list = await rows(
		tx,
		sql`SELECT r.id, r.title, r.status, r.action_id, r.created_by,
				to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on,
				(SELECT count(*) FROM reservation_lines l WHERE l.reservation_id = r.id) AS line_count,
				(SELECT string_agg(
					CASE l.kind
						WHEN 'article' THEN l.quantity || ' × ' || a.name
						WHEN 'set' THEN 'Set ' || s.name
						ELSE coalesce(nullif(u.label, ''), ua.name)
					END, ', ' ORDER BY l.position)
					FROM reservation_lines l
					LEFT JOIN articles a ON a.id = l.article_id
					LEFT JOIN sets s ON s.id = l.set_id
					LEFT JOIN units u ON u.id = l.unit_id
					LEFT JOIN articles ua ON ua.id = u.article_id
					WHERE l.reservation_id = r.id) AS summary
			FROM reservations r
			WHERE ${sql.join(where, sql` AND `)}
			ORDER BY r.starts_on, lower(r.title)
			LIMIT 500`
	);
	const t = today();
	return list.map((r) => {
		const s = String(r.status) as ReservationStatus;
		const endsOn = dateStr(r.ends_on);
		const summary = String(r.summary ?? '');
		return {
			id: String(r.id),
			title: String(r.title),
			startsOn: dateStr(r.starts_on),
			endsOn,
			status: s,
			actionId: r.action_id ? String(r.action_id) : null,
			createdBy: r.created_by ? String(r.created_by) : null,
			lineCount: num(r.line_count),
			itemSummary: summary.length > 160 ? `${summary.slice(0, 157)}…` : summary,
			overdue: s === 'issued' && endsOn < t,
			mine: !!ctx.userId && String(r.created_by ?? '') === ctx.userId
		};
	});
}

async function withNames(
	ctx: RequestContext,
	list: Awaited<ReturnType<typeof listReservations>>
): Promise<ReservationListItem[]> {
	const [names, actions] = await Promise.all([
		userNames(
			ctx,
			list.map((r) => r.createdBy)
		),
		actionNames(list.map((r) => r.actionId))
	]);
	return list.map(({ createdBy, ...r }) => ({
		...r,
		createdByName: createdBy ? (names.get(createdBy) ?? 'Unbekannt') : 'Unbekannt',
		actionName: r.actionId ? (actions.get(r.actionId) ?? null) : null
	}));
}

export const reservationsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/reservations',
		summary: 'Reservierungen (Standard: offene)',
		tags,
		permission: PERMISSIONS.view,
		query: reservationListQuery,
		handler: async ({ ctx, query }) =>
			withNames(
				ctx,
				await mdb().transaction((tx) =>
					listReservations(tx, ctx, { ...query, mine: query.mine === '1' })
				)
			)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/my/reservations',
		summary: 'Eigene offene Reservierungen (Dashboard)',
		tags,
		permission: PERMISSIONS.reserve,
		handler: async ({ ctx }) =>
			withNames(ctx, await mdb().transaction((tx) => listReservations(tx, ctx, { mine: true })))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations/by-action/:actionId',
		summary: 'Reservierungen einer Aktion (für die Karte in der Aktion)',
		description: 'Nur, wenn die Aktion für den Aufrufer sichtbar ist (sonst 404).',
		tags,
		permission: PERMISSIONS.view,
		params: actionParams,
		handler: async ({ ctx, params }) => {
			const service = await actionsService();
			const [action] = service
				? await service.accessibleActions(ctx, { ids: [params.actionId] })
				: [];
			if (!action) throw errors.notFound('Aktion nicht gefunden');
			const list = await mdb().transaction((tx) =>
				listReservations(tx, ctx, { status: 'all', actionId: params.actionId })
			);
			return {
				action: {
					id: action.id,
					name: action.name,
					startsOn: action.startsOn,
					endsOn: action.endsOn
				},
				reservations: (await withNames(ctx, list)).filter((r) => r.status !== 'cancelled'),
				canCreate: ctx.permissions.has(PERMISSIONS.reserve)
			};
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/availability',
		summary: 'Positionen gegen den Bestand prüfen (ohne zu speichern)',
		tags,
		permission: PERMISSIONS.view,
		body: availabilityInput,
		handler: ({ body }) =>
			mdb().transaction(async (tx) => {
				const extra = await setBulkLines(tx, body.lines);
				const results = await checkLines(tx, {
					startsOn: body.startsOn,
					endsOn: body.endsOn < body.startsOn ? body.startsOn : body.endsOn,
					excludeId: body.excludeReservationId ?? null,
					lines: [
						...body.lines,
						...extra.map((e) => ({
							kind: 'article' as const,
							articleId: e.articleId,
							quantity: e.quantity
						}))
					]
				});
				// Engpässe bei den Mengen eines Sets am Set melden
				const own = results.slice(0, body.lines.length);
				extra.forEach((e, j) => {
					const r = results[body.lines.length + j];
					if (!r || r.ok) return;
					const i = body.lines.findIndex((l) => l.kind === 'set' && l.setId === e.sourceSetId);
					const target = own[i];
					if (!target) return;
					target.ok = false;
					target.message = [target.message, r.message].filter(Boolean).join(' ');
				});
				return own;
			})
	}),
	defineEndpoint({
		method: 'GET',
		path: '/availability/articles',
		summary: 'Freie Anzahl je Artikel im Zeitraum',
		tags,
		permission: PERMISSIONS.view,
		query: availabilityQuery,
		handler: ({ query }) =>
			mdb().transaction(async (tx): Promise<ArticleAvailability[]> => {
				const to = query.to < query.from ? query.from : query.to;
				const { bookings } = await loadBookings(tx, {
					from: query.from,
					to,
					excludeId: query.excludeReservationId
				});
				const articles = await rows(
					tx,
					sql`SELECT a.id, a.kind,
							(SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) AS total
						FROM articles a WHERE a.archived_at IS NULL`
				);
				const units = await rows(tx, sql`SELECT id, article_id, condition, retired_at FROM units`);
				const usable = new Map<string, string[]>();
				for (const u of units) {
					if (!isUsable(u)) continue;
					const list = usable.get(String(u.article_id)) ?? [];
					list.push(String(u.id));
					usable.set(String(u.article_id), list);
				}
				return articles.map((a) => {
					const id = String(a.id);
					if (String(a.kind) === 'bulk') {
						const total = num(a.total);
						return {
							articleId: id,
							total,
							free: freeQuantity(total, id, bookings, query.from, to)
						};
					}
					const list = usable.get(id) ?? [];
					return {
						articleId: id,
						total: list.length,
						free: freeUnitCount(list, id, bookings, query.from, to)
					};
				});
			})
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations/:id',
		summary: 'Reservierung mit Positionen und ausgegebenen Stücken',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ ctx, params }) => fullReservation(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations',
		summary: 'Reservierung anlegen (prüft die Verfügbarkeit, sonst 409)',
		tags,
		permission: PERMISSIONS.reserve,
		body: reservationInput,
		handler: async ({ ctx, body }): Promise<Reservation> => {
			const actionName = await checkAction(ctx, body.actionId);
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('material:reservations'))`);
				await assertLinesAvailable(tx, {
					startsOn: body.startsOn,
					endsOn: body.endsOn,
					lines: await withSetBulk(tx, body.lines)
				});
				await tx.execute(
					sql`INSERT INTO reservations (id, title, action_id, starts_on, ends_on, notes, created_by)
						VALUES (${id}, ${body.title}, ${body.actionId}, ${body.startsOn}, ${body.endsOn},
							${body.notes}, ${ctx.userId ?? null})`
				);
				await replaceLines(tx, id, body.lines);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.created', {
				target: id,
				metadata: { lines: body.lines.length, actionId: body.actionId }
			});
			const full = await fullReservation(ctx, id);
			if (actionName) await notifyReservationCreated(ctx, full);
			return full;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/reservations/:id',
		summary: 'Reservierung ändern',
		description:
			'Reserviert: alles. Ausgegeben: Titel, Notiz, Aktion und Ende (Verlängern/Verkürzen); Positionen nur ergänzen ' +
			'über die Ausgabe. Abgeschlossene/stornierte → 409.',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: reservationUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			if (body.actionId !== undefined) await checkAction(ctx, body.actionId);
			await mdb().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('material:reservations'))`);
				const row = await requireReservationRow(tx, params.id);
				requireEdit(ctx, row);
				const status = String(row.status) as ReservationStatus;
				if (status !== 'reserved' && status !== 'issued') {
					throw errors.conflict('Die Reservierung ist abgeschlossen');
				}
				if (status === 'issued' && (body.lines || body.startsOn)) {
					throw errors.conflict(
						'Nach der Ausgabe lassen sich Beginn und Positionen nicht mehr ändern'
					);
				}
				const startsOn = body.startsOn ?? dateStr(row.starts_on);
				const endsOn = body.endsOn ?? dateStr(row.ends_on);
				if (endsOn < startsOn) {
					throw errors.validation([{ path: ['endsOn'], message: 'Ende liegt vor dem Beginn' }]);
				}
				const current = await loadReservation(tx, ctx, params.id);
				const lines =
					body.lines ??
					current.lines
						.filter((l) => !l.fromSet)
						.map((l) =>
							l.kind === 'unit'
								? { kind: 'unit' as const, unitId: l.unitId! }
								: l.kind === 'set'
									? { kind: 'set' as const, setId: l.setId! }
									: { kind: 'article' as const, articleId: l.articleId!, quantity: l.quantity }
						);
				if (status === 'reserved') {
					await assertLinesAvailable(tx, {
						startsOn,
						endsOn,
						excludeId: params.id,
						lines: await withSetBulk(tx, lines)
					});
				} else if (body.endsOn && body.endsOn > dateStr(row.ends_on)) {
					// Verlängern: noch nicht zurückgegebene Stücke und Mengen im neuen Zeitraum prüfen
					const index = await loadPlaceIndex(tx);
					const out = new Set(current.assigned.filter((a) => !a.returnedAt).map((a) => a.unit.id));
					const top = [...out].filter(
						(id) => !effectivePlace(index.units, id).chain.some((c) => out.has(c))
					);
					await assertLinesAvailable(tx, {
						startsOn: addDays(dateStr(row.ends_on), 1),
						endsOn,
						excludeId: params.id,
						lines: [
							...top.map((unitId) => ({ kind: 'unit' as const, unitId })),
							...current.lines
								.filter((l) => l.kind === 'article' && l.articleKind === 'bulk')
								.map((l) => ({
									kind: 'article' as const,
									articleId: l.articleId!,
									quantity: Math.max(1, l.issuedQty - l.returnedQty)
								}))
						]
					});
				}
				const sets = [sql`updated_at = now()`];
				if (body.title !== undefined) sets.push(sql`title = ${body.title}`);
				if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
				if (body.actionId !== undefined) sets.push(sql`action_id = ${body.actionId}`);
				if (body.startsOn !== undefined) sets.push(sql`starts_on = ${body.startsOn}`);
				if (body.endsOn !== undefined)
					sets.push(sql`ends_on = ${body.endsOn}, overdue_notified_on = NULL`);
				await tx.execute(
					sql`UPDATE reservations SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
				);
				if (body.lines) await replaceLines(tx, params.id, body.lines);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body).sort() }
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/cancel',
		summary: 'Reservierung stornieren (nur vor der Ausgabe)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Reservation> => {
			await mdb().transaction(async (tx) => {
				const row = await requireReservationRow(tx, params.id);
				requireEdit(ctx, row);
				if (String(row.status) !== 'reserved') {
					throw errors.conflict('Nur noch nicht ausgegebene Reservierungen lassen sich stornieren');
				}
				await tx.execute(
					sql`UPDATE reservations SET status = 'cancelled', updated_at = now() WHERE id = ${params.id}`
				);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.cancelled', { target: params.id });
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/reservations/:id',
		summary: 'Stornierte Reservierung endgültig löschen (Verwaltung)',
		tags,
		permission: PERMISSIONS.reservations,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const row = await requireReservationRow(tx, params.id);
				if (String(row.status) !== 'cancelled') {
					throw errors.conflict('Nur stornierte Reservierungen lassen sich löschen');
				}
				await tx.execute(sql`DELETE FROM reservations WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.deleted', { target: params.id });
			return { deleted: true, canManage: canHandleAll(ctx) };
		}
	})
];
