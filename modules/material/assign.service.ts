/**
 * Zuteilung konkreter Artikel an Typ-Zeilen in der Datenbank: Eingaben für `planAssignments` laden,
 * Ergebnis schreiben (`reassignAll`) und eine Vorschau für noch nicht gespeicherte Zeilen. Nur
 * Datenbankzugriffe – innerhalb einer Modul-Transaktion aufrufen, möglichst unter der Sperre
 * `material:reservations`.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '$lib/sdk/server';
import {
	planAssignments,
	samePicks,
	type Pick,
	type PlanItem,
	type PlanRequest,
	type Usage
} from './assignment';
import { bool, dateStr, num, rows, str, today } from './db';
import { assignmentEndSql, lineEndSql, loadPlanItems } from './inventory';

export interface PlanInput {
	items: PlanItem[];
	fixed: Usage[];
	requests: PlanRequest[];
	/** Bisherige automatische Zuteilungen (für den Vergleich beim Schreiben) */
	previous: Map<string, Pick[]>;
	/** Reservierung je Zeile */
	reservationOf: Map<string, string>;
}

/** Alle laufenden und kommenden Reservierungen (nicht storniert) als Planungsgrundlage */
export async function loadPlanInput(
	tx: Tx,
	opts: { excludeReservationId?: string | null } = {}
): Promise<PlanInput> {
	const t = today();
	const exclude = opts.excludeReservationId ?? '';
	const items = await loadPlanItems(tx);
	const lines = await rows(
		tx,
		sql`SELECT l.id, l.reservation_id, l.type_id, l.item_id, l.quantity, l.slot_size,
				to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(${lineEndSql}, 'YYYY-MM-DD') AS ends_on,
				r.handed_out_at IS NOT NULL AS handed_out
			FROM reservation_lines l JOIN reservations r ON r.id = l.reservation_id
			WHERE r.status = 'reserved' AND ${lineEndSql} >= ${t}::date AND l.tent_id IS NULL
				AND r.id::text <> ${exclude}
			ORDER BY r.starts_on, r.created_at, l.position, l.id`
	);
	const assigned = await rows(
		tx,
		sql`SELECT a.line_id, a.item_id, a.quantity, a.pinned, a.slot
			FROM reservation_assignments a JOIN reservations r ON r.id = a.reservation_id
			WHERE r.status = 'reserved' AND ${assignmentEndSql} >= ${t}::date AND r.id::text <> ${exclude}
			ORDER BY a.slot, a.id`
	);
	const pinnedOf = new Map<string, Pick[]>();
	const previous = new Map<string, Pick[]>();
	for (const a of assigned) {
		const target = bool(a.pinned) ? pinnedOf : previous;
		const key = String(a.line_id);
		const list = target.get(key) ?? [];
		list.push({ itemId: String(a.item_id), quantity: num(a.quantity), slot: num(a.slot) });
		target.set(key, list);
	}
	const fixed: Usage[] = [];
	const requests: PlanRequest[] = [];
	const reservationOf = new Map<string, string>();
	for (const l of lines) {
		const startsOn = dateStr(l.starts_on);
		const endsOn = dateStr(l.ends_on);
		const lineId = String(l.id);
		reservationOf.set(lineId, String(l.reservation_id));
		const itemId = str(l.item_id);
		if (itemId) {
			fixed.push({ itemId, startsOn, endsOn, quantity: num(l.quantity) });
			continue;
		}
		const handedOut = bool(l.handed_out);
		requests.push({
			lineId,
			startsOn,
			endsOn,
			typeId: String(l.type_id),
			quantity: num(l.quantity),
			slotSize: l.slot_size === null || l.slot_size === undefined ? null : num(l.slot_size),
			previous: previous.get(lineId) ?? [],
			pinned: pinnedOf.get(lineId) ?? [],
			frozen: handedOut || startsOn <= t,
			fillMissing: !handedOut
		});
	}
	return { items, fixed, requests, previous, reservationOf };
}

/**
 * Zuteilung aller laufenden/kommenden Reservierungen neu berechnen und nur geänderte Zeilen schreiben.
 * Liefert die Zahl der geänderten Zeilen.
 */
