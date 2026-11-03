/**
 * Reservierungen: Laden (Liste/Detail), Verfügbarkeit prüfen, Katalog für das Reservieren, Zweck
 * (Aktion/Gruppe) prüfen und auflösen. Funktionen mit `ctx` rufen Dienste und `core.*` selbst
 * AUSSERHALB der Modul-Transaktionen auf.
 */
import { sql, type SQL } from 'drizzle-orm';
import { CoreError, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import { describePicks, previewPlan } from './assign.service';
import { slotInfo } from './assignment';
import { AvailabilityIndex } from './availability';
import {
	actionsService,
	bool,
	canManage,
	canManageReservations,
	dateStr,
	idList,
	iso,
	isoOrNull,
	likePattern,
	mdb,
	membersService,
	num,
	rows,
	str,
	today,
	userNames,
	type Row
} from './db';
import { imagesFor, loadBookings, loadItems, loadStock, loadTents, loadTypes } from './inventory';
import type { reservationListQuery } from './schemas';
import {
	PERMISSIONS,
	isUsableCondition,
	reservationState,
	type Catalog,
	type CatalogEntry,
	type CatalogSet,
	type ConsumableUse,
	type LineAssignment,
	type LineAvailability,
	type Purpose,
	type PurposeOptions,
	type Reservation,
	type ReservationLine,
	type ReservationLineInput,
	type ReservationListItem,
	type ReservationPage,
	type ReservationStatus
} from './schemas';
import { expandTent, tentFree, type TentPartSpec } from './tents';
import type { z } from 'zod';

export type ReservationListQuery = z.output<typeof reservationListQuery>;

/** Ändern/Stornieren: Ersteller*in (mit Reservierungsrecht) oder Verwaltung */
export function canEditReservation(ctx: RequestContext, createdBy: string | null): boolean {
	if (canManageReservations(ctx)) return true;
	return ctx.permissions.has(PERMISSIONS.reserve) && !!ctx.userId && createdBy === ctx.userId;
}

// --- Zweck: Aktion und Gruppe ----------------------------------------------------

export async function actionNames(ids: (string | null)[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((x): x is string => !!x))];
	if (!unique.length) return new Map();
	const service = await actionsService();
	if (!service) return new Map();
	return new Map((await service.listActionRefs({ ids: unique })).map((a) => [a.id, a.name]));
}

export async function groupNames(ids: (string | null)[]): Promise<Map<string, string>> {
	if (!ids.some(Boolean)) return new Map();
	const service = await membersService();
	if (!service) return new Map();
	return new Map((await service.listGroups()).map((g) => [g.id, g.name]));
}

/** Aktion (für `ctx` sichtbar) bzw. Gruppe (existiert) prüfen; vor der Transaktion */
export async function checkPurpose(
	ctx: RequestContext,
	input: { actionId: string | null; groupId: string | null }
): Promise<void> {
	if (input.actionId) {
		const service = await actionsService();
		if (!service)
			throw errors.validation([{ path: ['actionId'], message: 'Aktionen sind nicht aktiv' }]);
		const [a] = await service.accessibleActions(ctx, { ids: [input.actionId] });
		if (!a) throw errors.validation([{ path: ['actionId'], message: 'Aktion nicht gefunden' }]);
	}
	if (input.groupId) {
		const service = await membersService();
		if (!service)
			throw errors.validation([{ path: ['groupId'], message: 'Gruppen sind nicht aktiv' }]);
		const groups = await service.listGroups();
		if (!groups.some((g) => g.id === input.groupId)) {
			throw errors.validation([{ path: ['groupId'], message: 'Gruppe nicht gefunden' }]);
		}
	}
}

/** Auswahl für den Zweck: sichtbare, nicht lange vergangene Aktionen und alle Gruppen */
export async function purposeOptions(ctx: RequestContext): Promise<PurposeOptions> {
	const [actions, members] = await Promise.all([actionsService(), membersService()]);
	const cutoff = today();
	const list = actions ? await actions.accessibleActions(ctx) : [];
	const groups = members ? await members.listGroups() : [];
	return {
		actionsActive: !!actions,
		groupsActive: !!members,
		actions: list
			.filter((a) => (a.endsOn ?? a.startsOn) >= cutoff)
			.sort((a, b) => a.startsOn.localeCompare(b.startsOn))
			.map((a) => ({ id: a.id, name: a.name, startsOn: a.startsOn, endsOn: a.endsOn })),
		groups: groups
			.map((g) => ({ id: g.id, name: g.name, color: g.color }))
			.sort((a, b) => a.name.localeCompare(b.name, 'de'))
	};
}

// --- Laden -----------------------------------------------------------------------------

