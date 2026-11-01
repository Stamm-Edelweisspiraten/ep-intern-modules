/**
 * Admin-gleiche Rechte (#16) und verschlüsselter Pflicht-Export vor dem Zurücksetzen (#29):
 * - `core.system.backup|reset` vergeben nur Administrator*innen (Rolle anlegen/bearbeiten, Rolle zuweisen, API-Key-Scope)
 * - Nicht-Admins mit Sicherungsrecht dürfen Konten/Rollen/API-Keys/Ämter weder wiederherstellen noch zusammenführen
 * - Fall `kept` (Admin): keine zusätzlichen Rollen, nur die bisherigen
 * - Reset-Export ist eine `.atriumbackup`-Datei ohne Klartext, wiederherstellbar über den Backup-Import
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import { seedBackupWorld, SEED_PASSWORD, type BackupWorld } from '../../helpers/backup-seed';
import { BACKUP_PW, exportBackup, failure, previewBackup } from '../../helpers/backup-flow';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { createUser, setUserRoles } from '$testing';
import { createApiKey } from '$testing';
import { createRole, updateRole } from '$testing';
import { ADMIN_ROLE_ID, PRIVILEGED_PERMISSIONS } from '$testing';
import { canGrantPermission, isAdministrator } from '$testing';
import { executeRestore } from '$testing';
import { MERGE_CONFIRM_WORD, RESTORE_CONFIRM_WORD } from '$testing';
import { backupScopesForResetAreas, exportResetData, previewReset } from '$testing';
import { resetAllForTests } from '$testing';
import type { RequestContext } from '$lib/sdk/types';

let world: BackupWorld;
let helperId: string;
let helperRoleId: string;
const HELPER_PW = 'Technik-Hilfe-Passwort-2026';

const ctxOf = async (id: string): Promise<RequestContext> => (await contextForUser(id))!.ctx;

beforeAll(async () => {
	world = await seedBackupWorld();
	// „Technische Hilfe“: Rollen- und API-Key-Verwaltung + Datensicherung, aber kein Admin
	helperRoleId = await createRole(world.admin, {
		name: 'Technik',
		permissions: [
			'core.roles.view',
			'core.roles.create',
			'core.roles.edit',
			'core.roles.assign',
			'core.users.view',
			'core.api.manage',
			'core.system.backup',
			'members.member.view'
		]
	});
	helperId = await createUser(world.admin, {
		name: 'Technik Hilfe',
		email: 'technik@backup.test',
		password: HELPER_PW,
		roleIds: [helperRoleId]
	});
}, 180_000);

afterAll(async () => {
	await world?.close();
});

describe('Klassifizierung', () => {
	it('backup und reset sind admin-gleich; Admin erkannt, Hilfe nicht', async () => {
		expect(PRIVILEGED_PERMISSIONS.has('core.system.backup')).toBe(true);
		expect(PRIVILEGED_PERMISSIONS.has('core.system.reset')).toBe(true);
		const helper = await ctxOf(helperId);
		expect(isAdministrator(world.admin)).toBe(true);
		expect(isAdministrator(helper)).toBe(false);
		expect(canGrantPermission(helper, 'core.system.backup')).toBe(false);
		expect(canGrantPermission(helper, 'core.roles.view')).toBe(true);
		expect(canGrantPermission(world.admin, 'core.system.reset')).toBe(true);
	});
});

describe('Vergabe nur durch Administrator*innen', () => {
	it('Rolle anlegen mit core.system.backup → 403, ohne → erlaubt; Admin darf', async () => {
		const helper = await ctxOf(helperId);
		const e = await failure(
			createRole(helper, { name: 'Sicherung', permissions: ['core.system.backup'] })
		);
		expect(e.status).toBe(403);
		expect(e.code).toBe('forbidden');
		await createRole(helper, { name: 'Nur Ansicht', permissions: ['core.roles.view'] });
		await createRole(world.admin, {
			name: 'Sicherung (Admin)',
			permissions: ['core.system.backup']
		});
	});

	it('Rolle bearbeiten: privilegiertes Recht hinzufügen → 403; Rolle mit privilegiertem Recht → 403', async () => {
		const helper = await ctxOf(helperId);
		const plain = await createRole(helper, { name: 'Ohne', permissions: ['core.users.view'] });
		expect(
			(
				await failure(
					updateRole(helper, plain, { permissions: ['core.users.view', 'core.system.backup'] })
				)
			).status
		).toBe(403);
		expect(
			(await failure(updateRole(helper, helperRoleId, { description: 'geändert' }))).status
		).toBe(403);
	});

	it('Rolle mit privilegiertem Recht zuweisen → 403', async () => {
		const helper = await ctxOf(helperId);
		const target = await createUser(world.admin, {
			name: 'Ohne Rolle',
			email: 'ohne-rolle@backup.test',
			password: 'Ohne-Rolle-Passwort-2026'
		});
		const viewOnly = await createRole(helper, {
			name: 'Ansicht',
			permissions: ['core.users.view']
		});
		await setUserRoles(helper, target, [viewOnly]);
		const e = await failure(setUserRoles(helper, target, [viewOnly, helperRoleId]));
		expect(e.status).toBe(403);
		expect(e.message).toContain('Admin-gleiche');
	});

	it('API-Key-Scope core.system.backup → 403, unkritischer Scope erlaubt', async () => {
		const helper = await ctxOf(helperId);
		expect(
			(await failure(createApiKey(helper, { name: 'k', scopes: ['core.system.backup'] }))).status
		).toBe(403);
		await createApiKey(helper, { name: 'ok', scopes: ['core.roles.view'] });
		await createApiKey(world.admin, { name: 'admin', scopes: ['core.system.backup'] });
	});
});

describe('Wiederherstellen durch Nicht-Admins', () => {
	it('Konten, Rollen, API-Keys und Ämter sind gesperrt (Wiederherstellen und Zusammenführen)', async () => {
		resetAllForTests();
		const helper = await ctxOf(helperId);
		const { bytes } = await exportBackup(world.admin);
		const preview = await previewBackup(helper, bytes, { password: HELPER_PW });
		for (const key of ['core:users', 'core:roles', 'core:api-keys', 'offices']) {
			const s = preview.scopes.find((x) => x.key === key)!;
			expect(s.available, key).toBe(false);
			expect(s.reason).toContain('Administrator*innen');
		}
		expect(preview.scopes.find((x) => x.key === 'members')!.available).toBe(true);
		for (const mode of ['restore', 'merge'] as const) {
			const e = await failure(
				executeRestore(helper, {
					token: preview.token,
					mode,
					scopes: ['core:roles'],
					takeSmtp: false,
					applyModuleState: false,
					confirmWord: mode === 'restore' ? RESTORE_CONFIRM_WORD : MERGE_CONFIRM_WORD
				})
			);
			expect(e.status).toBe(422);
		}
		// Rechte der Hilfe unverändert
		const after = await ctxOf(helperId);
		expect(isAdministrator(after)).toBe(false);
		const adminRole = await getDb()
			.select()
			.from(schema.userRole)
			.where(and(eq(schema.userRole.userId, helperId), eq(schema.userRole.roleId, ADMIN_ROLE_ID)));
		expect(adminRole).toEqual([]);
	}, 120_000);
});

describe('Pflicht-Export vor dem Zurücksetzen (#29)', () => {
	it('Bereichs-Abbildung: Core-Bereiche gleich, Modul-Teilbereiche → ganzes Modul', () => {
		expect(
			backupScopesForResetAreas([
				'core:audit',
				'members:all',
				'treasury:transactions',
				'treasury:all'
			])
		).toEqual(['core:audit', 'members', 'treasury']);
	});

	it('zu kurzes Sicherungs-Passwort → 422', async () => {
		const p = await previewReset(world.admin, ['members:all']);
		const e = await failure(
			exportResetData(world.admin, {
				token: p.token,
				password: SEED_PASSWORD,
				backupPassword: 'kurz'
			})
		);
		expect(e.status).toBe(422);
		expect(JSON.stringify(e.details)).toContain('backupPassword');
	});

	it('verschlüsselt, ohne Klartext aus members.custom, über den Backup-Import lesbar', async () => {
		const SECRET_HEALTH = 'Erdnussallergie-Klartext-Probe';
		await getDb().execute(
			sql`UPDATE mod_members.members SET custom = ${JSON.stringify({ allergies: SECRET_HEALTH })}::jsonb`
		);
		const p = await previewReset(world.admin, ['members:all']);
		const exp = await exportResetData(world.admin, {
			token: p.token,
			password: SEED_PASSWORD,
			backupPassword: BACKUP_PW
		});
		const bytes = await readFile(exp.path);
		await exp.done();
		expect(exp.fileName).toMatch(/^atrium-reset-.*\.atriumbackup$/);
		expect(bytes.subarray(0, 4).toString('latin1')).toBe('EPBK');
		expect(bytes.toString('latin1')).not.toContain(SECRET_HEALTH);
		expect(bytes.toString('latin1')).not.toContain('Lindenweg');
		expect(() => JSON.parse(bytes.toString('utf8'))).toThrow();

		// Wiederherstellbar: der Import erkennt die Sicherung mit dem Sicherungs-Passwort
		const preview = await previewBackup(world.admin, new Uint8Array(bytes));
		const members = preview.scopes.find((s) => s.key === 'members')!;
		expect(members.available).toBe(true);
		expect(members.tables.find((t) => t.table === 'mod_members.members')!.backupRows).toBe(2);
		const audit = (await getDb().execute(
			sql`SELECT metadata::text AS m FROM audit_log WHERE action = 'core.system.reset_exported'`
		)) as unknown as { rows: { m: string }[] };
		expect(audit.rows.at(-1)!.m).toMatch(/"encrypted": ?true/);
		expect(audit.rows.at(-1)!.m).not.toContain(SECRET_HEALTH);
	}, 120_000);
});
