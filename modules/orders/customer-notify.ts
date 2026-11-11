/**
 * Benachrichtigung „Meine Bestellung“ (core.notifications) an die bestellende Person und die mit dem
 * Mitglied verknüpften Konten: angelegt (wenn jemand anderes bestellt hat), geändert, ausgegeben, storniert,
 * gelöscht. Nie an
 * die handelnde Person. Immer nach der Transaktion; wirft nie.
 */
import { sql } from 'drizzle-orm';
import { bestEffort, core, type RequestContext } from '$lib/sdk/server';
import { mdb, membersService, rows } from './db';
import { BASE_PATH, MODULE_ID, NOTIFY_MY_ORDER, PERMISSIONS } from './schemas';

type Kind = 'created' | 'updated' | 'handed-out' | 'cancelled' | 'deleted';

/** Kopfdaten der Bestellung (`number`, `member_id`, `member_name`, `ordered_by`); beim Löschen vorher gelesen */
export type OrderSnapshot = Record<string, unknown>;

export async function notifyCustomer(
	ctx: RequestContext,
	orderId: string,
	kind: Kind,
	detail: { quantity?: number; all?: boolean; snapshot?: OrderSnapshot } = {}
): Promise<void> {
	await bestEffort(
		'orders.notify.customer',
		async () => {
			const [order] = detail.snapshot
				? [detail.snapshot]
				: await mdb().transaction((tx) =>
						rows(
							tx,
							sql`SELECT number, member_id, member_name, ordered_by FROM orders WHERE id = ${orderId}`
						)
					);
			if (!order) return;
			const memberId = String(order.member_id);
			const linked = (await (await membersService()).listLinkedUserIds([memberId]))[memberId] ?? [];
			const allowed = new Set(await core.permissions.usersWith(PERMISSIONS.view));
			const userIds = [
				...new Set([...(order.ordered_by ? [String(order.ordered_by)] : []), ...linked])
			].filter((id) => id !== ctx.userId && allowed.has(id));
			if (!userIds.length) return;
			const number = String(order.number);
			const name = String(order.member_name ?? '');
			const qty = detail.quantity ?? 0;
			const text =
				kind === 'created'
					? {
							title: `Bestellung ${number} für ${name}`,
							body: `Für ${name} wurde die Bestellung ${number} angelegt. Die Rechnung kommt per E-Mail.`
						}
					: kind === 'updated'
						? {
								title: `Bestellung ${number} geändert`,
								body: `Die Bestellung ${number} für ${name} wurde geändert. Eine angepasste Rechnung kommt gegebenenfalls per E-Mail.`
							}
						: kind === 'deleted'
							? {
									title: `Bestellung ${number} gelöscht`,
									body: `Die Bestellung ${number} für ${name} wurde gelöscht. Eine bereits verschickte Rechnung wurde storniert.`
								}
							: kind === 'handed-out'
								? {
										title: `Bestellung ${number} ausgegeben`,
										body: `${qty === 1 ? 'Ein Artikel' : `${qty} Artikel`} aus der Bestellung ${number} für ${name} ${qty === 1 ? 'wurde' : 'wurden'} ausgegeben.`
									}
								: {
										title: `Bestellung ${number} ${detail.all ? 'storniert' : 'teilweise storniert'}`,
										body: detail.all
											? `Die Bestellung ${number} für ${name} wurde storniert.`
											: `Aus der Bestellung ${number} für ${name} ${qty === 1 ? 'wurde ein Artikel' : `wurden ${qty} Artikel`} storniert.`
									};
			await core.notifications.send(ctx, MODULE_ID, [
				{ type: NOTIFY_MY_ORDER, userIds, ...text, link: `${BASE_PATH}?tab=meine` }
			]);
		},
		{ ctx, target: orderId }
	);
}
