/**
 * Reservierungen: Belegungen anderer Reservierungen laden, Positionen gegen den Bestand prüfen,
 * Reservierungen lesen. Nur Datenbankzugriffe (läuft in Modul-Transaktionen).
 */
import { sql } from 'drizzle-orm';
import { CoreError, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import { allocate, type Candidate } from './allocation';
import { blockedUnits, freeQuantity, freeUnitCount, overlaps, type Booking } from './availability';
import { canHandleAll, dateStr, iso, isoOrNull, num, rows, str, today } from './db';
import {
	containedUnits,
	isUsable,
	loadPlaceIndex,
	unitSummaries,
	UNIT_SELECT,
	toUnitSummary,
	type PlaceIndex
} from './inventory';
import {
	PERMISSIONS,
	type ArticleKind,
	type AssignedUnit,
	type Condition,
	type LineAvailability,
	type LineKind,
	type Reservation,
	type ReservationLine,
	type ReservationLineInput,
	type ReservationStatus
} from './schemas';

interface LineRow {
	id: string;
	reservationId: string;
	kind: LineKind;
	unitId: string | null;
	setId: string | null;
	articleId: string | null;
	quantity: number;
	issuedQty: number;
	returnedQty: number;
	sourceSetId: string | null;
}

function toLineRow(r: Record<string, unknown>): LineRow {
	return {
		id: String(r.id),
		reservationId: String(r.reservation_id),
		kind: String(r.kind) as LineKind,
		unitId: r.unit_id ? String(r.unit_id) : null,
		setId: r.set_id ? String(r.set_id) : null,
		articleId: r.article_id ? String(r.article_id) : null,
		quantity: num(r.quantity),
		issuedQty: num(r.issued_qty),
		returnedQty: num(r.returned_qty),
		sourceSetId: r.source_set_id ? String(r.source_set_id) : null
	};
}

/** Stücke je Set (aktuelle Zusammensetzung) */
export async function setUnitMap(tx: Tx): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	for (const r of await rows(tx, sql`SELECT set_id, unit_id FROM set_units`)) {
		const key = String(r.set_id);
		const list = out.get(key) ?? [];
		list.push(String(r.unit_id));
		out.set(key, list);
	}
	return out;
}

/** Konkrete Stücke einer Zeile (Kisten mit Inhalt, Sets mit ihren Stücken und deren Inhalt) */
function lineUnits(line: LineRow, index: PlaceIndex, sets: Map<string, string[]>): string[] {
	const base =
		line.kind === 'unit' && line.unitId
			? [line.unitId]
			: line.kind === 'set' && line.setId
				? (sets.get(line.setId) ?? [])
				: [];
	const out = new Set<string>();
	for (const id of base) {
		out.add(id);
		if (index.units.get(id)?.isContainer) for (const c of containedUnits(index, id)) out.add(c);
	}
	return [...out];
}

/**
 * Belegungen aller offenen Reservierungen (reserviert/ausgegeben), die `from..to` überschneiden.
 * Ausgegebene Reservierungen gelten mindestens bis heute (überfällige Rückgabe blockiert weiter).
 */
