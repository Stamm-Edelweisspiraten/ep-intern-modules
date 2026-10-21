/**
 * Ämter: Liste, Detail, Anlegen, Ändern, Löschen, Reihenfolge sowie Auswahl-Hilfen (Benutzer, Rollen).
 * Ablauf je Mutation: Daten lesen → Rechteausweitung prüfen → schreiben → Rechte abgleichen →
 * Namen auflösen → Audit (Core-Aufrufe immer außerhalb der Modul-Transaktion).
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint, type Tx } from '$lib/sdk/server';
import { assertCanChange, holderRoleId, syncGrants, validateRoleIds } from './grants.service';
import { applyTemplatesCached } from './templates.service';
import { buildOffice, buildOffices, loadOfficeOr404, loadOffices, mdb, rowsOf } from './load';
import {
	HOLDER_ROLE_NAME,
	MAX_OFFICES,
	idParams,
	officeCreateInput,
	officeOrderInput,
	officeUpdateInput,
	userSearchQuery,
	type Office,
	type RoleRef,
	type UserRef
} from './schemas';

const tags = ['Modul: offices'];

type EmailList = { label: string | null; email: string }[];

async function replaceEmails(tx: Tx, officeId: string, emails: EmailList): Promise<void> {
	await tx.execute(sql`DELETE FROM office_emails WHERE office_id = ${officeId}`);
	for (const [i, e] of emails.entries()) {
		await tx.execute(
			sql`INSERT INTO office_emails (id, office_id, email, label, position)
				VALUES (${crypto.randomUUID()}, ${officeId}, ${e.email}, ${e.label}, ${i})`
		);
	}
}

async function replaceRoles(tx: Tx, officeId: string, roleIds: readonly string[]): Promise<void> {
	await tx.execute(sql`DELETE FROM office_roles WHERE office_id = ${officeId}`);
	for (const roleId of roleIds) {
		await tx.execute(
			sql`INSERT INTO office_roles (office_id, role_id) VALUES (${officeId}, ${roleId})`
		);
	}
}

export const officeEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/offices',
		summary: 'Alle Ämter (sortiert nach Reihenfolge, dann Name)',
		tags,
		permission: 'offices.office.view',
		handler: async ({ ctx }): Promise<Office[]> => {
			await applyTemplatesCached(ctx);
			const data = await mdb().transaction((tx) => loadOffices(tx));
			return buildOffices(ctx, data);
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/offices/:id',
		summary: 'Ein Amt mit E-Mail-Adressen, Rollen und Inhaber*innen',
		tags,
		permission: 'offices.office.view',
		params: idParams,
		handler: async ({ ctx, params }): Promise<Office> => {
			const data = await mdb().transaction((tx) => loadOfficeOr404(tx, params.id));
			return buildOffice(ctx, data);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/offices',
		summary: 'Amt anlegen (landet am Ende der Reihenfolge)',
		tags,
		permission: 'offices.office.manage',
		body: officeCreateInput,
		handler: async ({ ctx, body }): Promise<Office> => {
			await validateRoleIds(ctx, body.roleIds);
			// Rollen nur verknüpfen, deren Rechte man selbst hat – auch bei noch unbesetztem Amt
			await assertCanChange(ctx, body.roleIds);
			const id = crypto.randomUUID();
			const data = await mdb().transaction(async (tx) => {
				// Anzahl/Position nur unter Sperre lesen (parallele Neuanlagen, #73)
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('offices:list'))`);
				const [stats] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n, COALESCE(MAX(position), -1)::int AS max FROM offices`
				);
				if (Number(stats?.n ?? 0) >= MAX_OFFICES) {
					throw errors.conflict(`Höchstens ${MAX_OFFICES} Ämter möglich`);
				}
				await tx.execute(
					sql`INSERT INTO offices (id, name, description, position, created_by)
						VALUES (${id}, ${body.name}, ${body.description}, ${Number(stats?.max ?? -1) + 1},
							${ctx.userId ?? null})`
				);
				await replaceEmails(tx, id, body.emails);
				await replaceRoles(tx, id, body.roleIds);
				return loadOfficeOr404(tx, id);
			});
			// Neues Amt hat noch keine Inhaber*innen – Abgleich der Vollständigkeit halber
			if (body.roleIds.length) await syncGrants(ctx);
			const office = await buildOffice(ctx, data);
			await core.audit.logFromContext(ctx, 'offices.office.created', {
				target: id,
				metadata: { name: body.name, emails: body.emails.length, roleIds: body.roleIds }
			});
			return office;
		}
	}),

	defineEndpoint({
		method: 'PATCH',
		path: '/offices/:id',
		summary: 'Amt ändern (übergebene Felder; `emails`/`roleIds` ersetzen die Liste)',
		tags,
		permission: 'offices.office.manage',
		params: idParams,
		body: officeUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Office> => {
			const before = await mdb().transaction((tx) => loadOfficeOr404(tx, params.id));
			const current = before.offices[0]!;
			let rolesChanged = false;
			if (body.roleIds) {
				const old = new Set(current.roleIds);
				const next = new Set(body.roleIds);
				await validateRoleIds(ctx, body.roleIds, old);
				const changed = [
					...body.roleIds.filter((r) => !old.has(r)),
					...current.roleIds.filter((r) => !next.has(r))
				];
				rolesChanged = changed.length > 0;
				if (rolesChanged) await assertCanChange(ctx, changed);
			}

			const data = await mdb().transaction(async (tx) => {
				const sets = [sql`updated_at = now()`];
				if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
				if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
				const updated = await rowsOf(
					tx,
					sql`UPDATE offices SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id} RETURNING id`
				);
				if (updated.length === 0) throw errors.notFound('Amt nicht gefunden');
				if (body.emails) await replaceEmails(tx, params.id, body.emails);
				if (body.roleIds && rolesChanged) await replaceRoles(tx, params.id, body.roleIds);
				return loadOfficeOr404(tx, params.id);
			});
			if (rolesChanged) await syncGrants(ctx);
			const office = await buildOffice(ctx, data);
			await core.audit.logFromContext(ctx, 'offices.office.updated', {
				target: params.id,
				metadata: {
					name: office.name,
					fields: Object.keys(body),
					...(rolesChanged ? { roleIds: body.roleIds } : {})
				}
			});
			return office;
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/offices/:id',
		summary: 'Amt löschen (Inhaber*innen verlieren die Rollen des Amts)',
		tags,
		permission: 'offices.office.manage',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const before = await mdb().transaction((tx) => loadOfficeOr404(tx, params.id));
			const current = before.offices[0]!;
			const hasHolders = current.holders.length > 0;
			if (hasHolders) await assertCanChange(ctx, current.roleIds, { includeHolderRole: true });
			await mdb().transaction(async (tx) => {
				const deleted = await rowsOf(
					tx,
					sql`DELETE FROM offices WHERE id = ${params.id} RETURNING id`
				);
				if (deleted.length === 0) throw errors.notFound('Amt nicht gefunden');
			});
			if (hasHolders) await syncGrants(ctx);
			await core.audit.logFromContext(ctx, 'offices.office.deleted', {
				target: params.id,
				metadata: {
					name: current.name,
					holders: current.holders.length,
					roleIds: current.roleIds
				}
			});
			return { deleted: true as const };
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/offices/order',
		summary: 'Reihenfolge der Ämter setzen (alle Amt-IDs genau einmal)',
		tags,
		permission: 'offices.office.manage',
		body: officeOrderInput,
		handler: async ({ ctx, body }): Promise<Office[]> => {
			const data = await mdb().transaction(async (tx) => {
				const rows = await rowsOf(tx, sql`SELECT id FROM offices`);
				const existing = new Set(rows.map((r) => String(r.id)));
				if (existing.size !== body.ids.length || body.ids.some((id) => !existing.has(id))) {
					throw errors.validation([
						{ path: ['ids'], message: 'Die Liste muss alle Ämter genau einmal enthalten' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE offices SET position = ${i} WHERE id = ${id}`);
				}
				return loadOffices(tx);
			});
			const offices = await buildOffices(ctx, data);
			await core.audit.logFromContext(ctx, 'offices.office.reordered', {
				metadata: { count: body.ids.length, ids: body.ids }
			});
			return offices;
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/users',
		summary: 'Aktive Benutzer*innen suchen (für die Zuordnung von Inhaber*innen, ab 2 Zeichen)',
		description:
			'E-Mail-Adressen nur mit `core.users.view` (sonst leer) – die Zuordnung braucht nur Name und Bild.',
		tags,
		permission: 'offices.office.manage',
		rateLimit: { limit: 60, windowSec: 60 },
		query: userSearchQuery,
		handler: async ({ ctx, query }): Promise<UserRef[]> => {
			if (query.search.length < 2) return [];
			const users = await core.users.directory(ctx, { search: query.search, limit: 30 });
			return users.map((u) => ({ id: u.id, name: u.name, email: u.email }));
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/roles',
		summary: `Alle Rollen zum Verknüpfen (ohne die automatische Rolle „${HOLDER_ROLE_NAME}“)`,
		tags,
		permission: 'offices.office.manage',
		handler: async ({ ctx }): Promise<RoleRef[]> => {
			const [roles, holderRole] = [
				await core.roles.directory(ctx, { all: true }),
				await holderRoleId(ctx)
			];
			return roles.filter((r) => r.id !== holderRole).map((r) => ({ id: r.id, name: r.name }));
		}
	})
];
