/**
 * Reservieren: Katalog mit freier Anzahl, Zweck-Auswahl, Verfügbarkeit, Reservierungen anlegen/ändern/
 * stornieren/löschen, Listen (eigene, alle, je Aktion).
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { reassignAll } from './assign.service';
import { AvailabilityIndex, type Booking } from './availability';
import { actionsService, mdb, num, rows, str, today } from './db';
import { loadBookings, loadStock } from './inventory';
import { notifyReservationCreated } from './notify';
import {
	assertLinesAvailable,
	canEditReservation,
	canHandOut,
	checkLines,
	checkPurpose,
	fullReservation,
	listReservations,
	loadCatalog,
	loadConsumables,
	mergeLines,
	purposeOptions,
	replaceLines,
	requireReservationRow
} from './reservations.service';
import {
	PERMISSIONS,
	actionParams,
	assignmentInput,
	availabilityInput,
	catalogQuery,
	formatAmount,
	idParams,
	lineParams,
	reservationInput,
	reservationListQuery,
	returnInput,
	type Catalog,
	type LineAvailability,
	type PurposeOptions,
	type Reservation,
	type ReservationListItem,
	type ReservationPage
} from './schemas';

const tags = ['Modul: material'];

const HANDED_OUT = 'Das Material ist ausgegeben – erst die Ausgabe zurücknehmen';
const RETURNED = 'Das Material ist schon zurückgenommen – erst die Rücknahme aufheben';

const lock = (tx: Tx) =>
	tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'material:reservations'}))`);

export const reservationsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/catalog',
		summary: 'Katalog zum Reservieren: Typen und Artikel ohne Typ mit freier Anzahl im Zeitraum',
		tags,
		permission: PERMISSIONS.view,
		query: catalogQuery,
		handler: ({ query }): Promise<Catalog> => mdb().transaction((tx) => loadCatalog(tx, query))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/purpose-options',
		summary: 'Auswahl für den Zweck: sichtbare Aktionen und Gruppen',
		tags,
		permission: PERMISSIONS.view,
		handler: ({ ctx }): Promise<PurposeOptions> => purposeOptions(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/availability',
		summary: 'Verfügbarkeit von Zeilen im Zeitraum prüfen (ohne zu speichern)',
		tags,
		permission: PERMISSIONS.view,
		body: availabilityInput,
		handler: ({ body }): Promise<LineAvailability[]> => {
			if (body.endsOn < body.startsOn) {
				throw errors.validation([{ path: ['endsOn'], message: 'Ende liegt vor dem Beginn' }]);
			}
			return mdb().transaction((tx) => checkLines(tx, body, { preview: true }));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations',
		summary: 'Reservierungen (eigene; alle mit Verwaltungsrecht)',
		tags,
		permission: PERMISSIONS.view,
		query: reservationListQuery,
		handler: ({ ctx, query }): Promise<ReservationPage> => listReservations(ctx, query)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/my/reservations',
		summary: 'Eigene laufende und kommende Reservierungen (Dashboard)',
		tags,
		permission: PERMISSIONS.reserve,
		handler: async ({ ctx }): Promise<ReservationListItem[]> =>
			(await listReservations(ctx, { scope: 'mine', state: 'open', limit: 20, offset: 0 })).items
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations/by-action/:actionId',
		summary: 'Reservierungen einer Aktion (Karte in der Aktion)',
		tags,
		permission: PERMISSIONS.view,
		params: actionParams,
		handler: async ({ ctx, params }) => {
			const service = await actionsService();
			const [action] = service
				? await service.accessibleActions(ctx, { ids: [params.actionId] })
				: [];
			if (!action) throw errors.notFound('Aktion nicht gefunden');
			const page = await listReservations(ctx, {
				scope: 'all',
				state: 'all',
				actionId: params.actionId,
				limit: 100,
				offset: 0
			});
			return {
				reservations: page.items.filter((r) => r.status !== 'cancelled'),
				canCreate: ctx.permissions.has(PERMISSIONS.reserve)
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/reservations/:id',
		summary: 'Reservierung mit Positionen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ ctx, params }): Promise<Reservation> => fullReservation(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations',
		summary: 'Reservieren (prüft die Verfügbarkeit, 409 mit `details.lines`)',
		tags,
		permission: PERMISSIONS.reserve,
		body: reservationInput,
		handler: async ({ ctx, body }): Promise<Reservation> => {
			await checkPurpose(ctx, body);
			const lines = mergeLines(body.lines);
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await lock(tx);
				await assertLinesAvailable(tx, { ...body, lines });
				await tx.execute(
					sql`INSERT INTO reservations (id, title, purpose, action_id, group_id, starts_on, ends_on, notes, created_by)
						VALUES (${id}, ${body.title}, ${body.purpose}, ${body.actionId}, ${body.groupId},
							${body.startsOn}::date, ${body.endsOn}::date, ${body.notes}, ${ctx.userId ?? null})`
				);
				await replaceLines(tx, id, lines);
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.created', {
				target: id,
				metadata: { lines: lines.length, purpose: body.purpose }
			});
			const reservation = await fullReservation(ctx, id);
			await notifyReservationCreated(ctx, reservation);
			return reservation;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/reservations/:id',
		summary: 'Reservierung ändern (ersetzt Angaben und Positionen)',
		tags,
		permission: PERMISSIONS.reserve,
		params: idParams,
		body: reservationInput,
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			await checkPurpose(ctx, body);
			const lines = mergeLines(body.lines);
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (!canEditReservation(ctx, current.createdBy)) {
					throw errors.forbidden('Nur eigene Reservierungen können geändert werden');
				}
				if (current.status !== 'reserved') throw errors.conflict('Die Reservierung ist storniert');
				if (current.handedOutAt) throw errors.conflict(HANDED_OUT);
				await assertLinesAvailable(tx, { ...body, lines, excludeReservationId: params.id });
				await tx.execute(
					sql`UPDATE reservations SET title = ${body.title}, purpose = ${body.purpose},
						action_id = ${body.actionId}, group_id = ${body.groupId}, starts_on = ${body.startsOn}::date,
						ends_on = ${body.endsOn}::date, notes = ${body.notes}, updated_at = now()
						WHERE id = ${params.id}`
				);
				await replaceLines(tx, params.id, lines, {
					keepPins: current.startsOn === body.startsOn && current.endsOn === body.endsOn
				});
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.updated', {
				target: params.id,
				metadata: { lines: lines.length }
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/cancel',
		summary: 'Reservierung stornieren',
		tags,
		permission: PERMISSIONS.reserve,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Reservation> => {
			await mdb().transaction(async (tx) => {
				const current = await requireReservationRow(tx, params.id);
				if (!canEditReservation(ctx, current.createdBy)) {
					throw errors.forbidden('Nur eigene Reservierungen können storniert werden');
				}
				if (current.status === 'cancelled') return;
				if (current.handedOutAt) throw errors.conflict(HANDED_OUT);
				await lock(tx);
				await tx.execute(
					sql`UPDATE reservations SET status = 'cancelled', cancelled_at = now(), updated_at = now()
						WHERE id = ${params.id}`
				);
				await tx.execute(
					sql`DELETE FROM reservation_assignments WHERE reservation_id = ${params.id}`
				);
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.cancelled', { target: params.id });
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/reservations/:id',
		summary: 'Reservierung löschen (nur stornierte oder vergangene)',
		tags,
		permission: PERMISSIONS.reserve,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const current = await requireReservationRow(tx, params.id);
				if (!canEditReservation(ctx, current.createdBy)) {
					throw errors.forbidden('Nur eigene Reservierungen können gelöscht werden');
				}
				if (current.status === 'reserved' && current.endsOn >= today()) {
					throw errors.conflict(
						'Nur stornierte oder vergangene Reservierungen können gelöscht werden'
					);
				}
				await rows(tx, sql`DELETE FROM reservations WHERE id = ${params.id} RETURNING id`);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.deleted', { target: params.id });
			return { deleted: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/hand-out',
		summary: 'Material als ausgegeben markieren (Zuteilung wird festgeschrieben)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Reservation> => {
			if (!canHandOut(ctx)) throw errors.forbidden('Ausgabe nur mit Verwaltungsrecht');
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (current.status !== 'reserved') throw errors.conflict('Die Reservierung ist storniert');
				if (current.handedOutAt) return;
				// Zuteilung vorher vervollständigen, damit die festgeschriebene Liste stimmt
				await reassignAll(tx);
				await tx.execute(
					sql`UPDATE reservations SET handed_out_at = now(), handed_out_by = ${ctx.userId ?? null},
						updated_at = now() WHERE id = ${params.id}`
				);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.handed-out', {
				target: params.id
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/reservations/:id/hand-out',
		summary: 'Ausgabe zurücknehmen (Zuteilung wird wieder umplanbar)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Reservation> => {
			if (!canHandOut(ctx)) throw errors.forbidden('Ausgabe nur mit Verwaltungsrecht');
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (!current.handedOutAt) return;
				if (current.returnedAt) throw errors.conflict(RETURNED);
				await tx.execute(
					sql`UPDATE reservations SET handed_out_at = NULL, handed_out_by = NULL, updated_at = now()
						WHERE id = ${params.id}`
				);
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.hand-out-undone', {
				target: params.id
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/return',
		summary: 'Material zurücknehmen und Verbrauch eintragen (Bestand sinkt um den Verbrauch)',
		description:
			'Nur nach der Ausgabe. `consumed` je Verbrauchsartikel der Reservierung (fehlende = nichts verbraucht), ' +
			'höchstens die ausgegebene Menge (sonst 422).',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: returnInput,
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			if (!canHandOut(ctx)) throw errors.forbidden('Rücknahme nur mit Verwaltungsrecht');
			let total = 0;
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (current.status !== 'reserved') throw errors.conflict('Die Reservierung ist storniert');
				if (!current.handedOutAt) throw errors.conflict('Das Material ist noch nicht ausgegeben');
				if (current.returnedAt) throw errors.conflict(RETURNED);
				const issued = new Map(
					(await loadConsumables(tx, params.id, false)).map((c) => [c.itemId, c])
				);
				const consumed = new Map<string, number>();
				body.consumed.forEach((c, i) => {
					const use = issued.get(c.itemId);
					if (!use) {
						throw errors.validation([
							{
								path: ['consumed', i, 'itemId'],
								message: 'Kein Verbrauchsmaterial dieser Reservierung'
							}
						]);
					}
					const sum = (consumed.get(c.itemId) ?? 0) + c.quantity;
					if (sum > use.issued) {
						throw errors.validation([
							{
								path: ['consumed', i, 'quantity'],
								message: `Höchstens ${formatAmount(use.issued, use.unit)} (ausgegeben)`
							}
						]);
					}
					consumed.set(c.itemId, sum);
				});
				for (const [itemId, quantity] of consumed) {
					if (quantity <= 0) continue;
					const use = issued.get(itemId)!;
					total += quantity;
					await tx.execute(
						sql`INSERT INTO consumptions (id, reservation_id, reservation_title, item_id, item_name, unit,
								quantity, recorded_by)
							VALUES (${crypto.randomUUID()}, ${params.id}, ${current.title}, ${itemId}, ${use.name},
								${use.unit}, ${quantity}, ${ctx.userId ?? null})`
					);
					await tx.execute(
						sql`UPDATE items SET quantity = greatest(0, quantity - ${quantity}), updated_at = now()
							WHERE id = ${itemId}`
					);
				}
				await tx.execute(
					sql`UPDATE reservations SET returned_at = now(), returned_by = ${ctx.userId ?? null},
						updated_at = now() WHERE id = ${params.id}`
				);
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.returned', {
				target: params.id,
				metadata: { consumedItems: body.consumed.filter((c) => c.quantity > 0).length, total }
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/reservations/:id/return',
		summary: 'Rücknahme zurücknehmen (Verbrauch wird dem Bestand wieder gutgeschrieben)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Reservation> => {
			if (!canHandOut(ctx)) throw errors.forbidden('Rücknahme nur mit Verwaltungsrecht');
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (!current.returnedAt) return;
				await tx.execute(
					sql`UPDATE items i SET quantity = i.quantity + c.n, updated_at = now()
						FROM (SELECT item_id, sum(quantity) AS n FROM consumptions
							WHERE reservation_id = ${params.id} AND item_id IS NOT NULL GROUP BY item_id) c
						WHERE i.id = c.item_id`
				);
				await tx.execute(sql`DELETE FROM consumptions WHERE reservation_id = ${params.id}`);
				await tx.execute(
					sql`UPDATE reservations SET returned_at = NULL, returned_by = NULL, updated_at = now()
						WHERE id = ${params.id}`
				);
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.return-undone', {
				target: params.id
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/reservations/:id/lines/:lineId/assignment',
		summary: 'Zuteilung einer Typ-Zeile von Hand festlegen (angeheftet; Rest teilt das System zu)',
		tags,
		permission: PERMISSIONS.view,
		params: lineParams,
		body: assignmentInput,
		handler: async ({ ctx, params, body }): Promise<Reservation> => {
			if (!canHandOut(ctx)) throw errors.forbidden('Zuteilung nur mit Verwaltungsrecht');
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (current.status !== 'reserved') throw errors.conflict('Die Reservierung ist storniert');
				const [line] = await rows(
					tx,
					sql`SELECT id, type_id, quantity FROM reservation_lines
						WHERE id = ${params.lineId} AND reservation_id = ${params.id}`
				);
				if (!line) throw errors.notFound('Position nicht gefunden');
				const typeId = str(line.type_id);
				if (!typeId) throw errors.badRequest('Nur Positionen mit beliebigen Artikeln eines Typs');
				const wanted = mergeAssignment(body.items);
				await assertAssignable(tx, current, params.lineId, typeId, num(line.quantity), wanted);
				await tx.execute(sql`DELETE FROM reservation_assignments WHERE line_id = ${params.lineId}`);
				for (const a of wanted) {
					await tx.execute(
						sql`INSERT INTO reservation_assignments (id, reservation_id, line_id, item_id, quantity, pinned, slot)
							VALUES (${crypto.randomUUID()}, ${params.id}, ${params.lineId}, ${a.itemId}, ${a.quantity}, true, 0)`
					);
				}
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.assignment-changed', {
				target: params.id,
				metadata: { line: params.lineId, items: body.items.length }
			});
			return fullReservation(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/reservations/:id/reassign',
		summary: 'Von Hand festgelegte Zuteilungen lösen und neu zuteilen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<Reservation> => {
			if (!canHandOut(ctx)) throw errors.forbidden('Zuteilung nur mit Verwaltungsrecht');
			await mdb().transaction(async (tx) => {
				await lock(tx);
				const current = await requireReservationRow(tx, params.id);
				if (current.status !== 'reserved') throw errors.conflict('Die Reservierung ist storniert');
				if (current.handedOutAt) throw errors.conflict(HANDED_OUT);
				await tx.execute(
					sql`DELETE FROM reservation_assignments WHERE reservation_id = ${params.id}`
				);
				await reassignAll(tx);
			});
			await core.audit.logFromContext(ctx, 'material.reservation.reassigned', {
				target: params.id
			});
			return fullReservation(ctx, params.id);
		}
	})
];

function mergeAssignment(items: { itemId: string; quantity: number }[]) {
	const map = new Map<string, number>();
	for (const a of items) map.set(a.itemId, (map.get(a.itemId) ?? 0) + a.quantity);
	return [...map.entries()].map(([itemId, quantity]) => ({ itemId, quantity }));
}

/**
 * Von Hand gewählte Artikel prüfen: gleicher Typ, nutzbar, höchstens die Anzahl der Zeile und im Zeitraum
 * frei – gegen andere Reservierungen und gegen die übrigen Positionen dieser Reservierung
 */