export async function loadBookings(
	tx: Tx,
	window: { from: string; to: string; excludeId?: string | null },
	ctx?: { index?: PlaceIndex; sets?: Map<string, string[]> }
): Promise<{ bookings: Booking[]; titles: Map<string, string> }> {
	const index = ctx?.index ?? (await loadPlaceIndex(tx));
	const sets = ctx?.sets ?? (await setUnitMap(tx));
	const todayStr = today();
	const resRows = await rows(
		tx,
		sql`SELECT id, title, status, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
				to_char(ends_on, 'YYYY-MM-DD') AS ends_on
			FROM reservations
			WHERE status IN ('reserved', 'issued')
				AND id::text <> ${window.excludeId ?? ''}
				AND starts_on <= ${window.to}::date
				AND (ends_on >= ${window.from}::date OR status = 'issued')`
	);
	const res = resRows
		.map((r) => {
			const status = String(r.status) as ReservationStatus;
			const endsOn = dateStr(r.ends_on);
			return {
				id: String(r.id),
				title: String(r.title),
				startsOn: dateStr(r.starts_on),
				endsOn: status === 'issued' && endsOn < todayStr ? todayStr : endsOn,
				status
			};
		})
		.filter((r) => overlaps(r.startsOn, r.endsOn, window.from, window.to));
	const titles = new Map(res.map((r) => [r.id, r.title]));
	if (!res.length) return { bookings: [], titles };
	const ids = res.map((r) => r.id);
	const lines = (
		await rows(
			tx,
			sql`SELECT * FROM reservation_lines WHERE reservation_id::text IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)})`
		)
	).map(toLineRow);
	const assigned = await rows(
		tx,
		sql`SELECT reservation_id, unit_id, line_id, returned_at FROM reservation_units
			WHERE reservation_id::text IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)})`
	);
	const articleKinds = new Map(
		(await rows(tx, sql`SELECT id, kind FROM articles`)).map((r) => [String(r.id), String(r.kind)])
	);
	const bookings: Booking[] = res.map((r) => {
		const myLines = lines.filter((l) => l.reservationId === r.id);
		const myAssigned = assigned.filter((a) => String(a.reservation_id) === r.id);
		const unitIds = new Set<string>();
		for (const l of myLines) for (const u of lineUnits(l, index, sets)) unitIds.add(u);
		for (const a of myAssigned) if (a.returned_at == null) unitIds.add(String(a.unit_id));
		const counts = new Map<string, number>();
		for (const l of myLines) {
			if (l.kind !== 'article' || !l.articleId) continue;
			let need: number;
			if (articleKinds.get(l.articleId) === 'bulk') {
				need = Math.max(l.quantity, l.issuedQty) - l.returnedQty;
			} else {
				const done = myAssigned.filter((a) => String(a.line_id ?? '') === l.id).length;
				need = l.quantity - done;
			}
			if (need > 0) counts.set(l.articleId, (counts.get(l.articleId) ?? 0) + need);
		}
		return {
			reservationId: r.id,
			startsOn: r.startsOn,
			endsOn: r.endsOn,
			unitIds: [...unitIds],
			counts
		};
	});
	return { bookings, titles };
}

interface UnitInfo {
	id: string;
	name: string;
	articleId: string;
	usable: boolean;
	setId: string | null;
	setName: string | null;
}

async function unitInfos(tx: Tx): Promise<Map<string, UnitInfo>> {
	const list = await rows(
		tx,
		sql`SELECT u.id, u.label, u.article_id, u.condition, u.retired_at, a.name AS article_name,
				su.set_id, s.name AS set_name
			FROM units u JOIN articles a ON a.id = u.article_id
			LEFT JOIN set_units su ON su.unit_id = u.id LEFT JOIN sets s ON s.id = su.set_id`
	);
	return new Map(
		list.map((r) => [
			String(r.id),
			{
				id: String(r.id),
				name: str(r.label) || String(r.article_name),
				articleId: String(r.article_id),
				usable: isUsable(r),
				setId: r.set_id ? String(r.set_id) : null,
				setName: r.set_name ? String(r.set_name) : null
			}
		])
	);
}

/**
 * Positionen einer (neuen oder geänderten) Reservierung gegen den Bestand prüfen. Liefert je Zeile
 * das Ergebnis; Aufrufer entscheidet, ob er bei Fehlern abbricht (`assertLinesAvailable`).
 */
