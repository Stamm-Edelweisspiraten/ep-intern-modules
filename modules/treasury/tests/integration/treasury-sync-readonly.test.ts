/**
 * Kasse: Lesepfade ohne Seiteneffekte, gezielter Abgleich je Aktion, gesammelte Kontakte (#12),
 * Anmeldung während eines laufenden Abgleichs (#58) und Mahnlauf ohne doppelte Erinnerungen (#57).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setMailTransportForTests } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import { refreshSentDocuments } from '$modules/treasury/documents';
import { runReminderJob } from '$modules/treasury/notify';
import { syncAll } from '$modules/treasury/sync';
import { STANDARD_FORM_KEYS, type FormConfig } from '$modules/actions/schemas';
import type { ActionsService } from '$modules/actions/contract';
import type { MembersService } from '$modules/members/contract';
import type { RequestContext } from '$lib/sdk/types';
import type { InvoiceDetail, InvoiceList } from '$modules/treasury/schemas';

let admin: RequestContext;
let close: () => Promise<void>;
let key = '';
type Mail = { to: string; subject: string; text: string; attachments?: { filename: string }[] };
const mails: Mail[] = [];
let failMail = false;

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
function publicApi(path: string, json: unknown) {
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			body: JSON.stringify(json),
			headers: { 'content-type': 'application/json' }
		}),
		url,
		ip: '127.0.0.9'
	});
}
const T = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/treasury${path}`, init);
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, init);

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

type Row = Record<string, unknown>;
const tq = async (q: ReturnType<typeof sql>) =>
	(
		(await core.database.forModule('treasury').transaction((tx) => tx.execute(q))) as unknown as {
			rows: Row[];
		}
	).rows;
const aq = async (q: ReturnType<typeof sql>) =>
	(
		(await core.database.forModule('actions').transaction((tx) => tx.execute(q))) as unknown as {
			rows: Row[];
		}
	).rows;

const membersSvc = membersModule.provides as unknown as MembersService;
const actionsSvc = actionsModule.provides as unknown as ActionsService;

async function newAction(name: string, fee = 18500): Promise<string> {
	const id = (
		await data<{ id: string }>(
			await A('/actions', {
				method: 'POST',
				json: { name, startsOn: '2026-07-20', endsOn: '2026-07-26' }
			}),
			201
		)
	).id;
	await aq(
		sql`UPDATE actions SET fee_cents = ${fee}, team_fee_cents = 9000, fee_applied_at = now() WHERE id = ${id}`
	);
	return id;
}

async function addParticipant(actionId: string, name: string, birthDate = '2015-03-12') {
	return data<{ id: string }>(
		await A(`/actions/${actionId}/participants`, {
			method: 'POST',
			json: { name, birthDate }
		}),
		201
	);
}

async function invoicesOf(search: string) {
	return (
		await data<InvoiceList>(await T(`/invoices?status=all&search=${encodeURIComponent(search)}`))
	).items;
}

async function enableForm(actionId: string): Promise<string> {
	const cfg = await data<FormConfig>(await A(`/actions/${actionId}/form`));
	await data(
		await A(`/actions/${actionId}/form`, {
			method: 'PUT',
			json: {
				enabled: true,
				opensAt: null,
				closesAt: null,
				maxParticipants: null,
				intro: null,
				disclaimerTemplate: cfg.disclaimerTemplate,
				privacyUrl: 'https://example.org/datenschutz',
				definition: cfg.definition
			}
		})
	);
	return (await data<FormConfig>(await A(`/actions/${actionId}/form`))).token!;
}

function registration(name: string, email: string, birthDate = '2016-05-04') {
	return {
		values: {
			[STANDARD_FORM_KEYS.name]: name,
			[STANDARD_FORM_KEYS.group]: 'Wölflinge',
			[STANDARD_FORM_KEYS.birthDate]: birthDate,
			[STANDARD_FORM_KEYS.bremenResident]: 'yes',
			[STANDARD_FORM_KEYS.diet]: 'vegetarian',
			[STANDARD_FORM_KEYS.allergies]: '',
			[STANDARD_FORM_KEYS.notes]: '',
			[STANDARD_FORM_KEYS.email]: email,
			[STANDARD_FORM_KEYS.privacy]: true,
			[STANDARD_FORM_KEYS.disclaimer]: true
		}
	};
}

/** Öffentliche Anmeldung inkl. Double-Opt-in (Bestätigungslink aus der Mail) */
async function registerPublic(formToken: string, body: unknown): Promise<void> {
	const before = mails.length;
	const res = await publicApi(`/modules/actions/public/forms/${formToken}/submit`, body);
	expect(res.status, await res.clone().text()).toBe(201);
	const optIn = mails.slice(before).find((m) => /anmeldung-bestaetigen\/[0-9a-f]{64}/.test(m.text));
	if (!optIn) return; // ohne Opt-in (ältere Abläufe): Anmeldung ist bereits angelegt
	const token = /anmeldung-bestaetigen\/([0-9a-f]{64})/.exec(optIn.text)![1]!;
	mails.splice(mails.indexOf(optIn), 1);
	const confirm = await publicApi(`/modules/actions/public/registrations/${token}/confirm`, {});
	expect(confirm.status, await confirm.clone().text()).toBe(201);
}