interface RawReservation {
	id: string;
	title: string;
	purpose: Purpose;
	actionId: string | null;
	groupId: string | null;
	startsOn: string;
	endsOn: string;
	status: ReservationStatus;
	notes: string;
	createdBy: string | null;
	createdAt: string;
	handedOutAt: string | null;
	handedOutBy: string | null;
	returnedAt: string | null;
	returnedBy: string | null;
}

const RES_SELECT = sql`SELECT r.id, r.title, r.purpose, r.action_id, r.group_id,
		to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on,
		r.status, r.notes, r.created_by, r.created_at, r.handed_out_at, r.handed_out_by,
		r.returned_at, r.returned_by
	FROM reservations r`;

const toRaw = (r: Row): RawReservation => ({
	id: String(r.id),
	title: String(r.title),
	purpose: String(r.purpose) as Purpose,
	actionId: str(r.action_id) || null,
	groupId: str(r.group_id) || null,
	startsOn: dateStr(r.starts_on),
	endsOn: dateStr(r.ends_on),
	status: String(r.status) as ReservationStatus,
	notes: str(r.notes),
	createdBy: str(r.created_by) || null,
	createdAt: iso(r.created_at),
	handedOutAt: isoOrNull(r.handed_out_at),
	handedOutBy: str(r.handed_out_by) || null,
	returnedAt: isoOrNull(r.returned_at),
	returnedBy: str(r.returned_by) || null
});

/**
 * Verbrauchsmaterial einer Reservierung je Artikel: gezielte Artikel-Zeilen und Zuteilungen (auch in
 * Zelten), dazu der Verbrauch aus der Rücknahme
 */
export async function loadConsumables(
	tx: Tx,
	reservationId: string,
	returned: boolean
): Promise<ConsumableUse[]> {
	const list = await rows(
		tx,
		sql`SELECT i.id, i.name, i.code, i.unit, sum(x.quantity) AS issued
			FROM (
				SELECT item_id, quantity FROM reservation_lines
					WHERE reservation_id = ${reservationId} AND item_id IS NOT NULL
				UNION ALL SELECT item_id, quantity FROM reservation_assignments
					WHERE reservation_id = ${reservationId}
			) x JOIN items i ON i.id = x.item_id
			WHERE i.consumable
			GROUP BY i.id, i.name, i.code, i.unit
			ORDER BY lower(i.name), i.code`
	);
	const used = new Map(
		(
			await rows(
				tx,
				sql`SELECT item_id, sum(quantity) AS n FROM consumptions
					WHERE reservation_id = ${reservationId} AND item_id IS NOT NULL GROUP BY item_id`
			)
		).map((r) => [String(r.item_id), num(r.n)])
	);
	return list.map((r) => ({
		itemId: String(r.id),
		name: String(r.name),
		code: String(r.code),
		unit: str(r.unit),
		issued: num(r.issued),
		consumed: returned ? (used.get(String(r.id)) ?? 0) : null
	}));
}

/** Ausgabe markieren, Zuteilung ändern: Verwaltung der Reservierungen oder des Lagers */
export const canHandOut = (ctx: RequestContext) => canManageReservations(ctx) || canManage(ctx);

/**
 * Zeilen je Reservierung (oberste Ebene; Zelt-Zeilen enthalten ihre Teile) mit Namen, Code, Ort,
 * Vorschaubild und zugeteilten Artikeln
 */