export async function checkLines(
	tx: Tx,
	input: {
		startsOn: string;
		endsOn: string;
		excludeId?: string | null;
		lines: ReservationLineInput[];
	}
): Promise<LineAvailability[]> {
	const index = await loadPlaceIndex(tx);
	const sets = await setUnitMap(tx);
	const { bookings, titles } = await loadBookings(
		tx,
		{ from: input.startsOn, to: input.endsOn, excludeId: input.excludeId },
		{ index, sets }
	);
	const blocked = blockedUnits(bookings, input.startsOn, input.endsOn);
	const units = await unitInfos(tx);
	const articles = new Map(
		(
			await rows(
				tx,
				sql`SELECT a.id, a.name, a.kind, a.archived_at,
						(SELECT coalesce(sum(quantity), 0) FROM stock s WHERE s.article_id = a.id) AS total
					FROM articles a`
			)
		).map((r) => [
			String(r.id),
			{
				name: String(r.name),
				kind: String(r.kind) as ArticleKind,
				archived: r.archived_at != null,
				total: num(r.total)
			}
		])
	);
	const setNames = new Map(
		(await rows(tx, sql`SELECT id, name FROM sets`)).map((r) => [String(r.id), String(r.name)])
	);
	const usableByArticle = new Map<string, string[]>();
	for (const u of units.values()) {
		if (!u.usable) continue;
		const list = usableByArticle.get(u.articleId) ?? [];
		list.push(u.id);
		usableByArticle.set(u.articleId, list);
	}
	const blockedBy = (id: string) =>
		(blocked.get(id) ?? []).map((r) => `„${titles.get(r) ?? 'andere Reservierung'}“`).join(', ');

	const results: LineAvailability[] = input.lines.map((_, index) => ({
		index,
		ok: true,
		available: null,
		message: null,
		notes: []
	}));
	const fail = (i: number, message: string) => {
		const r = results[i]!;
		r.ok = false;
		r.message = r.message ? `${r.message} ${message}` : message;
	};

	// konkrete Stücke der eigenen Reservierung (je Artikel) und doppelte Nennungen
	const mine = new Map<string, Set<string>>();
	const seen = new Map<string, number>();
	const addMine = (unitId: string, i: number) => {
		const u = units.get(unitId);
		if (!u) return;
		const prev = seen.get(unitId);
		if (prev !== undefined && prev !== i)
			fail(i, `${u.name} ist schon in einer anderen Zeile enthalten.`);
		seen.set(unitId, i);
		const set = mine.get(u.articleId) ?? new Set<string>();
		set.add(unitId);
		mine.set(u.articleId, set);
	};

	input.lines.forEach((line, i) => {
		if (line.kind === 'unit') {
			const u = units.get(line.unitId);
			if (!u) return fail(i, 'Stück nicht gefunden.');
			if (!u.usable) fail(i, `${u.name} ist defekt, verloren oder ausgemustert.`);
			const all = [
				line.unitId,
				...(index.units.get(line.unitId)?.isContainer ? containedUnits(index, line.unitId) : [])
			];
			for (const id of all) {
				if (blocked.has(id)) {
					fail(
						i,
						`${units.get(id)?.name ?? 'Stück'} ist im Zeitraum schon verplant (${blockedBy(id)}).`
					);
				}
				addMine(id, i);
			}
			if (u.setId) results[i]!.notes.push(`Aus Set ${u.setName ?? ''} – das Set wird aufgeteilt.`);
		} else if (line.kind === 'set') {
			const list = sets.get(line.setId);
			const name = setNames.get(line.setId);
			if (!name) return fail(i, 'Set nicht gefunden.');
			if (!list?.length) return fail(i, `Set ${name} ist leer.`);
			for (const id of list) {
				const all = [id, ...(index.units.get(id)?.isContainer ? containedUnits(index, id) : [])];
				for (const x of all) {
					if (blocked.has(x)) {
						fail(
							i,
							`${units.get(x)?.name ?? 'Stück'} aus Set ${name} ist schon verplant (${blockedBy(x)}).`
						);
					}
					addMine(x, i);
				}
				if (!units.get(id)?.usable) {
					results[i]!.notes.push(`${units.get(id)?.name ?? 'Ein Stück'} ist defekt oder verloren.`);
				}
			}
		} else {
			const a = articles.get(line.articleId);
			if (!a) return fail(i, 'Artikel nicht gefunden.');
			if (a.archived) fail(i, `${a.name} ist archiviert.`);
		}
	});

	// Anzahl-Zeilen je Artikel gesammelt prüfen
	const countLines = new Map<string, number[]>();
	input.lines.forEach((line, i) => {
		if (line.kind !== 'article') return;
		const list = countLines.get(line.articleId) ?? [];
		list.push(i);
		countLines.set(line.articleId, list);
	});
	const articleIds = new Set<string>([...countLines.keys(), ...mine.keys()]);
	for (const articleId of articleIds) {
		const a = articles.get(articleId);
		if (!a) continue;
		const idxs = countLines.get(articleId) ?? [];
		const wanted = idxs.reduce((s, i) => {
			const l = input.lines[i]!;
			return s + (l.kind === 'article' ? l.quantity : 0);
		}, 0);
		if (a.kind === 'bulk') {
			const free = freeQuantity(a.total, articleId, bookings, input.startsOn, input.endsOn);
			for (const i of idxs) results[i]!.available = free;
			if (wanted > free) {
				for (const i of idxs) fail(i, `Nur ${free} von ${a.total} ${a.name} im Zeitraum frei.`);
			}
			continue;
		}
		const usable = usableByArticle.get(articleId) ?? [];
		const free = freeUnitCount(usable, articleId, bookings, input.startsOn, input.endsOn);
		const concrete = mine.get(articleId)?.size ?? 0;
		for (const i of idxs) results[i]!.available = Math.max(0, free - concrete);
		if (concrete + wanted > free) {
			const msg =
				wanted > 0
					? `Nur ${Math.max(0, free - concrete)} ${a.name} im Zeitraum frei.`
					: `Alle ${a.name} sind im Zeitraum schon verplant.`;
			const targets = idxs.length
				? idxs
				: input.lines
						.map((l, i) => ({ l, i }))
						.filter(({ l }) => l.kind !== 'article')
						.filter(({ i }) => [...(mine.get(articleId) ?? [])].some((u) => seen.get(u) === i))
						.map(({ i }) => i);
			for (const i of targets) fail(i, msg);
		} else if (wanted > 0) {
			// Vorschau der Zuteilung: würden Sets aufgeteilt?
			const taken = new Set<string>([...blocked.keys(), ...(mine.get(articleId) ?? [])]);
			const candidates = candidatesFor(usable, taken, units, sets);
			const plan = allocate(candidates, wanted);
			if (plan.splitSets.length) {
				for (const i of idxs) {
					results[i]!.notes.push(
						`Dafür werden voraussichtlich Sets aufgeteilt: ${plan.splitSets.join(', ')}.`
					);
				}
			}
		}
	}
	return results;
}

