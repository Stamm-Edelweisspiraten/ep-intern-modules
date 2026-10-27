/**
 * Ausgabe und Rückgabe einer Reservierung (per Scan oder Auswahl), Zuteilungsvorschlag für
 * Anzahl-Zeilen („8 Kohtenbahnen“), Codes auflösen und vorab vergeben.
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
import { allocate } from './allocation';
import { blockedUnits } from './availability';
import { dateStr, logMovement, mdb, nextCodes, num, rows, str } from './db';
import { containedUnits, isUsable, loadPlaceIndex, unitSummaries, UNIT_SELECT } from './inventory';
import { notifyDamage } from './notify';
import {
	candidatesFor,
	loadBookings,
	loadReservation,
	requireEdit,
	requireReservationRow,
	setUnitMap
} from './reservations.service';
import { fullReservation } from './reservations.endpoints';
import { setQty } from './stock.endpoints';
import {
	CONDITION_LABELS,
	PERMISSIONS,
	codeFromScan,
	codeParams,
	idParams,
	issueInput,
	reserveCodesInput,
	returnInput,
	type AllocationSuggestion,
	type CodeTarget,
	type Condition,
	type Reservation
} from './schemas';
import { z } from 'zod';

const tags = ['Modul: material'];

async function requireOpen(tx: Tx, ctx: RequestContext, id: string) {
	const row = await requireReservationRow(tx, id);
	requireEdit(ctx, row);
	const status = String(row.status);
	if (status !== 'reserved' && status !== 'issued') {
		throw errors.conflict('Die Reservierung ist abgeschlossen');
	}
	return row;
}

/** Alle Stücke einer Zeile ausgeben bzw. zuordnen: Zeile → konkrete Stücke (Kisten mit Inhalt) */
async function allocationFor(
	tx: Tx,
	ctx: RequestContext,
	reservationId: string
): Promise<AllocationSuggestion[]> {
	const r = await loadReservation(tx, ctx, reservationId);
	const index = await loadPlaceIndex(tx);
	const sets = await setUnitMap(tx);
	const { bookings } = await loadBookings(
		tx,
		{ from: r.startsOn, to: r.endsOn, excludeId: reservationId },
		{ index, sets }
	);
	const blocked = blockedUnits(bookings, r.startsOn, r.endsOn);
	const unitRows = await rows(
		tx,
		sql`SELECT u.id, u.article_id, u.condition, u.retired_at, u.issued_reservation_id, su.set_id, s.name AS set_name
			FROM units u LEFT JOIN set_units su ON su.unit_id = u.id LEFT JOIN sets s ON s.id = su.set_id`
	);
	const units = new Map(
		unitRows.map((u) => [
			String(u.id),
			{
				articleId: String(u.article_id),
				usable: isUsable(u) && !u.issued_reservation_id,
				setId: u.set_id ? String(u.set_id) : null,
				setName: u.set_name ? String(u.set_name) : null
			}
		])
	);
	const taken = new Set<string>([...blocked.keys(), ...r.assigned.map((a) => a.unit.id)]);
	for (const l of r.lines) {
		if (l.unitId) taken.add(l.unitId);
		if (l.setId) for (const u of sets.get(l.setId) ?? []) taken.add(u);
	}
	const out: AllocationSuggestion[] = [];
	for (const l of r.lines) {
		if (l.kind !== 'article' || l.articleKind !== 'unit' || !l.articleId) continue;
		const needed = l.quantity - l.assignedCount;
		if (needed <= 0) continue;
		const usable = [...units.entries()]
			.filter(([, u]) => u.articleId === l.articleId && u.usable)
			.map(([id]) => id);
		const plan = allocate(candidatesFor(usable, taken, units, sets), needed);
		for (const id of plan.unitIds) taken.add(id);
		out.push({
			lineId: l.id,
			articleId: l.articleId,
			needed,
			units: await unitSummaries(tx, plan.unitIds, index),
			splitSets: plan.splitSets,
			missing: plan.missing
		});
	}
	return out;
}