export async function loadLines(tx: Tx, ids: string[]): Promise<Map<string, ReservationLine[]>> {
	const map = new Map<string, ReservationLine[]>();
	if (!ids.length) return map;
	const list = await rows(
		tx,
		sql`SELECT l.id, l.reservation_id, l.type_id, l.item_id, l.tent_id, l.parent_line_id, l.label,
				l.slot_size, l.quantity, coalesce(i.name, t.name, z.name) AS name, i.code,
				coalesce(i.consumable, t.consumable, false) AS consumable, coalesce(i.unit, t.unit, '') AS unit,
				loc.name AS location_name, coalesce(i.type_id, l.type_id) AS cover_type
			FROM reservation_lines l
			LEFT JOIN types t ON t.id = l.type_id
			LEFT JOIN items i ON i.id = l.item_id
			LEFT JOIN tents z ON z.id = l.tent_id
			LEFT JOIN locations loc ON loc.id = i.location_id
			WHERE l.reservation_id IN (${idList(ids)})
			ORDER BY l.position, l.id`
	);
	const assigned = await rows(
		tx,
		sql`SELECT a.line_id, a.item_id, a.quantity, a.pinned, a.slot, i.name, i.code, i.set_id,
				s.name AS set_name, loc.name AS location_name
			FROM reservation_assignments a
			JOIN items i ON i.id = a.item_id
			LEFT JOIN sets s ON s.id = i.set_id
			LEFT JOIN locations loc ON loc.id = i.location_id
			WHERE a.reservation_id IN (${idList(ids)})
			ORDER BY a.slot, lower(i.name), i.code`
	);
	const typeIds = [...new Set(list.map((r) => str(r.type_id)).filter(Boolean))];
	const withSets = new Set(
		typeIds.length
			? (
					await rows(
						tx,
						sql`SELECT DISTINCT type_id FROM items
							WHERE set_id IS NOT NULL AND archived_at IS NULL AND type_id IN (${idList(typeIds)})`
					)
				).map((r) => String(r.type_id))
			: []
	);
	const byLine = new Map<string, LineAssignment[]>();
	for (const a of assigned) {
		const arr = byLine.get(String(a.line_id)) ?? [];
		arr.push({
			itemId: String(a.item_id),
			name: String(a.name),
			code: String(a.code),
			setId: str(a.set_id) || null,
			setName: str(a.set_name) || null,
			locationName: str(a.location_name) || null,
			quantity: num(a.quantity),
			pinned: bool(a.pinned),
			slot: num(a.slot)
		});
		byLine.set(String(a.line_id), arr);
	}
	const itemImages = await imagesFor(tx, 'items', list.map((r) => str(r.item_id)).filter(Boolean));
	const typeImages = await imagesFor(
		tx,
		'types',
		list.map((r) => str(r.cover_type)).filter(Boolean)
	);
	const byId = new Map<string, ReservationLine>();
	const top: { reservationId: string; line: ReservationLine }[] = [];
	for (const r of list) {
		const id = String(r.id);
		const itemId = str(r.item_id) || null;
		const typeId = str(r.type_id) || null;
		const tentId = str(r.tent_id) || null;
		const cover =
			(itemId ? itemImages.get(itemId)?.[0] : undefined) ?? typeImages.get(str(r.cover_type))?.[0];
		const quantity = num(r.quantity);
		const assignments = byLine.get(id) ?? [];
		const slotSize = r.slot_size === null || r.slot_size === undefined ? null : num(r.slot_size);
		const info = slotInfo(
			assignments,
			(itemId) => assignments.find((a) => a.itemId === itemId)?.setId ?? null,
			slotSize,
			quantity,
			!!typeId && withSets.has(typeId)
		);
		const line: ReservationLine = {
			id,
			kind: tentId ? 'tent' : itemId ? 'item' : 'type',
			typeId,
			itemId,
			tentId,
			name: str(r.name),
			label: str(r.label),
			code: str(r.code) || null,
			locationName: str(r.location_name) || null,
			quantity,
			consumable: bool(r.consumable),
			unit: str(r.unit),
			thumbUrl: cover?.thumbUrl ?? null,
			assignments,
			missing: typeId ? Math.max(0, quantity - assignments.reduce((n, a) => n + a.quantity, 0)) : 0,
			slotSize,
			mixedSlots: info.mixedSlots,
			parts: []
		};
		byId.set(id, line);
		const parent = str(r.parent_line_id);
		if (!parent) top.push({ reservationId: String(r.reservation_id), line });
	}
	for (const r of list) {
		const parent = str(r.parent_line_id);
		if (parent) byId.get(parent)?.parts.push(byId.get(String(r.id))!);
	}
	for (const { reservationId, line } of top) {
		const arr = map.get(reservationId) ?? [];
		arr.push(line);
		map.set(reservationId, arr);
	}
	return map;
}

/** Hinweise zur Zuteilung für die Detailansicht */
export function lineNotices(lines: ReservationLine[]): string[] {
	const out: string[] = [];
	const missing = (l: ReservationLine, prefix: string) => {
		if (l.kind === 'type' && l.missing > 0) {
			out.push(`${prefix}${l.label || l.name}: ${l.missing} noch nicht zugeteilt`);
		}
	};
	for (const l of lines) {
		if (l.kind !== 'tent') {
			missing(l, '');
			continue;
		}
		const mixed = Math.max(0, ...l.parts.map((p) => p.mixedSlots));
		if (mixed > 0) {
			out.push(
				l.quantity === 1
					? `${l.name}: kein vollständiges Set frei – aus Teilen verschiedener Sets zusammengestellt`
					: `${l.name}: ${mixed} von ${l.quantity} aus Teilen verschiedener Sets zusammengestellt`
			);
		}
		for (const p of l.parts) missing(p, `${l.name} – `);
	}
	return out;
}

export async function requireReservationRow(tx: Tx, id: string): Promise<RawReservation> {
	const [r] = await rows(tx, sql`${RES_SELECT} WHERE r.id = ${id}`);
	if (!r) throw errors.notFound('Reservierung nicht gefunden');
	return toRaw(r);
}