/** Freie Kandidaten eines Artikels für die Zuteilung */
export function candidatesFor(
	usable: readonly string[],
	taken: ReadonlySet<string>,
	units: ReadonlyMap<
		string,
		{ setId: string | null; setName: string | null; articleId: string; usable: boolean }
	>,
	sets: ReadonlyMap<string, string[]>
): Candidate[] {
	return usable
		.filter((id) => !taken.has(id))
		.map((id) => {
			const u = units.get(id)!;
			const setSize = u.setId
				? (sets.get(u.setId) ?? []).filter((x) => {
						const o = units.get(x);
						return o?.articleId === u.articleId && o.usable;
					}).length
				: 0;
			return { unitId: id, setId: u.setId, setName: u.setName, setSize };
		});
}

/** Bricht mit 409 ab, wenn eine Zeile nicht verfügbar ist */
export async function assertLinesAvailable(
	tx: Tx,
	input: Parameters<typeof checkLines>[1]
): Promise<void> {
	const results = await checkLines(tx, input);
	const failed = results.filter((r) => !r.ok);
	if (failed.length) {
		throw new CoreError('conflict', failed.map((f) => f.message).join(' '), {
			lines: failed.map((f) => ({ index: f.index, message: f.message }))
		});
	}
}

/** Mengen-Zeile, die der Server zu einem reservierten Set anlegt (Mengenteile des Set-Typs) */
export interface SetBulkLine {
	kind: 'article';
	articleId: string;
	quantity: number;
	sourceSetId: string;
}

/** Mengenteile der Set-Typen aller Set-Zeilen (z. B. 20 Heringe je Kohte) */
export async function setBulkLines(tx: Tx, lines: ReservationLineInput[]): Promise<SetBulkLine[]> {
	const setIds = lines
		.filter((l) => l.kind === 'set')
		.map((l) => (l.kind === 'set' ? l.setId : ''));
	if (!setIds.length) return [];
	const parts = await rows(
		tx,
		sql`SELECT s.id AS set_id, p.article_id, p.quantity
			FROM sets s
			JOIN set_template_parts p ON p.template_id = s.template_id
			JOIN articles a ON a.id = p.article_id
			WHERE a.kind = 'bulk' AND s.id::text IN (${sql.join(
				setIds.map((id) => sql`${id}`),
				sql`, `
			)})
			ORDER BY p.position`
	);
	return parts.map((r) => ({
		kind: 'article',
		articleId: String(r.article_id),
		quantity: num(r.quantity),
		sourceSetId: String(r.set_id)
	}));
}

