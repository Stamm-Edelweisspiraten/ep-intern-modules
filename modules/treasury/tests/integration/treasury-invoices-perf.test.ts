/**
 * #12/#22: Kasse mit großem Bestand – 2 000 versendete Rechnungen.
 * - `GET /overview`, `GET /invoices` (mit und ohne Suche), `GET /payers`, `GET /actions` bleiben im Laufzeitbudget
 * - Listen laden nur die Seite (Kennzahlen, Summen und Zähler per SQL)
 * - Zahlersummen per SQL-Aggregat stimmen mit der Rechnung je Rechnung überein
 *
 * Budget: Abnahmekriterium in #12 ist < 500 ms auf echter Hardware (lokal gemessen 10–130 ms je Anfrage).
 * Im Test (PGlite im Speicher, CI-Runner geteilt, parallele Testdateien) gilt ein großzügiger Rahmen
 * (1,5 s), der einen Rückfall auf „ganzen Bestand laden“ (N+1 je Rechnung, Sekunden) trotzdem erkennt.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import type { InvoiceList, Overview, Payer } from '$modules/treasury/schemas';
import type { MembersService } from '$modules/members/contract';
import { moduleSql } from '$testing';

/** Laufzeitbudget je Anfrage in Millisekunden (siehe Kopfkommentar) */
const BUDGET_MS = 1500;
const INVOICES = 2000;
const MEMBERS = 20;
const PAYERS = 10;
const TODAY = '2026-06-01';

let close: () => Promise<void>;
let key = '';
const memberIds: string[] = [];

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
const T = (path: string) => api(`/modules/treasury${path}`);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

/** Misst eine Anfrage und prüft das Budget */
async function timed<R>(label: string, path: string): Promise<R> {
	const start = performance.now();
	const result = await data<R>(await T(path));
	const ms = performance.now() - start;
	expect(ms, `${label} dauerte ${Math.round(ms)} ms`).toBeLessThan(BUDGET_MS);
	return result;
}

// --- Erzeugung (gleiche Formeln in SQL und hier für die Erwartungswerte) --------
const amountOf = (g: number) => 1000 + (g % 10) * 100;
const isCancelled = (g: number) => g % 50 === 0;
const isPaid = (g: number) => g % 4 === 0;
/** Fälligkeit = 01.01.2026 + (g % 150) + 14 Tage; überfällig, wenn vor dem 01.06.2026 (Tag 151) */
const isOverdue = (g: number) => (g % 150) + 14 < 151;
const memberIndexOf = (g: number) => g % MEMBERS;

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
	let admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	setTodayForTests(TODAY);
	key = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	for (let i = 0; i < MEMBERS; i++) {
		const m = await data<{ id: string }>(
			await api('/modules/members/members', {
				method: 'POST',
				json: {
					firstName: `Jörg${i}`,
					lastName: 'Lasttest',
					birthDate: '2014-03-10',
					street: `Lindenweg ${i + 1}`,
					postalCode: '28195',
					city: 'Bremen',
					stage: 'woelfling',
					emails: [{ name: 'Eltern', value: `eltern${i}@example.test` }]
				}
			}),
			201
		);
		memberIds.push(m.id);
	}

	// Bestand per SQL (schnell): Zahler, 2 000 versendete Rechnungen mit je einem Posten, Zahlungen
	await moduleSql(
		'treasury',
		sql`INSERT INTO payers (id, name) SELECT 'perf-payer-' || k, 'Familie ' || k FROM generate_series(0, ${PAYERS - 1}) k`
	);
	for (let k = 0; k < PAYERS; k++) {
		await moduleSql(
			'treasury',
			sql`INSERT INTO payer_members (payer_id, member_id) VALUES (${`perf-payer-${k}`}, ${memberIds[k]!})`
		);
	}
	await moduleSql(
		'treasury',
		sql`INSERT INTO invoices (id, number, year, seq, source, recipient_name, issued_on, due_on, cancelled_at)
			SELECT 'perf-inv-' || g, 'R-2026-' || lpad(g::text, 4, '0'), 2026, g, 'manual', 'Empfänger ' || g,
				date '2026-01-01' + (g % 150), date '2026-01-01' + (g % 150) + 14,
				CASE WHEN g % 50 = 0 THEN now() ELSE NULL END
			FROM generate_series(1, ${INVOICES}) g`
	);
	for (let k = 0; k < MEMBERS; k++) {
		await moduleSql(
			'treasury',
			sql`INSERT INTO invoice_lines (id, invoice_id, position, description, amount_cents, member_id)
				SELECT 'perf-line-' || g, 'perf-inv-' || g, 0, 'Beitrag', 1000 + (g % 10) * 100, ${memberIds[k]!}
				FROM generate_series(1, ${INVOICES}) g WHERE g % ${MEMBERS} = ${k}`
		);
	}
	await moduleSql(
		'treasury',
		sql`INSERT INTO invoice_documents (id, invoice_id, version, reason, snapshot, sent_at, recipients)
			SELECT 'perf-doc-' || g, 'perf-inv-' || g, 1, 'manual', '{}'::jsonb, now(), 1
			FROM generate_series(1, ${INVOICES}) g`
	);
	await moduleSql(
		'treasury',
		sql`INSERT INTO accounts (id, name, kind, opening_date) VALUES ('perf-acc', 'Girokonto', 'giro', '2026-01-01')`
	);
	await moduleSql(
		'treasury',
		sql`INSERT INTO transactions (id, account_id, booked_on, amount_cents, purpose, category_id)
			SELECT 'perf-tx-' || g, 'perf-acc', date '2026-02-01', 1000 + (g % 10) * 100, 'Zahlung ' || g, 'cat-beitraege'
			FROM generate_series(1, ${INVOICES}) g WHERE g % 4 = 0`
	);
	await moduleSql(
		'treasury',
		sql`INSERT INTO allocations (id, transaction_id, line_id, amount_cents)
			SELECT 'perf-al-' || g, 'perf-tx-' || g, 'perf-line-' || g, 1000 + (g % 10) * 100
			FROM generate_series(1, ${INVOICES}) g WHERE g % 4 = 0`
	);
	// Aufwärmen (erste Abfragen planen/kompilieren), damit die Messung den Dauerbetrieb abbildet
	await T('/overview');
	await T('/invoices?limit=1');
});