/** Detail mit Namen (Benutzer, Aktion, Gruppe) – eigene Transaktion, Dienste danach */
export async function fullReservation(ctx: RequestContext, id: string): Promise<Reservation> {
	const { raw, lines, consumables } = await mdb().transaction(async (tx) => {
		const raw = await requireReservationRow(tx, id);
		const lines = (await loadLines(tx, [id])).get(id) ?? [];
		const consumables = await loadConsumables(tx, id, !!raw.returnedAt);
		return { raw, lines, consumables };
	});
	const [users, actions, groups] = await Promise.all([
		userNames(ctx, [raw.createdBy, raw.handedOutBy, raw.returnedBy]),
		actionNames([raw.actionId]),
		groupNames([raw.groupId])
	]);
	const { handedOutBy, returnedBy, ...rest } = raw;
	return {
		...rest,
		state: reservationState(raw, today()),
		actionName: raw.actionId ? (actions.get(raw.actionId) ?? null) : null,
		groupName: raw.groupId ? (groups.get(raw.groupId) ?? null) : null,
		createdByName: raw.createdBy ? (users.get(raw.createdBy) ?? 'Unbekannt') : 'Unbekannt',
		handedOutByName: handedOutBy ? (users.get(handedOutBy) ?? 'Unbekannt') : null,
		returnedByName: returnedBy ? (users.get(returnedBy) ?? 'Unbekannt') : null,
		consumables,
		lines,
		canEdit:
			raw.status === 'reserved' && !raw.handedOutAt && canEditReservation(ctx, raw.createdBy),
		canHandOut: raw.status === 'reserved' && canHandOut(ctx),
		notices: raw.status === 'reserved' ? lineNotices(lines) : []
	};
}

export function summarizeLines(lines: ReservationLine[], max = 4): string {
	const parts = lines.map((l) => (l.quantity > 1 ? `${l.quantity} × ${l.name}` : l.name));
	return (
		parts.slice(0, max).join(', ') +
		(parts.length > max ? ` und ${parts.length - max} weitere` : '')
	);
}

async function toListItems(
	ctx: RequestContext,
	raws: RawReservation[],
	lines: Map<string, ReservationLine[]>
): Promise<ReservationListItem[]> {
	const [users, actions, groups] = await Promise.all([
		userNames(
			ctx,
			raws.map((r) => r.createdBy)
		),
		actionNames(raws.map((r) => r.actionId)),
		groupNames(raws.map((r) => r.groupId))
	]);
	const t = today();
	return raws.map((r) => {
		const l = lines.get(r.id) ?? [];
		return {
			id: r.id,
			title: r.title,
			startsOn: r.startsOn,
			endsOn: r.endsOn,
			status: r.status,
			state: reservationState(r, t),
			purpose: r.purpose,
			actionId: r.actionId,
			actionName: r.actionId ? (actions.get(r.actionId) ?? null) : null,
			groupId: r.groupId,
			groupName: r.groupId ? (groups.get(r.groupId) ?? null) : null,
			createdByName: r.createdBy ? (users.get(r.createdBy) ?? 'Unbekannt') : 'Unbekannt',
			lineCount: l.length,
			itemSummary: summarizeLines(l),
			mine: !!ctx.userId && r.createdBy === ctx.userId,
			canEdit: r.status === 'reserved' && !r.handedOutAt && canEditReservation(ctx, r.createdBy),
			handedOut: !!r.handedOutAt,
			returned: !!r.returnedAt
		};
	});
}

/** Liste nach Filter; `scope: 'all'` nur mit Verwaltungsrecht (sonst 403) */
export async function listReservations(
	ctx: RequestContext,
	q: Omit<ReservationListQuery, 'scope' | 'state'> & {
		scope: 'mine' | 'all';
		state: ReservationListQuery['state'];
		/** Nur diese Aktion (Karte in der Aktion; Zugriff prüft der Aufrufer) */
		actionId?: string;
	}
): Promise<ReservationPage> {
	if (q.scope === 'all' && !canManageReservations(ctx) && !q.actionId) {
		throw errors.forbidden('Alle Reservierungen nur mit Verwaltungsrecht');
	}
	const t = today();
	const where: SQL[] = [];
	if (q.scope === 'mine') where.push(sql`r.created_by = ${ctx.userId ?? ''}`);
	if (q.actionId) where.push(sql`r.action_id = ${q.actionId}`);
	if (q.state === 'open') where.push(sql`r.status = 'reserved' AND r.ends_on >= ${t}::date`);
	if (q.state === 'past') where.push(sql`r.status = 'reserved' AND r.ends_on < ${t}::date`);
	if (q.state === 'cancelled') where.push(sql`r.status = 'cancelled'`);
	if (q.purpose) where.push(sql`r.purpose = ${q.purpose}`);
	if (q.from) where.push(sql`r.ends_on >= ${q.from}::date`);
	if (q.to) where.push(sql`r.starts_on <= ${q.to}::date`);
	if (q.search) where.push(sql`r.title ILIKE ${likePattern(q.search)}`);
	const cond = where.length ? sql.join(where, sql` AND `) : sql`TRUE`;
	const order = q.state === 'past' || q.state === 'cancelled' ? sql`DESC` : sql`ASC`;
	const { raws, lines, total } = await mdb().transaction(async (tx) => {
		const [c] = await rows(tx, sql`SELECT count(*) AS n FROM reservations r WHERE ${cond}`);
		const raws = (
			await rows(
				tx,
				sql`${RES_SELECT} WHERE ${cond} ORDER BY r.starts_on ${order}, r.created_at ${order}, r.id
					LIMIT ${q.limit} OFFSET ${q.offset}`
			)
		).map(toRaw);
		const lines = await loadLines(
			tx,
			raws.map((r) => r.id)
		);
		return { raws, lines, total: num(c?.n) };
	});
	return { items: await toListItems(ctx, raws, lines), total };
}