const memberIds: string[] = [];

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
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury']) await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	setMailTransportForTests({
		sendMail: async (m) => {
			// Benachrichtigungen (core.notifications, z. B. „Neue Anmeldung“) prüft notifications-modules.test.ts
			if (m.headers?.['X-Atrium'] === 'notification') return;
			if (failMail) throw new Error('SMTP nicht erreichbar');
			mails.push(m as Mail);
		}
	});
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));
	setTodayForTests('2026-06-01');

	const all = [...admin.permissions].filter((p) => /^(treasury|members|actions)\./.test(p));
	const role = await createRole(admin, { name: 'Kasse', permissions: ['core.api.manage', ...all] });
	const id = await createUser(admin, {
		name: 'Kasse',
		email: 'kasse@example.test',
		password: 'correct-horse-battery',
		roleIds: [role]
	});
	const ctx = await ctxOf(id);
	key = (await createApiKey(ctx, { name: 't', scopes: [...ctx.permissions] })).key;

	for (let i = 0; i < 10; i++) {
		const m = await data<{ id: string }>(
			await api('/modules/members/members', {
				method: 'POST',
				json: {
					firstName: `Kind${i}`,
					lastName: 'Beispiel',
					birthDate: `2014-0${(i % 9) + 1}-1${i % 9}`,
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
});

afterEach(() => {
	vi.restoreAllMocks();
	failMail = false;
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Lesende Endpunkte der Kasse (#12)', () => {
	it('schreiben nichts und verschicken keine Mails – auch wenn ein Abgleich etwas ändern würde', async () => {
		const actionId = await newAction('Lesetest');
		// Mitglied Kind0 (Name + Geburtsdatum) → Rechnung geht an dessen Adresse
		await addParticipant(actionId, 'Kind0 Beispiel', '2014-01-10');
		const [inv] = await invoicesOf('Lesetest');
		expect(inv, 'Rechnung entsteht sofort durch den gezielten Abgleich').toBeTruthy();
		await data(await T(`/invoices/${inv!.id}/send`, { method: 'POST' }), 201);

		// Beitrag direkt in der DB ändern (ohne Endpunkt von `actions` → kein gezielter Abgleich)
		await aq(sql`UPDATE actions SET fee_cents = 20000 WHERE id = ${actionId}`);
		const state = async () => ({
			invoices: await tq(
				sql`SELECT count(*)::int AS n, max(updated_at)::text AS t, sum(l.amount_cents)::int AS cents
				FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id`
			),
			docs: await tq(sql`SELECT count(*)::int AS n FROM invoice_documents`),
			payables: await tq(sql`SELECT count(*)::int AS n, max(updated_at)::text AS t FROM payables`),
			sync: await tq(sql`SELECT last_sync_at::text AS t FROM sync_state`)
		});
		const before = await state();
		const mailCount = mails.length;
		const reads = [
			'/overview',
			'/invoices',
			'/invoices?status=all',
			`/invoices/${inv!.id}`,
			'/open-items',
			'/payables',
			'/transactions',
			'/actions',
			'/open-lines',
			'/suggestions',
			`/family-account?memberId=${memberIds[0]}`
		];
		for (const path of reads) {
			const res = await T(path);
			expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
		}
		expect(mails.length).toBe(mailCount);
		expect(await state()).toEqual(before);
		expect((await invoicesOf('Lesetest'))[0]!.totalCents).toBe(18500);

		// „Jetzt abgleichen“ übernimmt die Änderung und verschickt die geänderte Rechnung
		const r = await data<{ updated: number; documents?: { mailsSent: number } }>(
			await T('/sync', { method: 'POST' }),
			201
		);
		expect(r.updated).toBe(1);
		expect(r.documents?.mailsSent).toBe(1);
		expect(mails.at(-1)!.subject).toContain('Geänderte Rechnung');
		const overview = await data<{ lastSyncAt: string | null }>(await T('/overview'));
		expect(overview.lastSyncAt).not.toBeNull();
	});
});

describe('Änderungen in Aktionen erscheinen ohne Job (#12)', () => {
	it('Teilnahme, Rollenwechsel und Löschen wirken sofort auf die Rechnung', async () => {
		const actionId = await newAction('Sofortlager');
		const p = await addParticipant(actionId, 'Sina Sofort');
		const [inv] = await invoicesOf('Sina');
		expect(inv).toMatchObject({ totalCents: 18500, status: 'open' });

		await data(
			await A(`/actions/${actionId}/participants/${p.id}`, {
				method: 'PUT',
				json: { name: 'Sina Sofort', birthDate: '2015-03-12', role: 'team' }
			})
		);
		expect((await invoicesOf('Sina'))[0]!.totalCents).toBe(9000);

		await data(await A(`/actions/${actionId}/participants/${p.id}`, { method: 'DELETE' }));
		expect((await invoicesOf('Sina'))[0]!.status).toBe('cancelled');

		// Audit des gezielten Abgleichs: Auslöser*in, Ziel = Aktion
		const entries = await getDb()
			.select()
			.from(schema.auditLog)
			.where(
				and(
					eq(schema.auditLog.action, 'treasury.sync.completed'),
					eq(schema.auditLog.target, actionId)
				)
			);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((e) => e.actorType === 'api_key' || e.actorType === 'user')).toBe(true);
	});
});

describe('Kontakte gesammelt laden (#12)', () => {
	it('50 versendete Rechnungen → ein Aufruf von listMemberContacts je Prüflauf', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 50; i++) {
			const inv = await data<InvoiceDetail>(
				await T('/invoices', {
					method: 'POST',
					json: {
						recipientName: `Familie ${i}`,
						recipientEmail: `familie${i}@example.test`,
						issuedOn: '2026-06-01',
						dueOn: '2026-06-30',
						lines: [{ description: `Posten ${i}`, amountCents: 1000, memberId: memberIds[i % 10] }]
					}
				}),
				201
			);
			ids.push(inv.id);
			resetAllForTests();
			await data(await T(`/invoices/${inv.id}/send`, { method: 'POST' }), 201);
		}
		const spy = vi.spyOn(membersSvc, 'listMemberContacts');
		const mailCount = mails.length;
		const r = await refreshSentDocuments(admin, ids);
		expect(r.mailsSent).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);

		// Inkrementeller Lauf: alle 50 als geändert markiert, inhaltlich gleich → 1 Aufruf, 0 Mails
		spy.mockClear();
		await tq(sql`UPDATE invoices SET updated_at = now() + interval '1 minute'`);
		await refreshSentDocuments(admin);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(mails.length).toBe(mailCount);

		// Vollabgleich: Anzahl der Aufrufe hängt nicht von der Zahl der Rechnungen ab
		spy.mockClear();
		await syncAll(admin);
		expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
		expect(mails.length).toBe(mailCount);
	});
});

