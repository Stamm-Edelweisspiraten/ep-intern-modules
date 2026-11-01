/**
 * Datensicherung: Modul-Hooks `backup.rehash` (treasury, files) berechnen schlüsselgebundene Hashes aus den
 * verschlüsselten Quellspalten neu (wie nach dem Wiederherstellen auf einem Server mit anderem APP_SECRET).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { decryptSecret, keyedHash } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import type { ModuleBackupHooks, ModuleBackupRehashHelpers } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import filesModule from '$modules/files/module';
import { treasuryBackup } from '$modules/treasury/backup';
import { filesBackup } from '$modules/files/backup';
import type { ShareLink } from '$modules/files/schemas';

const IBAN = 'DE89 3704 0044 0532 0130 00';
const IBAN_N = 'DE89370400440532013000';
const IBAN_2 = 'DE02120300000000202051';
const OLD_TOKEN = 'A'.repeat(43);

let close: () => Promise<void>;
let key = '';

async function api(path: string, method = 'GET', json?: unknown, token: string | null = key) {
	resetAllForTests();
	const headers = new Headers();
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	return { status: res.status, body };
}

async function data<T>(p: Promise<{ status: number; body: { data?: unknown } }>, status = 200) {
	const r = await p;
	expect(r.status, JSON.stringify(r.body)).toBe(status);
	return r.body.data as T;
}

const q = async (query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as Record<string, unknown>[];

const helpersFor = (id: string): ModuleBackupRehashHelpers => ({
	hash: (v) => keyedHash(v, `module:${id}`),
	decrypt: (v) => decryptSecret(v, `module:${id}`)
});

function run(id: string, hooks: ModuleBackupHooks) {
	return core.database.forModule(id).transaction((tx) => hooks.rehash!(tx, helpersFor(id)));
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	registerModule(filesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	let admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'treasury', 'files']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	key = (await createApiKey(admin, { name: 't', scopes: [...admin.permissions] })).key;
});

afterAll(async () => {
	await close();
});

describe('treasury.backup.rehash', () => {
	let payerId = '';
	let txId = '';
	let orphanId = '';

	beforeAll(async () => {
		payerId = (
			await data<{ id: string }>(
				api('/modules/treasury/payers', 'POST', { name: 'Familie Müller', iban: IBAN }),
				201
			)
		).id;
		const account = await data<{ id: string }>(
			api('/modules/treasury/accounts', 'POST', {
				name: 'Girokonto',
				kind: 'giro',
				openingDate: '2026-01-01'
			}),
			201
		);
		const created = await data<{ transaction?: { id: string }; id?: string }>(
			api('/modules/treasury/transactions', 'POST', {
				accountId: account.id,
				bookedOn: '2026-02-01',
				amountCents: 1500,
				counterparty: 'Fremde Person',
				counterpartyIban: IBAN_2
			}),
			201
		);
		txId = created.transaction?.id ?? created.id ?? '';
		expect(txId).not.toBe('');
		// Zahler mit Hash, aber ohne verschlüsselte Quelle (nicht wiederherstellbar)
		orphanId = crypto.randomUUID();
		await q(
			sql`INSERT INTO mod_treasury.payers (id, name, iban_last4, iban_hash)
				VALUES (${orphanId}, 'Ohne Quelle', '9999', 'alter-hash')`
		);
	});

	it('Hashes stimmen nach dem Anlegen mit dem Modulschlüssel überein', async () => {
		const [p] = await q(sql`SELECT iban_hash FROM mod_treasury.payers WHERE id = ${payerId}`);
		expect(p!.iban_hash).toBe(core.crypto.forModule('treasury').hash(IBAN_N));
	});

	it('verfälschte Hashes werden neu berechnet, ohne Quelle → unrecoverable + NULL', async () => {
		await q(sql`UPDATE mod_treasury.payers SET iban_hash = 'falsch' WHERE id = ${payerId}`);
		await q(
			sql`UPDATE mod_treasury.transactions SET counterparty_iban_hash = 'falsch' WHERE id = ${txId}`
		);
		const r = await run('treasury', treasuryBackup);
		expect(r).toEqual({ updated: 2, unrecoverable: 1 });

		const [p] = await q(sql`SELECT iban_hash FROM mod_treasury.payers WHERE id = ${payerId}`);
		expect(p!.iban_hash).toBe(keyedHash(IBAN_N, 'module:treasury'));
		const [t] = await q(
			sql`SELECT counterparty_iban_hash FROM mod_treasury.transactions WHERE id = ${txId}`
		);
		expect(t!.counterparty_iban_hash).toBe(keyedHash(IBAN_2, 'module:treasury'));
		const [o] = await q(
			sql`SELECT iban_hash, iban_last4 FROM mod_treasury.payers WHERE id = ${orphanId}`
		);
		expect(o).toEqual({ iban_hash: null, iban_last4: '9999' });

		// IBAN-Abgleich wie im Import (`payerByIbanHash`) findet den Zahler wieder
		const found = await q(
			sql`SELECT id FROM mod_treasury.payers
				WHERE iban_hash = ${core.crypto.forModule('treasury').hash(IBAN_N)}`
		);
		expect(found.map((x) => x.id)).toEqual([payerId]);
	});

	it('zweiter Lauf ändert nichts (idempotent)', async () => {
		expect(await run('treasury', treasuryBackup)).toEqual({ updated: 0, unrecoverable: 0 });
	});
});

describe('files.backup.rehash', () => {
	let token = '';
	let linkId = '';
	let oldLinkId = '';

	beforeAll(async () => {
		const folder = await data<{ id: string }>(
			api('/modules/files/folders', 'POST', { parentId: null, name: 'Fotos' }),
			201
		);
		const link = await data<ShareLink>(
			api(`/modules/files/nodes/${folder.id}/links`, 'POST', { expiresOn: null, password: null }),
			201
		);
		linkId = link.id;
		token = String(link.url).split('/').pop()!;
		// alter Link ohne `token_enc` (vor Migration 0003)
		oldLinkId = crypto.randomUUID();
		await q(
			sql`INSERT INTO mod_files.share_links (id, node_id, token_hash, mode)
				VALUES (${oldLinkId}, ${folder.id}, ${keyedHash(OLD_TOKEN, 'module:files')}, 'view')`
		);
	});

	it('Link funktioniert vorher, nach Verfälschen nicht mehr', async () => {
		expect((await api(`/modules/files/public/links/${token}`, 'GET', undefined, null)).status).toBe(
			200
		);
		expect(
			(await api(`/modules/files/public/links/${OLD_TOKEN}`, 'GET', undefined, null)).status
		).toBe(200);
		await q(sql`UPDATE mod_files.share_links SET token_hash = 'falsch' WHERE id = ${linkId}`);
		expect((await api(`/modules/files/public/links/${token}`, 'GET', undefined, null)).status).toBe(
			404
		);
	});

	it('Hash aus token_enc neu, Link ohne Quelle widerrufen', async () => {
		expect(await run('files', filesBackup)).toEqual({ updated: 1, unrecoverable: 1 });
		expect((await api(`/modules/files/public/links/${token}`, 'GET', undefined, null)).status).toBe(
			200
		);
		const [old] = await q(
			sql`SELECT revoked_at IS NOT NULL AS revoked FROM mod_files.share_links WHERE id = ${oldLinkId}`
		);
		expect(old!.revoked).toBe(true);
		expect(
			(await api(`/modules/files/public/links/${OLD_TOKEN}`, 'GET', undefined, null)).status
		).toBe(404);
	});

	it('zweiter Lauf ändert nichts (idempotent)', async () => {
		expect(await run('files', filesBackup)).toEqual({ updated: 0, unrecoverable: 0 });
	});
});