// --- Zelte in Teile auflösen ------------------------------------------------------------

interface TentInfo {
	name: string;
	archived: boolean;
	parts: (TentPartSpec & { name: string })[];
}

/** Baupläne der genannten Zelte */
export async function loadTentSpecs(tx: Tx, ids: string[]): Promise<Map<string, TentInfo>> {
	const map = new Map<string, TentInfo>();
	const unique = [...new Set(ids)];
	if (!unique.length) return map;
	for (const r of await rows(
		tx,
		sql`SELECT id, name, archived_at FROM tents WHERE id IN (${idList(unique)})`
	)) {
		map.set(String(r.id), { name: String(r.name), archived: !!r.archived_at, parts: [] });
	}
	for (const p of await rows(
		tx,
		sql`SELECT p.tent_id, p.label, p.type_id, p.item_id, p.quantity, p.from_one_set,
				coalesce(t.name, i.name) AS name
			FROM tent_parts p LEFT JOIN types t ON t.id = p.type_id LEFT JOIN items i ON i.id = p.item_id
			WHERE p.tent_id IN (${idList(unique)}) ORDER BY p.position, p.id`
	)) {
		map.get(String(p.tent_id))?.parts.push({
			label: str(p.label),
			typeId: str(p.type_id) || null,
			itemId: str(p.item_id) || null,
			quantity: num(p.quantity),
			fromOneSet: bool(p.from_one_set),
			name: str(p.name)
		});
	}
	return map;
}

/** Flache Zeile für Prüfung/Zuteilung; `source` = Index der Eingabezeile */
interface FlatLine {
	source: number;
	label: string;
	name: string;
	typeId: string | null;
	itemId: string | null;
	quantity: number;
	slotSize: number | null;
}

function flatten(lines: ReservationLineInput[], tents: Map<string, TentInfo>): FlatLine[] {
	const out: FlatLine[] = [];
	lines.forEach((l, source) => {
		if (l.kind === 'type') {
			out.push({
				source,
				label: '',
				name: '',
				typeId: l.typeId,
				itemId: null,
				quantity: l.quantity,
				slotSize: null
			});
		} else if (l.kind === 'item') {
			out.push({
				source,
				label: '',
				name: '',
				typeId: null,
				itemId: l.itemId,
				quantity: l.quantity,
				slotSize: null
			});
		} else {
			const tent = tents.get(l.tentId);
			if (!tent) return;
			expandTent(tent.parts, l.quantity).forEach((p, k) => {
				out.push({ source, name: tent.parts[k]!.name, ...p });
			});
		}
	});
	return out;
}

// --- Verfügbarkeit ----------------------------------------------------------------------

