import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { symmetricEncrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage, fakeObjects } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { getAuth } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { ADMIN_ROLE_ID } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { createApiKey } from '$testing';
import { setSetting, getSetting } from '$testing';
import { pauseJobs, resumeJobs, runDueJobs } from '$testing';
import { isCoreError } from '$testing';
import { core } from '$testing';
import {
	RESET_CONFIRM_WORD,
	executeReset,
	exportResetData,
	listResetAreas,
	previewReset,
	setResetClockForTests,
	totpCode
} from '$testing';
import { defineModule } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'Sehr-Sicheres-Passwort-1';
let admin: RequestContext;
let adminId: string;
let close: () => Promise<void>;

const base = defineModule({
	manifest: {
		id: 'rstbase',
		name: 'Reset-Basis',
		version: '1.0.0',
		dependencies: [],
		permissions: [],
		navigation: []
	},
	migrations: [
		{
			name: '0001_init.sql',
			sql: `CREATE TABLE IF NOT EXISTS item (id text PRIMARY KEY, name text NOT NULL);
INSERT INTO item (id, name) VALUES ('seed', 'Start') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS note (id text PRIMARY KEY, item_id text REFERENCES item(id), user_id text);`
		}
	],
	resetAreas: [
		{ id: 'notes', label: 'Notizen', description: 'Alle Notizen', tables: ['note'] },
		{
			id: 'items',
			label: 'Einträge',
			description: 'Einträge',
			tables: ['note', 'item'],
			implies: [
				{ area: 'rstbase:notes', reason: 'Notizen hängen an Einträgen' },
				{ area: 'rstdep:links', reason: 'Verweise zeigen auf Einträge' },
				{ area: 'ghost:x', reason: 'nicht installiert' }
			]
		},
		{
			id: 'all',
			label: 'Alles',
			description: 'Neu aufbauen',
			tables: [],
			rebuild: true,
			storagePrefixes: 'all'
		}
	],
	resetUsers: async (tx, keep) => {
		await tx.execute(sql`UPDATE note SET user_id = NULL WHERE user_id <> ${keep}`);
	}
});

const dep = defineModule({
	manifest: {
		id: 'rstdep',
		name: 'Reset-Abhaengig',
		version: '1.0.0',
		dependencies: ['rstbase'],
		permissions: [],
		navigation: []
	},
	migrations: [
		{
			name: '0001_init.sql',
			sql: `CREATE TABLE IF NOT EXISTS link (id text PRIMARY KEY, item_id text NOT NULL);`
		}
	],
	resetAreas: [{ id: 'links', label: 'Verweise', description: 'Verweise', tables: ['link'] }]
});

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function q(query: ReturnType<typeof sql>) {
	return ((await getDb().execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
}
const count = async (table: string) =>
	Number((await q(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]!.n);

async function expectError(p: Promise<unknown>, code: string) {
	try {
		await p;
	} catch (e) {
		expect(isCoreError(e), String(e)).toBe(true);
		expect((e as { code: string }).code).toBe(code);
		return e as { code: string; details?: unknown };
	}
	throw new Error(`Fehler ${code} erwartet`);
}

async function seedBase() {
	await q(sql`DELETE FROM mod_rstdep.link`);
	await q(sql`DELETE FROM mod_rstbase.note`);
	await q(sql`DELETE FROM mod_rstbase.item WHERE id <> 'seed'`);
	await q(sql`INSERT INTO mod_rstbase.item (id, name) VALUES ('a', 'A'), ('b', 'B')`);
	await q(
		sql`INSERT INTO mod_rstbase.note (id, item_id, user_id) VALUES ('n1', 'a', 'u1'), ('n2', 'b', ${adminId})`
	);
	await q(sql`INSERT INTO mod_rstdep.link (id, item_id) VALUES ('l1', 'a')`);
}

/** Pflicht-Export ist eine verschlüsselte `.atriumbackup`-Datei (kein Klartext-JSON, #29); räumt die Temp-Datei ab. */
async function expectEncryptedExport(exp: { path: string; size: number; done(): Promise<void> }) {
	const bytes = await readFile(exp.path);
	expect(bytes.length).toBe(exp.size);
	expect(bytes.subarray(0, 4).toString('latin1')).toBe('EPBK');
	const text = bytes.toString('latin1');
	expect(text).not.toContain('ep-intern-reset-export');
	expect(text).not.toContain('mod_rstbase');
	expect(() => JSON.parse(bytes.toString('utf8'))).toThrow();
	await exp.done();
}

/** Vorschau → Export → Ausführen */
async function runFull(areas: string[]) {
	const p = await previewReset(admin, areas);
	const exp = await exportResetData(admin, {
		token: p.token,
		password: PW,
		backupPassword: 'Reset-Sicherung-2026'
	});
	const res = await executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD });
	return { p, exp, res };
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(base);
	registerModule(dep);
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	await syncModules();
	await bootstrapAdmin('admin@test.local', PW);
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@test.local'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	for (const id of ['rstbase', 'rstdep', 'members', 'actions', 'treasury']) {
		await enableModule(admin, id);
	}
	admin = await ctxOf(adminId);
});

