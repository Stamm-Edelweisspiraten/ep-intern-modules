/**
 * Freigaben einer Aktion an Principals (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in).
 * Ändern dürfen nur Eigentümer*in und `actions.action.edit-all` (`requireAccess(…, 'share')`).
 * `PUT/DELETE /actions/:id/shares/:userId` bleiben als Kurzform für Freigaben an einzelne Benutzer*innen.
 */
import { sql } from 'drizzle-orm';
import {
	addedPrincipals,
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	describePrincipals,
	errors,
	moduleDb,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	principalMatchSql,
	type RequestContext,
	requireShareCapability,
	rowsOf,
	searchPrincipals,
	type StoredShare,
	type Tx,
	validatePrincipals
} from '$lib/sdk/server';
import { actionShareAccess, requireAccess } from './access';
import { notifyShared } from './notify';
import {
	MODULE_ID,
	idParams,
	principalSearchQuery,
	shareInput,
	shareParams,
	sharesInput,
	userSearchQuery,
	type ActionShares,
	type ShareEntry,
	type ShareLevel,
	type UserRef
} from './schemas';

const tags = ['Aktionen'];
const STAMM_NAME_SETTING = 'events.stamm.name';
const DEFAULT_EVERYONE_LABEL = 'Stamm';

/** Anzeigename für `everyone` (Stammesname aus den Termin-Einstellungen, sonst „Stamm“) */
export async function everyoneLabel(): Promise<string> {
	try {
		const value = await core.settings.get<unknown>(STAMM_NAME_SETTING);
		if (typeof value === 'string' && value.trim()) return value.trim();
	} catch {
		// Einstellung nicht registriert (events nicht aktiv) → Standard
	}
	return DEFAULT_EVERYONE_LABEL;
}

async function loadState(tx: Tx, ctx: RequestContext, id: string, need: 'read' | 'share') {
	const access = await requireAccess(tx, ctx, id, need);
	const [action] = await rowsOf(tx, sql`SELECT owner_id, name FROM actions WHERE id = ${id}`);
	return {
		access,
		ownerId: String(action?.owner_id),
		name: String(action?.name ?? 'Aktion'),
		shares: await actionShareAccess.loadShares(tx, id)
	};
}

/** Antwort aufbauen (nach der Transaktion: Namen über Core/members) */
async function buildShares(
	ctx: RequestContext,
	state: { ownerId: string; shares: StoredShare[]; canManage: boolean }
): Promise<ActionShares> {
	const label = await everyoneLabel();
	const [owners, described] = await Promise.all([
		core.users.byIds(ctx, [state.ownerId]),
		describePrincipals(ctx, MODULE_ID, state.shares, { everyoneLabel: label })
	]);
	const o = owners.get(state.ownerId);
	const owner: UserRef = o
		? { userId: o.id, name: o.name, email: o.email }
		: { userId: state.ownerId, name: 'Unbekannt', email: null };
	const shares: ShareEntry[] = described.map((p, i) => ({
		type: p.type,
		userId: p.id,
		name: p.name,
		detail: p.detail ?? null,
		color: p.color ?? null,
		image: p.image ?? null,
		level: state.shares[i]!.level
	}));
	shares.sort((a, b) => a.name.localeCompare(b.name, 'de'));
	return { owner, shares, canManage: state.canManage, everyoneLabel: label };
}

/** Neue oder höher gestufte Freigaben (für Benachrichtigungen) */
function upgraded(before: StoredShare[], after: StoredShare[]): StoredShare[] {
	const old = new Map(before.map((s) => [`${s.type}:${s.id}`, s.level]));
	return [
		...addedPrincipals(before, after),
		...after.filter((s) => s.level === 'edit' && old.get(`${s.type}:${s.id}`) === 'read')
	];
}

async function saveShares(
	ctx: RequestContext,
	id: string,
	next: (current: StoredShare[]) => StoredShare[]
): Promise<{ before: StoredShare[]; after: StoredShare[]; name: string; ownerId: string }> {
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const state = await loadState(tx, ctx, id, 'share');
		const after = next(state.shares);
		await actionShareAccess.replaceShares(tx, ctx, id, after);
		return { before: state.shares, after, name: state.name, ownerId: state.ownerId };
	});
}

async function afterSave(
	ctx: RequestContext,
	id: string,
	saved: { before: StoredShare[]; after: StoredShare[]; name: string; ownerId: string }
): Promise<void> {
	const changed = upgraded(saved.before, saved.after);
	if (changed.length) {
		await notifyShared(ctx, {
			actionId: id,
			actionName: saved.name,
			ownerId: saved.ownerId,
			principals: changed
		});
	}
}