export const handoutEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/codes/:code',
		summary: 'Gescannten Code auflösen (Stück, Kiste, Set, Lagerort)',
		description: 'Akzeptiert auch die volle Scan-URL aus dem QR-Code.',
		tags,
		permission: PERMISSIONS.view,
		params: codeParams,
		handler: ({ params }) =>
			mdb().transaction(async (tx): Promise<CodeTarget> => {
				const code = codeFromScan(params.code);
				if (!code) throw errors.notFound('Unbekannter Code');
				const [u] = await rows(
					tx,
					sql`SELECT u.id, u.code, u.label, a.name FROM units u JOIN articles a ON a.id = u.article_id
						WHERE u.code = ${code}`
				);
				if (u)
					return { type: 'unit', id: String(u.id), code, name: str(u.label) || String(u.name) };
				const [s] = await rows(tx, sql`SELECT id, name FROM sets WHERE code = ${code}`);
				if (s) return { type: 'set', id: String(s.id), code, name: String(s.name) };
				const [l] = await rows(tx, sql`SELECT id, name FROM locations WHERE code = ${code}`);
				if (l) return { type: 'location', id: String(l.id), code, name: String(l.name) };
				const [rc] = await rows(tx, sql`SELECT code FROM reserved_codes WHERE code = ${code}`);
				if (rc) return { type: 'reserved', code };
				throw errors.notFound('Unbekannter Code');
			})
	}),
	defineEndpoint({
		method: 'POST',
		path: '/codes/reserve',
		summary: 'Codes vorab vergeben (für Leer-Etiketten)',
		tags,
		permission: PERMISSIONS.manage,
		body: reserveCodesInput,
		handler: async ({ ctx, body }) => {
			const codes = await mdb().transaction(async (tx) => {
				const list = await nextCodes(tx, 'unit', body.count);
				for (const code of list) {
					await tx.execute(
						sql`INSERT INTO reserved_codes (code, created_by) VALUES (${code}, ${ctx.userId ?? null})`
					);
				}
				return list;
			});
			await core.audit.logFromContext(ctx, 'material.codes.reserved', {
				metadata: { count: codes.length }
			});
			return { codes };
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/reservations/:id/allocation',
		summary: 'Zuteilungsvorschlag für Anzahl-Zeilen (wenige Sets aufteilen)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ ctx, params }) => mdb().transaction((tx) => allocationFor(tx, ctx, params.id))
	}),

	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/issue',
		summary: 'Ausgeben (Stücke scannen/auswählen, Mengen eintragen)',
		description:
			'Mehrfach aufrufbar. Kisten nehmen ihren Inhalt mit. Stücke werden ihrer Zeile zugeordnet (konkretes Stück, ' +
			'Set, Kiste oder passende Anzahl-Zeile); andere Stücke nur mit `allowExtra` (dann als neue Zeile, wenn frei). ' +
			'`bulk.quantity` ist die insgesamt ausgegebene Menge der Zeile.',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: issueInput,
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			const count = await mdb().transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('material:reservations'))`);
				const row = await requireOpen(tx, ctx, params.id);
				const r = await loadReservation(tx, ctx, params.id);
				const index = await loadPlaceIndex(tx);
				const sets = await setUnitMap(tx);
				const assigned = new Set(r.assigned.filter((a) => !a.returnedAt).map((a) => a.unit.id));
				const lineOfUnit = new Map<string, string>();
				for (const l of r.lines) {
					const base = l.unitId ? [l.unitId] : l.setId ? (sets.get(l.setId) ?? []) : [];
					for (const id of base) {
						lineOfUnit.set(id, l.id);
						if (index.units.get(id)?.isContainer) {
							for (const c of containedUnits(index, id)) lineOfUnit.set(c, l.id);
						}
					}
				}
				const capacity = new Map(
					r.lines
						.filter((l) => l.kind === 'article' && l.articleKind === 'unit')
						.map((l) => [l.id, { articleId: l.articleId!, free: l.quantity - l.assignedCount }])
				);
				const { bookings, titles } = await loadBookings(
					tx,
					{ from: dateStr(row.starts_on), to: dateStr(row.ends_on), excludeId: params.id },
					{ index, sets }
				);
				const blocked = blockedUnits(bookings, dateStr(row.starts_on), dateStr(row.ends_on));

				const toIssue: { unitId: string; lineId: string | null }[] = [];
				const queue = [...new Set(body.unitIds)];
				const handled = new Set<string>();
				let extraPosition = r.lines.length;
				for (const unitId of queue) {
					if (handled.has(unitId) || assigned.has(unitId)) continue;
					const [u] = await rows(tx, sql`${UNIT_SELECT} WHERE u.id = ${unitId}`);
					if (!u) throw errors.notFound('Stück nicht gefunden');
					const name = str(u.label) || String(u.article_name);
					if (!isUsable(u)) throw errors.conflict(`${name} ist defekt, verloren oder ausgemustert`);
					if (u.issued_reservation_id && String(u.issued_reservation_id) !== params.id) {
						throw errors.conflict(`${name} ist schon ausgegeben („${str(u.issued_title)}“)`);
					}
					let lineId = lineOfUnit.get(unitId) ?? null;
					if (!lineId) {
						const free = [...capacity.entries()].find(
							([, c]) => c.articleId === String(u.article_id) && c.free > 0
						);
						if (free) {
							lineId = free[0];
							free[1].free--;
						}
					}
					if (!lineId) {
						if (!body.allowExtra) {
							throw errors.validation(
								[{ path: ['unitIds'], message: `${name} gehört nicht zu dieser Reservierung` }],
								`${name} gehört nicht zu dieser Reservierung`
							);
						}
						if (blocked.has(unitId)) {
							const other = (blocked.get(unitId) ?? []).map((x) => titles.get(x)).join(', ');
							throw errors.conflict(`${name} ist im Zeitraum schon verplant (${other})`);
						}
						lineId = crypto.randomUUID();
						await tx.execute(
							sql`INSERT INTO reservation_lines (id, reservation_id, kind, unit_id, quantity, position)
								VALUES (${lineId}, ${params.id}, 'unit', ${unitId}, 1, ${extraPosition++})`
						);
						if (index.units.get(unitId)?.isContainer) {
							for (const c of containedUnits(index, unitId)) lineOfUnit.set(c, lineId);
						}
					}
					handled.add(unitId);
					toIssue.push({ unitId, lineId });
					// Kisten nehmen ihren Inhalt mit
					if (index.units.get(unitId)?.isContainer) {
						for (const c of containedUnits(index, unitId)) {
							if (handled.has(c) || assigned.has(c)) continue;
							handled.add(c);
							toIssue.push({ unitId: c, lineId: lineOfUnit.get(c) ?? lineId });
						}
					}
				}
				for (const t of toIssue) {
					await tx.execute(
						sql`INSERT INTO reservation_units (reservation_id, unit_id, line_id, issued_by)
							VALUES (${params.id}, ${t.unitId}, ${t.lineId}, ${ctx.userId ?? null})
							ON CONFLICT (reservation_id, unit_id) DO UPDATE SET returned_at = NULL,
								returned_by = NULL, return_condition = NULL, return_note = '',
								issued_at = now(), line_id = EXCLUDED.line_id`
					);
					await tx.execute(
						sql`UPDATE units SET issued_reservation_id = ${params.id}, updated_at = now()
							WHERE id = ${t.unitId}`
					);
					await logMovement(tx, ctx, {
						kind: 'issued',
						unitId: t.unitId,
						detail: String(row.title),
						reservationId: params.id
					});
				}
				for (const b of body.bulk) {
					const line = r.lines.find((l) => l.id === b.lineId && l.articleKind === 'bulk');
					if (!line) throw errors.validation([{ path: ['bulk'], message: 'Zeile nicht gefunden' }]);
					if (b.quantity < line.returnedQty) {
						throw errors.conflict('Es ist schon mehr zurückgegeben');
					}
					await tx.execute(
						sql`UPDATE reservation_lines SET issued_qty = ${b.quantity} WHERE id = ${b.lineId}`
					);
					if (b.quantity !== line.issuedQty) {
						await logMovement(tx, ctx, {
							kind: 'issued',
							articleId: line.articleId,
							quantity: b.quantity - line.issuedQty,
							detail: String(row.title),
							reservationId: params.id
						});
					}
				}
				if (toIssue.length || body.bulk.some((b) => b.quantity > 0)) {
					await tx.execute(
						sql`UPDATE reservations SET status = 'issued', issued_at = coalesce(issued_at, now()),
								issued_by = coalesce(issued_by, ${ctx.userId ?? null}), updated_at = now()
							WHERE id = ${params.id}`
					);
				}
				return toIssue.length;
			});
			await core.audit.logFromContext(ctx, 'material.reservation.issued', {
				target: params.id,
				metadata: { units: count, bulkLines: body.bulk.length }
			});
			return fullReservation(ctx, params.id);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/return',
		summary: 'Zurücknehmen (mit Zustand je Stück), optional Rest als verloren abschließen',
		description:
			'Kisten bringen ihren Inhalt mit (Zustand der Kiste, wenn nicht einzeln angegeben). `bulk.quantity` ist ' +
			'die insgesamt zurückgegebene Menge. Sind alle Stücke und Mengen zurück, ist die Reservierung abgeschlossen.',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: returnInput,
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			const result = await mdb().transaction(async (tx) => {
				const row = await requireOpen(tx, ctx, params.id);
				const r = await loadReservation(tx, ctx, params.id);
				const index = await loadPlaceIndex(tx);
				const out = new Map(r.assigned.filter((a) => !a.returnedAt).map((a) => [a.unit.id, a]));
				const given = new Map<string, { condition: Condition; note: string }>();
				for (const u of body.units) {
					if (!out.has(u.unitId)) {
						throw errors.validation([
							{ path: ['units'], message: 'Stück ist nicht aus dieser Reservierung ausgegeben' }
						]);
					}
					given.set(u.unitId, { condition: u.condition, note: u.note });
					if (index.units.get(u.unitId)?.isContainer) {
						for (const c of containedUnits(index, u.unitId)) {
							if (out.has(c) && !body.units.some((x) => x.unitId === c)) {
								given.set(c, { condition: u.condition === 'lost' ? 'lost' : 'ok', note: '' });
							}
						}
					}
				}
				if (body.closeMissingAsLost) {
					for (const id of out.keys()) {
						if (!given.has(id)) given.set(id, { condition: 'lost', note: 'Nicht zurückgegeben' });
					}
				}
				const damaged: { name: string; condition: Condition; note: string }[] = [];
				for (const [unitId, g] of given) {
					const a = out.get(unitId)!;
					await tx.execute(
						sql`UPDATE reservation_units SET returned_at = now(), returned_by = ${ctx.userId ?? null},
								return_condition = ${g.condition}, return_note = ${g.note}
							WHERE reservation_id = ${params.id} AND unit_id = ${unitId}`
					);
					const changed = g.condition !== a.unit.condition && g.condition !== 'ok';
					await tx.execute(
						sql`UPDATE units SET issued_reservation_id = NULL, updated_at = now()
							${changed ? sql`, condition = ${g.condition}, condition_note = ${g.note}` : sql``}
							WHERE id = ${unitId}`
					);
					await logMovement(tx, ctx, {
						kind: 'returned',
						unitId,
						detail: `${String(row.title)} – ${CONDITION_LABELS[g.condition]}`,
						note: g.note,
						reservationId: params.id
					});
					if (g.condition === 'damaged' || g.condition === 'defect' || g.condition === 'lost') {
						damaged.push({ name: a.unit.name, condition: g.condition, note: g.note });
					}
				}
				const bulkLines = r.lines.filter((l) => l.articleKind === 'bulk');
				for (const b of body.bulk) {
					const line = bulkLines.find((l) => l.id === b.lineId);
					if (!line) throw errors.validation([{ path: ['bulk'], message: 'Zeile nicht gefunden' }]);
					if (b.quantity > line.issuedQty) {
						throw errors.validation([{ path: ['bulk'], message: 'Mehr zurück als ausgegeben' }]);
					}
					await tx.execute(
						sql`UPDATE reservation_lines SET returned_qty = ${b.quantity} WHERE id = ${b.lineId}`
					);
					line.returnedQty = b.quantity;
				}
				if (body.closeMissingAsLost) {
					for (const line of bulkLines) {
						const lost = line.issuedQty - line.returnedQty;
						if (lost <= 0) continue;
						// Verlorene Menge aus dem Bestand ausbuchen (größte Lagerstellen zuerst)
						let rest = lost;
						const holders = await rows(
							tx,
							sql`SELECT location_id, container_id, quantity FROM stock
								WHERE article_id = ${line.articleId} AND quantity > 0 ORDER BY quantity DESC`
						);
						for (const h of holders) {
							if (rest <= 0) break;
							const take = Math.min(rest, num(h.quantity));
							await setQty(
								tx,
								line.articleId!,
								{
									locationId: h.location_id ? String(h.location_id) : null,
									containerId: h.container_id ? String(h.container_id) : null
								},
								num(h.quantity) - take
							);
							rest -= take;
						}
						await tx.execute(
							sql`UPDATE reservation_lines SET returned_qty = issued_qty WHERE id = ${line.id}`
						);
						await logMovement(tx, ctx, {
							kind: 'stock-lost',
							articleId: line.articleId,
							quantity: lost,
							detail: String(row.title),
							reservationId: params.id
						});
						damaged.push({ name: `${lost} × ${line.name}`, condition: 'lost', note: '' });
						line.returnedQty = line.issuedQty;
					}
				}
				const stillOut = [...out.keys()].filter((id) => !given.has(id)).length;
				const bulkOpen = bulkLines.some((l) => l.returnedQty < l.issuedQty);
				const done = stillOut === 0 && !bulkOpen;
				if (done) {
					await tx.execute(
						sql`UPDATE reservations SET status = 'returned', returned_at = now(),
								returned_by = ${ctx.userId ?? null}, updated_at = now()
							WHERE id = ${params.id}`
					);
				}
				return { returned: given.size, damaged, done, title: String(row.title) };
			});
			await core.audit.logFromContext(ctx, 'material.reservation.returned', {
				target: params.id,
				metadata: { units: result.returned, damaged: result.damaged.length, completed: result.done }
			});
			if (result.damaged.length) await notifyDamage(ctx, params.id, result.title, result.damaged);
			return fullReservation(ctx, params.id);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/unissue',
		summary: 'Ausgabe eines Stücks zurücknehmen (Fehlscan)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: z.object({ unitId: z.uuid() }),
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			await mdb().transaction(async (tx) => {
				await requireOpen(tx, ctx, params.id);
				const index = await loadPlaceIndex(tx);
				const ids = [
					body.unitId,
					...(index.units.get(body.unitId)?.isContainer ? containedUnits(index, body.unitId) : [])
				];
				for (const id of ids) {
					const res = await rows(
						tx,
						sql`DELETE FROM reservation_units WHERE reservation_id = ${params.id} AND unit_id = ${id}
							AND returned_at IS NULL RETURNING unit_id`
					);
					if (!res.length) continue;
					await tx.execute(
						sql`UPDATE units SET issued_reservation_id = NULL WHERE id = ${id}
							AND issued_reservation_id = ${params.id}`
					);
				}
				const [left] = await rows(
					tx,
					sql`SELECT
						(SELECT count(*) FROM reservation_units WHERE reservation_id = ${params.id}) +
						(SELECT coalesce(sum(issued_qty), 0) FROM reservation_lines WHERE reservation_id = ${params.id}) AS n`
				);
				if (num(left?.n) === 0) {
					await tx.execute(
						sql`UPDATE reservations SET status = 'reserved', issued_at = NULL, issued_by = NULL
							WHERE id = ${params.id}`
					);
				}
			});
			await core.audit.logFromContext(ctx, 'material.reservation.unissued', { target: params.id });
			return fullReservation(ctx, params.id);
		}
	})
];