afterAll(async () => {
	setResetClockForTests(undefined);
	uninstallFakeStorage();
	await close();
});

describe('Rechte', () => {
	it('ohne core.system.reset → 403, API-Key-Kontext → 403', async () => {
		expect(admin.permissions.has('core.system.reset')).toBe(true);
		const roleId = await createRole(admin, { name: 'Leser', permissions: ['core.users.view'] });
		const uid = await createUser(admin, {
			name: 'Lea',
			email: 'lea@test.local',
			password: PW,
			roleIds: [roleId]
		});
		const lea = await ctxOf(uid);
		await expectError(listResetAreas(lea), 'forbidden');
		await expectError(previewReset(lea, ['core:audit']), 'forbidden');
		await expectError(
			exportResetData(lea, { token: 'x', password: PW, backupPassword: 'Reset-Sicherung-2026' }),
			'forbidden'
		);
		await expectError(executeReset(lea, { token: 'x', confirmWord: 'x' }), 'forbidden');
		const keyCtx: RequestContext = { ...admin, actor: { type: 'api_key', id: 'k', name: 'k' } };
		await expectError(listResetAreas(keyCtx), 'forbidden');
		await expectError(core.system.reset.listAreas(core.auth.systemContext()), 'forbidden');
	});
});

describe('Bereiche und Vorschau', () => {
	it('listet Core- und Modulbereiche aktiver Module mit Implikationen', async () => {
		const areas = await listResetAreas(admin);
		const keys = areas.map((a) => a.key);
		for (const k of [
			'core:audit',
			'core:users',
			'core:settings',
			'rstbase:items',
			'rstdep:links'
		]) {
			expect(keys).toContain(k);
		}
		const items = areas.find((a) => a.key === 'rstbase:items')!;
		expect(items.group).toBe('Reset-Basis');
		expect(items.implies.map((i) => i.area)).toEqual(['rstbase:notes', 'rstdep:links']);
		const all = areas.find((a) => a.key === 'rstbase:all')!;
		expect(all.rebuild).toBe(true);
		expect(all.implies.map((i) => i.area).sort()).toEqual(['rstbase:items', 'rstbase:notes']);
		expect(areas.find((a) => a.key === 'core:users')!.implies[0]!.area).toBe('core:api-keys');
		// Abhängige Module zuerst
		expect(keys.indexOf('rstdep:links')).toBeLessThan(keys.indexOf('rstbase:items'));
	});

	it('zählt Zeilen und löst Implikationen transitiv auf', async () => {
		await seedBase();
		const p = await previewReset(admin, ['rstbase:items']);
		expect(p.areas.sort()).toEqual(['rstbase:items', 'rstbase:notes', 'rstdep:links']);
		expect(p.implied).toEqual(
			expect.arrayContaining([
				{ area: 'rstdep:links', by: 'rstbase:items', reason: 'Verweise zeigen auf Einträge' }
			])
		);
		const t = (area: string, table: string) =>
			p.tables.find((x) => x.area === area && x.table === table)?.rows;
		expect(t('rstbase:items', 'mod_rstbase.item')).toBe(3);
		expect(t('rstbase:items', 'mod_rstbase.note')).toBe(2);
		expect(t('rstdep:links', 'mod_rstdep.link')).toBe(1);
		expect(p.token.length).toBeGreaterThan(20);
		expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
	});

	it('unbekannter Bereich oder leere Auswahl → 422', async () => {
		await expectError(previewReset(admin, ['foo:bar']), 'validation_failed');
		await expectError(previewReset(admin, []), 'validation_failed');
	});
});

