/**
 * Eigene Benachrichtigungs-Einstellungen für Vorlagen-Ämter: je Amt und Ereignis sofort / täglich / aus.
 * Gespeichert werden nur Abweichungen vom Standard (sofort).
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { mdb, rowsOf, usersByIds, type Row } from './load';
import {
	DEFAULT_NOTIFY_MODE,
	NOTIFY_MODES,
	notificationPrefInput,
	type MyNotifications,
	type NotifyMode
} from './schemas';
import { applyTemplatesCached } from './templates.service';
import { registeredTemplates } from './templates';

const tags = ['Modul: offices'];

function requireUserId(userId: string | null | undefined): string {
	if (!userId) throw errors.forbidden('Nur für angemeldete Benutzer*innen');
	return userId;
}

interface RawMine {
	offices: Row[];
	prefs: Row[];
}

async function loadRaw(tx: Tx, userId: string): Promise<RawMine> {
	return {
		offices: await rowsOf(
			tx,
			sql`SELECT o.id, o.name, o.source_module, o.source_key
				FROM office_holders h JOIN offices o ON o.id = h.office_id
				WHERE h.user_id = ${userId} AND o.source_module IS NOT NULL
				ORDER BY o.position, o.name, o.id`
		),
		prefs: await rowsOf(
			tx,
			sql`SELECT module_id, office_key, event_key, mode FROM notification_prefs
				WHERE user_id = ${userId}`
		)
	};
}

/** Zusammenbauen (außerhalb der Transaktion): nur Vorlagen registrierter, aktiver Module */
async function build(userId: string, raw: RawMine): Promise<MyNotifications> {
	const templates = registeredTemplates();
	const prefs = new Map<string, NotifyMode>();
	for (const p of raw.prefs) {
		const mode = String(p.mode) as NotifyMode;
		if (NOTIFY_MODES.includes(mode)) {
			prefs.set(`${String(p.module_id)}|${String(p.office_key)}|${String(p.event_key)}`, mode);
		}
	}
	const enabled = new Map<string, boolean>();
	const offices: MyNotifications['offices'] = [];
	for (const o of raw.offices) {
		const module = String(o.source_module);
		const key = String(o.source_key);
		const info = templates.get(module);
		const template = info?.templates.get(key);
		if (!info || !template) continue;
		if (!enabled.has(module)) enabled.set(module, await core.modules.isEnabled(module));
		if (!enabled.get(module) || template.notifications.length === 0) continue;
		offices.push({
			officeId: String(o.id),
			officeName: String(o.name),
			module,
			moduleName: info.moduleName,
			officeKey: key,
			events: template.notifications.map((n) => ({
				key: n.key,
				label: n.label,
				description: n.description ?? null,
				mode: prefs.get(`${module}|${key}|${n.key}`) ?? DEFAULT_NOTIFY_MODE
			}))
		});
	}
	const users = await usersByIds(core.auth.systemContext('offices'), [userId]);
	return { email: users.get(userId)?.email ?? null, offices };
}

async function loadMine(userId: string): Promise<MyNotifications> {
	const raw = await mdb().transaction((tx) => loadRaw(tx, userId));
	return build(userId, raw);
}

export const notificationEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/me/notifications',
		summary: 'Eigene Benachrichtigungen der Vorlagen-Ämter (Modus je Ereignis)',
		tags,
		permission: 'offices.office.view',
		handler: async ({ ctx }): Promise<MyNotifications> => {
			const userId = requireUserId(ctx.userId);
			await applyTemplatesCached(ctx);
			return loadMine(userId);
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/me/notifications',
		summary: 'Modus einer Benachrichtigung setzen (sofort, täglich oder aus)',
		tags,
		permission: 'offices.office.view',
		body: notificationPrefInput,
		handler: async ({ ctx, body }): Promise<MyNotifications> => {
			const userId = requireUserId(ctx.userId);
			const template = registeredTemplates().get(body.module)?.templates.get(body.office);
			const moduleActive = template ? await core.modules.isEnabled(body.module) : false;
			const raw = await mdb().transaction(async (tx) => {
				const [holder] = await rowsOf(
					tx,
					sql`SELECT 1 AS ok FROM office_holders h JOIN offices o ON o.id = h.office_id
						WHERE h.user_id = ${userId} AND o.source_module = ${body.module}
							AND o.source_key = ${body.office}
						LIMIT 1`
				);
				if (!holder) {
					throw errors.forbidden('Benachrichtigungen gibt es nur für eigene Ämter');
				}
				if (!moduleActive || !template?.notifications.some((n) => n.key === body.event)) {
					throw errors.validation([{ path: ['event'], message: 'Unbekannte Benachrichtigung' }]);
				}
				if (body.mode === DEFAULT_NOTIFY_MODE) {
					await tx.execute(
						sql`DELETE FROM notification_prefs WHERE user_id = ${userId}
							AND module_id = ${body.module} AND office_key = ${body.office}
							AND event_key = ${body.event}`
					);
				} else {
					await tx.execute(
						sql`INSERT INTO notification_prefs (user_id, module_id, office_key, event_key, mode)
							VALUES (${userId}, ${body.module}, ${body.office}, ${body.event}, ${body.mode})
							ON CONFLICT (user_id, module_id, office_key, event_key)
							DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`
					);
				}
				return loadRaw(tx, userId);
			});
			const mine = await build(userId, raw);
			await core.audit.logFromContext(ctx, 'offices.notification.pref-updated', {
				target: userId,
				metadata: {
					module: body.module,
					office: body.office,
					event: body.event,
					mode: body.mode
				}
			});
			return mine;
		}
	})
];
