import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { installFakeStorage, fakeObjects, uninstallFakeStorage } from '$testing';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$lib/sdk/server';
import { eq, sql } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { buildArchive, parseArchive, type ArchiveDocument } from '$modules/actions/action-archive';
import type { RequestContext } from '$lib/sdk/types';

const BASE = '/modules/actions';
const IBAN = 'DE89 3704 0044 0532 0130 00';
const IBAN_PLAIN = 'DE89370400440532013000';
const PDF = strToU8('%PDF-1.4\n% Testbeleg für den Export\n');

let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
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

const as = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status?: number): Promise<T> {
	const body = await res.json();
	if (status) expect(res.status, JSON.stringify(body)).toBe(status);
	else expect([200, 201], JSON.stringify(body)).toContain(res.status);
	return body.data as T;
}

const STORAGE = ['actions.storage.read', 'actions.storage.write', 'actions.storage.delete'];
const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	full: [...BASE_PERMS, 'actions.action.create', 'actions.payout.view', ...STORAGE],
	lite: [...BASE_PERMS, 'actions.action.create'],
	nostore: [...BASE_PERMS, 'actions.action.create', 'actions.payout.view']
};
const USERS: [string, string][] = [
	['owner', 'full'],
	['importer', 'full'],
	['lite', 'lite'],
	['nostore', 'nostore'],
	['stranger', 'full']
];

const ctxOf = async (userId: string) => {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
};

const mdb = () => core.database.forModule('actions');

async function dbRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
	return mdb().transaction(async (tx) => {
		const res = (await tx.execute(query)) as unknown as { rows: Record<string, unknown>[] };
		return res.rows;
	});
}

// --- Testdaten ---------------------------------------------------------------

interface Built {
	id: string;
	foodEntryId: string;
	payeeId: string;
}

async function buildFullAction(opts: { refund?: boolean; close?: boolean } = {}): Promise<Built> {
	const a = await data<{ id: string }>(
		await as('owner', '/actions', {
			method: 'POST',
			json: {
				name: 'Sommerlager Süd',
				description: 'Zwei Wochen im Wald',
				location: 'Wald',
				startsOn: '2026-07-10',
				startsTime: '10:00',
				endsOn: '2026-07-12',
				endsTime: '16:00'
			}
		}),
		201
	);
	const id = a.id;
	const put = (path: string, json: unknown) =>
		as('owner', `/actions/${id}${path}`, { method: 'PUT', json });
	const post = (path: string, json?: unknown) =>
		as('owner', `/actions/${id}${path}`, { method: 'POST', json: json ?? {} });

	// Teilnehmende
	for (const p of [
		{
			name: 'Paula Pfad',
			groupLabel: 'Wölflinge',
			birthDate: '2015-04-02',
			bremenResident: true,
			role: 'participant',
			juleica: false,
			subsidyEligible: true,
			diet: 'vegan',
			allergies: 'Nüsse',
			notes: 'Schwimmerin'
		},
		{
			name: 'Tom Teamer',
			groupLabel: null,
			birthDate: '2005-01-01',
			bremenResident: false,
			role: 'team',
			juleica: true,
			diet: 'meat',
			allergies: null,
			notes: null
		}
	]) {
		await data(await post('/participants', p), 201);
	}

	// Kalkulation + Beitrag
	await data(
		await put('/calculation', {
			participants: 1,
			team: 1,
			teamPercent: 0,
			nights: 2,
			bufferPercent: 0,
			includeSubsidy: true,
			lodgingType: 'external',
			konfi: false,
			freizeitType: 'kids',
			bremenChildren: 1,
			bremenYouth: 0,
			teamWithJuleica: 1,
			teamWithoutJuleica: 0,
			teamYouth: 0,
			checklist: { training_hhh: true, training_basic: false },
			items: [
				{ id: 'a', category: 'food', label: 'Essen', amountCents: 10000, basis: 'flat' },
				{ id: 'b', category: 'lodging', label: 'Haus', amountCents: 500, basis: 'per_person_night' }
			]
		})
	);
	await data(await post('/calculation/apply'));

	// Anmeldeformular
	const cfg = await data<{ definition: unknown }>(await as('owner', `/actions/${id}/form`));
	await data(
		await put('/form', {
			enabled: true,
			opensAt: '2026-05-01T08:00:00.000Z',
			closesAt: '2026-06-30T20:00:00.000Z',
			maxParticipants: 25,
			intro: 'Willkommen',
			disclaimerTemplate: 'Ich melde mich an: {{aktion}}',
			privacyUrl: 'https://example.org/datenschutz',
			definition: cfg.definition
		})
	);

	// Empfänger und Buchungen
	const payee = await data<{ id: string }>(
		await post('/accounting/payees', {
			name: 'Anna Auslage',
			iban: IBAN,
			bic: 'COBADEFFXXX',
			note: 'Konto der Mutter'
		}),
		201
	);
	const entry = async (body: Record<string, unknown>) =>
		(await data<{ id: string }>(await post('/accounting/entries', body), 201)).id;
	const foodEntryId = await entry({
		type: 'expense',
		category: 'food',
		description: 'Einkauf Supermarkt',
		amountCents: 1250,
		entryDate: '2026-07-11',
		paidBy: 'club',
		payeeId: null
	});
	const personEntryId = await entry({
		type: 'expense',
		category: 'materials',
		description: 'Bastelmaterial',
		amountCents: 3000,
		entryDate: '2026-07-09',
		paidBy: 'person',
		payeeId: payee.id
	});
	await entry({
		type: 'income',
		category: 'contributions',
		description: 'Beiträge bar',
		amountCents: 50000,
		entryDate: '2026-07-01',
		paidBy: 'club',
		payeeId: null
	});

	// Beleg
	const fd = new FormData();
	fd.set(
		'file',
		new File([new Uint8Array(PDF)], 'Rechnung Müller.pdf', { type: 'application/pdf' })
	);
	await data(
		await as('owner', `/actions/${id}/accounting/entries/${foodEntryId}/receipt`, {
			method: 'POST',
			body: fd
		}),
		201
	);
	// Auszahlung markieren
	await data(
		await as('owner', `/actions/${id}/accounting/payees/${payee.id}/reimburse`, { method: 'POST' })
	);
	void personEntryId;

	if (opts.refund) {
		await data(await post('/accounting/refund', {}), 201);
	}
	if (opts.close) {
		await data(await post('/accounting/close', { acceptMissingReceipts: true }), 201);
	}
	return { id, foodEntryId, payeeId: payee.id };
}

