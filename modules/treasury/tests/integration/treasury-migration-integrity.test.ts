/**
 * Kasse, Migration 0009 (#73): verwaiste `invoices.annual_run_id` werden auf NULL gesetzt, danach gilt
 * ein Fremdschlüssel (ON DELETE SET NULL); neue Indizes vorhanden. Altbestand wird simuliert, indem der
 * Fremdschlüssel entfernt, ein verwaister Verweis eingefügt und die Migration erneut ausgeführt wird.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { getDb, schema } from '$testing';
import { splitSqlStatements } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import m0009 from '$modules/treasury/migrations/0009_integrity_indexes.sql?raw';

let close: () => Promise<void>;
type Row = Record<string, unknown>;
const q = async (query: ReturnType<typeof sql>) =>
	(
		(await core.database
			.forModule('treasury')
			.transaction((tx) => tx.execute(query))) as unknown as {
			rows: Row[];
		}
	).rows;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	const admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
});

afterAll(async () => {
	await close();
});

const invoice = (id: string, seq: number, runId: string | null) =>
	q(sql`INSERT INTO invoices (id, number, year, seq, source, recipient_name, issued_on, due_on, annual_run_id)
		VALUES (${id}, ${`R-2026-${String(seq).padStart(4, '0')}`}, 2026, ${seq}, 'annual', 'Familie Test',
			'2026-01-02', '2026-03-31', ${runId})`);

describe('Migration 0009 – Integrität und Indizes', () => {
	it('bereinigt verwaiste Verweise, legt den Fremdschlüssel und die Indizes an', async () => {
		// Altbestand: Fremdschlüssel weg, Lauf vorhanden + ein verwaister Verweis
		await q(sql`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_annual_run_id_fkey`);
		const runId = crypto.randomUUID();
		await q(sql`INSERT INTO annual_fee_runs (id, year, created_on, due_on, rates, mail_subject, mail_body, pdf_text)
			VALUES (${runId}, 2026, '2026-01-02', '2026-03-31', '{}'::jsonb, 'B', 'T', 'P')`);
		await invoice('inv-ok', 9001, runId);
		await invoice('inv-orphan', 9002, 'gibt-es-nicht');

		await core.database.forModule('treasury').transaction(async (tx) => {
			for (const stmt of splitSqlStatements(m0009)) await tx.execute(sql.raw(stmt));
		});

		const rows = await q(
			sql`SELECT id, annual_run_id FROM invoices WHERE id IN ('inv-ok', 'inv-orphan') ORDER BY id`
		);
		expect(rows).toEqual([
			{ id: 'inv-ok', annual_run_id: runId },
			{ id: 'inv-orphan', annual_run_id: null }
		]);
		// Neuer verwaister Verweis wird abgelehnt
		await expect(invoice('inv-bad', 9003, 'gibt-es-nicht')).rejects.toThrow();
		// Lauf löschen → Verweis NULL, Rechnung bleibt
		await q(sql`DELETE FROM annual_fee_runs WHERE id = ${runId}`);
		expect(await q(sql`SELECT annual_run_id FROM invoices WHERE id = 'inv-ok'`)).toEqual([
			{ annual_run_id: null }
		]);
		const idx = (
			await q(sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'mod_treasury'`)
		).map((r) => String(r.indexname));
		expect(idx).toEqual(
			expect.arrayContaining([
				'transactions_category_idx',
				'transactions_import_batch_idx',
				'payables_payer_idx'
			])
		);
	});
});