/** Zeilen zum Prüfen: eigene Zeilen plus Mengen-Zeilen der Sets */
export async function withSetBulk(
	tx: Tx,
	lines: ReservationLineInput[]
): Promise<ReservationLineInput[]> {
	const extra = await setBulkLines(tx, lines);
	return [
		...lines,
		...extra.map((e) => ({
			kind: 'article' as const,
			articleId: e.articleId,
			quantity: e.quantity
		}))
	];
}

/** Zeilen einer Reservierung ersetzen; zu Sets werden deren Mengenteile als eigene Zeilen angelegt */
export async function replaceLines(
	tx: Tx,
	reservationId: string,
	lines: ReservationLineInput[]
): Promise<void> {
	await tx.execute(sql`DELETE FROM reservation_lines WHERE reservation_id = ${reservationId}`);
	for (const [i, l] of lines.entries()) {
		await tx.execute(
			sql`INSERT INTO reservation_lines (id, reservation_id, kind, unit_id, set_id, article_id, quantity, position)
				VALUES (${crypto.randomUUID()}, ${reservationId}, ${l.kind},
					${l.kind === 'unit' ? l.unitId : null}, ${l.kind === 'set' ? l.setId : null},
					${l.kind === 'article' ? l.articleId : null}, ${l.kind === 'article' ? l.quantity : 1}, ${i})`
		);
	}
	for (const [j, b] of (await setBulkLines(tx, lines)).entries()) {
		await tx.execute(
			sql`INSERT INTO reservation_lines (id, reservation_id, kind, article_id, quantity, position, source_set_id)
				VALUES (${crypto.randomUUID()}, ${reservationId}, 'article', ${b.articleId}, ${b.quantity},
					${lines.length + j}, ${b.sourceSetId})`
		);
	}
}

export async function requireReservationRow(tx: Tx, id: string): Promise<Record<string, unknown>> {
	const [r] = await rows(
		tx,
		sql`SELECT id, title, action_id, status, notes, created_by, created_at, issued_at, returned_at,
				to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
			FROM reservations WHERE id = ${id}`
	);
	if (!r) throw errors.notFound('Reservierung nicht gefunden');
	return r;
}

/** Darf `ctx` die Reservierung ändern bzw. aus-/zurückgeben? (Ersteller*in oder Verwaltung) */
export function canEditReservation(ctx: RequestContext, createdBy: unknown): boolean {
	if (canHandleAll(ctx)) return true;
	return (
		!!ctx.userId &&
		String(createdBy ?? '') === ctx.userId &&
		ctx.permissions.has(PERMISSIONS.reserve)
	);
}

export function requireEdit(ctx: RequestContext, row: Record<string, unknown>): void {
	if (!canEditReservation(ctx, row.created_by)) {
		throw errors.forbidden('Nur die Ersteller*in oder die Materialverwaltung darf das');
	}
}

