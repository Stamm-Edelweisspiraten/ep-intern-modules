/**
 * Datensicherung: Datenzeilen über 16 MB (früheres Limit) lassen sich prüfen und wiederherstellen.
 * Anlass: Produktiv-Sicherung (~300 MB) scheiterte bei der Prüfung mit „Eine Datenzeile der Sicherung ist zu groß.“
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedBackupWorld, type BackupWorld } from '../../helpers/backup-seed';
import { exportBackup, previewBackup, runRestore } from '../../helpers/backup-flow';
import { getDb } from '$testing';

let world: BackupWorld;

/** ~20 MB JSON-Text in einer einzigen Zeile von `public.setting` */
const BIG = 'x'.repeat(20 * 1024 * 1024);
const KEY = 'test.large-row';

async function bigValueLength(): Promise<number | null> {
	const res = (await getDb().execute(
		sql`SELECT length(value #>> '{}') AS n FROM "public"."setting" WHERE key = ${KEY} AND scope_id = ''`
	)) as unknown as { rows: { n: number | string }[] };
	const n = res.rows[0]?.n;
	return n === undefined ? null : Number(n);
}

beforeAll(async () => {
	world = await seedBackupWorld();
	await getDb().execute(
		sql`INSERT INTO "public"."setting" (key, scope_id, value) VALUES (${KEY}, '', to_jsonb(${BIG}::text))`
	);
}, 120_000);

afterAll(async () => {
	await world?.close();
});

describe('Datensicherung mit großer Datenzeile', () => {
	it('prüft und stellt eine Zeile über 16 MB wieder her', async () => {
		const { bytes } = await exportBackup(world.admin, {
			scopes: ['core:settings'],
			includeFiles: false
		});
		await getDb().execute(sql`DELETE FROM "public"."setting" WHERE key = ${KEY}`);
		expect(await bigValueLength()).toBeNull();

		const preview = await previewBackup(world.admin, bytes);
		expect(preview.scopes.find((s) => s.key === 'core:settings')?.available).toBe(true);

		await runRestore(world.admin, preview, { scopes: ['core:settings'] });
		expect(await bigValueLength()).toBe(BIG.length);
	}, 180_000);
});