async function exportZip(who: string, id: string): Promise<{ res: Response; bytes: Uint8Array }> {
	const res = await as(who, `/actions/${id}/export`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	return { res, bytes };
}

function zipFormData(bytes: Uint8Array, type = 'application/zip', name = 'export.zip') {
	const fd = new FormData();
	fd.set('file', new File([new Uint8Array(bytes)], name, { type }));
	return fd;
}

const importZip = (who: string, bytes: Uint8Array, type?: string) =>
	as(who, '/actions/import', { method: 'POST', body: zipFormData(bytes, type) });

interface ImportData {
	id: string;
	name: string;
	counts: Record<string, number>;
	warnings: string[];
}

let full: Built;
let fullBytes: Uint8Array;

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);

	const roleIds: Record<string, string> = {};
	for (const [name, perms] of Object.entries(ROLES)) {
		roleIds[name] = await createRole(admin, { name: `role-${name}`, permissions: perms });
	}
	for (const [name, role] of USERS) {
		userIds[name] = await createUser(admin, {
			name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: [...ROLES[role]!] })).key;
	}
	full = await buildFullAction({ refund: true, close: true });
	fullBytes = (await exportZip('owner', full.id)).bytes;
});

afterAll(() => uninstallFakeStorage());

describe('Export', () => {
	it('liefert ZIP mit Header, Manifest, Klartext-IBAN und Beleg', async () => {
		const { res, bytes } = await exportZip('owner', full.id);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('content-disposition')).toMatch(
			/^attachment; filename="aktion-sommerlager-sued-\d{4}-\d{2}-\d{2}\.zip"$/
		);
		const p = parseArchive(bytes);
		expect(p.manifest.contents).toEqual({
			participants: 2,
			entries: 4,
			receipts: 1,
			payees: 1,
			includesBank: true,
			// ohne `members.data.export` keine Gesundheitsdaten
			includesHealth: false
		});
		expect(p.document.payees[0]!.iban).toBe(IBAN_PLAIN);
		expect(p.document.accounting.closed).toBe(true);
		expect(p.document.refund?.mode).toBe('auto');
		expect(p.document.form?.definition.fields.length).toBeGreaterThan(5);
		const raw = JSON.stringify(p.document);
		expect(raw).not.toContain(userIds.owner!);
		expect(raw).not.toContain('token');
		expect(p.document.calculation?.items).toHaveLength(2);
		expect(p.document.action.feeCents).not.toBeNull();
		const files = [...p.files.keys()].filter((k) => k.startsWith('receipts/'));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^receipts\/e\d+-Rechnung_Muller\.pdf$/);
		expect(p.files.get(files[0]!)).toEqual(PDF);
	});

	it('ohne payout.view/storage.read: keine IBAN, keine Belege, Hinweis im Manifest', async () => {
		const id = full.id;
		// Freigabe (read) für den schwach berechtigten Benutzer
		await data(
			await as('owner', `/actions/${id}/shares/${userIds.lite}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		const { res, bytes } = await exportZip('lite', id);
		expect(res.status).toBe(200);
		const p = parseArchive(bytes);
		expect(p.manifest.contents.includesBank).toBe(false);
		expect(p.manifest.receiptsOmitted).toBe(true);
		expect(p.manifest.contents.receipts).toBe(0);
		expect(p.document.payees[0]).not.toHaveProperty('iban');
		expect(JSON.stringify(p.document)).not.toContain(IBAN_PLAIN);
		expect(p.document.entries.every((e) => e.receipt === null)).toBe(true);
	});

	it('fremde Aktion -> 404, unbekannte ID -> 404', async () => {
		expect((await as('stranger', `/actions/${full.id}/export`)).status).toBe(404);
		expect((await as('owner', `/actions/${crypto.randomUUID()}/export`)).status).toBe(404);
	});
});

describe('Import und Round-Trip', () => {
	it('Export -> Import -> Export liefert gleiche action.json', async () => {
		const before = fakeObjects.size;
		const res = await importZip('importer', fullBytes);
		const imp = await data<ImportData>(res, 201);
		expect(imp.name).toBe('Sommerlager Süd');
		expect(imp.counts).toEqual({
			participants: 2,
			entries: 4,
			receipts: 1,
			payees: 1,
			formFields: expect.any(Number)
		});
		expect(imp.id).not.toBe(full.id);
		expect(fakeObjects.size).toBe(before + 1);

		const again = await exportZip('importer', imp.id);
		expect(again.res.status).toBe(200);
		const a = parseArchive(fullBytes);
		const b = parseArchive(again.bytes);
		expect(b.document).toEqual(a.document);
		expect([...b.files.keys()].sort()).toEqual([...a.files.keys()].sort());
		for (const [name, bytes] of a.files) {
			if (name === 'manifest.json') continue; // enthält exportedAt
			expect(b.files.get(name)).toEqual(bytes);
		}
	});

	it('neue IDs, neue Besitzerin, Formular deaktiviert mit neuem Token, geschlossen', async () => {
		const imp = await data<ImportData>(await importZip('importer', fullBytes), 201);
		const detail = await data<{ owner: { userId: string }; participantCount: number }>(
			await as('importer', `/actions/${imp.id}`)
		);
		expect(detail.owner.userId).toBe(userIds.importer);
		expect(detail.participantCount).toBe(2);
		// Original unberührt und für Importierende nicht sichtbar
		expect((await as('importer', `/actions/${full.id}`)).status).toBe(404);

		const oldForm = await dbRows(
			sql`SELECT token_hash FROM action_forms WHERE action_id = ${full.id}`
		);
		const newForm = await dbRows(
			sql`SELECT token, token_hash, enabled FROM action_forms WHERE action_id = ${imp.id}`
		);
		expect(newForm[0]!.enabled).toBe(false);
		// Token nur als Hash gespeichert (#67, 01b-14), neuer Link beim Import
		expect(newForm[0]!.token).toBeNull();
		expect(newForm[0]!.token_hash).toBeTruthy();
		expect(newForm[0]!.token_hash).not.toBe(oldForm[0]!.token_hash);

		const ids = await dbRows(
			sql`SELECT (SELECT count(*)::int FROM action_participants WHERE id IN
					(SELECT id FROM action_participants WHERE action_id = ${full.id})
					AND action_id = ${imp.id}) AS shared`
		);
		expect(ids[0]!.shared).toBe(0);

		const acc = await data<{ closed: unknown; entries: unknown[] }>(
			await as('importer', `/actions/${imp.id}/accounting`)
		);
		expect(acc.closed).not.toBeNull();
		const entry = (acc.entries as { id: string; category: string }[]).find(
			(e) => e.category === 'food'
		)!;
		const upd = await as('importer', `/actions/${imp.id}/accounting/entries/${entry.id}`, {
			method: 'PUT',
			json: {
				type: 'expense',
				category: 'food',
				description: 'x',
				amountCents: 100,
				entryDate: '2026-07-11',
				paidBy: 'club',
				payeeId: null
			}
		});
		expect(upd.status).toBe(409);

		// Rückzahlung konsistent: Snapshot zeigt auf die neue Buchung und neue Teilnehmenden-IDs
		const snap = await dbRows(
			sql`SELECT b.entry_id, e.category FROM action_refund_booking b
				JOIN accounting_entries e ON e.id = b.entry_id WHERE b.action_id = ${imp.id}`
		);
		expect(snap[0]!.category).toBe('refund');
		const refunds = await dbRows(
			sql`SELECT r.participant_id FROM accounting_refunds r WHERE r.action_id = ${imp.id}`
		);
		expect(refunds.length).toBeGreaterThan(0);
		for (const r of refunds) {
			const own = await dbRows(
				sql`SELECT 1 FROM action_participants WHERE id = ${String(r.participant_id)} AND action_id = ${imp.id}`
			);
			expect(own).toHaveLength(1);
		}
	});

	it('doppelter Import erzeugt zwei getrennte Aktionen', async () => {
		const one = await data<ImportData>(await importZip('stranger', fullBytes), 201);
		const two = await data<ImportData>(await importZip('stranger', fullBytes), 201);
		expect(one.id).not.toBe(two.id);
		const list = await data<{ items: { id: string }[]; total: number }>(
			await as('stranger', '/actions')
		);
		expect(list.items.map((i) => i.id).sort()).toEqual([one.id, two.id].sort());
	});

	it('Import ohne storage.write mit Belegen -> 403, ohne Belege -> 201 (ohne IBAN ohne payout.view)', async () => {
		const before = fakeObjects.size;
		expect((await importZip('nostore', fullBytes)).status).toBe(403);
		expect(fakeObjects.size).toBe(before);

		const { bytes: liteBytes } = await exportZip('lite', full.id);
		const imp = await data<ImportData>(await importZip('lite', liteBytes), 201);
		expect(imp.counts.receipts).toBe(0);
		expect(imp.warnings.join(' ')).toContain('ohne Belege');

		// Archiv mit IBAN, Importeur ohne payout.view: IBAN wird verworfen
		const parsed = parseArchive(fullBytes);
		const noReceipts = buildArchive({
			manifest: parsed.manifest,
			document: {
				...parsed.document,
				entries: parsed.document.entries.map((e) => ({ ...e, receipt: null }))
			},
			receipts: new Map()
		});
		const lite2 = await data<ImportData>(await importZip('lite', noReceipts), 201);
		expect(lite2.warnings.join(' ')).toContain('IBAN');
		const rows = await dbRows(
			sql`SELECT iban_enc FROM accounting_payees WHERE action_id = ${lite2.id}`
		);
		expect(rows[0]!.iban_enc).toBeNull();
	});

	it('IBAN wird verschlüsselt abgelegt, ungültige IBAN gibt Warnung', async () => {
		const imp = await data<ImportData>(await importZip('importer', fullBytes), 201);
		const [row] = await dbRows(
			sql`SELECT iban_enc, iban_last4 FROM accounting_payees WHERE action_id = ${imp.id}`
		);
		expect(String(row!.iban_enc)).not.toContain('3704');
		expect(row!.iban_last4).toBe('013000');

		const parsed = parseArchive(fullBytes);
		const bad = buildArchive({
			manifest: parsed.manifest,
			document: {
				...parsed.document,
				payees: parsed.document.payees.map((p) => ({ ...p, iban: 'DE00 1234' }))
			},
			receipts: new Map([...parsed.files].filter(([k]) => k.startsWith('receipts/')))
		});
		const res = await data<ImportData>(await importZip('importer', bad), 201);
		expect(res.warnings.join(' ')).toContain('ungültig');
		const [r2] = await dbRows(
			sql`SELECT iban_enc FROM accounting_payees WHERE action_id = ${res.id}`
		);
		expect(r2!.iban_enc).toBeNull();
	});

	it('Audit ohne personenbezogene Daten', async () => {
		const rows = (await listAudit({ limit: 500 })).rows.filter(
			(e) => e.action === 'actions.action.exported' || e.action === 'actions.action.imported'
		);
		expect(rows.some((e) => e.action === 'actions.action.exported')).toBe(true);
		expect(rows.some((e) => e.action === 'actions.action.imported')).toBe(true);
		const text = JSON.stringify(rows);
		for (const secret of [IBAN_PLAIN, 'Paula', 'Anna Auslage', 'Nüsse']) {
			expect(text).not.toContain(secret);
		}
		const exp = rows.find((e) => e.action === 'actions.action.exported')!;
		expect(JSON.stringify(exp)).toContain('withBank');
	});
});

describe('Ungültige Archive', () => {
	it('kaputtes ZIP, Klartext, leere Datei -> 422', async () => {
		expect((await importZip('importer', strToU8('das ist kein zip, wirklich nicht'))).status).toBe(
			422
		);
		const truncated = fullBytes.slice(0, Math.floor(fullBytes.length / 2));
		const res = await importZip('importer', truncated);
		expect(res.status).toBe(422);
		expect((await res.json()).error.code).toBe('validation_failed');
		expect((await importZip('importer', new Uint8Array())).status).toBe(422);
	});

	it('falscher Content-Type -> 422, Feld fehlt -> 422 (einheitliche Upload-Regel, #33)', async () => {
		expect((await importZip('importer', fullBytes, 'text/plain')).status).toBe(422);
		const fd = new FormData();
		fd.set('other', 'x');
		expect((await as('importer', '/actions/import', { method: 'POST', body: fd })).status).toBe(
			422
		);
	});

	it('Zip-Slip-Eintrag -> 422', async () => {
		const parsed = parseArchive(fullBytes);
		const files: Record<string, Uint8Array> = {
			'manifest.json': strToU8(JSON.stringify(parsed.manifest)),
			'action.json': strToU8(JSON.stringify(parsed.document)),
			'../../evil.pdf': PDF
		};
		const res = await importZip('importer', zipSync(files));
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(JSON.stringify(body)).toMatch(/Pfad|Datei/);
	});

	it('Version, Schema, Referenzen und Dateityp -> 422', async () => {
		const parsed = parseArchive(fullBytes);
		const mk = (
			document: unknown,
			manifest: unknown = parsed.manifest,
			extra: Record<string, Uint8Array> = {}
		) =>
			zipSync({
				'manifest.json': strToU8(JSON.stringify(manifest)),
				'action.json': strToU8(JSON.stringify(document)),
				...extra
			});
		const doc = parsed.document;
		const receiptFile = [...parsed.files.keys()].find((k) => k.startsWith('receipts/'))!;
		const receipts = { [receiptFile]: PDF };

		expect(
			(await importZip('importer', mk(doc, { ...parsed.manifest, formatVersion: 9 }, receipts)))
				.status
		).toBe(422);
		expect(
			(await importZip('importer', mk({ ...doc, owner: 'x' }, parsed.manifest, receipts))).status
		).toBe(422);
		const badRef = {
			...doc,
			entries: doc.entries.map((e, i) =>
				i === 0 ? { ...e, paidBy: 'person', payeeRef: 'y99' } : e
			)
		};
		expect((await importZip('importer', mk(badRef, parsed.manifest, receipts))).status).toBe(422);
		const badAmount: ArchiveDocument = {
			...doc,
			entries: doc.entries.map((e, i) => (i === 0 ? { ...e, amountCents: -5 } : e))
		};
		expect((await importZip('importer', mk(badAmount, parsed.manifest, receipts))).status).toBe(
			422
		);
		// Beleg mit falschem Inhalt (kein PDF/Bild)
		const notPdf = { [receiptFile]: strToU8('MZ ausführbare Datei') };
		expect((await importZip('importer', mk(doc, parsed.manifest, notPdf))).status).toBe(422);
		// fehlende Belegdatei
		expect((await importZip('importer', mk(doc, parsed.manifest))).status).toBe(422);
	});
});
