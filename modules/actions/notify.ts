/**
 * Benachrichtigungen der Aktionen über `core.notifications` (Kanal wählt jede Person im Profil):
 * neue Anmeldungen und Abrechnungs-Ereignisse an Eigentümer*in + Bearbeiten-Freigaben, Freigabe an die
 * neue Person, Anmeldebestätigung als Push an das anmeldende Konto. Immer nach der Transaktion, wirft nie.
 */
import { sql } from 'drizzle-orm';
import { bestEffort, core, moduleDb, rowsOf, type RequestContext } from '$lib/sdk/server';
import {
	MODULE_ID,
	NOTIFY_ACCOUNTING,
	NOTIFY_ACTION_SHARED,
	NOTIFY_REGISTRATION_NEW,
	NOTIFY_REGISTRATION_OWN
} from './schemas';

const VIEW = 'actions.action.view';
const actionLink = (id: string, tab?: string) =>
	`/modules/actions/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`;

/** Eigentümer*in und Personen mit Bearbeiten-Freigabe, mit Leserecht des Moduls, ohne `exclude` */
async function editorsOf(actionId: string, exclude: (string | null)[]): Promise<string[]> {
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT owner_id AS user_id FROM actions WHERE id = ${actionId}
				UNION SELECT user_id FROM action_shares WHERE action_id = ${actionId} AND level = 'edit'`
		)
	);
	const allowed = new Set(await core.permissions.usersWith(VIEW));
	const skip = new Set(exclude.filter((x): x is string => !!x));
	return [...new Set(rows.map((r) => String(r.user_id)))].filter(
		(id) => allowed.has(id) && !skip.has(id)
	);
}

/** Neue Anmeldung (über den Anmeldelink, nach Double-Opt-in bzw. mit verknüpftem Mitglied) */
export async function notifyRegistration(
	ctx: RequestContext,
	input: {
		actionId: string;
		actionName: string;
		participantName: string;
		memberId: string | null;
	}
): Promise<void> {
	await bestEffort(
		'actions.notify.registration',
		async () => {
			const editors = await editorsOf(input.actionId, [ctx.userId]);
			const items = [];
			if (editors.length) {
				items.push({
					type: NOTIFY_REGISTRATION_NEW,
					userIds: editors,
					title: `Neue Anmeldung für ${input.actionName}`,
					body: `${input.participantName} hat sich über den Anmeldelink für „${input.actionName}“ angemeldet.`,
					link: actionLink(input.actionId, 'participants'),
					group: input.actionName
				});
			}
			// Anmeldung mit verknüpftem Mitglied: Bestätigung als Push an das Konto (und weitere verknüpfte Konten)
			if (input.memberId) {
				const members = await core.modules.use<{
					listLinkedUserIds(ids: string[]): Promise<Record<string, string[]>>;
				}>('members', MODULE_ID);
				const linked = (await members.listLinkedUserIds([input.memberId]))[input.memberId] ?? [];
				const own = [...new Set([...(ctx.userId ? [ctx.userId] : []), ...linked])];
				if (own.length) {
					items.push({
						type: NOTIFY_REGISTRATION_OWN,
						userIds: own,
						title: `Anmeldung eingegangen: ${input.actionName}`,
						body: `${input.participantName} ist für „${input.actionName}“ angemeldet. Die Bestätigung kommt per E-Mail.`,
						link: '/dashboard'
					});
				}
			}
			if (items.length) await core.notifications.send(ctx, MODULE_ID, items);
		},
		{ ctx, target: input.actionId }
	);
}

/** Aktion mit einer Person geteilt bzw. ihre Rechte geändert */
export async function notifyShared(
	ctx: RequestContext,
	input: { actionId: string; actionName: string; userId: string; level: 'read' | 'edit' }
): Promise<void> {
	if (input.userId === ctx.userId) return;
	await bestEffort(
		'actions.notify.shared',
		async () => {
			const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
			const who = me?.name ?? 'Jemand';
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_ACTION_SHARED,
					userIds: [input.userId],
					title: `${who} hat „${input.actionName}“ mit dir geteilt`,
					body:
						input.level === 'edit'
							? `Du kannst die Aktion „${input.actionName}“ jetzt ansehen und bearbeiten.`
							: `Du kannst die Aktion „${input.actionName}“ jetzt ansehen.`,
					link: actionLink(input.actionId)
				}
			]);
		},
		{ ctx, target: input.actionId }
	);
}

/** Abrechnung abgeschlossen, Zwischenabrechnung angelegt oder wieder geöffnet (nicht an die handelnde Person) */
export async function notifyAccounting(
	ctx: RequestContext,
	input: {
		actionId: string;
		actionName: string;
		kind: 'final' | 'interim' | 'reopened';
		number?: number;
	}
): Promise<void> {
	await bestEffort(
		'actions.notify.accounting',
		async () => {
			const editors = await editorsOf(input.actionId, [ctx.userId]);
			if (!editors.length) return;
			const title =
				input.kind === 'final'
					? `Abrechnung abgeschlossen: ${input.actionName}`
					: input.kind === 'interim'
						? `Zwischenabrechnung${input.number ? ` Nr. ${input.number}` : ''} für ${input.actionName}`
						: `Abrechnung wieder geöffnet: ${input.actionName}`;
			const body =
				input.kind === 'final'
					? `Die Abrechnung von „${input.actionName}“ wurde abgeschlossen; offene Auslagen gehen jetzt an die Kasse.`
					: input.kind === 'interim'
						? `Für „${input.actionName}“ wurde eine Zwischenabrechnung angelegt; enthaltene Auslagen gehen an die Kasse.`
						: `Die Abrechnung von „${input.actionName}“ ist wieder offen und kann bearbeitet werden.`;
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_ACCOUNTING,
					userIds: editors,
					title,
					body,
					link: actionLink(input.actionId, 'accounting'),
					group: input.actionName
				}
			]);
		},
		{ ctx, target: input.actionId }
	);
}