async function assertAssignable(
	tx: Tx,
	r: { id: string; startsOn: string; endsOn: string },
	lineId: string,
	typeId: string,
	lineQuantity: number,
	wanted: { itemId: string; quantity: number }[]
): Promise<void> {
	if (wanted.reduce((n, a) => n + a.quantity, 0) > lineQuantity) {
		throw errors.validation([{ path: ['items'], message: `Höchstens ${lineQuantity} zuteilen` }]);
	}
	const own: Booking[] = (
		await rows(
			tx,
			sql`SELECT item_id, quantity FROM reservation_lines
				WHERE reservation_id = ${r.id} AND item_id IS NOT NULL
				UNION ALL SELECT item_id, quantity FROM reservation_assignments
				WHERE reservation_id = ${r.id} AND line_id <> ${lineId}`
		)
	).map((x) => ({
		startsOn: r.startsOn,
		endsOn: r.endsOn,
		typeId: null,
		itemId: String(x.item_id),
		quantity: num(x.quantity),
		assigned: true
	}));
	const index = new AvailabilityIndex(
		await loadStock(tx),
		await loadBookings(tx, r.startsOn, r.endsOn, r.id)
	);
	const period = { from: r.startsOn, to: r.endsOn };
	wanted.forEach((a, i) => {
		const s = index.item(a.itemId);
		if (!s || s.typeId !== typeId || !s.usable) {
			throw errors.validation([
				{ path: ['items', i, 'itemId'], message: 'Artikel passt nicht oder ist nicht nutzbar' }
			]);
		}
		if (index.freeItem(a.itemId, period, own) < a.quantity) {
			throw errors.conflict('Ein gewählter Artikel ist im Zeitraum schon fest vergeben');
		}
	});
}