/** Je Zeile prüfen (innerhalb der Transaktion); Meldungen mit Namen, auf Wunsch mit Zuteilungs-Vorschau */
export async function checkLines(
	tx: Tx,
	input: {
		startsOn: string;
		endsOn: string;
		excludeReservationId?: string | null;
		lines: ReservationLineInput[];
	},
	opts: { preview?: boolean } = {}
): Promise<LineAvailability[]> {
	const period = { from: input.startsOn, to: input.endsOn };
	const stock = await loadStock(tx);
	const bookings = await loadBookings(tx, input.startsOn, input.endsOn, input.excludeReservationId);
	const index = new AvailabilityIndex(stock, bookings);
	const tents = await loadTentSpecs(
		tx,
		input.lines.flatMap((l) => (l.kind === 'tent' ? [l.tentId] : []))
	);
	const flat = flatten(input.lines, tents);
	const typeIds = flat.flatMap((l) => (l.typeId ? [l.typeId] : []));
	const itemIds = flat.flatMap((l) => (l.itemId ? [l.itemId] : []));
	const names = new Map<string, { name: string; archived: boolean }>();
	if (typeIds.length || itemIds.length) {
		for (const r of await rows(
			tx,
			sql`SELECT id, name, archived_at FROM types WHERE id::text IN (${sql.join(
				[...typeIds, ''].map((v) => sql`${v}`),
				sql`, `
			)})
				UNION ALL SELECT id, name, archived_at FROM items WHERE id::text IN (${sql.join(
					[...itemIds, ''].map((v) => sql`${v}`),
					sql`, `
				)})`
		)) {
			names.set(String(r.id), { name: String(r.name), archived: !!r.archived_at });
		}
	}
	const checks = index.check(
		flat.map((l) => ({ typeId: l.typeId, itemId: l.itemId, quantity: l.quantity })),
		period
	);
	const result: LineAvailability[] = input.lines.map((line, i) => {
		if (line.kind === 'tent') {
			const tent = tents.get(line.tentId);
			if (!tent)
				return { index: i, ok: false, available: 0, message: 'Nicht gefunden', note: null };
			if (tent.archived) {
				return {
					index: i,
					ok: false,
					available: 0,
					message: `${tent.name} ist archiviert`,
					note: null
				};
			}
			const own = flat.map((f, k) => ({ f, c: checks[k]! })).filter((x) => x.f.source === i);
			const bad = own.find(
				(x) => !x.c.ok || names.get((x.f.typeId ?? x.f.itemId)!)?.archived !== false
			);
			if (!bad) {
				return { index: i, ok: true, available: line.quantity, message: null, note: null };
			}
			const part = names.get((bad.f.typeId ?? bad.f.itemId)!);
			const available = Math.min(
				line.quantity - 1,
				tentFree(index, tent.parts, period, line.quantity)
			);
			const what = part?.name ?? 'Ein Teil';
			const message = !part
				? `${tent.name}: ein Teil gibt es nicht mehr`
				: part.archived
					? `${tent.name}: ${what} ist archiviert`
					: `${tent.name}: ${what} reicht im Zeitraum nur für ${Math.max(0, available)}`;
			return { index: i, ok: false, available: Math.max(0, available), message, note: null };
		}
		const k = flat.findIndex((f) => f.source === i);
		const c = checks[k]!;
		const id = line.kind === 'type' ? line.typeId : line.itemId;
		const known = names.get(id);
		if (!known) return { index: i, ok: false, available: 0, message: 'Nicht gefunden', note: null };
		if (known.archived) {
			return {
				index: i,
				ok: false,
				available: 0,
				message: `${known.name} ist archiviert`,
				note: null
			};
		}
		const message = c.ok
			? null
			: c.available === 0
				? `${known.name} ist im Zeitraum nicht frei`
				: `Von ${known.name} sind im Zeitraum nur ${c.available} frei`;
		return { index: i, ok: c.ok, available: c.available, message, note: null };
	});
	if (opts.preview && result.every((r) => r.ok) && flat.length) {
		await addPreviewNotes(tx, input, flat, result);
	}
	return result;
}

/** Voraussichtliche Zuteilung als Hinweis je Zeile („Set KJ1“, „gemischt …“) */
async function addPreviewNotes(
	tx: Tx,
	input: {
		startsOn: string;
		endsOn: string;
		excludeReservationId?: string | null;
		lines: ReservationLineInput[];
	},
	flat: FlatLine[],
	result: LineAvailability[]
): Promise<void> {
	const { plan, items, typesWithSets } = await previewPlan(tx, {
		startsOn: input.startsOn,
		endsOn: input.endsOn,
		excludeReservationId: input.excludeReservationId,
		requests: flat.map((f, k) => ({
			key: String(k),
			typeId: f.typeId,
			itemId: f.itemId,
			quantity: f.quantity,
			slotSize: f.slotSize
		}))
	});
	const setName = (itemId: string) => items.get(itemId)?.setName ?? null;
	const setId = (itemId: string) => items.get(itemId)?.setId ?? null;
	input.lines.forEach((line, i) => {
		const own = flat
			.map((f, k) => ({ f, picks: plan.get(String(k)) ?? [] }))
			.filter((x) => x.f.source === i);
		if (line.kind === 'type') {
			const picks = own[0]?.picks ?? [];
			// Nur erwähnenswert, wenn es für den Typ Sets gibt
			if (typesWithSets.has(line.typeId)) result[i]!.note = describePicks(picks, setName);
			return;
		}
		if (line.kind !== 'tent') return;
		let mixed = 0;
		const sets = new Set<string>();
		for (const { f, picks } of own) {
			if (!f.slotSize || !f.typeId) continue;
			const info = slotInfo(picks, setId, f.slotSize, f.quantity, typesWithSets.has(f.typeId));
			mixed = Math.max(mixed, info.mixedSlots);
			for (const p of picks) {
				const n = setName(p.itemId);
				if (n) sets.add(n);
			}
		}
		const names = [...sets].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
		if (mixed > 0) {
			result[i]!.note =
				`Kein vollständiges Set frei – ${mixed === line.quantity ? (mixed === 1 ? 'wird' : 'alle werden') : `${mixed} von ${line.quantity} werden`} aus Teilen verschiedener Sets zusammengestellt`;
		} else if (names.length) {
			result[i]!.note =
				names.length === 1 ? `aus Set ${names[0]}` : `aus den Sets ${names.join(', ')}`;
		}
	});
}

