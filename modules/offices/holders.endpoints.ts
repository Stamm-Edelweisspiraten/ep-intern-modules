/**
 * Inhaber*innen eines Amts komplett ersetzen. Kommen Personen hinzu oder fallen weg, ändern sich
 * deren Rollen: Der Handelnde braucht dann alle Rechte der Amt-Rollen und der automatischen
 * Inhaber-Rolle (Schutz vor Rechteausweitung).
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type AnyApiEndpoint } from '$lib/sdk/server';
import { assertCanChange, syncGrants } from './grants.service';
import { buildOffice, loadOfficeOr404, mdb, usersByIds } from './load';
import { holdersInput, idParams, type Office } from './schemas';

const tags = ['Modul: offices'];

export const holderEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'PUT',
		path: '/offices/:id/holders',
		summary: 'Inhaber*innen eines Amts ersetzen (Reihenfolge der Liste = Anzeige)',
		tags,
		permission: 'offices.office.manage',
		params: idParams,
		body: holdersInput,
		handler: async ({ ctx, params, body }): Promise<Office> => {
			const before = await mdb().transaction((tx) => loadOfficeOr404(tx, params.id));
			const current = before.offices[0]!;

			// Neu hinzukommende Personen müssen aktiv sein; bisherige (inzwischen deaktivierte) dürfen
			// bleiben, damit Umsortieren oder „seit“ ändern nicht blockiert
			const active = await usersByIds(
				ctx,
				body.holders.map((h) => h.userId)
			);
			const existing = new Set(current.holders.map((h) => h.userId));
			const issues: { path: (string | number)[]; message: string }[] = [];
			body.holders.forEach((h, i) => {
				if (!active.has(h.userId) && !existing.has(h.userId)) {
					issues.push({
						path: ['holders', i, 'userId'],
						message: 'Benutzer*in nicht gefunden oder deaktiviert'
					});
				}
			});
			if (issues.length) throw errors.validation(issues);

			const oldIds = new Set(current.holders.map((h) => h.userId));
			const newIds = new Set(body.holders.map((h) => h.userId));
			const added = [...newIds].filter((id) => !oldIds.has(id));
			const removed = [...oldIds].filter((id) => !newIds.has(id));
			const peopleChanged = added.length > 0 || removed.length > 0;
			if (peopleChanged) {
				await assertCanChange(ctx, current.roleIds, { includeHolderRole: true });
			}

			const data = await mdb().transaction(async (tx) => {
				const found = await tx.execute(
					sql`UPDATE offices SET updated_at = now() WHERE id = ${params.id} RETURNING id`
				);
				if ((found as unknown as { rows: unknown[] }).rows.length === 0) {
					throw errors.notFound('Amt nicht gefunden');
				}
				await tx.execute(sql`DELETE FROM office_holders WHERE office_id = ${params.id}`);
				for (const [i, h] of body.holders.entries()) {
					await tx.execute(
						sql`INSERT INTO office_holders (office_id, user_id, since, position)
							VALUES (${params.id}, ${h.userId}, ${h.since}::date, ${i})`
					);
				}
				return loadOfficeOr404(tx, params.id);
			});
			if (peopleChanged) await syncGrants(ctx);
			const office = await buildOffice(ctx, data);
			await core.audit.logFromContext(ctx, 'offices.office.holders-changed', {
				target: params.id,
				metadata: { name: office.name, count: body.holders.length, added, removed }
			});
			return office;
		}
	})
];
