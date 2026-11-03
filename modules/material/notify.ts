/**
 * Benachrichtigungen an das Amt „Materialwart*in“ (Vorlage, Modul `offices` optional): neue Reservierung
 * und gemeldeter Schaden. Immer NACH der Transaktion; wirft nie.
 */
import { formatDateDe } from '$lib/sdk/dates';
import { bestEffort, type RequestContext } from '$lib/sdk/server';
import { officesService } from './db';
import {
	BASE_PATH,
	CONDITION_LABELS,
	MODULE_ID,
	NOTIFY_DAMAGE,
	NOTIFY_FOOD_EXPIRING,
	NOTIFY_RESERVATION_CREATED,
	OFFICE_KEY,
	PURPOSE_LABELS,
	type Item,
	type Reservation
} from './schemas';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const reservationLink = (id: string) => `${BASE_PATH}?tab=alle&open=${id}`;
export const itemLink = (id: string) => `${BASE_PATH}?tab=lager&open=${id}`;

export async function notifyReservationCreated(ctx: RequestContext, r: Reservation): Promise<void> {
	await bestEffort(
		'material.notify.reservation-created',
		async () => {
			const offices = await officesService();
			if (!offices) return;
			const forWhat = r.actionName
				? ` für die Aktion „${r.actionName}“`
				: r.groupName
					? ` für die Gruppe „${r.groupName}“`
					: '';
			await offices.notify(ctx, [
				{
					module: MODULE_ID,
					office: OFFICE_KEY,
					event: NOTIFY_RESERVATION_CREATED,
					subject: clip(`Neue Reservierung: ${r.title}`, 150),
					text: clip(
						[
							`${r.createdByName} hat Material reserviert${forWhat}.`,
							`Zeitraum: ${formatDateDe(r.startsOn)} – ${formatDateDe(r.endsOn)} · ${PURPOSE_LABELS[r.purpose]}`,
							'',
							...r.lines.map((l) => `• ${l.quantity > 1 ? `${l.quantity} × ` : ''}${l.name}`)
						].join('\n'),
						4000
					),
					link: reservationLink(r.id)
				}
			]);
		},
		{ ctx, target: r.id }
	);
}

export const pantryLink = (id?: string) =>
	`${BASE_PATH}?tab=vorrat${id ? `&open=${encodeURIComponent(id)}` : ''}`;

/**
 * Sammel-Hinweis „Lebensmittel laufen ab“; `false`, wenn `offices` nicht aktiv ist (dann bleibt der Hinweis
 * offen und kommt beim nächsten Lauf).
 */
export async function notifyFoodExpiring(
	ctx: RequestContext,
	lines: { productId: string; text: string }[]
): Promise<boolean> {
	const offices = await officesService();
	if (!offices || !lines.length) return false;
	await bestEffort(
		'material.notify.food-expiring',
		() =>
			offices.notify(ctx, [
				{
					module: MODULE_ID,
					office: OFFICE_KEY,
					event: NOTIFY_FOOD_EXPIRING,
					subject:
						lines.length === 1
							? clip(`Lebensmittel läuft ab: ${lines[0]!.text}`, 150)
							: `${lines.length} Lebensmittel laufen bald ab`,
					text: clip(
						[
							'Im Vorrat laufen Lebensmittel ab oder sind abgelaufen:',
							'',
							...lines.map((l) => `• ${l.text}`)
						].join('\n'),
						4000
					),
					link: lines.length === 1 ? pantryLink(lines[0]!.productId) : pantryLink()
				}
			]),
		{ ctx }
	);
	return true;
}

export async function notifyDamage(ctx: RequestContext, item: Item, note: string): Promise<void> {
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
					subject: clip(`${CONDITION_LABELS[item.condition]}: ${item.name}`, 150),
					text: clip(
						`${item.name} (${item.code}) wurde als „${CONDITION_LABELS[item.condition]}“ gemeldet.` +
							(note ? `\n\n${note}` : ''),
						4000
					),
					link: itemLink(item.id)
				}
			]);
		},
		{ ctx, target: item.id }
	);
}
