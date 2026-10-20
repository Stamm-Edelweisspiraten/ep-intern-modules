/**
 * Rechte-Abgleich: Jede*r Inhaber*in erhält die Rollen aller seiner Ämter plus die automatische
 * Rolle `HOLDER_ROLE_NAME`. Verliehen über `core.roles.replaceModuleGrants` (Core-Tabelle
 * `user_role_grant`, wirkt nur bei aktivem Modul). Core-Aufrufe nie innerhalb der Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext } from '$lib/sdk/server';
import { mdb, rolesByIds, rowsOf } from './load';
import { HOLDER_ROLE_NAME, MODULE_ID } from './schemas';

/** ID der automatischen Inhaber-Rolle oder `null`, wenn sie (noch) nicht existiert */
export async function holderRoleId(ctx: RequestContext): Promise<string | null> {
	const found = await core.roles.directory(ctx, { search: HOLDER_ROLE_NAME, limit: 30 });
	const exact = found.find((r) => r.name === HOLDER_ROLE_NAME);
	if (exact) return exact.id;
	const all = await core.roles.directory(ctx, { all: true });
	return all.find((r) => r.name === HOLDER_ROLE_NAME)?.id ?? null;
}

export interface SyncResult {
	users: number;
	grants: number;
}

/** Alle Verleihungen des Moduls aus `office_holders × office_roles` neu setzen */
export async function syncGrants(ctx: RequestContext): Promise<SyncResult> {
	const holderRole = await holderRoleId(ctx);
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT h.user_id, r.role_id FROM office_holders h
				LEFT JOIN office_roles r ON r.office_id = h.office_id`
		)
	);
	const byUser = new Map<string, Set<string>>();
	for (const r of rows) {
		const userId = String(r.user_id);
		const set = byUser.get(userId) ?? new Set<string>(holderRole ? [holderRole] : []);
		if (r.role_id !== null && r.role_id !== undefined) set.add(String(r.role_id));
		byUser.set(userId, set);
	}
	const grants = [...byUser].map(([userId, roles]) => ({ userId, roleIds: [...roles] }));
	await core.roles.replaceModuleGrants(MODULE_ID, grants);
	return { users: grants.length, grants: grants.reduce((n, g) => n + g.roleIds.length, 0) };
}

/**
 * Rollen-IDs prüfen, die an einem Amt gespeichert werden sollen: unbekannte Rollen und die
 * automatische Inhaber-Rolle → 422 (`['roleIds', i]`). `keep` = bereits gespeicherte IDs, die
 * auch dann akzeptiert werden, wenn die Rolle inzwischen gelöscht wurde.
 */
export async function validateRoleIds(
	ctx: RequestContext,
	roleIds: readonly string[],
	keep: ReadonlySet<string> = new Set()
): Promise<void> {
	if (roleIds.length === 0) return;
	const [known, holderRole] = [await rolesByIds(ctx, roleIds), await holderRoleId(ctx)];
	const issues: { path: (string | number)[]; message: string }[] = [];
	roleIds.forEach((id, i) => {
		if (holderRole && id === holderRole) {
			issues.push({
				path: ['roleIds', i],
				message: `Die Rolle „${HOLDER_ROLE_NAME}“ wird automatisch vergeben und kann nicht verknüpft werden`
			});
		} else if (!known.has(id) && !keep.has(id)) {
			issues.push({ path: ['roleIds', i], message: 'Rolle nicht gefunden' });
		}
	});
	if (issues.length) throw errors.validation(issues);
}

/**
 * Schutz vor Rechteausweitung: Wer Rollen (über ein Amt) vergibt oder entzieht, braucht alle
 * Rechte dieser Rollen selbst. Mit `includeHolderRole` zählt die automatische Inhaber-Rolle mit
 * (wenn Personen hinzukommen oder wegfallen). Wirft `forbidden`.
 */
export async function assertCanChange(
	ctx: RequestContext,
	roleIds: readonly string[],
	opts: { includeHolderRole?: boolean } = {}
): Promise<void> {
	const ids = new Set(roleIds);
	if (opts.includeHolderRole) {
		const holderRole = await holderRoleId(ctx);
		if (holderRole) ids.add(holderRole);
	}
	if (ids.size) await core.roles.assertCanGrant(ctx, [...ids]);
}