describe('Ablauf', () => {
	it('falsches Passwort → 422 (password), Ausführen ohne Export → 409, falsches Wort → 422', async () => {
		await seedBase();
		const p = await previewReset(admin, ['rstbase:notes']);
		const err = await expectError(
			exportResetData(admin, {
				token: p.token,
				password: 'falsch-falsch-1',
				backupPassword: 'Reset-Sicherung-2026'
			}),
			'validation_failed'
		);
		expect(JSON.stringify(err.details)).toContain('password');
		await expectError(
			executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD }),
			'conflict'
		);
		const exp = await exportResetData(admin, {
			token: p.token,
			password: PW,
			backupPassword: 'Reset-Sicherung-2026'
		});
		await expectError(
			executeReset(admin, { token: p.token, confirmWord: 'zurücksetzen' }),
			'validation_failed'
		);
		expect(await count('mod_rstbase.note')).toBe(2);

		expect(exp.fileName).toMatch(/^atrium-reset-.*\.atriumbackup$/);
		await expectEncryptedExport(exp);

		const res = await executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD });
		expect(res.areas).toEqual(['rstbase:notes']);
		expect(res.deletedRows).toBe(2);
		expect(await count('mod_rstbase.note')).toBe(0);
		expect(await count('mod_rstbase.item')).toBe(3);
		// Token ist verbraucht
		await expectError(
			executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD }),
			'conflict'
		);
		const audit = await q(
			sql`SELECT action, metadata FROM audit_log WHERE action LIKE 'core.system.reset%' ORDER BY created_at`
		);
		expect(audit.map((a) => a.action)).toEqual(['core.system.reset_exported', 'core.system.reset']);
	});

	it('fremder, unbekannter und abgelaufener Token → 409', async () => {
		const uid = await createUser(admin, {
			name: 'Zweite Admin',
			email: 'admin2@test.local',
			password: PW,
			roleIds: [ADMIN_ROLE_ID]
		});
		const other = await ctxOf(uid);
		const p = await previewReset(admin, ['rstbase:notes']);
		await expectError(
			exportResetData(other, {
				token: p.token,
				password: PW,
				backupPassword: 'Reset-Sicherung-2026'
			}),
			'conflict'
		);
		await expectError(
			exportResetData(admin, {
				token: 'unbekannt',
				password: PW,
				backupPassword: 'Reset-Sicherung-2026'
			}),
			'conflict'
		);
		setResetClockForTests(() => Date.now() + 16 * 60_000);
		try {
			await expectError(
				exportResetData(admin, {
					token: p.token,
					password: PW,
					backupPassword: 'Reset-Sicherung-2026'
				}),
				'conflict'
			);
		} finally {
			setResetClockForTests(undefined);
		}
	});

	it('DELETE-Bereich mit Implikation über Modulgrenzen', async () => {
		await seedBase();
		const { res } = await runFull(['rstbase:items']);
		expect(res.areas.sort()).toEqual(['rstbase:items', 'rstbase:notes', 'rstdep:links']);
		expect(await count('mod_rstbase.item')).toBe(0);
		expect(await count('mod_rstdep.link')).toBe(0);
	});

	it('rebuild stellt die Startdaten wieder her', async () => {
		await q(
			sql`INSERT INTO mod_rstbase.item (id, name) VALUES ('seed', 'Start') ON CONFLICT DO NOTHING`
		);
		await seedBase();
		const { p, exp, res } = await runFull(['rstbase:all']);
		expect(p.areas.sort()).toEqual([
			'rstbase:all',
			'rstbase:items',
			'rstbase:notes',
			'rstdep:links'
		]);
		await expectEncryptedExport(exp);
		expect(res.deletedRows).toBeGreaterThanOrEqual(5);
		const items = await q(sql`SELECT id FROM mod_rstbase.item`);
		expect(items.map((r) => r.id)).toEqual(['seed']);
		expect(await count('mod_rstbase.note')).toBe(0);
		const mig = await q(sql`SELECT name FROM module_migration WHERE module_id = 'rstbase'`);
		expect(mig).toHaveLength(1);
	});

	it('Datei-Metadaten (auch pending) ohne S3 werden gelöscht (mit Warnung)', async () => {
		await q(sql`INSERT INTO file (id, module_id, path, name, object_key, size, content_type, status)
			VALUES ('f1', 'rstbase', 'docs/a.pdf', 'a.pdf', 'rstbase/f1', 100, 'application/pdf', 'ready'),
			       ('f2', 'rstbase', 'docs/b.pdf', 'b.pdf', 'rstbase/f2', 50, 'application/pdf', 'pending')`);
		const p = await previewReset(admin, ['rstbase:all']);
		expect(p.files).toEqual([{ module: 'rstbase', count: 2, bytes: 150 }]);
		const exp = await exportResetData(admin, {
			token: p.token,
			password: PW,
			backupPassword: 'Reset-Sicherung-2026'
		});
		await expectEncryptedExport(exp);
		const res = await executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD });
		expect(res.deletedFiles).toBe(2);
		expect(res.warnings.join(' ')).toContain('nur Metadaten');
		expect(await count(`file WHERE module_id = 'rstbase'`)).toBe(0);
	});
});