/** 409 mit `details.lines`, wenn eine Zeile nicht passt */
export async function assertLinesAvailable(
	tx: Tx,
	input: Parameters<typeof checkLines>[1]
): Promise<void> {
	const checks = await checkLines(tx, input);
	const bad = checks.filter((c) => !c.ok);
	if (bad.length) {
		throw new CoreError('conflict', bad.map((c) => c.message ?? 'Nicht verfügbar').join(' · '), {
			lines: checks
		});
	}
}

// --- Katalog ------------------------------------------------------------------------------

export async function loadCatalog(
	tx: Tx,
	q: { from: string; to: string; excludeReservationId?: string }
): Promise<Catalog> {
	const p = { from: q.from, to: q.to };
	const stock = await loadStock(tx);
	const index = new AvailabilityIndex(
		stock,
		await loadBookings(tx, q.from, q.to, q.excludeReservationId)
	);
	const types = await loadTypes(tx, sql`t.archived_at IS NULL`);
	const items = await loadItems(tx, sql`i.archived_at IS NULL`);
	const byType = new Map<string, typeof items>();
	for (const item of items) {
		if (!item.typeId) continue;
		const list = byType.get(item.typeId) ?? [];
		list.push(item);
		byType.set(item.typeId, list);
	}
	const entries: CatalogEntry[] = [];
	for (const t of types) {
		const members = byType.get(t.id) ?? [];
		const typeFree = Math.max(0, index.freeType(t.id, p));
		const catalogItems = members.map((m) => ({
			id: m.id,
			name: m.name,
			code: m.code,
			quantity: m.quantity,
			free: Math.max(0, Math.min(index.freeItem(m.id, p), typeFree)),
			locationName: m.locationName,
			condition: m.condition,
			thumbUrl: m.thumbUrl,
			setId: m.setId,
			setName: m.setName
		}));
		const sets = new Map<string, CatalogSet>();
		for (const m of catalogItems) {
			if (!m.setId || !isUsableCondition(m.condition)) continue;
			const s = sets.get(m.setId) ?? {
				id: m.setId,
				name: m.setName ?? '',
				itemIds: [],
				size: 0,
				wholeFree: true
			};
			s.itemIds.push(m.id);
			s.size += m.quantity;
			if (m.free < m.quantity) s.wholeFree = false;
			sets.set(m.setId, s);
		}
		entries.push({
			kind: 'type',
			id: t.id,
			name: t.name,
			description: t.description,
			category: t.category,
			images: t.images,
			thumbUrl: t.images[0]?.thumbUrl ?? members.find((m) => m.thumbUrl)?.thumbUrl ?? null,
			total: index.totalType(t.id),
			free: typeFree,
			consumable: t.consumable,
			unit: t.unit,
			items: catalogItems,
			code: null,
			locationName: null,
			sets: [...sets.values()].sort((a, b) =>
				a.name.localeCompare(b.name, 'de', { numeric: true })
			),
			parts: []
		});
	}
	for (const m of items.filter((i) => !i.typeId)) {
		entries.push({
			kind: 'item',
			id: m.id,
			name: m.name,
			description: m.notes,
			category: m.category,
			images: m.images,
			thumbUrl: m.thumbUrl,
			total: index.totalItem(m.id),
			free: Math.max(0, index.freeItem(m.id, p)),
			consumable: m.consumable,
			unit: m.unit,
			items: [],
			code: m.code,
			locationName: m.locationName,
			sets: [],
			parts: []
		});
	}
	const tents = await loadTents(tx, sql`z.archived_at IS NULL`);
	const unbooked = new AvailabilityIndex(stock, []);
	for (const z of tents) {
		entries.push({
			kind: 'tent',
			id: z.id,
			name: z.name,
			description: z.description,
			category: z.category,
			images: [],
			thumbUrl: z.thumbUrl,
			total: tentFree(unbooked, z.parts, p),
			free: tentFree(index, z.parts, p),
			consumable: false,
			unit: '',
			items: [],
			code: null,
			locationName: null,
			sets: [],
			parts: z.parts.map((part) => ({
				label: part.label,
				name: part.name,
				quantity: part.quantity,
				fromOneSet: part.fromOneSet
			}))
		});
	}
	entries.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
	return { from: q.from, to: q.to, entries };
}

// --- Speichern ----------------------------------------------------------------------------

/**
 * Zeilen einer Reservierung ersetzen (zusammengefasst je Typ/Artikel/Zelt). Zelt-Zeilen bekommen ihre
 * Teil-Zeilen. Bisherige Zuteilungen gleicher Typ-Zeilen (bzw. gleicher Zelt-Teile) werden übernommen,
 * angeheftete nur bei gleichem Zeitraum (`keepPins`). Danach `reassignAll` aufrufen.
 */
