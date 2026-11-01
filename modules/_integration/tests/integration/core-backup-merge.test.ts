/**
 * Datensicherung: Zusammenführen (bestehende Zeilen bleiben, fehlende kommen dazu, vorhandene Benutzer
 * bekommen keine Anmeldedaten aus der Sicherung) und Kontoschutz beim Wiederherstellen von `core:users`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
	seedBackupWorld,
	SEED_PASSWORD,
	SEED_USER_EMAIL,
	type BackupWorld
} from '../../helpers/backup-seed';
import {
	dumpTable,
	exportBackup,
	failure,
	previewBackup,
	runRestore
} from '../../helpers/backup-flow';
import { getDb, schema } from '$testing';
import { getAuth } from '$testing';
import { contextForUser } from '$testing';
import { createUser } from '$testing';
import { verifyUserPassword } from '$testing';
import { executeRestore } from '$testing';
import { RESTORE_CONFIRM_WORD } from '$testing';
import { ADMIN_ROLE_ID } from '$testing';
import { resetAllForTests } from '$testing';
import type { RequestContext } from '$lib/sdk/types';

let world: BackupWorld;
let file: Uint8Array;

const exec = (q: ReturnType<typeof sql>) => getDb().execute(q);
const ctxOf = async (id: string): Promise<RequestContext> => (await contextForUser(id))!.ctx;
const userByEmail = async (email: string) =>
	(await getDb().select().from(schema.user).where(eq(schema.user.email, email)))[0];

beforeAll(async () => {
	world = await seedBackupWorld();
	file = (await exportBackup(world.admin)).bytes;
}, 180_000);

afterAll(async () => {
	await world?.close();
});

describe('Zusammenführen', () => {
	it('bestehende Zeilen bleiben, gelöschte kommen zurück, vorhandene Benutzer ohne Anmeldedaten aus der Sicherung', async () => {
		const [keep, gone] = world.ids.memberIds as [string, string];
		const membersBackup = await dumpTable('mod_members.members');
		await exec(sql`UPDATE mod_members.members SET first_name = 'Lena-Geändert' WHERE id = ${keep}`);
		await exec(sql`DELETE FROM mod_members.members WHERE id = ${gone}`);
		const changedRow = (await dumpTable('mod_members.members')).find((r) => r.includes(keep))!;

		// Tessa neu angelegt: gleiche E-Mail, neue ID, anderes Passwort, ohne 2FA
		await exec(sql`DELETE FROM "public"."user" WHERE id = ${world.userId}`);
		const NEW_PW = 'Tessa-Neues-Passwort-2026';
		const newTessa = await createUser(world.admin, {
			name: 'Tessa Neu',
			email: SEED_USER_EMAIL,
			password: NEW_PW
		});

		const preview = await previewBackup(world.admin, file);
		expect(preview.account.case).toBe('same');
		const status = await runRestore(world.admin, preview, {
			mode: 'merge',
			scopes: ['members', 'core:users']
		});
		const r = status.result!;
		expect(r.mode).toBe('merge');
		expect(r.deleted).toBe(0);

		// members: geänderte Zeile unverändert, gelöschte wieder da
		const after = await dumpTable('mod_members.members');
		expect(after).toHaveLength(2);
		expect(after).toContain(changedRow);
		expect(after).toContain(membersBackup.find((x) => x.includes(gone))!);

		// Benutzer: Admin und alte Tessa (E-Mail vorhanden) übersprungen, keine Anmeldedaten übernommen
		expect(r.skipped['public.user']).toBe(2);
		expect(r.skipped['public.account']).toBe(2);
		expect(r.skipped['public.two_factor']).toBe(1);
		const tessa = await userByEmail(SEED_USER_EMAIL);
		expect(tessa!.id).toBe(newTessa);
		expect(tessa!.name).toBe('Tessa Neu');
		expect(tessa!.twoFactorEnabled).toBeFalsy();
		expect(
			await getDb().select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, newTessa))
		).toEqual([]);
		expect(await verifyUserPassword(newTessa, NEW_PW)).toBe(true);
		expect(await verifyUserPassword(newTessa, SEED_PASSWORD)).toBe(false);
		// Alte ID der Sicherung gibt es nicht (keine zweite Tessa)
		expect(
			await getDb().select().from(schema.user).where(eq(schema.user.id, world.userId))
		).toEqual([]);
	}, 120_000);

	it('zweites Zusammenführen ändert nichts', async () => {
		const before = await dumpTable('mod_members.members');
		const users = await dumpTable('public.user');
		const preview = await previewBackup(world.admin, file);
		const status = await runRestore(world.admin, preview, {
			mode: 'merge',
			scopes: ['members', 'core:users']
		});
		expect(status.result!.inserted).toBe(0);
		expect(await dumpTable('mod_members.members')).toEqual(before);
		expect(await dumpTable('public.user')).toEqual(users);
	}, 120_000);
});

describe('Kontoschutz', () => {
	it('Fall „same“: eigenes Konto mit gleichem Passwort in der Sicherung', async () => {
		const preview = await previewBackup(world.admin, file);
		expect(preview.account).toEqual({ case: 'same', willLogout: false, twoFactorInBackup: false });
		expect(preview.scopes.find((s) => s.key === 'core:users')!.available).toBe(true);
	}, 60_000);

	it('Fall „kept“: Konto nicht in der Sicherung bleibt erhalten und behält die Administrator-Rolle', async () => {
		const PW = 'Neuer-Admin-Passwort-2026';
		const newAdminId = await createUser(world.admin, {
			name: 'Neue Admin',
			email: 'neu-admin@backup.test',
			password: PW,
			roleIds: [ADMIN_ROLE_ID]
		});
		const newAdmin = await ctxOf(newAdminId);
		const preview = await previewBackup(newAdmin, file, { password: PW });
		expect(preview.account).toEqual({ case: 'kept', willLogout: false, twoFactorInBackup: false });
		const status = await runRestore(newAdmin, preview, { scopes: ['core:users', 'core:roles'] });
		expect(status.result!.loggedOut).toBe(false);

		expect((await userByEmail('neu-admin@backup.test'))?.id).toBe(newAdminId);
		expect(await verifyUserPassword(newAdminId, PW)).toBe(true);
		const roles = await getDb()
			.select()
			.from(schema.userRole)
			.where(
				and(eq(schema.userRole.userId, newAdminId), eq(schema.userRole.roleId, ADMIN_ROLE_ID))
			);
		expect(roles).toHaveLength(1);
		// Konten aus der Sicherung sind zurück (Tessa mit alter ID und 2FA)
		const tessa = await userByEmail(SEED_USER_EMAIL);
		expect(tessa!.id).toBe(world.userId);
		expect(tessa!.twoFactorEnabled).toBe(true);
		// Datensicherung bleibt für das neue Konto möglich
		const again = await previewBackup(await ctxOf(newAdminId), file, { password: PW });
		expect(again.account.case).toBe('kept');
	}, 120_000);

	it('Kollision: eigenes Konto mit anderem Passwort in der Sicherung → core:users gesperrt, 422', async () => {
		resetAllForTests();
		const NEW_PW = 'Admin-Anderes-Passwort-2026';
		const hash = await (await getAuth().$context).password.hash(NEW_PW);
		await exec(
			sql`UPDATE "public"."account" SET password = ${hash}
				WHERE user_id = ${world.adminId} AND provider_id = 'credential'`
		);
		const preview = await previewBackup(world.admin, file, { password: NEW_PW });
		const users = preview.scopes.find((s) => s.key === 'core:users')!;
		expect(users.available).toBe(false);
		expect(users.reason).toMatch(/anderen Passwort/);
		expect(preview.scopes.find((s) => s.key === 'members')!.available).toBe(true);
		const err = await failure(
			executeRestore(world.admin, {
				token: preview.token,
				mode: 'restore',
				scopes: ['core:users'],
				takeSmtp: false,
				applyModuleState: true,
				confirmWord: RESTORE_CONFIRM_WORD
			})
		);
		expect(err.status).toBe(422);
		expect(JSON.stringify(err.details)).toContain('scopes');
	}, 120_000);
});