describe('Core-Bereiche', () => {
	it('core:users behält den Admin, entfernt API-Keys und bereinigt Modulverweise', async () => {
		await seedBase();
		const roleId = await createRole(admin, {
			name: 'Keyrolle',
			permissions: ['core.api.manage']
		});
		const uid = await createUser(admin, {
			name: 'Kim',
			email: 'kim@test.local',
			password: PW,
			roleIds: [roleId]
		});
		await createApiKey(await ctxOf(uid), { name: 'k', scopes: ['core.api.manage'] });
		await setSetting(await ctxOf(uid), 'core.user.theme', 'dark').catch(() => undefined);
		const before = await count('"user"');
		expect(before).toBeGreaterThan(1);
		const { p, exp, res } = await runFull(['core:users']);
		expect(p.areas).toEqual(['core:api-keys', 'core:users']);
		await expectEncryptedExport(exp);
		expect(res.deletedRows).toBeGreaterThan(0);
		const users = await q(sql`SELECT id FROM "user"`);
		expect(users.map((u) => u.id)).toEqual([adminId]);
		expect(await count('api_key')).toBe(0);
		expect(await count('session WHERE user_id <> ' + `'${adminId}'`)).toBe(0);
		const notes = await q(sql`SELECT id, user_id FROM mod_rstbase.note ORDER BY id`);
		expect(notes).toEqual([
			{ id: 'n1', user_id: null },
			{ id: 'n2', user_id: adminId }
		]);
		admin = await ctxOf(adminId);
		expect(admin.permissions.has('core.system.reset')).toBe(true);
	});

	it('core:roles entfernt eigene Rollen, Administrator bleibt', async () => {
		await createRole(admin, { name: 'Wegwerf', permissions: ['core.users.view'] });
		await runFull(['core:roles']);
		const roles = await q(sql`SELECT id, is_system FROM role`);
		expect(roles.every((r) => r.is_system)).toBe(true);
		expect(roles.map((r) => r.id)).toContain(ADMIN_ROLE_ID);
		admin = await ctxOf(adminId);
		expect(admin.permissions.has('core.system.reset')).toBe(true);
	});

	it('core:settings behält Speicher-/SMTP-Zugang', async () => {
		await setSetting(admin, 'core.system.name', 'Testsystem');
		await setSetting(admin, 'core.smtp.host', 'smtp.test.local');
		await setSetting(admin, 'core.storage.bucket', 'bucket-x');
		await runFull(['core:settings']);
		expect(await getSetting('core.system.name')).not.toBe('Testsystem');
		expect(await getSetting('core.smtp.host')).toBe('smtp.test.local');
		expect(await getSetting('core.storage.bucket')).toBe('bucket-x');
		await q(sql`DELETE FROM setting WHERE key = 'core.storage.bucket'`);
	});

	it('core:audit löscht alles, danach existiert genau der Reset-Eintrag', async () => {
		expect(await count('audit_log')).toBeGreaterThan(3);
		await runFull(['core:audit', 'core:api-log', 'core:jobs', 'core:ai-usage']);
		const rows = await q(sql`SELECT action, metadata FROM audit_log`);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.action).toBe('core.system.reset');
		const meta = (
			typeof rows[0]!.metadata === 'string'
				? JSON.parse(String(rows[0]!.metadata))
				: rows[0]!.metadata
		) as { areas: string[] };
		expect(meta.areas).toContain('core:audit');
		// Direktes DELETE bleibt verboten
		await expect(q(sql`DELETE FROM audit_log`)).rejects.toThrow();
	});

	it('2FA: ohne/mit falschem Code 422, mit gültigem Code ok', async () => {
		const secret = 'TESTSECRET1234567890';
		const authCtx = await getAuth().$context;
		await getDb()
			.insert(schema.twoFactor)
			.values({
				id: 'tf1',
				userId: adminId,
				secret: await symmetricEncrypt({ key: authCtx.secretConfig, data: secret }),
				backupCodes: 'x'
			});
		await getDb()
			.update(schema.user)
			.set({ twoFactorEnabled: true })
			.where(eq(schema.user.id, adminId));
		// Eigene TOTP-Implementierung entspricht Better Auth
		expect(await createOTP(secret).verify(totpCode(secret))).toBe(true);
		const p = await previewReset(admin, ['core:jobs']);
		const e1 = await expectError(
			exportResetData(admin, {
				token: p.token,
				password: PW,
				backupPassword: 'Reset-Sicherung-2026'
			}),
			'validation_failed'
		);
		expect(JSON.stringify(e1.details)).toContain('totp');
		await expectError(
			exportResetData(admin, {
				token: p.token,
				password: PW,
				backupPassword: 'Reset-Sicherung-2026',
				totp: '000000' === totpCode(secret) ? '111111' : '000000'
			}),
			'validation_failed'
		);
		await exportResetData(admin, {
			token: p.token,
			password: PW,
			backupPassword: 'Reset-Sicherung-2026',
			totp: totpCode(secret)
		});
		await executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD });
		await getDb()
			.update(schema.user)
			.set({ twoFactorEnabled: false })
			.where(eq(schema.user.id, adminId));
		await getDb().delete(schema.twoFactor).where(eq(schema.twoFactor.userId, adminId));
	});
});