describe('Öffentliche Anmeldung (#12, #58)', () => {
	it('gleicht nur die eigene Aktion ab; andere Aktionen bleiben unverändert', async () => {
		const own = await newAction('Eigene Fahrt');
		const other = await newAction('Andere Fahrt');
		// Teilnehmende der anderen Aktion direkt in der DB (ohne gezielten Abgleich)
		await aq(
			sql`INSERT INTO action_participants (id, action_id, name, role, birth_date)
			VALUES (${crypto.randomUUID()}, ${other}, 'Otto Anders', 'participant', '2015-02-02')`
		);
		const token = await enableForm(own);
		const spy = vi.spyOn(actionsSvc, 'listReceivableSources');
		mails.length = 0;
		resetAllForTests();
		await registerPublic(token, registration('Emil Eigen', 'emil.eltern@example.test'));
		expect(spy.mock.calls.length).toBeGreaterThan(0);
		for (const [q] of spy.mock.calls) expect(q?.actionIds).toEqual([own]);
		expect(await invoicesOf('Emil')).toHaveLength(1);
		expect(await invoicesOf('Otto')).toHaveLength(0);
		expect(mails[0]!.attachments?.some((a) => a.filename.startsWith('Rechnung-R-2026-'))).toBe(
			true
		);
	});

	it('Anmeldung während eines laufenden Vollabgleichs bekommt trotzdem die Rechnung', async () => {
		const actionId = await newAction('Andrang');
		const token = await enableForm(actionId);
		const original = actionsSvc.listReceivableSources.bind(actionsSvc);
		let read!: () => void;
		const readDone = new Promise<void>((r) => (read = r));
		vi.spyOn(actionsSvc, 'listReceivableSources').mockImplementation(async (q) => {
			const result = await original(q);
			if (!q?.actionIds) {
				// Vollabgleich hat seine Quellen VOR der Anmeldung gelesen und hängt noch
				read();
				// Bewusste Verzögerung (#75: begründete Ausnahme): simuliert einen langsamen Vollabgleich.
				// Die Anmeldung wartet in dieser Zeit auf ihn – ein Ereignis zum Freigeben gibt es nicht.
				await new Promise((r) => setTimeout(r, 300));
			}
			return result;
		});
		const running = syncAll(null);
		await readDone;
		mails.length = 0;
		resetAllForTests();
		await registerPublic(
			token,
			registration('Greta Gleichzeitig', 'greta.eltern@example.test', '2016-06-06')
		);
		await running;
		expect(mails).toHaveLength(1);
		expect(mails[0]!.attachments?.some((a) => a.filename.startsWith('Rechnung-R-2026-'))).toBe(
			true
		);
		expect(await invoicesOf('Greta')).toHaveLength(1);
		// Abgleich der öffentlichen Anmeldung läuft als System, nicht unter fremdem Kontext
		const entries = await getDb()
			.select()
			.from(schema.auditLog)
			.where(
				and(
					eq(schema.auditLog.action, 'treasury.sync.completed'),
					eq(schema.auditLog.target, actionId)
				)
			);
		expect(entries.length).toBe(1);
		expect(entries[0]!.actorType).toBe('system');
	});
});

