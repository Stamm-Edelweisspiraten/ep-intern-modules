/**
 * Datensicherung – vollständiger Ablauf mit allen Modulen (inkl. galleries) gegen PGlite + Fake-S3:
 * Vollsicherung → Änderungen → Wiederherstellen aller Bereiche → tabellenweise Gleichheit + Dateibytes;
 * Teil-Wiederherstellung eines Moduls; Audit; Sicherung ohne Dateien; Wiederherstellen ohne S3.
 * Weitere Szenarien: `core-backup-secret`, `core-backup-merge`, `core-backup-security`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateStorageConfigCache } from '$testing';
import { sql } from 'drizzle-orm';
import { seedBackupWorld, type BackupWorld } from '../../helpers/backup-seed';
import {
	allScopeKeys,
	dumpAll,
	dumpTable,
	exportBackup,
	previewBackup,
	runRestore
} from '../../helpers/backup-flow';
import { getDb } from '$testing';
import { executeReset, exportResetData, previewReset, RESET_CONFIRM_WORD } from '$testing';
import { SEED_PASSWORD } from '../../helpers/backup-seed';

let world: BackupWorld;
let full: Uint8Array;
let before: Record<string, string[]>;
let objectsBefore: Map<string, { body: Uint8Array; contentType?: string }>;
let exportAudit: string[] = [];

const exec = (q: ReturnType<typeof sql>) => getDb().execute(q);
const auditMeta = async (action: string) =>
	(
		(await exec(
			sql`SELECT metadata::text AS m FROM "public"."audit_log" WHERE action = ${action}`
		)) as unknown as { rows: { m: string }[] }
	).rows.map((r) => r.m);

beforeAll(async () => {
	world = await seedBackupWorld();
	before = await dumpAll();
	objectsBefore = new Map(world.objects);
	full = (await exportBackup(world.admin)).bytes;
	// Die Vollsicherung enthält `core:audit` – der Export-Eintrag entsteht danach und fällt beim
	// Wiederherstellen weg, daher hier festhalten
	exportAudit = await auditMeta('core.system.backup_exported');
}, 180_000);

afterAll(async () => {
	await world?.close();
});

describe('Vollsicherung und Wiederherstellen', () => {
	it('alle Bereiche (inkl. galleries) sind in der Sicherung', async () => {
		const scopes = await allScopeKeys();
		expect(scopes).toEqual(
			expect.arrayContaining([
				'core:users',
				'members',
				'actions',
				'treasury',
				'orders',
				'offices',
				'events',
				'galleries',
				'files'
			])
		);
	});

	it('Reset + Änderungen → Wiederherstellen ergibt tabellenweise den alten Stand', async () => {
		// Änderungen: Modul-Reset (members/treasury), Löschen/Ändern per SQL, Dateien weg
		const p = await previewReset(world.admin, ['treasury:all', 'members:all']);
		await exportResetData(world.admin, {
			token: p.token,
			password: SEED_PASSWORD,
			backupPassword: 'Reset-Sicherung-2026'
		});
		await executeReset(world.admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD });
		expect(await dumpTable('mod_members.members')).toEqual([]);
		await exec(sql`DELETE FROM mod_files.share_links`);
		await exec(sql`DELETE FROM mod_galleries.galleries`);
		await exec(sql`UPDATE mod_events.events SET title = 'Geändert'`);
		await exec(sql`UPDATE "public"."user" SET name = 'Geändert' WHERE id = ${world.userId}`);
		await exec(sql`INSERT INTO "public"."role" (id, name) VALUES ('neu-nach-sicherung', 'Neu')`);
		for (const k of [...world.objects.keys()]) world.objects.delete(k);
		expect(await dumpAll()).not.toEqual(before);

		const preview = await previewBackup(world.admin, full);
		expect(preview.scopes.filter((s) => !s.available)).toEqual([]);
		expect(preview.secretChanged).toBe(false);
		expect(preview.account.case).toBe('same');
		const status = await runRestore(world.admin, preview);
		const r = status.result!;
		expect(r.loggedOut).toBe(false);
		expect(r.files.failed).toBe(0);
		expect(r.files.uploaded).toBe(objectsBefore.size);
		expect(r.rehash).toEqual({ updated: 0, unrecoverable: 0 });

		const after = await dumpAll();
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		for (const t of Object.keys(before)) expect(after[t], t).toEqual(before[t]);

		expect(world.objects.size).toBe(objectsBefore.size);
		for (const [k, v] of objectsBefore) {
			const got = world.objects.get(k);
			expect(got, k).toBeDefined();
			expect(Buffer.from(got!.body).equals(Buffer.from(v.body)), k).toBe(true);
		}

		// Anwendung funktioniert: Datei-Link, Kasse, Galerie
		expect(
			(await world.call(null, 'GET', `/modules/files/public/links/${world.ids.linkToken}`)).status
		).toBe(200);
		expect((await world.call('admin', 'GET', '/modules/treasury/payers')).status).toBe(200);
		expect(
			(await world.call('admin', 'GET', `/modules/galleries/galleries/${world.ids.galleryId}`))
				.status
		).toBe(200);
	}, 180_000);

	it('Teil-Wiederherstellung nur members lässt andere Module unberührt', async () => {
		const membersBefore = await dumpTable('mod_members.members');
		await exec(sql`DELETE FROM mod_members.members WHERE id = ${world.ids.memberIds[1]!}`);
		await exec(sql`UPDATE mod_events.events SET title = 'Nach der Sicherung'`);
		await exec(sql`UPDATE mod_offices.offices SET name = 'Nach der Sicherung'`);
		const eventsNow = await dumpTable('mod_events.events');
		const officesNow = await dumpTable('mod_offices.offices');
		const usersNow = await dumpTable('public.user');

		const preview = await previewBackup(world.admin, full);
		const status = await runRestore(world.admin, preview, { scopes: ['members'] });
		expect(status.result!.scopes).toEqual(['members']);

		expect(await dumpTable('mod_members.members')).toEqual(membersBefore);
		expect(await dumpTable('mod_events.events')).toEqual(eventsNow);
		expect(await dumpTable('mod_offices.offices')).toEqual(officesNow);
		expect(await dumpTable('public.user')).toEqual(usersNow);
	}, 180_000);

	it('Audit: backup_exported / backup_restored ohne E-Mail oder IBAN', async () => {
		expect(exportAudit).toHaveLength(1);
		expect(JSON.parse(exportAudit[0]!)).toMatchObject({ includesFiles: true });
		const restored = await auditMeta('core.system.backup_restored');
		expect(restored.length).toBeGreaterThanOrEqual(2);
		expect(JSON.parse(restored.at(-1)!)).toMatchObject({ mode: 'restore', scopes: ['members'] });
		for (const m of [...exportAudit, ...restored]) {
			expect(m).not.toContain('@');
			expect(m).not.toMatch(/DE\d{20}/);
		}
	});
});

describe('ohne Dateien / ohne S3', () => {
	it('includeFiles=false: keine Dateien in der Sicherung, Wiederherstellen ohne Dateischritt', async () => {
		const { bytes, summary } = await exportBackup(world.admin, {
			scopes: ['files'],
			includeFiles: false
		});
		expect(summary.files).toBe(0);
		const preview = await previewBackup(world.admin, bytes);
		expect(preview.backup.includesFiles).toBe(false);
		expect(preview.scopes.find((s) => s.key === 'files')!.files.count).toBe(0);
		const status = await runRestore(world.admin, preview, { scopes: ['files'] });
		expect(status.result!.files).toEqual({ uploaded: 0, skipped: 0, failed: 0 });
	}, 120_000);

	it('Sicherung mit Dateien auf Server ohne S3 → Warnung, Datensätze trotzdem zurück', async () => {
		await exec(sql`DELETE FROM "public"."setting" WHERE key LIKE 'core.storage.%'`);
		invalidateStorageConfigCache(); // Einstellungen am Dienst vorbei per SQL gelöscht
		const preview = await previewBackup(world.admin, full);
		expect(preview.warnings.join(' ')).toMatch(/Kein Dateispeicher/);
		await exec(sql`DELETE FROM mod_offices.office_holders`);
		const status = await runRestore(world.admin, preview, { scopes: ['offices', 'files'] });
		expect(status.result!.warnings.join(' ')).toMatch(/Kein Dateispeicher/);
		expect(status.result!.files.uploaded).toBe(0);
		expect(status.result!.files.skipped).toBeGreaterThan(0);
		expect(await dumpTable('mod_offices.office_holders')).toEqual(
			before['mod_offices.office_holders']
		);
	}, 120_000);
});