export async function replaceLines(
	tx: Tx,
	reservationId: string,
	lines: ReservationLineInput[],
	opts: { keepPins?: boolean } = {}
): Promise<void> {
	const old = await rows(
		tx,
		sql`SELECT a.item_id, a.quantity, a.pinned, a.slot, l.type_id, l.label, p.tent_id AS parent_tent
			FROM reservation_assignments a
			JOIN reservation_lines l ON l.id = a.line_id
			LEFT JOIN reservation_lines p ON p.id = l.parent_line_id
			WHERE a.reservation_id = ${reservationId}
			ORDER BY a.pinned DESC, a.slot, a.id`
	);
	const keyOf = (typeId: string, tentId: string | null, label: string) =>
		tentId ? `z:${tentId}:${typeId}:${label}` : `t:${typeId}`;
	const carried = new Map<
		string,
		{ itemId: string; quantity: number; pinned: boolean; slot: number }[]
	>();
	for (const a of old) {
		const key = keyOf(String(a.type_id), str(a.parent_tent) || null, str(a.label));
		const list = carried.get(key) ?? [];
		list.push({
			itemId: String(a.item_id),
			quantity: num(a.quantity),
			pinned: bool(a.pinned) && !!opts.keepPins,
			slot: num(a.slot)
		});
		carried.set(key, list);
	}
	await tx.execute(sql`DELETE FROM reservation_lines WHERE reservation_id = ${reservationId}`);
	const merged = mergeLines(lines);
	const tents = await loadTentSpecs(
		tx,
		merged.flatMap((l) => (l.kind === 'tent' ? [l.tentId] : []))
	);
	let position = 0;
	const insert = async (row: {
		typeId: string | null;
		itemId: string | null;
		tentId: string | null;
		parentId: string | null;
		label: string;
		slotSize: number | null;
		quantity: number;
	}) => {
		const id = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO reservation_lines (id, reservation_id, type_id, item_id, tent_id, parent_line_id,
					label, slot_size, quantity, position)
				VALUES (${id}, ${reservationId}, ${row.typeId}, ${row.itemId}, ${row.tentId}, ${row.parentId},
					${row.label}, ${row.slotSize}, ${row.quantity}, ${position++})`
		);
		return id;
	};
	const carryOver = async (lineId: string, key: string, quantity: number) => {
		let left = quantity;
		for (const a of carried.get(key) ?? []) {
			if (left <= 0) break;
			const n = Math.min(a.quantity, left);
			left -= n;
			await tx.execute(
				sql`INSERT INTO reservation_assignments (id, reservation_id, line_id, item_id, quantity, pinned, slot)
					VALUES (${crypto.randomUUID()}, ${reservationId}, ${lineId}, ${a.itemId}, ${n}, ${a.pinned}, ${a.slot})`
			);
		}
		carried.delete(key);
	};
	for (const l of merged) {
		if (l.kind === 'item') {
			await insert({
				typeId: null,
				itemId: l.itemId,
				tentId: null,
				parentId: null,
				label: '',
				slotSize: null,
				quantity: l.quantity
			});
			continue;
		}
		if (l.kind === 'type') {
			const id = await insert({
				typeId: l.typeId,
				itemId: null,
				tentId: null,
				parentId: null,
				label: '',
				slotSize: null,
				quantity: l.quantity
			});
			await carryOver(id, keyOf(l.typeId, null, ''), l.quantity);
			continue;
		}
		const tent = tents.get(l.tentId);
		if (!tent) continue;
		const parentId = await insert({
			typeId: null,
			itemId: null,
			tentId: l.tentId,
			parentId: null,
			label: '',
			slotSize: null,
			quantity: l.quantity
		});
		for (const part of expandTent(tent.parts, l.quantity)) {
			const id = await insert({
				typeId: part.typeId,
				itemId: part.itemId,
				tentId: null,
				parentId,
				label: part.label,
				slotSize: part.slotSize,
				quantity: part.quantity
			});
			if (part.typeId) await carryOver(id, keyOf(part.typeId, l.tentId, part.label), part.quantity);
		}
	}
}

/** Gleiche Typen/Artikel/Zelte zusammenfassen (Reihenfolge des ersten Auftretens) */
export function mergeLines(lines: ReservationLineInput[]): ReservationLineInput[] {
	const out = new Map<string, ReservationLineInput>();
	for (const l of lines) {
		const key =
			l.kind === 'type' ? `t:${l.typeId}` : l.kind === 'item' ? `i:${l.itemId}` : `z:${l.tentId}`;
		const prev = out.get(key);
		if (prev) prev.quantity += l.quantity;
		else out.set(key, { ...l });
	}
	return [...out.values()];
}
