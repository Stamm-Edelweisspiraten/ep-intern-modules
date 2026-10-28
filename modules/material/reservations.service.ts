/**
 * Reservierungen: Laden (Liste/Detail), Verfügbarkeit prüfen, Katalog für das Reservieren, Zweck
 * (Aktion/Gruppe) prüfen und auflösen. Funktionen mit `ctx` rufen Dienste und `core.*` selbst
 * AUSSERHALB der Modul-Transaktionen auf.
 */
import { sql, type SQL } from 'drizzle-orm';
import { CoreError, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import { AvailabilityIndex } from './availability';
import {
	actionsService,
	canManageReservations,
	dateStr,
	iso,
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
import { imagesFor, loadBookings, loadItems, loadStock, loadTypes } from './inventory';
import {
	PERMISSIONS,
	reservationListQuery,
	reservationState,
	type Catalog,
	type CatalogEntry,
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
}

const RES_SELECT = sql`SELECT r.id, r.title, r.purpose, r.action_id, r.group_id,
		to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on,
		r.status, r.notes, r.created_by, r.created_at
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
	createdAt: iso(r.created_at)
});

/** Zeilen je Reservierung (Typ- bzw. Artikelname, Code, Ort, Vorschaubild) */
export async function loadLines(tx: Tx, ids: string[]): Promise<Map<string, ReservationLine[]>> {
	const map = new Map<string, ReservationLine[]>();
	if (!ids.length) return map;
	const list = await rows(
		tx,
		sql`SELECT l.id, l.reservation_id, l.type_id, l.item_id, l.quantity,
				coalesce(i.name, t.name) AS name, i.code, loc.name AS location_name,
				coalesce(i.type_id, l.type_id) AS cover_type
			FROM reservation_lines l
			LEFT JOIN types t ON t.id = l.type_id
			LEFT JOIN items i ON i.id = l.item_id
			LEFT JOIN locations loc ON loc.id = i.location_id
			WHERE l.reservation_id IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)})
			ORDER BY l.position, l.id`
	);
	const itemImages = await imagesFor(tx, 'items', list.map((r) => str(r.item_id)).filter(Boolean));
	const typeImages = await imagesFor(
		tx,
		'types',
		list.map((r) => str(r.cover_type)).filter(Boolean)
	);
	for (const r of list) {
		const itemId = str(r.item_id) || null;
		const cover =
			(itemId ? itemImages.get(itemId)?.[0] : undefined) ?? typeImages.get(str(r.cover_type))?.[0];
		const line: ReservationLine = {
			id: String(r.id),
			kind: itemId ? 'item' : 'type',
			typeId: str(r.type_id) || null,
			itemId,
			name: str(r.name),
			code: str(r.code) || null,
			locationName: str(r.location_name) || null,
			quantity: num(r.quantity),
			thumbUrl: cover?.thumbUrl ?? null
		};
		const arr = map.get(String(r.reservation_id)) ?? [];
		arr.push(line);
		map.set(String(r.reservation_id), arr);
	}
	return map;
}

export async function requireReservationRow(tx: Tx, id: string): Promise<RawReservation> {
	const [r] = await rows(tx, sql`${RES_SELECT} WHERE r.id = ${id}`);
	if (!r) throw errors.notFound('Reservierung nicht gefunden');
	return toRaw(r);
}

/** Detail mit Namen (Benutzer, Aktion, Gruppe) – eigene Transaktion, Dienste danach */
export async function fullReservation(ctx: RequestContext, id: string): Promise<Reservation> {
	const { raw, lines } = await mdb().transaction(async (tx) => {
		const raw = await requireReservationRow(tx, id);
		const lines = (await loadLines(tx, [id])).get(id) ?? [];
		return { raw, lines };
	});
	const [users, actions, groups] = await Promise.all([
		userNames(ctx, [raw.createdBy]),
		actionNames([raw.actionId]),
		groupNames([raw.groupId])
	]);
	return {
		...raw,
		state: reservationState(raw, today()),
		actionName: raw.actionId ? (actions.get(raw.actionId) ?? null) : null,
		groupName: raw.groupId ? (groups.get(raw.groupId) ?? null) : null,
		createdByName: raw.createdBy ? (users.get(raw.createdBy) ?? 'Unbekannt') : 'Unbekannt',
		lines,
		canEdit: raw.status === 'reserved' && canEditReservation(ctx, raw.createdBy)
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
			canEdit: r.status === 'reserved' && canEditReservation(ctx, r.createdBy)
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

// --- Verfügbarkeit ----------------------------------------------------------------------

/** Je Zeile prüfen (innerhalb der Transaktion); Meldungen mit Namen */
export async function checkLines(
	tx: Tx,
	input: {
		startsOn: string;
		endsOn: string;
		excludeReservationId?: string | null;
		lines: ReservationLineInput[];
	}
): Promise<LineAvailability[]> {
	const stock = await loadStock(tx);
	const bookings = await loadBookings(tx, input.startsOn, input.endsOn, input.excludeReservationId);
	const index = new AvailabilityIndex(stock, bookings);
	const typeIds = input.lines.flatMap((l) => (l.kind === 'type' ? [l.typeId] : []));
	const itemIds = input.lines.flatMap((l) => (l.kind === 'item' ? [l.itemId] : []));
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
		input.lines.map((l) => ({
			typeId: l.kind === 'type' ? l.typeId : null,
			itemId: l.kind === 'item' ? l.itemId : null,
			quantity: l.quantity
		})),
		{ from: input.startsOn, to: input.endsOn }
	);
	return checks.map((c, i) => {
		const line = input.lines[i]!;
		const id = line.kind === 'type' ? line.typeId : line.itemId;
		const known = names.get(id);
		if (!known) {
			return { index: i, ok: false, available: 0, message: 'Nicht gefunden' };
		}
		if (known.archived) {
			return { index: i, ok: false, available: 0, message: `${known.name} ist archiviert` };
		}
		const message = c.ok
			? null
			: c.available === 0
				? `${known.name} ist im Zeitraum nicht frei`
				: `Von ${known.name} sind im Zeitraum nur ${c.available} frei`;
		return { index: i, ok: c.ok, available: c.available, message };
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
	const index = new AvailabilityIndex(
		await loadStock(tx),
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
			items: members.map((m) => ({
				id: m.id,
				name: m.name,
				code: m.code,
				quantity: m.quantity,
				free: Math.max(0, Math.min(index.freeItem(m.id, p), typeFree)),
				locationName: m.locationName,
				condition: m.condition,
				thumbUrl: m.thumbUrl
			})),
			code: null,
			locationName: null
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
			items: [],
			code: m.code,
			locationName: m.locationName
		});
	}
	entries.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
	return { from: q.from, to: q.to, entries };
}

/** Zeilen einer Reservierung ersetzen (zusammengefasst je Typ/Artikel) */
export async function replaceLines(
	tx: Tx,
	reservationId: string,
	lines: ReservationLineInput[]
): Promise<void> {
	await tx.execute(sql`DELETE FROM reservation_lines WHERE reservation_id = ${reservationId}`);
	for (const [i, l] of mergeLines(lines).entries()) {
		await tx.execute(
			sql`INSERT INTO reservation_lines (id, reservation_id, type_id, item_id, quantity, position)
				VALUES (${crypto.randomUUID()}, ${reservationId}, ${l.kind === 'type' ? l.typeId : null},
					${l.kind === 'item' ? l.itemId : null}, ${l.quantity}, ${i})`
		);
	}
}

/** Gleiche Typen/Artikel zusammenfassen (Reihenfolge des ersten Auftretens) */
export function mergeLines(lines: ReservationLineInput[]): ReservationLineInput[] {
	const out = new Map<string, ReservationLineInput>();
	for (const l of lines) {
		const key = l.kind === 'type' ? `t:${l.typeId}` : `i:${l.itemId}`;
		const prev = out.get(key);
		if (prev) prev.quantity += l.quantity;
		else out.set(key, { ...l });
	}
	return [...out.values()];
}