export const shareEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/actions/:id/shares',
		summary: 'Freigaben einer Aktion auflisten',
		tags,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const state = await moduleDb(MODULE_ID).transaction((tx) =>
				loadState(tx, ctx, params.id, 'read')
			);
			return buildShares(ctx, { ...state, canManage: state.access.canShare });
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/actions/:id/shares',
		summary: 'Freigaben einer Aktion ersetzen',
		description:
			'Ersetzt alle Freigaben (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in; Stufe `read`/`edit`). Nur Eigentümer*in oder `actions.action.edit-all`. Bereits gespeicherte Ziele werden ohne erneute Prüfung akzeptiert.',
		tags,
		permission: 'actions.action.view',
		params: idParams,
		body: sharesInput,
		handler: async ({ ctx, params, body }) => {
			const current = await moduleDb(MODULE_ID).transaction((tx) =>
				loadState(tx, ctx, params.id, 'share')
			);
			body.shares.forEach((s, i) => {
				if (s.type === 'user' && s.id === current.ownerId) {
					throw errors.validation([
						{ path: ['shares', i, 'id'], message: 'Die Eigentümer*in hat bereits Zugriff' }
					]);
				}
			});
			await validatePrincipals(ctx, MODULE_ID, body.shares, {
				keep: new Set(current.shares.map((s) => `${s.type}:${s.id}`))
			});
			const saved = await saveShares(ctx, params.id, () => body.shares);
			await afterSave(ctx, params.id, saved);
			await core.audit.logFromContext(ctx, 'actions.action.shared', {
				target: params.id,
				metadata: {
					shares: saved.after.length,
					added: addedPrincipals(saved.before, saved.after).length,
					removed: addedPrincipals(saved.after, saved.before).length
				}
			});
			return buildShares(ctx, { ownerId: saved.ownerId, shares: saved.after, canManage: true });
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/actions/:id/shares/:userId',
		summary: 'Aktion mit einer Benutzer*in teilen oder Stufe ändern',
		tags,
		permission: 'actions.action.view',
		params: shareParams,
		body: shareInput,
		handler: async ({ ctx, params, body }) => {
			const current = await moduleDb(MODULE_ID).transaction((tx) =>
				loadState(tx, ctx, params.id, 'share')
			);
			if (current.ownerId === params.userId) {
				throw errors.badRequest('Die Aktion kann nicht mit der Eigentümer*in geteilt werden');
			}
			const target = (await core.users.byIds(ctx, [params.userId])).get(params.userId);
			if (!target) throw errors.validation({ userId: 'Unbekannter oder inaktiver Benutzer' });
			const saved = await saveShares(ctx, params.id, (shares) => [
				...shares.filter((s) => !(s.type === 'user' && s.id === params.userId)),
				{ type: 'user', id: params.userId, level: body.level }
			]);
			await afterSave(ctx, params.id, saved);
			await core.audit.logFromContext(ctx, 'actions.action.shared', {
				target: params.id,
				metadata: { userId: params.userId, level: body.level }
			});
			const entry: ShareEntry = {
				type: 'user',
				userId: target.id,
				name: target.name,
				detail: target.email || null,
				color: null,
				image: target.image ?? null,
				level: body.level as ShareLevel
			};
			return entry;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/actions/:id/shares/:userId',
		summary: 'Freigabe an eine Benutzer*in entfernen',
		description: 'Benutzer dürfen ihre eigene Freigabe entfernen (Aktion verlassen).',
		tags,
		permission: 'actions.action.view',
		params: shareParams,
		handler: async ({ ctx, params }) => {
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				const own = !!ctx.userId && ctx.userId === params.userId;
				await requireAccess(tx, ctx, params.id, own ? 'read' : 'share');
				await tx.execute(
					sql`DELETE FROM action_shares WHERE action_id = ${params.id}
						AND principal_type = 'user' AND principal_id = ${params.userId}`
				);
			});
			await core.audit.logFromContext(ctx, 'actions.action.unshared', {
				target: params.id,
				metadata: { userId: params.userId }
			});
			return { id: params.id, userId: params.userId };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Ziele suchen (Stamm, Gruppen, Rollen, Mitglieder, Benutzer*innen)',
		description:
			'Nur für Personen, die Aktionen teilen können (`actions.action.edit-all` oder Eigentümer*in mindestens einer Aktion), sonst 403. Mitglieder nur mit `members.member.view`, E-Mail-Adressen nur mit `core.users.view`.',
		tags,
		permission: 'actions.action.view',
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalSearchQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: ['actions.action.edit-all'],
				canShareSql: (userId) => sql`SELECT 1 FROM actions WHERE owner_id = ${userId}`
			});
			return searchPrincipals(ctx, MODULE_ID, query.search, {
				everyoneLabel: await everyoneLabel()
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/users',
		summary: 'Benutzerverzeichnis für Freigaben durchsuchen',
		description:
			'Nur für Personen, die Aktionen teilen können (`actions.action.edit-all` oder Eigentümer*in mindestens einer Aktion), sonst 403. E-Mail-Adressen nur mit `core.users.view` (sonst leer). Neue Oberflächen nutzen `/principals`.',
		tags,
		permission: 'actions.action.view',
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: userSearchQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: ['actions.action.edit-all'],
				canShareSql: (userId) => sql`SELECT 1 FROM actions WHERE owner_id = ${userId}`
			});
			return core.users.directory(ctx, { search: query.search, limit: query.limit });
		}
	})
];

/** Höchste Freigabestufe des Aufrufers je Aktion (für Listen; in der Transaktion) */
export async function shareLevelsFor(
	tx: Tx,
	ids: readonly string[],
	keys: readonly string[]
): Promise<Map<string, ShareLevel>> {
	const map = new Map<string, ShareLevel>();
	if (!ids.length || !keys.length) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT s.action_id, bool_or(s.level = 'edit') AS edit FROM action_shares s
			WHERE s.action_id IN (${sql.join(
				ids.map((i) => sql`${i}`),
				sql`, `
			)}) AND ${principalMatchSql('s', keys)}
			GROUP BY s.action_id`
	);
	for (const r of rows) {
		map.set(String(r.action_id), r.edit === true || r.edit === 't' ? 'edit' : 'read');
	}
	return map;
}