describe('Jobs und Storage', () => {
	it('pausierte Jobs laufen nicht', async () => {
		pauseJobs();
		try {
			expect(await runDueJobs()).toEqual([]);
		} finally {
			resumeJobs();
		}
	});

	it('storage.purge löscht Objekte und Metadaten, Recht nötig', async () => {
		await installFakeStorage(admin);
		try {
			for (const path of ['docs/a.txt', 'docs/b.txt', 'other/c.txt']) {
				await core.storage.upload(admin, {
					module: 'rstbase',
					path,
					file: new TextEncoder().encode('hallo'),
					contentType: 'text/plain'
				});
			}
			const roleId = await createRole(admin, { name: 'Ohne', permissions: ['core.users.view'] });
			const uid = await createUser(admin, {
				name: 'Ole',
				email: 'ole@test.local',
				password: PW,
				roleIds: [roleId]
			});
			await expectError(core.storage.purge(await ctxOf(uid), { module: 'rstbase' }), 'forbidden');
			const r = await core.storage.purge(admin, { module: 'rstbase', prefix: 'docs/' });
			expect(r.count).toBe(2);
			expect(r.bytes).toBe(10);
			expect(r.warnings).toEqual([]);
			const left = await core.storage.list(admin, { module: 'rstbase', prefix: 'other' });
			expect(left.files).toHaveLength(1);
			expect(fakeObjects.size).toBe(1);

			// Reset über Bereich mit storagePrefixes 'all'
			const { p, res } = await runFull(['rstbase:all']);
			expect(p.files).toEqual([{ module: 'rstbase', count: 1, bytes: 5 }]);
			expect(res.deletedFiles).toBe(1);
			expect(fakeObjects.size).toBe(0);
			const purgeAudit = await q(
				sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'core.storage.purged'`
			);
			expect(Number(purgeAudit[0]!.n)).toBe(1);
		} finally {
			uninstallFakeStorage();
		}
	});
});

describe('Echte Module', () => {
	it('Reset über alle Bereiche (members/actions/treasury aktiv)', async () => {
		const areas = (await listResetAreas(admin)).map((a) => a.key);
		const { res } = await runFull(areas);
		expect(res.areas.sort()).toEqual([...areas].sort());
		const users = await q(sql`SELECT id FROM "user"`);
		expect(users.map((u) => u.id)).toEqual([adminId]);
		const rows = await q(sql`SELECT action FROM audit_log`);
		expect(rows.map((r) => r.action)).toEqual(['core.system.reset']);
		admin = await ctxOf(adminId);
		expect((await listResetAreas(admin)).length).toBe(areas.length);
		for (const id of ['members', 'actions', 'treasury']) {
			expect(await core.modules.isEnabled(id)).toBe(true);
		}
	});
});
