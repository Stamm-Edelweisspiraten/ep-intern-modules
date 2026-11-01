/**
 * Datensicherung – Rechte und Sicherheit: Recht `core.system.backup`, nur Sitzungen (keine API-Keys),
 * erneute Anmeldung (Passwort, TOTP), Sicherungs-Passwort, manipulierte Dateien, Bestätigungswort,
 * nur ein Wartungsvorgang gleichzeitig.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
	seedBackupWorld,
	SEED_PASSWORD,
	SEED_TOTP_SECRET,
	type BackupWorld
} from '../../helpers/backup-seed';
import {
	BACKUP_PW,
	exportBackup,
	failure,
	previewBackup,
	uploadBackup
} from '../../helpers/backup-flow';
import { getDb } from '$testing';
import { contextForUser } from '$testing';
import { startBackupExport, takeBackupDownload } from '$testing';
import { analyzeBackup, executeRestore, waitForRestore } from '$testing';
import { MERGE_CONFIRM_WORD, RESTORE_CONFIRM_WORD } from '$testing';
import { totpCode } from '$testing';
import { acquireMaintenanceLock, releaseMaintenanceLock } from '$testing';
import { resetAllForTests } from '$testing';
import type { RequestContext } from '$lib/sdk/types';

let world: BackupWorld;
let file: Uint8Array;

const ctxOf = async (id: string): Promise<RequestContext> => (await contextForUser(id))!.ctx;
const exportInput = (over: Record<string, unknown> = {}) => ({
	scopes: ['members'],
	includeFiles: false,
	backupPassword: BACKUP_PW,
	password: SEED_PASSWORD,
	...over
});
const paths = (e: { details?: unknown }) =>
	((e.details ?? []) as { path?: unknown[] }[]).map((d) => (d.path ?? []).join('.'));

beforeAll(async () => {
	world = await seedBackupWorld();
	file = (await exportBackup(world.admin, { scopes: ['members', 'events'] })).bytes;
}, 180_000);

afterAll(async () => {
	await world?.close();
});

describe('Zugriff', () => {
	it('ohne core.system.backup → 403 (Export, Upload, Analyse)', async () => {
		expect((await failure(startBackupExport(world.user, exportInput()))).status).toBe(403);
		const e2 = await failure(uploadBackup(world.user, file));
		expect(e2.status).toBe(403);
	});

	it('API-Key-Kontext → 403, auch mit allen Rechten', async () => {
		const keyCtx: RequestContext = {
			...world.admin,
			actor: { type: 'api_key', id: 'key-1', name: 'Schlüssel' }
		};
		const e = await failure(startBackupExport(keyCtx, exportInput()));
		expect(e.status).toBe(403);
		expect(e.message).toMatch(/angemeldete Benutzer/);
		expect((await failure(uploadBackup(keyCtx, file))).status).toBe(403);
	});

	it('Download nur einmal und nur für dieselbe Person', async () => {
		resetAllForTests();
		const res = await startBackupExport(world.admin, exportInput());
		// Tessa mit Backup-Recht, aber fremder Download → 404
		await getDb().execute(
			sql`INSERT INTO "public"."role_permission" (role_id, permission_key)
				VALUES (${world.ids.roleId}, 'core.system.backup') ON CONFLICT DO NOTHING`
		);
		const tessa = await ctxOf(world.userId);
		expect((await failure(takeBackupDownload(tessa, res.downloadId))).status).toBe(404);
		const dl = await takeBackupDownload(world.admin, res.downloadId);
		await dl.done();
		expect((await failure(takeBackupDownload(world.admin, res.downloadId))).status).toBe(404);
	});
});

describe('erneute Anmeldung', () => {
	it('falsches Konto-Passwort → 422 (Export und Analyse)', async () => {
		resetAllForTests();
		const e = await failure(startBackupExport(world.admin, exportInput({ password: 'falsch' })));
		expect(e.status).toBe(422);
		expect(paths(e)).toContain('password');
		const uploadId = await uploadBackup(world.admin, file);
		const e2 = await failure(
			analyzeBackup(world.admin, { uploadId, backupPassword: BACKUP_PW, password: 'falsch' })
		);
		expect(e2.status).toBe(422);
		expect(paths(e2)).toContain('password');
	});

	it('2FA: fehlender/falscher Code → 422, richtiger Code → Export', async () => {
		resetAllForTests();
		// Rolle „Leitung“ hat seit dem vorigen Test core.system.backup; Tessa hat 2FA
		const tessa = await ctxOf(world.userId);
		const missing = await failure(startBackupExport(tessa, exportInput()));
		expect(missing.status).toBe(422);
		expect(paths(missing)).toContain('totp');
		const right = totpCode(SEED_TOTP_SECRET);
		const wrong = right === '000000' ? '111111' : '000000';
		const bad = await failure(startBackupExport(tessa, exportInput({ totp: wrong })));
		expect(bad.status).toBe(422);
		expect(paths(bad)).toContain('totp');
		const ok = await startBackupExport(tessa, exportInput({ totp: right }));
		expect(ok.summary.scopes).toEqual(['members']);
		await (await takeBackupDownload(tessa, ok.downloadId)).done();
	});
});

describe('Sicherungsdatei', () => {
	it('falsches Sicherungs-Passwort → 422 backupPassword', async () => {
		resetAllForTests();
		const e = await failure(
			previewBackup(world.admin, file, { backupPassword: 'ganz-falsches-passwort' })
		);
		expect(e.status).toBe(422);
		expect(JSON.stringify(e.details)).toContain('backupPassword');
	});

	it('manipulierte Datei (ein Byte geändert / abgeschnitten) → 422', async () => {
		resetAllForTests();
		const flipped = new Uint8Array(file);
		const pos = Math.floor(flipped.length / 2);
		flipped[pos] = flipped[pos]! ^ 0xff;
		const e = await failure(previewBackup(world.admin, flipped));
		expect(e.status).toBe(422);
		const cut = file.subarray(0, file.length - 100);
		expect((await failure(previewBackup(world.admin, cut))).status).toBe(422);
		const garbage = new TextEncoder().encode('kein backup '.repeat(20));
		expect((await failure(previewBackup(world.admin, garbage))).status).toBe(422);
	});

	it('falsches Bestätigungswort → 422; Bereich nicht in der Sicherung → 422', async () => {
		resetAllForTests();
		const preview = await previewBackup(world.admin, file);
		const base = {
			token: preview.token,
			takeSmtp: false,
			applyModuleState: true
		};
		const e1 = await failure(
			executeRestore(world.admin, {
				...base,
				mode: 'restore',
				scopes: ['members'],
				confirmWord: MERGE_CONFIRM_WORD
			})
		);
		expect(e1.status).toBe(422);
		expect(paths(e1)).toContain('confirmWord');
		const e2 = await failure(
			executeRestore(world.admin, {
				...base,
				mode: 'restore',
				scopes: ['files'],
				confirmWord: RESTORE_CONFIRM_WORD
			})
		);
		expect(e2.status).toBe(422);
		expect(paths(e2)).toContain('scopes');
		// fremde Vorschau → 409 (nicht gefunden)
		const tessa = await ctxOf(world.userId);
		const e3 = await failure(
			executeRestore(tessa, {
				...base,
				mode: 'restore',
				scopes: ['members'],
				confirmWord: RESTORE_CONFIRM_WORD
			})
		);
		expect(e3.status).toBe(409);
	});
});

describe('nur ein Vorgang gleichzeitig', () => {
	it('zweiter paralleler Lauf → 409', async () => {
		resetAllForTests();
		const p1 = await previewBackup(world.admin, file);
		const p2 = await previewBackup(world.admin, file);
		const input = (token: string) => ({
			token,
			mode: 'restore' as const,
			scopes: ['members', 'events'],
			takeSmtp: false,
			applyModuleState: true,
			confirmWord: RESTORE_CONFIRM_WORD
		});
		const { runId } = await executeRestore(world.admin, input(p1.token));
		const second = await failure(executeRestore(world.admin, input(p2.token)));
		expect(second.status).toBe(409);
		expect(second.message).toMatch(/Wartungsvorgang/);
		const done = await waitForRestore(runId);
		expect(done.state, done.error).toBe('done');
		// danach wieder möglich (Vorschau p2 ist noch gültig)
		const { runId: r2 } = await executeRestore(world.admin, input(p2.token));
		expect((await waitForRestore(r2)).state).toBe('done');
	}, 120_000);

	it('Export während eines anderen Wartungsvorgangs (z. B. Zurücksetzen) → 409', async () => {
		resetAllForTests();
		acquireMaintenanceLock('Zurücksetzen');
		try {
			const e = await failure(startBackupExport(world.admin, exportInput()));
			expect(e.status).toBe(409);
			expect(e.message).toMatch(/Zurücksetzen/);
		} finally {
			releaseMaintenanceLock();
		}
		const ok = await startBackupExport(world.admin, exportInput());
		await (await takeBackupDownload(world.admin, ok.downloadId)).done();
	});
});