describe('Mahnlauf ohne doppelte Erinnerungen (#57)', () => {
	async function overdueInvoice(email: string): Promise<string> {
		const inv = await data<InvoiceDetail>(
			await T('/invoices', {
				method: 'POST',
				json: {
					recipientName: 'Familie Mahnung',
					recipientEmail: email,
					issuedOn: '2026-06-01',
					dueOn: '2026-06-02',
					lines: [{ description: 'Beitrag', amountCents: 5000 }]
				}
			}),
			201
		);
		return inv.id;
	}
	const remindersOf = (id: string) =>
		tq(sql`SELECT level, status, manual FROM reminders WHERE invoice_id = ${id} ORDER BY level`);

	it('zwei parallele Läufe → je Rechnung und Stufe genau eine Mail und ein Eintrag', async () => {
		const id = await overdueInvoice('parallel@example.test');
		setTodayForTests('2026-06-20');
		try {
			mails.length = 0;
			const [a, b] = await Promise.all([runReminderJob(admin), runReminderJob(admin)]);
			expect(mails.filter((m) => m.to === 'parallel@example.test')).toHaveLength(1);
			expect(await remindersOf(id)).toEqual([{ level: 1, status: 'sent', manual: false }]);
			expect(a.invoices + b.invoices).toBeGreaterThanOrEqual(1);

			// Auch zwei gleichzeitige Klicks auf „Erinnerungen jetzt senden“
			resetAllForTests();
			const both = await Promise.all([
				T('/reminders/run', { method: 'POST' }),
				T('/reminders/run', { method: 'POST' })
			]);
			expect(both.map((r) => r.status)).toEqual([201, 201]);
			expect(mails.filter((m) => m.to === 'parallel@example.test')).toHaveLength(1);
			expect(await remindersOf(id)).toHaveLength(1);
		} finally {
			setTodayForTests('2026-06-01');
		}
	});

	it('SMTP nicht erreichbar → Fehler gezählt, keine Stufe vermerkt, nächster Lauf versucht es erneut', async () => {
		const id = await overdueInvoice('smtp@example.test');
		setTodayForTests('2026-06-20');
		try {
			failMail = true;
			const r = await runReminderJob(admin);
			expect(r.mailErrors).toBeGreaterThanOrEqual(1);
			expect(await remindersOf(id)).toEqual([]);
			failMail = false;
			mails.length = 0;
			await runReminderJob(admin);
			expect(mails.filter((m) => m.to === 'smtp@example.test')).toHaveLength(1);
			expect(await remindersOf(id)).toEqual([{ level: 1, status: 'sent', manual: false }]);
		} finally {
			failMail = false;
			setTodayForTests('2026-06-01');
		}
	});

	it('vorhandene Reservierung (Bestätigung fehlgeschlagen) wird nicht erneut verschickt', async () => {
		const id = await overdueInvoice('pending@example.test');
		await tq(
			sql`INSERT INTO reminders (id, invoice_id, level, sent_on, recipients, manual, status)
			VALUES (${crypto.randomUUID()}, ${id}, 1, '2026-06-20', 0, false, 'pending')`
		);
		setTodayForTests('2026-06-20');
		try {
			mails.length = 0;
			await runReminderJob(admin);
			expect(mails.filter((m) => m.to === 'pending@example.test')).toHaveLength(0);
		} finally {
			setTodayForTests('2026-06-01');
		}
	});
});