afterAll(async () => {
	vi.restoreAllMocks();
	setTodayForTests(null);
	await close();
});

describe('Kasse mit 2 000 versendeten Rechnungen (#12/#22)', () => {
	const all = Array.from({ length: INVOICES }, (_, i) => i + 1);
	const openOf = (g: number) => (isCancelled(g) || isPaid(g) ? 0 : amountOf(g));

	it('GET /overview im Budget, Summen aus SQL', async () => {
		const ov = await timed<Overview>('GET /overview', '/overview');
		expect(ov.openCents).toBe(all.reduce((s, g) => s + openOf(g), 0));
		expect(ov.overdueCount).toBe(all.filter((g) => openOf(g) > 0 && isOverdue(g)).length);
		expect(ov.creditCents).toBe(
			all.filter((g) => isCancelled(g) && isPaid(g)).reduce((s, g) => s + amountOf(g), 0)
		);
	});

	it('GET /invoices lädt nur die Seite, Zähler und Summen über den ganzen Bestand', async () => {
		const forModule = vi.spyOn(core.database, 'forModule');
		const list = await timed<InvoiceList>('GET /invoices', '/invoices?status=all&limit=50');
		expect(list.items).toHaveLength(50);
		expect(list.total).toBe(INVOICES);
		expect(list.totals.openCents).toBe(all.reduce((s, g) => s + openOf(g), 0));
		// Wenige Transaktionen unabhängig vom Bestand (Liste + Seite + Namen), kein Laden je Rechnung
		expect(forModule.mock.calls.length).toBeLessThan(15);
		vi.restoreAllMocks();

		const unpaid = await timed<InvoiceList>(
			'GET /invoices?status=unpaid',
			'/invoices?status=unpaid'
		);
		expect(unpaid.total).toBe(all.filter((g) => openOf(g) > 0).length);
	});

	it('GET /invoices mit Suche begrenzt Kandidaten in SQL (Mitgliedsname, Umlaute, Nummer)', async () => {
		const members = await core.modules.use<MembersService>('members', 'treasury');
		const contacts = vi.spyOn(members, 'listMemberContacts');
		const forModule = vi.spyOn(core.database, 'forModule');
		// Mitglied 3: Rechnungen g mit g % 20 = 3 → 100 Treffer; „Joerg3“ = „Jörg3“
		const byMember = await timed<InvoiceList>(
			'GET /invoices?search=Joerg3',
			'/invoices?status=all&search=Joerg3&limit=20'
		);
		expect(byMember.total).toBe(INVOICES / MEMBERS);
		expect(byMember.items).toHaveLength(20);
		expect(byMember.items.every((i) => i.people.some((p) => p === 'Jörg3 Lasttest'))).toBe(true);
		// Namen nur für die Seite bzw. die Namenssuche, nie für alle Rechnungen einzeln
		expect(contacts.mock.calls.length).toBeLessThanOrEqual(4);
		expect(forModule.mock.calls.length).toBeLessThan(15);
		vi.restoreAllMocks();

		const byNumber = await timed<InvoiceList>(
			'GET /invoices?search=R-2026-0042',
			'/invoices?status=all&search=R-2026-0042'
		);
		expect(byNumber.items.map((i) => i.number)).toEqual(['R-2026-0042']);

		const byRecipient = await timed<InvoiceList>(
			'GET /invoices?search=empfaenger 1999',
			`/invoices?status=all&search=${encodeURIComponent('empfaenger 1999')}`
		);
		expect(byRecipient.items.map((i) => i.number)).toEqual(['R-2026-1999']);
	});

	it('GET /payers: Summen per Aggregat, Mitglieder gestückelt', async () => {
		const payers = await timed<Payer[]>('GET /payers', '/payers');
		expect(payers).toHaveLength(PAYERS);
		for (let k = 0; k < PAYERS; k++) {
			const p = payers.find((x) => x.id === `perf-payer-${k}`)!;
			const own = all.filter((g) => memberIndexOf(g) === k);
			expect(p.members.map((m) => m.id)).toEqual([memberIds[k]]);
			expect(p.openCents).toBe(own.reduce((s, g) => s + openOf(g), 0));
			expect(p.overdueCents).toBe(
				own.filter((g) => isOverdue(g)).reduce((s, g) => s + openOf(g), 0)
			);
			expect(p.creditCents).toBe(
				own.filter((g) => isCancelled(g) && isPaid(g)).reduce((s, g) => s + amountOf(g), 0)
			);
		}
	});

	it('GET /open-items und GET /actions im Budget', async () => {
		await timed('GET /open-items', '/open-items');
		await timed('GET /actions', '/actions');
	});
});
