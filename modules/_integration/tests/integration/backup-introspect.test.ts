/**
 * Datensicherung (Team B): Introspektion, Bereichsplanung und Export gegen PGlite.
 * Der Export wird mit der echten Hülle/dem echten ZIP gelesen und auf Inhalt geprüft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { resetAllForTests } from '$testing';
import filesModule from '$modules/files/module';
import { loadTableInfo, selfReference } from '$testing';
import { listBackupScopes, planTables } from '$testing';
import { decodeRowSecrets, encodeRowSecrets, keyCheckValue, secretPurposeFor } from '$testing';
import { setBackupClockForTests, startBackupExport, takeBackupDownload } from '$testing';
import { decryptEnvelope, deriveEnvelopeKey, readEnvelopeHeader } from '$testing';
import { readArchive } from '$testing';
import { collect } from '$testing';
import { encryptSecret, isEncrypted } from '$testing';
import { isSecretMarker, type TableInfo } from '$testing';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'a-long-enough-pw';
const BACKUP_PW = 'sicherungs-passwort-123';
let close: () => Promise<void>;
let admin: RequestContext;
let adminId: string;
let plainCtx: RequestContext;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function readBackup(path: string) {
	const header = await readEnvelopeHeader(path);
	const key = await deriveEnvelopeKey(header, BACKUP_PW);
	const entries: { name: string; text: string; bytes: Uint8Array }[] = [];
	for await (const e of readArchive(decryptEnvelope(path, header, key))) {
		const bytes = await collect(e.stream());
		entries.push({ name: e.name, bytes, text: new TextDecoder().decode(bytes) });
	}
	return entries;
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(filesModule);
	await syncModules();
	await bootstrapAdmin('admin@test.local', PW);
	const [u0] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@test.local'));
	adminId = u0!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'files');
	admin = await ctxOf(adminId);
	const u = await createUser(admin, {
		name: 'Ohne Recht',
		email: 'plain@test.local',
		password: PW,
		roleIds: []
	});
	plainCtx = await ctxOf(u);
	await installFakeStorage(admin);
}, 60_000);

afterAll(async () => {
	setBackupClockForTests(undefined);
	uninstallFakeStorage();
	await close();
});

describe('loadTableInfo', () => {
	it('liest Spalten, Primärschlüssel und Fremdschlüssel (inkl. Eigenbezug)', async () => {
		const info = await loadTableInfo(getDb(), ['public', 'mod_files']);
		const user = info.find((t) => t.schema === 'public' && t.table === 'user')!;
		expect(user.primaryKey).toEqual(['id']);
		expect(user.columns.find((c) => c.name === 'created_at')?.type).toBe(
			'timestamp with time zone'
		);
		const apiKey = info.find((t) => t.table === 'api_key')!;
		expect(apiKey.columns.find((c) => c.name === 'scopes')?.type).toBe('text[]');
		expect(apiKey.foreignKeys).toContainEqual({
			columns: ['owner_id'],
			refSchema: 'public',
			refTable: 'user',
			refColumns: ['id']
		});
		const setting = info.find((t) => t.table === 'setting')!;
		expect(setting.primaryKey).toEqual(['key', 'scope_id']);

		const nodes = info.find((t) => t.schema === 'mod_files' && t.table === 'nodes')!;
		expect(nodes).toBeTruthy();
		expect(selfReference(nodes)).toMatchObject({ refSchema: 'mod_files', refTable: 'nodes' });
		expect(info.some((t) => t.schema === 'drizzle')).toBe(false);
	});
});

describe('Bereiche', () => {
	it('listet Core-Bereiche und Module mit Schema', async () => {
		const scopes = await listBackupScopes();
		expect(scopes.slice(0, 8).map((s) => s.key)).toEqual([
			'core:users',
			'core:roles',
			'core:api-keys',
			'core:settings',
			'core:audit',
			'core:api-log',
			'core:jobs',
			'core:ai-usage'
		]);
		const files = scopes.find((s) => s.key === 'files')!;
		expect(files).toMatchObject({ group: 'module', enabled: true, implies: [] });
		expect(scopes.find((s) => s.key === 'core:users')!.implies[0]!.scope).toBe('core:api-keys');
	});

	it('plant Tabellen in Einfüge-Reihenfolge ohne verbotene Tabellen', async () => {
		const { tables } = await planTables(getDb(), [
			'core:users',
			'core:roles',
			'core:api-keys',
			'core:settings',
			'files'
		]);
		const names = tables.map((t) => `${t.schema}.${t.table}${t.where ? `|${t.where}` : ''}`);
		const idx = (n: string) => names.findIndex((x) => x.startsWith(n));
		for (const banned of ['session', 'verification', 'permission', 'module_state']) {
			expect(names.some((n) => n.startsWith(`public.${banned}`))).toBe(false);
		}
		expect(idx('public.user')).toBeLessThan(idx('public.account'));
		expect(idx('public.role')).toBeLessThan(idx('public.user_role'));
		expect(idx('public.user')).toBeLessThan(idx('public.api_key'));
		// user_role nur einmal, setting zweimal (verschiedene Filter)
		expect(names.filter((n) => n === 'public.user_role')).toHaveLength(1);
		expect(names.filter((n) => n.startsWith('public.setting'))).toEqual([
			"public.setting|scope_id <> ''",
			"public.setting|scope_id = ''"
		]);
		// Module nach Core, mit eigenem file-Anteil
		expect(idx('mod_files.')).toBeGreaterThan(idx('public.api_key'));
		expect(names).toContain("public.file|module_id = 'files'");
		expect(names).toContain("public.file|module_id = 'core'");
	});

	it('lehnt unbekannte Bereiche ab', async () => {
		await expect(planTables(getDb(), ['core:nope'])).rejects.toThrow();
		await expect(planTables(getDb(), ["x'; drop"])).rejects.toThrow();
	});
});

describe('Geheimnisse', () => {
	const settingInfo: TableInfo = {
		schema: 'public',
		table: 'setting',
		columns: [
			{ name: 'key', type: 'text', nullable: false },
			{ name: 'value', type: 'jsonb', nullable: false }
		],
		primaryKey: ['key'],
		foreignKeys: []
	};

	it('ordnet Zwecke zu', () => {
		expect(secretPurposeFor('public', 'setting', 'value')).toBe('settings');
		expect(secretPurposeFor('public', 'two_factor', 'secret')).toBe('better-auth');
		expect(secretPurposeFor('public', 'two_factor', 'backup_codes')).toBe('better-auth');
		expect(secretPurposeFor('mod_files', 'links', 'token_enc')).toBe('module:files');
		expect(secretPurposeFor('mod_unbekannt', 'x', 'y')).toBeNull();
		expect(secretPurposeFor('public', 'user', 'email')).toBeNull();
		expect(keyCheckValue()).toMatch(/^[0-9a-f]{64}$/);
	});

	it('Roundtrip: Marker beim Export, neu verschlüsselt beim Import', async () => {
		const row = { key: 'x', value: encryptSecret('geheim') };
		const enc = await encodeRowSecrets(settingInfo, row);
		expect(enc.undecryptable).toBe(0);
		expect(enc.row.value).toEqual({ $secret: { p: 'settings', v: 'geheim' } });
		const dec = await decodeRowSecrets(settingInfo, enc.row);
		expect(isEncrypted(dec.value)).toBe(true);
		expect(dec.value).not.toBe(row.value);

		const bad = await encodeRowSecrets(settingInfo, { key: 'y', value: 'enc:v1:a.b.c' });
		expect(bad.undecryptable).toBe(1);
		expect(bad.row.value).toBe('enc:v1:a.b.c');
	});

	it('lehnt Marker mit falschem Zweck oder in falschen Spalten ab', async () => {
		await expect(
			decodeRowSecrets(settingInfo, { key: 'x', value: { $secret: { p: 'better-auth', v: 'a' } } })
		).rejects.toMatchObject({ code: 'corrupt' });
		await expect(
			decodeRowSecrets(settingInfo, { key: { $secret: { p: 'settings', v: 'a' } }, value: 1 })
		).rejects.toMatchObject({ code: 'corrupt' });
	});
});

describe('Export', () => {
	it('verlangt Recht, Session und Passwort', async () => {
		const input = {
			scopes: ['core:settings'],
			includeFiles: false,
			backupPassword: BACKUP_PW,
			password: PW
		};
		await expect(startBackupExport(plainCtx, input)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			startBackupExport({ ...admin, actor: { ...admin.actor, type: 'api_key' } }, input)
		).rejects.toMatchObject({ code: 'forbidden' });
		resetAllForTests();
		await expect(
			startBackupExport(admin, { ...input, password: 'falsch-falsch' })
		).rejects.toMatchObject({ code: 'validation_failed' });
		await expect(
			startBackupExport(admin, { ...input, backupPassword: 'kurz' })
		).rejects.toMatchObject({ code: 'validation_failed' });
		await expect(
			startBackupExport(admin, { ...input, scopes: ['core:nope'] })
		).rejects.toMatchObject({ code: 'validation_failed' });
	});

	it('schreibt eine vollständige, verschlüsselte Sicherung mit Dateien', async () => {
		resetAllForTests();
		// Ordner + Datei im Modul files; Datei-Objekt im Fake-Speicher
		const db = getDb();
		const objectKey = `files/${randomUUID()}`;
		const body = new TextEncoder().encode('Hallo Sicherung');
		const sum = createHash('sha256').update(body).digest('hex');
		fakeObjects.set(objectKey, { body });
		const missingKey = `files/${randomUUID()}`;
		await db.execute(sql`INSERT INTO "public"."file" (id, module_id, path, name, object_key, size, content_type, checksum, status)
			VALUES (${randomUUID()}, 'files', 'a/b.txt', 'b.txt', ${objectKey}, ${body.length}, 'text/plain', ${sum}, 'ready'),
			       (${randomUUID()}, 'files', 'a/c.txt', 'c.txt', ${missingKey}, 3, 'text/plain', ${'0'.repeat(64)}, 'ready')`);

		const res = await startBackupExport(admin, {
			scopes: ['core:users', 'core:settings', 'files'],
			includeFiles: true,
			backupPassword: BACKUP_PW,
			password: PW
		});
		expect(res.fileName).toMatch(/^atrium-sicherung-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.atriumbackup$/);
		expect(res.summary.scopes).toEqual(['core:users', 'core:api-keys', 'core:settings', 'files']);
		expect(res.summary.files).toBe(1);
		expect(res.summary.warnings.some((w) => w.includes(missingKey))).toBe(true);

		// fremder Benutzer → 404, eigener → einmalig
		await expect(takeBackupDownload(plainCtx, res.downloadId)).rejects.toMatchObject({
			code: 'forbidden'
		});
		const dl = await takeBackupDownload(admin, res.downloadId);
		expect(dl.size).toBe(res.summary.bytes);
		await expect(takeBackupDownload(admin, res.downloadId)).rejects.toMatchObject({
			code: 'not_found'
		});

		const entries = await readBackup(dl.path);
		const names = entries.map((e) => e.name);
		expect(names[0]).toBe('backup.json');
		expect(names[names.length - 1]).toBe('checksums.json');
		const meta = JSON.parse(entries[0]!.text);
		expect(meta.keyCheck).toBe(keyCheckValue());
		expect(meta.createdBy.id).toBe(adminId);
		expect(meta.modules.files.migrations.length).toBeGreaterThan(0);
		expect(meta.files).toEqual({ count: 2, bytes: body.length + 3 });
		// eine Datei-Entry, Inhalt identisch
		const fileEntry = entries.find((e) => e.name === `files/${objectKey}`)!;
		expect(new TextDecoder().decode(fileEntry.bytes)).toBe('Hallo Sicherung');
		expect(names).not.toContain(`files/${missingKey}`);

		// setting nur einmal, Zeilenzahl stimmt mit Meta überein
		expect(names.filter((n) => n === 'data/public.setting.ndjson')).toHaveLength(1);
		const checks = JSON.parse(entries[entries.length - 1]!.text).entries;
		for (const t of meta.tables) {
			const e = entries.find((x) => x.name === `data/${t.name}.ndjson`)!;
			const lines = e.text.split('\n').filter(Boolean);
			expect(lines.length, t.name).toBe(t.rows);
			expect(checks[`data/${t.name}.ndjson`].rows).toBe(t.rows);
			expect(checks[`data/${t.name}.ndjson`].sha256).toBe(
				createHash('sha256').update(e.bytes).digest('hex')
			);
		}
		expect(meta.tables.find((t: { name: string }) => t.name === 'public.setting').scope).toBe(
			'core:users,core:settings'
		);
		// Secret-Einstellung des Speichers als Marker, kein enc:v1 mehr
		const settings = entries
			.find((e) => e.name === 'data/public.setting.ndjson')!
			.text.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(settings.some((s) => isSecretMarker(s.value))).toBe(true);
		expect(settings.some((s) => isEncrypted(s.value))).toBe(false);
		// keine Sitzungen
		expect(names.some((n) => n.includes('session'))).toBe(false);

		await dl.done();
		expect(existsSync(dl.path)).toBe(false);
	}, 60_000);

	it('Download verfällt nach der Frist', async () => {
		resetAllForTests();
		const res = await startBackupExport(admin, {
			scopes: ['core:roles'],
			includeFiles: false,
			backupPassword: BACKUP_PW,
			password: PW
		});
		const now = Date.now();
		setBackupClockForTests(() => now + 16 * 60_000);
		await expect(takeBackupDownload(admin, res.downloadId)).rejects.toMatchObject({
			code: 'not_found'
		});
		setBackupClockForTests(undefined);
	}, 60_000);
});
