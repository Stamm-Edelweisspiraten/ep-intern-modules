/**
 * Reservieren: Katalog mit freier Anzahl, Zweck-Auswahl, Verfügbarkeit, Reservierungen anlegen/ändern/
 * stornieren/löschen, Listen (eigene, alle, je Aktion).
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { actionsService, mdb, rows, today } from './db';
import { notifyReservationCreated } from './notify';
import {
	assertLinesAvailable,
	canEditReservation,
	checkLines,
	checkPurpose,
	fullReservation,
	listReservations,
	loadCatalog,
	mergeLines,
	purposeOptions,
	replaceLines,
	requireReservationRow
} from './reservations.service';
import {
	PERMISSIONS,
	actionParams,
	availabilityInput,
	catalogQuery,
	idParams,
	reservationInput,
	reservationListQuery,
	type Catalog,
	type LineAvailability,
	type PurposeOptions,
	type Reservation,
	type ReservationListItem,
	type ReservationPage
} from './schemas';

const tags = ['Modul: material'];

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
			return mdb().transaction((tx) => checkLines(tx, body));
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
				await assertLinesAvailable(tx, { ...body, lines, excludeReservationId: params.id });
				await tx.execute(
					sql`UPDATE reservations SET title = ${body.title}, purpose = ${body.purpose},
						action_id = ${body.actionId}, group_id = ${body.groupId}, starts_on = ${body.startsOn}::date,
						ends_on = ${body.endsOn}::date, notes = ${body.notes}, updated_at = now()
						WHERE id = ${params.id}`
				);
				await replaceLines(tx, params.id, lines);
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
				await tx.execute(
					sql`UPDATE reservations SET status = 'cancelled', cancelled_at = now(), updated_at = now()
						WHERE id = ${params.id}`
				);
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
	})
];
