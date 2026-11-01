import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isRealPostgres, pgTestUrl, useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule, unregisterModule } from '$testing';
import { enableModule, runModuleMigrations, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { withMigrationLock } from '$testing';
import { setMailTransportForTests } from '$testing';
import { runDueJobs } from '$testing';
import { resetAllForTests } from '$testing';
import { env } from '$testing';
import { core, defineModule, isCoreError } from '$lib/sdk/server';
import { setTodayForTests } from '$lib/sdk/dates';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import ordersModule from '$modules/orders/module';
import filesModule from '$modules/files/module';
import { runReminderJob } from '$modules/treasury/notify';
import { nextNumber } from '$modules/orders/db';
import { assertQuota } from '$modules/files/storage';
import type { InvoiceDetail } from '$modules/treasury/schemas';
import type { RequestContext } from '$lib/sdk/types';

/*
 * #60: Nebenläufigkeit der Advisory-Sperren unter ECHTEM PostgreSQL (mehrere Verbindungen).
 * Läuft nur mit `TEST_DATABASE_URL` (siehe tests/helpers/db.ts, docs/database.md); unter PGlite
 * (eine Sitzung) liefen die Transaktionen ohnehin nacheinander und bewiesen nichts.
 *
 * Gegenprobe (einmalig von Hand, siehe .claude/rules/testing-and-verification.md): die jeweilige
 * `pg_advisory_xact_lock`-Zeile entfernen → der zugehörige Test wird rot (doppelte Nummer → 409/500,
 * Kontingent überschritten, Migration doppelt eingetragen).
 */

const PARALLEL = 20;
let admin: RequestContext;
let key = '';
let close: (() => Promise<void>) | undefined;
let realPg = false;
const mails: { to: string; subject: string }[] = [];
let jobRuns = 0;

type Row = Record<string, unknown>;
const mq = async (moduleId: string, q: ReturnType<typeof sql>) =>
	(
		(await core.database.forModule(moduleId).transaction((tx) => tx.execute(q))) as unknown as {
			rows: Row[];
		}
	).rows;

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${key}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}

const jobModule = defineModule({
	manifest: {
		id: 'pgjob',
		name: 'Job-Test',
		version: '1.0.0',
		dependencies: [],
		permissions: [],
		navigation: []
	},
	jobs: [
		{
			id: 'tick',
			summary: 'zählt Läufe',
			schedule: 'hourly',
			run: async () => {
				jobRuns++;
				return 'ok';
			}
		}
	]
});

