/**
 * Benachrichtigungen: Amt „Materialwart*in“ (Vorlage, Modul `offices` optional) bei neuer Reservierung
 * für eine Aktion, bei Schäden/Verlusten und bei überfälligen Rückgaben (Tagesjob); die reservierende
 * Person bekommt „Rückgabe überfällig“ über `core.notifications`. Immer NACH der Transaktion; wirft nie.
 */
import { sql } from 'drizzle-orm';
import { formatDateDe } from '$lib/sdk/dates';
import { bestEffort, core, type RequestContext } from '$lib/sdk/server';
import { dateStr, mdb, officesService, rows, today } from './db';
import {
	BASE_PATH,
	CONDITION_LABELS,
	MODULE_ID,
	NOTIFY_DAMAGE,
	NOTIFY_MY_OVERDUE,
	NOTIFY_OVERDUE,
	NOTIFY_RESERVATION_CREATED,
	OFFICE_KEY,
	type Condition,
	type Reservation
} from './schemas';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const link = (id: string) => `${BASE_PATH}/reservierung/${id}`;

export async function notifyReservationCreated(ctx: RequestContext, r: Reservation): Promise<void> {
	await bestEffort(
		'material.notify.reservation-created',
		async () => {
			const offices = await officesService();
			if (!offices) return;
			const items = r.lines.map((l) =>
				l.kind === 'article' ? `${l.quantity} × ${l.name}` : l.name
			);
			await offices.notify(ctx, [
				{
					module: MODULE_ID,
					office: OFFICE_KEY,
					event: NOTIFY_RESERVATION_CREATED,
					subject: clip(`Neue Reservierung: ${r.title}`, 150),
					text: clip(
						[
							`${r.createdByName} hat Material reserviert${r.actionName ? ` für „${r.actionName}“` : ''}.`,
							`Zeitraum: ${formatDateDe(r.startsOn)} – ${formatDateDe(r.endsOn)}`,
							'',
							...items.map((i) => `• ${i}`)
						].join('\n'),
						4000
					),
					link: link(r.id)
				}
			]);
		},
		{ ctx, target: r.id }
	);
}

export async function notifyDamage(
	ctx: RequestContext,
	reservationId: string,
	title: string,
	items: { name: string; condition: Condition; note: string }[]
): Promise<void> {
	await bestEffort(
		'material.notify.damage',
		async () => {
			const offices = await officesService();
			if (!offices) return;
			await offices.notify(ctx, [
				{
					module: MODULE_ID,
					office: OFFICE_KEY,
					event: NOTIFY_DAMAGE,
					subject: clip(`Schaden/Verlust bei der Rückgabe: ${title}`, 150),
					text: clip(
						items
							.map(
								(i) =>
									`• ${i.name}: ${CONDITION_LABELS[i.condition]}${i.note ? ` – ${i.note}` : ''}`
							)
							.join('\n'),
						4000
					),
					link: link(reservationId)
				}
			]);
		},
		{ ctx, target: reservationId }
	);
}

/** Tagesjob: überfällige Rückgaben einmal je Fälligkeit melden (Amt + reservierende Person) */
export async function runOverdueJob(ctx: RequestContext): Promise<string> {
	const t = today();
	const list = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT id, title, created_by, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
				FROM reservations
				WHERE status = 'issued' AND ends_on < ${t}::date
					AND (overdue_notified_on IS NULL OR overdue_notified_on < ends_on)`
		)
	);
	if (!list.length) return 'Keine überfälligen Rückgaben';
	const offices = await officesService();
	if (offices) {
		await bestEffort('material.notify.overdue', () =>
			offices.notify(
				ctx,
				list.map((r) => ({
					module: MODULE_ID,
					office: OFFICE_KEY,
					event: NOTIFY_OVERDUE,
					subject: clip(`Rückgabe überfällig: ${String(r.title)}`, 150),
					text: `Das Material der Reservierung „${String(r.title)}“ sollte bis ${formatDateDe(dateStr(r.ends_on))} zurück sein.`,
					link: link(String(r.id))
				}))
			)
		);
	}
	const personal = list.filter((r) => r.created_by);
	if (personal.length) {
		await bestEffort('material.notify.my-overdue', () =>
			core.notifications.send(
				ctx,
				MODULE_ID,
				personal.map((r) => ({
					type: NOTIFY_MY_OVERDUE,
					userIds: [String(r.created_by)],
					title: clip(`Rückgabe überfällig: ${String(r.title)}`, 150),
					body: `Bitte bring das Material der Reservierung „${String(r.title)}“ zurück (geplant bis ${formatDateDe(dateStr(r.ends_on))}) oder verlängere die Reservierung.`,
					link: link(String(r.id))
				}))
			)
		);
	}
	await mdb().transaction(async (tx) => {
		for (const r of list) {
			await tx.execute(
				sql`UPDATE reservations SET overdue_notified_on = ${t}::date WHERE id = ${String(r.id)}`
			);
		}
	});
	return `${list.length} überfällige Rückgabe(n) gemeldet`;
}