/** Reservierung vollständig laden (ohne Namen von Konten/Aktionen – die setzt der Aufrufer) */
export async function loadReservation(
	tx: Tx,
	ctx: RequestContext,
	id: string
): Promise<Omit<Reservation, 'createdByName' | 'actionName'>> {
	const r = await requireReservationRow(tx, id);
	const index = await loadPlaceIndex(tx);
	const sets = await setUnitMap(tx);
	const lines = (
		await rows(
			tx,
			sql`SELECT * FROM reservation_lines WHERE reservation_id = ${id} ORDER BY position`
		)
	).map(toLineRow);
	const assignedRows = await rows(
		tx,
		sql`SELECT unit_id, line_id, issued_at, returned_at, return_condition, return_note
			FROM reservation_units WHERE reservation_id = ${id} ORDER BY issued_at, unit_id`
	);
	const assignedUnits = await unitSummaries(
		tx,
		assignedRows.map((a) => String(a.unit_id)),
		index
	);
	const byUnit = new Map(assignedUnits.map((u) => [u.id, u]));
	const assigned: AssignedUnit[] = assignedRows
		.filter((a) => byUnit.has(String(a.unit_id)))
		.map((a) => ({
			unit: byUnit.get(String(a.unit_id))!,
			lineId: a.line_id ? String(a.line_id) : null,
			issuedAt: iso(a.issued_at),
			returnedAt: isoOrNull(a.returned_at),
			returnCondition: a.return_condition ? (String(a.return_condition) as Condition) : null,
			returnNote: str(a.return_note)
		}));

	const unitIds = lines.filter((l) => l.unitId).map((l) => l.unitId!);
	const unitRows = unitIds.length
		? await rows(
				tx,
				sql`${UNIT_SELECT} WHERE u.id::text IN (${sql.join(
					unitIds.map((x) => sql`${x}`),
					sql`, `
				)})`
			)
		: [];
	const unitById = new Map(unitRows.map((u) => [String(u.id), toUnitSummary(index, u)]));
	const setRows = await rows(tx, sql`SELECT id, name, code FROM sets`);
	const setById = new Map(setRows.map((s) => [String(s.id), s]));
	const articleRows = await rows(tx, sql`SELECT id, name, kind, unit_label FROM articles`);
	const articleById = new Map(articleRows.map((a) => [String(a.id), a]));

	const outLines: ReservationLine[] = lines.map((l) => {
		// Zähler je Zeile ohne Kisteninhalt: Stück = 0/1, Set = Stücke des Sets, Artikel = zugeteilte Stücke
		const out = assigned.filter((a) => a.lineId === l.id);
		const base =
			l.kind === 'unit' ? [l.unitId!] : l.kind === 'set' ? (sets.get(l.setId!) ?? []) : null;
		const assignedCount = base ? out.filter((a) => base.includes(a.unit.id)).length : out.length;
		const src = l.sourceSetId ? setById.get(l.sourceSetId) : undefined;
		const fromSet = l.sourceSetId ? (src ? String(src.name) : 'Set') : null;
		if (l.kind === 'unit') {
			const u = unitById.get(l.unitId!);
			return {
				id: l.id,
				kind: l.kind,
				unitId: l.unitId,
				setId: null,
				articleId: u?.articleId ?? null,
				name: u ? u.name : 'Unbekanntes Stück',
				code: u?.code ?? null,
				articleKind: 'unit',
				unitLabel: 'Stück',
				quantity: 1,
				issuedQty: 0,
				returnedQty: 0,
				assignedCount,
				fromSet
			};
		}
		if (l.kind === 'set') {
			const s = setById.get(l.setId!);
			return {
				id: l.id,
				kind: l.kind,
				unitId: null,
				setId: l.setId,
				articleId: null,
				name: s ? `Set ${String(s.name)}` : 'Unbekanntes Set',
				code: s ? String(s.code) : null,
				articleKind: null,
				unitLabel: 'Stück',
				quantity: lineUnits(l, index, sets).length,
				issuedQty: 0,
				returnedQty: 0,
				assignedCount,
				fromSet
			};
		}
		const a = articleById.get(l.articleId!);
		return {
			id: l.id,
			kind: l.kind,
			unitId: null,
			setId: null,
			articleId: l.articleId,
			name: a ? String(a.name) : 'Unbekannter Artikel',
			code: null,
			articleKind: a ? (String(a.kind) as ArticleKind) : null,
			unitLabel: a ? str(a.unit_label) || 'Stück' : 'Stück',
			quantity: l.quantity,
			issuedQty: l.issuedQty,
			returnedQty: l.returnedQty,
			assignedCount,
			fromSet
		};
	});

	const status = String(r.status) as ReservationStatus;
	const endsOn = dateStr(r.ends_on);
	const editable = canEditReservation(ctx, r.created_by);
	return {
		id,
		title: String(r.title),
		startsOn: dateStr(r.starts_on),
		endsOn,
		status,
		actionId: r.action_id ? String(r.action_id) : null,
		notes: str(r.notes),
		createdBy: r.created_by ? String(r.created_by) : null,
		createdAt: iso(r.created_at),
		issuedAt: isoOrNull(r.issued_at),
		returnedAt: isoOrNull(r.returned_at),
		lines: outLines,
		assigned,
		canEdit: editable && (status === 'reserved' || status === 'issued'),
		canHandle: editable && (status === 'reserved' || status === 'issued'),
		overdue: status === 'issued' && endsOn < today()
	};
}