export async function reassignAll(tx: Tx): Promise<number> {
	const input = await loadPlanInput(tx);
	if (!input.requests.length) return 0;
	const plan = planAssignments(input);
	let changed = 0;
	for (const r of input.requests) {
		const next = plan.get(r.lineId) ?? [];
		if (samePicks(next, r.previous)) continue;
		changed++;
		await tx.execute(
			sql`DELETE FROM reservation_assignments WHERE line_id = ${r.lineId} AND NOT pinned`
		);
		const reservationId = input.reservationOf.get(r.lineId)!;
		for (const p of next) {
			await tx.execute(
				sql`INSERT INTO reservation_assignments (id, reservation_id, line_id, item_id, quantity, pinned, slot)
					VALUES (${crypto.randomUUID()}, ${reservationId}, ${r.lineId}, ${p.itemId}, ${p.quantity},
						false, ${p.slot})`
			);
		}
	}
	return changed;
}

export interface PreviewRequest {
	key: string;
	typeId: string | null;
	itemId: string | null;
	quantity: number;
	slotSize: number | null;
}

/**
 * Voraussichtliche Zuteilung neuer Zeilen (noch nicht gespeichert): bestehende Reservierungen planen mit,
 * die neuen Zeilen kommen als umplanbare Anfragen dazu.
 */
export async function previewPlan(
	tx: Tx,
	input: {
		startsOn: string;
		endsOn: string;
		excludeReservationId?: string | null;
		requests: PreviewRequest[];
	}
): Promise<{
	plan: Map<string, Pick[]>;
	items: Map<string, PlanItem>;
	typesWithSets: Set<string>;
}> {
	const base = await loadPlanInput(tx, { excludeReservationId: input.excludeReservationId });
	const fixed = [...base.fixed];
	const requests = [...base.requests];
	for (const r of input.requests) {
		if (r.itemId) {
			fixed.push({
				itemId: r.itemId,
				startsOn: input.startsOn,
				endsOn: input.endsOn,
				quantity: r.quantity
			});
		} else if (r.typeId) {
			requests.push({
				lineId: `new:${r.key}`,
				startsOn: input.startsOn,
				endsOn: input.endsOn,
				typeId: r.typeId,
				quantity: r.quantity,
				slotSize: r.slotSize,
				previous: [],
				pinned: [],
				frozen: false,
				fillMissing: true
			});
		}
	}
	const plan = planAssignments({ items: base.items, fixed, requests });
	const result = new Map<string, Pick[]>();
	for (const r of input.requests) {
		const picks = plan.get(`new:${r.key}`);
		if (picks) result.set(r.key, picks);
	}
	return {
		plan: result,
		items: new Map(base.items.map((i) => [i.id, i])),
		typesWithSets: typesWithSets(base.items)
	};
}

export function typesWithSets(items: readonly PlanItem[]): Set<string> {
	return new Set(
		items.filter((i) => i.setId && i.typeId && i.capacity > 0).map((i) => i.typeId as string)
	);
}

/** „Set KJ1“, „Sets KJ1, KJ2 + 2 einzelne“, „3 einzelne“ */
export function describePicks(
	picks: readonly Pick[],
	setNameOf: (itemId: string) => string | null
): string | null {
	if (!picks.length) return null;
	const sets = new Set<string>();
	let loose = 0;
	for (const p of picks) {
		const name = setNameOf(p.itemId);
		if (name) sets.add(name);
		else loose += p.quantity;
	}
	const names = [...sets].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
	const parts: string[] = [];
	if (names.length === 1) parts.push(`Set ${names[0]}`);
	if (names.length > 1) parts.push(`Sets ${names.join(', ')}`);
	if (loose > 0) parts.push(`${loose} einzeln`);
	return parts.join(' + ');
}

/** `reassignAll` unter der Sperre `material:reservations` (für Änderungen am Bestand) */
export async function reassignLocked(tx: Tx): Promise<number> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'material:reservations'}))`);
	return reassignAll(tx);
}
