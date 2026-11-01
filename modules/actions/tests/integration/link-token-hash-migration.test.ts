/**
 * #67 01b-14 + #73/#72: Upgrade-Tests mit Bestandsdaten für die Migrationen actions/0020, members/0014, offices/0005.
 * - Öffentliche Link-Tokens (Anmeldelink, Kosten-Link, Verknüpfungscode) liegen danach nur noch als `token_hash`
 *   + `token_enc` vor, Klartext `token` = NULL; bestehende Links funktionieren weiter.
 * - Neue CHECKs/Fremdschlüssel: Altbestand bereinigt, Constraints validiert, Roh-SQL mit ungültigen Werten abgewiesen.
 * - Backup-`rehash`-Hooks berechnen `token_hash` mit einem anderen Schlüssel neu.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { migrateModuleTo, moduleSql } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { resetAllForTests } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$testing';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import officesModule from '$modules/offices/module';
import { hashStoredLinkTokens } from '$modules/actions/link-tokens';
import type { RequestContext } from '$lib/sdk/types';
import type { Tx } from '$lib/sdk/server';

let close: () => Promise<void>;
let admin: RequestContext;

const actionId = '0a000000-0000-4000-8000-000000000001';
const badActionId = '0a000000-0000-4000-8000-000000000002';
const memberId = '0d000000-0000-4000-8000-000000000001';
const formToken = randomBytes(32).toString('hex');
const expenseToken = randomBytes(32).toString('hex');
const memberToken = randomBytes(16).toString('hex');

async function publicGet(moduleId: string, path: string): Promise<number> {
	resetAllForTests();
	const url = new URL(`http://localhost:5173/api/v1/modules/${moduleId}${path}`);
	const res = await handleApiRequest({ request: new Request(url), url, ip: '127.0.0.1' });
	return res.status;
}

const rejects = (moduleId: string, query: ReturnType<typeof sql>) =>
	expect(moduleSql(moduleId, query)).rejects.toThrow();

async function validated(schemaName: string, names: string[]) {
	const rows = (
		await getDb().execute(
			sql`SELECT c.conname, c.convalidated FROM pg_constraint c
				JOIN pg_namespace n ON n.oid = c.connamespace
				WHERE n.nspname = ${schemaName}`
		)
	).rows as { conname: string; convalidated: boolean }[];
	for (const name of names) {
		expect(rows.find((r) => r.conname === name)?.convalidated, name).toBe(true);
	}
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'Sehr-Sicheres-Passwort-1');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = (await contextForUser(u!.id))!.ctx;

	// --- members bis 0013 + Altbestand ---
	await migrateModuleTo('members', '0013_privacy');
	const codeEnc = core.crypto.forModule('members').encrypt('123456');
	await moduleSql(
		'members',
		sql`INSERT INTO members (id, first_name, last_name, birth_date, address, street, postal_code, city,
				stage, entry_date, exit_date)
			VALUES (${memberId}, 'Mia', 'Alt', '2012-03-04', 'Altweg 1', 'Altweg 1', '28195', 'Bremen',
				'pfadfinder', '2024-05-01', '2023-01-01')`
	);
	await moduleSql(
		'members',
		sql`INSERT INTO groups (id, name, type, meeting_time, meeting_end_time)
			VALUES ('g-legacy', 'Alte Sippe', 'sippe', '25:00', '18 Uhr')`
	);
	await moduleSql(
		'members',
		sql`INSERT INTO member_link_codes (member_id, token, code_enc, expires_at)
			VALUES (${memberId}, ${memberToken}, ${codeEnc}, now() + interval '30 days')`
	);
	await enableModule(admin, 'members');

	// --- actions bis 0019 + Altbestand ---
	await migrateModuleTo('actions', '0019_registration_optin');
	await moduleSql(
		'actions',
		sql`INSERT INTO actions (id, name, starts_on, starts_time, ends_on, ends_time, owner_id) VALUES
			(${actionId}, 'Sommerlager', '2026-07-01', '09:00', '2026-07-10', '18:00', ${admin.userId}),
			(${badActionId}, 'Kaputt', '2026-07-10', '9 Uhr', '2026-07-01', '25:61', ${admin.userId})`
	);
	await moduleSql(
		'actions',
		sql`INSERT INTO action_forms (action_id, token, enabled, definition)
			VALUES (${actionId}, ${formToken}, true, '{}'::jsonb)`
	);
	await moduleSql(
		'actions',
		sql`INSERT INTO expense_links (action_id, token, enabled) VALUES (${actionId}, ${expenseToken}, true)`
	);
	// Verwaiste Rückzahlungs-Verweise (Buchung gibt es nicht)
	await moduleSql(
		'actions',
		sql`INSERT INTO accounting_refunds (id, action_id, entry_id, participant_id, name, amount_cents)
			VALUES ('r-legacy', ${actionId}, 'gone-entry', 'manual-uuid', 'Anna', 500)`
	);
	await moduleSql(
		'actions',
		sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents,
				paying_count, remainder_cents)
			VALUES (${actionId}, 'gone-entry', 1000, 500, 2, 0)`
	);
	await enableModule(admin, 'actions');

	// --- offices bis 0004 + Altbestand ---
	await migrateModuleTo('offices', '0004_website_optin');
	await moduleSql(
		'offices',
		sql`INSERT INTO holder_profiles (user_id, bio) VALUES ('u-legacy', ${'x'.repeat(2500)})`
	);
	await enableModule(admin, 'offices');
});

afterAll(async () => {
	await close();
});

describe('actions/0020: Link-Tokens nur als Hash', () => {
	it('kein Klartext mehr, Hash + verschlüsseltes Token gesetzt', async () => {
		const crypt = core.crypto.forModule('actions');
		const [form] = await moduleSql(
			'actions',
			sql`SELECT token, token_hash, token_enc FROM action_forms WHERE action_id = ${actionId}`
		);
		expect(form!.token).toBeNull();
		expect(form!.token_hash).toBe(crypt.hash(formToken));
		expect(crypt.decrypt(String(form!.token_enc))).toBe(formToken);
		const [link] = await moduleSql(
			'actions',
			sql`SELECT token, token_hash FROM expense_links WHERE action_id = ${actionId}`
		);
		expect(link!.token).toBeNull();
		expect(link!.token_hash).toBe(crypt.hash(expenseToken));
	});

	it('bestehende Links funktionieren weiter, fremde Tokens nicht', async () => {
		expect(await publicGet('actions', `/public/forms/${formToken}`)).toBe(200);
		expect(await publicGet('actions', `/public/expense-links/${expenseToken}`)).toBe(200);
		expect(await publicGet('actions', `/public/forms/${randomBytes(32).toString('hex')}`)).toBe(
			404
		);
	});

	it('Altzeile ohne Hash (vor dem Abgleich) wird gefunden und vom Job umgestellt', async () => {
		const late = randomBytes(32).toString('hex');
		await moduleSql(
			'actions',
			sql`UPDATE expense_links SET token = ${late}, token_hash = NULL, token_enc = NULL
				WHERE action_id = ${actionId}`
		);
		expect(await publicGet('actions', `/public/expense-links/${late}`)).toBe(200);
		expect((await hashStoredLinkTokens()).updated).toBe(1);
		const [link] = await moduleSql(
			'actions',
			sql`SELECT token, token_hash FROM expense_links WHERE action_id = ${actionId}`
		);
		expect(link!.token).toBeNull();
		expect(link!.token_hash).toBe(core.crypto.forModule('actions').hash(late));
		expect(await publicGet('actions', `/public/expense-links/${late}`)).toBe(200);
		expect((await hashStoredLinkTokens()).updated).toBe(0);
	});

	it('Backup-rehash berechnet die Hashes mit anderem Schlüssel neu (idempotent)', async () => {
		const crypt = core.crypto.forModule('actions');
		const other = { hash: (v: string) => `other:${v}`, decrypt: (v: string) => crypt.decrypt(v) };
		const run = (helpers: typeof other) =>
			core.database
				.forModule('actions')
				.transaction((tx) => actionsModule.backup!.rehash!(tx as Tx, helpers));
		expect(await run(other)).toEqual({ updated: 2, unrecoverable: 0 });
		expect(await run(other)).toEqual({ updated: 0, unrecoverable: 0 });
		const [form] = await moduleSql(
			'actions',
			sql`SELECT token_hash FROM action_forms WHERE action_id = ${actionId}`
		);
		expect(form!.token_hash).toBe(`other:${formToken}`);
		// Zurück auf den echten Schlüssel
		await run({ hash: (v) => crypt.hash(v), decrypt: other.decrypt });
		expect(await publicGet('actions', `/public/forms/${formToken}`)).toBe(200);
	});
});

describe('actions/0020: CHECKs und Fremdschlüssel', () => {
	it('bereinigt Altbestand und validiert die Constraints', async () => {
		const [bad] = await moduleSql(
			'actions',
			sql`SELECT starts_time, ends_time, ends_on FROM actions WHERE id = ${badActionId}`
		);
		expect(bad).toEqual({ starts_time: null, ends_time: null, ends_on: null });
		const [ok] = await moduleSql(
			'actions',
			sql`SELECT starts_time, ends_time FROM actions WHERE id = ${actionId}`
		);
		expect(ok).toEqual({ starts_time: '09:00', ends_time: '18:00' });
		const [refund] = await moduleSql(
			'actions',
			sql`SELECT entry_id, participant_id FROM accounting_refunds WHERE id = 'r-legacy'`
		);
		// Buchung fehlte → NULL; participant_id bleibt (manuelle Rückzahlungen nutzen eigene UUIDs)
		expect(refund).toEqual({ entry_id: null, participant_id: 'manual-uuid' });
		expect(
			await moduleSql(
				'actions',
				sql`SELECT 1 FROM action_refund_booking WHERE action_id = ${actionId}`
			)
		).toHaveLength(0);
		await validated('mod_actions', [
			'actions_starts_time_check',
			'actions_ends_time_check',
			'actions_ends_on_check',
			'accounting_refunds_entry_id_fkey',
			'action_refund_booking_entry_id_fkey'
		]);
	});

	it('weist ungültige Werte per Roh-SQL ab', async () => {
		await rejects('actions', sql`UPDATE actions SET starts_time = '7 Uhr' WHERE id = ${actionId}`);
		await rejects('actions', sql`UPDATE actions SET ends_on = '2026-06-01' WHERE id = ${actionId}`);
		await rejects(
			'actions',
			sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents,
					paying_count, remainder_cents) VALUES (${actionId}, 'nope', 1, 1, 1, 0)`
		);
	});

	it('Löschen der Buchung räumt Rückzahlungs-Verweise auf (SET NULL)', async () => {
		await moduleSql(
			'actions',
			sql`INSERT INTO accounting_entries (id, action_id, type, category, description, amount_cents,
					entry_date, paid_by)
				VALUES ('e-refund', ${actionId}, 'expense', 'refund', 'Rückzahlung', 1000, '2026-07-11', 'club')`
		);
		await moduleSql(
			'actions',
			sql`UPDATE accounting_refunds SET entry_id = 'e-refund' WHERE id = 'r-legacy'`
		);
		await moduleSql(
			'actions',
			sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents,
					paying_count, remainder_cents) VALUES (${actionId}, 'e-refund', 1000, 500, 2, 0)`
		);
		await moduleSql('actions', sql`DELETE FROM accounting_entries WHERE id = 'e-refund'`);
		const [refund] = await moduleSql(
			'actions',
			sql`SELECT entry_id FROM accounting_refunds WHERE id = 'r-legacy'`
		);
		expect(refund!.entry_id).toBeNull();
		// Seit 0024 (Rückzahlung spenden) bleibt der Snapshot, nur der Verweis wird NULL (vorher CASCADE)
		const booking = await moduleSql(
			'actions',
			sql`SELECT entry_id FROM action_refund_booking WHERE action_id = ${actionId}`
		);
		expect(booking).toHaveLength(1);
		expect(booking[0]!.entry_id).toBeNull();
	});
});

describe('members/0014', () => {
	it('Verknüpfungs-Token nur als Hash, Link funktioniert weiter', async () => {
		const crypt = core.crypto.forModule('members');
		const [row] = await moduleSql(
			'members',
			sql`SELECT token, token_hash, token_enc FROM member_link_codes WHERE member_id = ${memberId}`
		);
		expect(row!.token).toBeNull();
		expect(row!.token_hash).toBe(crypt.hash(memberToken));
		expect(crypt.decrypt(String(row!.token_enc))).toBe(memberToken);
		expect(await publicGet('members', `/public/link/${memberToken}`)).toBe(200);
		expect(await publicGet('members', `/public/link/${randomBytes(16).toString('hex')}`)).toBe(404);
	});

	it('Backup-rehash berechnet den Hash neu', async () => {
		const crypt = core.crypto.forModule('members');
		const run = (hash: (v: string) => string) =>
			core.database
				.forModule('members')
				.transaction((tx) =>
					membersModule.backup!.rehash!(tx as Tx, { hash, decrypt: (v) => crypt.decrypt(v) })
				);
		expect(await run((v) => `other:${v}`)).toEqual({ updated: 1, unrecoverable: 0 });
		expect(await run((v) => crypt.hash(v))).toEqual({ updated: 1, unrecoverable: 0 });
		expect(await publicGet('members', `/public/link/${memberToken}`)).toBe(200);
	});

	it('bereinigt Altbestand, leert die Altspalte address und validiert die CHECKs', async () => {
		const [g] = await moduleSql(
			'members',
			sql`SELECT meeting_time, meeting_end_time FROM groups WHERE id = 'g-legacy'`
		);
		expect(g).toEqual({ meeting_time: null, meeting_end_time: null });
		const [m] = await moduleSql(
			'members',
			sql`SELECT address, street, to_char(entry_date, 'YYYY-MM-DD') AS entry_date,
					to_char(exit_date, 'YYYY-MM-DD') AS exit_date FROM members WHERE id = ${memberId}`
		);
		expect(m).toEqual({
			address: null,
			street: 'Altweg 1',
			entry_date: null,
			exit_date: '2023-01-01'
		});
		await validated('mod_members', [
			'groups_meeting_time_check',
			'groups_meeting_end_time_check',
			'members_exit_date_check'
		]);
		const idx = await moduleSql(
			'members',
			sql`SELECT 1 FROM pg_indexes WHERE schemaname = 'mod_members' AND indexname = 'group_leaders_member_idx'`
		);
		expect(idx).toHaveLength(1);
	});

	it('weist ungültige Werte per Roh-SQL ab', async () => {
		await rejects('members', sql`UPDATE groups SET meeting_time = '9:5' WHERE id = 'g-legacy'`);
		await rejects(
			'members',
			sql`UPDATE groups SET meeting_end_time = '24:00' WHERE id = 'g-legacy'`
		);
		await rejects(
			'members',
			sql`UPDATE members SET entry_date = '2024-01-01' WHERE id = ${memberId}`
		);
	});
});

describe('offices/0005', () => {
	it('kürzt zu lange Beschreibungen und weist neue ab', async () => {
		const [row] = await moduleSql(
			'offices',
			sql`SELECT char_length(bio) AS n FROM holder_profiles WHERE user_id = 'u-legacy'`
		);
		expect(Number(row!.n)).toBe(2000);
		await validated('mod_offices', ['holder_profiles_bio_check']);
		await rejects(
			'offices',
			sql`UPDATE holder_profiles SET bio = ${'y'.repeat(2001)} WHERE user_id = 'u-legacy'`
		);
	});
});
