/**
 * Datensicherung: Rauchtest Export → Upload → Analyse → Wiederherstellen/Zusammenführen (PGlite + Fake-S3).
 * Ausführliche Szenarien (anderer Schlüssel, Kontoschutz, Rollback …) liegen in `core-backup*.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { seedBackupWorld, SEED_PASSWORD, type BackupWorld } from '../../helpers/backup-seed';
import { getDb } from '$testing';
import { startBackupExport, takeBackupDownload } from '$testing';
import { listBackupScopes } from '$testing';
import {
	analyzeBackup,
	appendUpload,
	createUpload,
	executeRestore,
	waitForRestore
} from '$testing';
import { MERGE_CONFIRM_WORD, RESTORE_CONFIRM_WORD } from '$testing';
import { resetAllForTests } from '$testing';
import { isCoreError } from '$testing';
import { decryptSecret } from '$testing';
import { getAuth } from '$testing';

let world: BackupWorld;
let file: Uint8Array;

const BACKUP_PW = 'Sicherung-Passwort-2026';

async function dump(table: string): Promise<string[]> {
	const res = (await getDb().execute(
		sql.raw(`SELECT row_to_json(t)::text AS j FROM ${table} t`)
	)) as unknown as { rows: { j: string }[] };
	// Geheimnisse werden neu verschlüsselt (neue IV) → Klartext vergleichen
	const purpose = table.includes('mod_') ? `module:${table.split('"')[1]!.slice(4)}` : 'settings';
	return res.rows
		.map((r) => r.j.replace(/enc:v1:[A-Za-z0-9_.-]+/g, (v) => `ENC(${decryptSecret(v, purpose)})`))
		.sort();
}

async function upload(bytes: Uint8Array): Promise<string> {
	const { uploadId, chunkBytes } = await createUpload(world.admin, { size: bytes.length });
	for (let off = 0; off < bytes.length; off += chunkBytes) {
		const part = bytes.subarray(off, off + chunkBytes);
		const body = new Response(Buffer.from(part)).body!;
		const p = await appendUpload(world.admin, uploadId, off, body, part.length);
		expect(p.received).toBe(off + part.length);
	}
	return uploadId;
}

const TABLES = [
	'"public"."user"',
	'"public"."role"',
	'"public"."file"',
	'"mod_members"."members"',
	'"mod_treasury"."payers"',
	'"mod_files"."share_links"',
	'"mod_offices"."office_holders"',
	'"mod_galleries"."galleries"',
	'"mod_galleries"."gallery_images"'
];

beforeAll(async () => {
	world = await seedBackupWorld();
	// Titelbild setzen (Zyklus galleries.cover_image_id ↔ gallery_images.gallery_id)
	expect(world.ids.galleryImageId).toBeTruthy();
	await getDb().execute(
		sql`UPDATE "mod_galleries"."galleries" SET cover_image_id = ${world.ids.galleryImageId} WHERE id = ${world.ids.galleryId}`
	);
	const scopes = (await listBackupScopes()).map((s) => s.key);
	const res = await startBackupExport(world.admin, {
		scopes,
		includeFiles: true,
		backupPassword: BACKUP_PW,
		password: SEED_PASSWORD
	});
	const dl = await takeBackupDownload(world.admin, res.downloadId);
	file = new Uint8Array(await readFile(dl.path));
	await dl.done();
}, 120_000);

afterAll(async () => {
	await world?.close();
});

describe('Wiederherstellen (Rauchtest)', () => {
	it('Upload: falscher Offset → 409 mit Stand', async () => {
		const { uploadId } = await createUpload(world.admin, { size: 10 });
		const err = await appendUpload(world.admin, uploadId, 5, new Response('abc').body, 3).catch(
			(e: unknown) => e
		);
		expect(isCoreError(err) && err.status).toBe(409);
		expect(isCoreError(err) && err.details).toEqual({ received: 0, size: 10, complete: false });
	});

	it('falsches Sicherungs-Passwort → 422 backupPassword', async () => {
		const uploadId = await upload(file);
		const err = await analyzeBackup(world.admin, {
			uploadId,
			backupPassword: 'falsch-falsch-falsch',
			password: SEED_PASSWORD
		}).catch((e: unknown) => e);
		expect(isCoreError(err) && err.status).toBe(422);
		expect(JSON.stringify(isCoreError(err) && err.details)).toContain('backupPassword');
	});

	it('Export → Änderungen → Wiederherstellen ergibt den alten Stand', async () => {
		resetAllForTests();
		const before: Record<string, string[]> = Object.fromEntries(
			await Promise.all(TABLES.map(async (t) => [t, await dump(t)]))
		);
		const objectsBefore = new Map(world.objects);
		const cover = async () =>
			(
				(await getDb().execute(
					sql`SELECT cover_image_id FROM "mod_galleries"."galleries" WHERE id = ${world.ids.galleryId}`
				)) as unknown as { rows: { cover_image_id: string | null }[] }
			).rows[0]?.cover_image_id ?? null;
		const coverBefore = await cover();
		expect(coverBefore).toBeTruthy();

		// Änderungen nach der Sicherung
		await getDb().execute(sql.raw(`DELETE FROM "mod_members"."members"`));
		await getDb().execute(sql.raw(`DELETE FROM "mod_galleries"."gallery_images"`));
		await getDb().execute(
			sql.raw(`UPDATE "public"."user" SET name = 'Geändert' WHERE email = 'tessa@backup.test'`)
		);
		for (const k of [...world.objects.keys()]) world.objects.delete(k);

		const uploadId = await upload(file);
		const preview = await analyzeBackup(world.admin, {
			uploadId,
			backupPassword: BACKUP_PW,
			password: SEED_PASSWORD
		});
		expect(preview.secretChanged).toBe(false);
		expect(preview.account).toEqual({ case: 'same', willLogout: false, twoFactorInBackup: false });
		const blocked = preview.scopes.filter((s) => !s.available);
		expect(blocked, JSON.stringify(blocked)).toEqual([]);
		const members = preview.scopes.find((s) => s.key === 'members')!;
		expect(members.tables.find((t) => t.table === 'mod_members.members')).toMatchObject({
			backupRows: 2,
			currentRows: 0
		});

		const { runId } = await executeRestore(world.admin, {
			token: preview.token,
			mode: 'restore',
			scopes: preview.scopes.map((s) => s.key),
			takeSmtp: false,
			applyModuleState: true,
			confirmWord: RESTORE_CONFIRM_WORD
		});
		const status = await waitForRestore(runId);
		expect(status.state, status.error).toBe('done');
		expect(status.result!.loggedOut).toBe(false);
		expect(status.result!.files.uploaded).toBeGreaterThan(0);

		for (const t of TABLES) expect(await dump(t), t).toEqual(before[t]);
		expect(await cover()).toBe(coverBefore);
		// Ämter-Rollen nach dem Abgleich-Job wieder verliehen
		const grants = (await getDb().execute(
			sql`SELECT user_id FROM "public"."user_role_grant" WHERE module_id = 'offices'`
		)) as unknown as { rows: { user_id: string }[] };
		expect(grants.rows.map((r) => r.user_id)).toContain(world.userId);
		const triggered = (await getDb().execute(
			sql`SELECT count(*)::int AS n FROM "public"."audit_log" WHERE action = 'core.job.triggered' AND target = 'offices.sync-grants'`
		)) as unknown as { rows: { n: number }[] };
		expect(triggered.rows[0]!.n).toBeGreaterThan(0);
		expect(status.result!.warnings.join(' ')).not.toMatch(/Abgleich/);
		for (const [k, v] of objectsBefore) {
			if (before['"public"."file"']!.some((j) => j.includes(k))) {
				const got = world.objects.get(k);
				expect(got, k).toBeDefined();
				expect(Buffer.from(got!.body).equals(Buffer.from(v.body)), k).toBe(true);
				expect(got!.contentType).toBe(v.contentType);
			}
		}
		// API funktioniert danach weiter
		const r = await world.call('admin', 'GET', '/modules/members/members');
		expect(r.status).toBe(200);
	}, 120_000);

	it('Zusammenführen: nichts doppelt, Bestätigungswort Pflicht', async () => {
		resetAllForTests();
		const uploadId = await upload(file);
		const preview = await analyzeBackup(world.admin, {
			uploadId,
			backupPassword: BACKUP_PW,
			password: SEED_PASSWORD
		});
		const input = {
			token: preview.token,
			mode: 'merge' as const,
			scopes: ['members', 'core:users', 'galleries'],
			takeSmtp: false,
			applyModuleState: true,
			confirmWord: RESTORE_CONFIRM_WORD
		};
		const err = await executeRestore(world.admin, input).catch((e: unknown) => e);
		expect(isCoreError(err) && err.status).toBe(422);
		const before = await dump('"mod_members"."members"');
		const users = await dump('"public"."user"');
		const { runId } = await executeRestore(world.admin, {
			...input,
			confirmWord: MERGE_CONFIRM_WORD
		});
		const status = await waitForRestore(runId);
		expect(status.state, status.error).toBe('done');
		expect(status.result!.inserted).toBe(0);
		expect(await dump('"mod_members"."members"')).toEqual(before);
		expect(await dump('"public"."user"')).toEqual(users);
	}, 120_000);
	it('Kontoschutz: anderes Passwort in der Sicherung sperrt core:users', async () => {
		resetAllForTests();
		const NEW_PW = 'Neues-Passwort-2026-xyz';
		const hash = await (await getAuth().$context).password.hash(NEW_PW);
		await getDb().execute(
			sql`UPDATE "public"."account" SET password = ${hash} WHERE user_id = ${world.adminId} AND provider_id = 'credential'`
		);
		const uploadId = await upload(file);
		const preview = await analyzeBackup(world.admin, {
			uploadId,
			backupPassword: BACKUP_PW,
			password: NEW_PW
		});
		const users = preview.scopes.find((s) => s.key === 'core:users')!;
		expect(users.available).toBe(false);
		expect(users.reason).toMatch(/anderen Passwort/);
		expect(preview.scopes.find((s) => s.key === 'members')!.available).toBe(true);
		const err = await executeRestore(world.admin, {
			token: preview.token,
			mode: 'restore',
			scopes: ['core:users'],
			takeSmtp: false,
			applyModuleState: true,
			confirmWord: RESTORE_CONFIRM_WORD
		}).catch((e: unknown) => e);
		expect(isCoreError(err) && err.status).toBe(422);
	}, 120_000);
});