describe.skipIf(!pgTestUrl())('PostgreSQL: Nebenläufigkeit der Sperren (#60)', () => {
	beforeAll(async () => {
		realPg = await isRealPostgres();
		({ close } = await useTestDatabase());
		registerCoreApi();
		for (const m of [membersModule, actionsModule, treasuryModule, ordersModule, filesModule]) {
			registerModule(m);
		}
		registerModule(jobModule);
		await syncModules();
		await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
		const [u] = await getDb()
			.select()
			.from(schema.user)
			.where(eq(schema.user.email, 'admin@example.test'));
		const ctxOf = async () => (await contextForUser(u!.id))!.ctx;
		admin = await ctxOf();
		for (const m of ['members', 'actions', 'treasury', 'orders', 'files', 'pgjob']) {
			await enableModule(admin, m);
		}
		admin = await ctxOf();
		key = (await createApiKey(admin, { name: 'pg', scopes: [...admin.permissions] })).key;
		setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
		setTodayForTests('2026-06-01');
	});

	afterAll(async () => {
		setTodayForTests(null);
		setMailTransportForTests(undefined);
		unregisterModule('pgjob');
		await close?.();
	});

	it('Pool hat mehrere Verbindungen (sonst wäre nichts nebenläufig)', async () => {
		if (!realPg) return;
		const pids = await Promise.all(
			Array.from({ length: 4 }, () =>
				getDb().transaction(async (tx) => {
					const r = await tx.execute(sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.2)`);
					return Number((r.rows[0] as Row).pid);
				})
			)
		);
		expect(new Set(pids).size).toBeGreaterThan(1);
	});

	it('Treiber: count(*) kommt als String (int8), timestamptz als String – Mapper müssen umwandeln', async () => {
		const r = await getDb().execute(
			sql`SELECT count(*) AS n, now() AS ts, current_date AS d FROM module_state`
		);
		const row = r.rows[0] as Row;
		// PGlite liefert int8 als number, der pg-Treiber als String (Typen parst der Client)
		expect(typeof row.n).toBe('string');
		expect(Number(row.n)).toBeGreaterThan(0);
		// drizzle (node-postgres) reicht DATE/TIMESTAMP(TZ) roh durch – kein Date-Objekt
		expect(typeof row.ts).toBe('string');
		expect(row.d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it(`Rechnungsnummern: ${PARALLEL} parallele POST /invoices → alle 201, Nummern eindeutig und lückenlos`, async () => {
		resetAllForTests();
		const res = await Promise.all(
			Array.from({ length: PARALLEL }, (_, i) =>
				api('/modules/treasury/invoices', {
					method: 'POST',
					json: {
						recipientName: `Familie Parallel ${i}`,
						recipientEmail: `parallel${i}@example.test`,
						issuedOn: '2026-06-01',
						dueOn: '2026-06-15',
						lines: [{ description: 'Beitrag', amountCents: 1000 + i }]
					}
				})
			)
		);
		const bodies = await Promise.all(res.map((r) => r.json()));
		expect(
			res.map((r) => r.status),
			JSON.stringify(bodies.find((b) => b.error))
		).toEqual(Array(PARALLEL).fill(201));
		const numbers = bodies.map((b) => (b.data as InvoiceDetail).number);
		expect(new Set(numbers).size).toBe(PARALLEL);
		const seqs = numbers.map((n) => Number(n.slice(-4))).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: PARALLEL }, (_, i) => seqs[0]! + i));
	});

	it(`Bestellnummern (orders.nextNumber): ${PARALLEL} parallele Vergaben → eindeutig`, async () => {
		const numbers = await Promise.all(
			Array.from({ length: PARALLEL }, (_, i) =>
				core.database.forModule('orders').transaction(async (tx) => {
					const n = await nextNumber(tx, 'supplier_orders', '2026-06-01');
					await tx.execute(sql`INSERT INTO supplier_orders (id, number, year, seq, supplier, ordered_on)
						VALUES (${crypto.randomUUID()}, ${n.number}, ${n.year}, ${n.seq}, ${'Lieferant ' + i}, '2026-06-01')`);
					return n.number;
				})
			)
		);
		expect(new Set(numbers).size).toBe(PARALLEL);
		expect([...numbers].sort()[0]).toBe('E-2026-0001');
	});

	it('Kontingent (files.assertQuota): parallele Uploads überschreiten das Limit nicht', async () => {
		const owner = `quota-${crypto.randomUUID()}`;
		const limit = 1000;
		const size = 300;
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) =>
				core.database.forModule('files').transaction(async (tx) => {
					await assertQuota(tx, owner, size, limit);
					// kurze Pause im kritischen Abschnitt, damit sich Transaktionen ohne Sperre überlappen
					await tx.execute(sql`SELECT pg_sleep(0.05)`);
					await tx.execute(sql`INSERT INTO nodes (id, kind, space, owner_id, name, storage_path, size_bytes)
						VALUES (${crypto.randomUUID()}, 'file', 'personal', ${owner}, ${`datei-${i}.bin`},
							${`files/${owner}/${i}`}, ${size})`);
				})
			)
		);
		const ok = results.filter((r) => r.status === 'fulfilled').length;
		expect(ok).toBe(Math.floor(limit / size));
		for (const r of results) {
			if (r.status === 'rejected') expect(isCoreError(r.reason) && r.reason.status).toBe(413);
		}
		const [used] = await mq(
			'files',
			sql`SELECT COALESCE(SUM(size_bytes), 0) AS used FROM nodes WHERE owner_id = ${owner}`
		);
		expect(Number(used!.used)).toBeLessThanOrEqual(limit);
	});

	it('Mahnlauf (treasury): drei parallele Läufe → genau eine Erinnerung und eine Mail', async () => {
		resetAllForTests();
		const res = await api('/modules/treasury/invoices', {
			method: 'POST',
			json: {
				recipientName: 'Familie Mahnung',
				recipientEmail: 'mahnung-pg@example.test',
				issuedOn: '2026-06-01',
				dueOn: '2026-06-02',
				lines: [{ description: 'Beitrag', amountCents: 5000 }]
			}
		});
		expect(res.status).toBe(201);
		const id = ((await res.json()).data as InvoiceDetail).id;
		setTodayForTests('2026-06-20');
		try {
			mails.length = 0;
			await Promise.all([runReminderJob(admin), runReminderJob(admin), runReminderJob(admin)]);
			expect(mails.filter((m) => m.to === 'mahnung-pg@example.test')).toHaveLength(1);
			const rows = await mq(
				'treasury',
				sql`SELECT level, status FROM reminders WHERE invoice_id = ${id} ORDER BY level`
			);
			expect(rows).toEqual([{ level: 1, status: 'sent' }]);
		} finally {
			setTodayForTests('2026-06-01');
		}
	});

	it('Modul-Migrationen: zwei parallele Läufe wenden jede Migration genau einmal an', async () => {
		unregisterModule('pgmig');
		registerModule({
			manifest: {
				id: 'pgmig',
				name: 'pgmig',
				version: '1.0.0',
				dependencies: [],
				permissions: [],
				navigation: []
			},
			migrations: [
				{ name: '0001_init', sql: 'CREATE TABLE items (id text PRIMARY KEY);' },
				{ name: '0002_more', sql: 'ALTER TABLE items ADD COLUMN note text;' }
			]
		});
		try {
			const runs = await Promise.all([
				runModuleMigrations('pgmig'),
				runModuleMigrations('pgmig'),
				runModuleMigrations('pgmig')
			]);
			expect(runs.flat().sort()).toEqual(['0001_init', '0002_more']);
			const r = await getDb().execute(
				sql`SELECT count(*) AS n FROM module_migration WHERE module_id = 'pgmig'`
			);
			expect(Number((r.rows[0] as Row).n)).toBe(2);
		} finally {
			unregisterModule('pgmig');
		}
	});

	it('Core-Migrationssperre (withMigrationLock): zweiter Start wartet, bis der erste fertig ist', async (ctx) => {
		// Session-Sperre auf eigener Verbindung – mit PGlite(-Socket) teilen sich alle eine Sitzung
		if (!realPg) ctx.skip();
		const url = env().DATABASE_URL;
		let releaseA!: () => void;
		const holdA = new Promise<void>((r) => (releaseA = r));
		let enteredA!: () => void;
		const aInside = new Promise<void>((r) => (enteredA = r));
		let bEntered = false;
		const a = withMigrationLock(url, async () => {
			enteredA();
			await holdA;
		});
		await aInside;
		const b = withMigrationLock(url, async () => {
			bEntered = true;
		});
		// B steht nachweislich in der Warteschlange der Advisory-Sperre
		await vi.waitFor(
			async () => {
				const r = await getDb().execute(
					sql`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
				);
				expect(Number((r.rows[0] as Row).n)).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 5000, interval: 50 }
		);
		expect(bEntered).toBe(false);
		releaseA();
		await Promise.all([a, b]);
		expect(bEntered).toBe(true);
	});

	it('Job-Claim: fünf parallele runDueJobs() → der Job läuft genau einmal', async () => {
		jobRuns = 0;
		const ran = await Promise.all(Array.from({ length: 5 }, () => runDueJobs()));
		expect(jobRuns).toBe(1);
		expect(ran.flat().filter((k) => k === 'pgjob.tick')).toHaveLength(1);
	});
});
