/**
 * Eigene Ämter und persönliche Beschreibung (eine je Person, gilt für alle ihre Ämter).
 * Nur wer mindestens ein Amt hat, darf eine Beschreibung speichern.
 */
import { sql } from 'drizzle-orm';
import { core, defineEndpoint, errors, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { mdb, rowsOf, textOrNull } from './load';
import { bioInput, type MyOffices } from './schemas';

const tags = ['Modul: offices'];

async function loadMine(tx: Tx, userId: string): Promise<MyOffices> {
	const offices = await rowsOf(
		tx,
		sql`SELECT o.id, o.name FROM office_holders h JOIN offices o ON o.id = h.office_id
			WHERE h.user_id = ${userId} ORDER BY o.position, o.name, o.id`
	);
	const [profile] = await rowsOf(
		tx,
		sql`SELECT bio FROM holder_profiles WHERE user_id = ${userId}`
	);
	return {
		offices: offices.map((r) => ({ id: String(r.id), name: String(r.name) })),
		bio: textOrNull(profile?.bio),
		canEditBio: offices.length > 0
	};
}

function requireUserId(userId: string | null | undefined): string {
	if (!userId) throw errors.forbidden('Nur für angemeldete Benutzer*innen');
	return userId;
}

export const profileEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/me',
		summary: 'Eigene Ämter und persönliche Beschreibung',
		tags,
		permission: 'offices.office.view',
		handler: async ({ ctx }): Promise<MyOffices> => {
			const userId = requireUserId(ctx.userId);
			return mdb().transaction((tx) => loadMine(tx, userId));
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/me/bio',
		summary: 'Persönliche Beschreibung speichern (nur mit mindestens einem Amt)',
		tags,
		permission: 'offices.office.view',
		body: bioInput,
		handler: async ({ ctx, body }): Promise<MyOffices> => {
			const userId = requireUserId(ctx.userId);
			const mine = await mdb().transaction(async (tx) => {
				const [holder] = await rowsOf(
					tx,
					sql`SELECT 1 AS ok FROM office_holders WHERE user_id = ${userId} LIMIT 1`
				);
				if (!holder) {
					throw errors.forbidden('Eine Beschreibung können nur Amtsinhaber*innen speichern');
				}
				await tx.execute(
					sql`INSERT INTO holder_profiles (user_id, bio, updated_at)
						VALUES (${userId}, ${body.bio}, now())
						ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, updated_at = now()`
				);
				return loadMine(tx, userId);
			});
			await core.audit.logFromContext(ctx, 'offices.profile.updated', {
				target: userId,
				metadata: { hasBio: body.bio !== null }
			});
			return mine;
		}
	})
] as unknown as ApiEndpoint[];