describe('Eindeutige Namen (#55)', () => {
	it('doppeltes Konto (Groß-/Kleinschreibung egal) → 409 mit eigenem Text', async () => {
		const account = { name: 'Doppelkonto', kind: 'giro', openingDate: '2026-01-01' };
		await data(await T('/accounts', { method: 'POST', json: account }), 201);
		const dup = await T('/accounts', { method: 'POST', json: { ...account, name: 'doppelkonto' } });
		const body = await dup.json();
		expect(dup.status).toBe(409);
		expect(body.error.message).toBe('Ein Konto mit diesem Namen existiert bereits');
	});
});

describe('Rechnungsliste in SQL (#22)', () => {
	it('lädt nur die Seite, Summen/Status/Suche wie bisher', async () => {
		const all = await data<InvoiceList>(await T('/invoices?status=all&limit=200'));
		expect(all.total).toBeGreaterThan(50);
		// Summen über alle Treffer, unabhängig von der Seite
		expect(all.totals.totalCents).toBe(all.items.reduce((s, i) => s + i.totalCents, 0));
		expect(all.totals.openCents).toBe(all.items.reduce((s, i) => s + i.openCents, 0));
		// Sortierung: Rechnungsdatum absteigend, dann Nummer absteigend
		const sorted = [...all.items].sort(
			(a, b) => b.issuedOn.localeCompare(a.issuedOn) || b.number.localeCompare(a.number)
		);
		expect(all.items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));

		const spy = vi.spyOn(membersSvc, 'listMemberContacts');
		const page = await data<InvoiceList>(await T('/invoices?status=all&limit=5&offset=5'));
		expect(page.items.map((i) => i.id)).toEqual(all.items.slice(5, 10).map((i) => i.id));
		expect(page.total).toBe(all.total);
		expect(page.totals).toEqual(all.totals);
		// Kontakte nur für die Mitglieder der Seite
		for (const [q] of spy.mock.calls) expect((q.ids ?? []).length).toBeLessThanOrEqual(5);

		for (const status of ['open', 'partial', 'paid', 'cancelled', 'unpaid', 'overdue'] as const) {
			const r = await data<InvoiceList>(await T(`/invoices?status=${status}&limit=200`));
			const expected = all.items.filter((i) =>
				status === 'unpaid'
					? i.status === 'open' || i.status === 'partial'
					: status === 'overdue'
						? i.overdue
						: i.status === status
			);
			expect(
				r.items.map((i) => i.id),
				status
			).toEqual(expected.map((i) => i.id));
		}

		// Suche über Mitgliedsnamen (Umlaute/Groß egal) und Nummer
		const byMember = await data<InvoiceList>(await T('/invoices?status=all&search=kind3'));
		expect(byMember.total).toBeGreaterThan(0);
		const number = all.items[0]!.number;
		const byNumber = await data<InvoiceList>(await T(`/invoices?status=all&search=${number}`));
		expect(byNumber.items.map((i) => i.number)).toContain(number);
	});
});
