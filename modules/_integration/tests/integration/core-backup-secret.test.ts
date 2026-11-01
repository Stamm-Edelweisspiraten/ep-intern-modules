/**
 * Datensicherung auf einen neuen Server mit anderem APP_SECRET: Geheimnisse werden neu verschlüsselt,
 * schlüsselgebundene Hashes neu berechnet (Modul-Hooks), 2FA bleibt nutzbar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage } from '$testing';
import {
	seedBackupWorld,
	SEED_ADMIN_EMAIL,
	SEED_COUNTERPARTY_IBAN,
	SEED_PASSWORD,
	SEED_PAYEE_IBAN,
	SEED_PAYER_IBAN,
	SEED_SMTP_PASSWORD,
	SEED_TOTP_SECRET,
	type BackupWorld
} from '../../helpers/backup-seed';
import { exportBackup, previewBackup, runRestore } from '../../helpers/backup-flow';
import { getDb, schema } from '$testing';
import { resetEnvForTests } from '$testing';
import { resetAuthForTests } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { syncModules } from '$testing';
import { setFileRepoForTests } from '$testing';
import { getSetting } from '$testing';
import { keyCheckValue } from '$testing';
import { totpCode, verifyTotp } from '$testing';
import { core } from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import type { RestorePreview, RunStatus } from '$lib/backup/contract';

const OLD_SECRET = process.env.APP_SECRET!;
const NEW_SECRET = 'ganz-anderer-server-schluessel-2026-abcdef';

let world: BackupWorld;
let closeTarget: (() => Promise<void>) | null = null;
let preview: RestorePreview;
let status: RunStatus;
let keyBefore = '';

async function ctxOf(id: string): Promise<RequestContext> {
	return (await contextForUser(id))!.ctx;
}

beforeAll(async () => {
	world = await seedBackupWorld();
	const { bytes } = await exportBackup(world.admin);
	keyBefore = keyCheckValue();
	await world.close();

	// Neuer Server: anderer Schlüssel, leere Datenbank, gleiche Admin-Anmeldung
	process.env.APP_SECRET = NEW_SECRET;
	resetEnvForTests();
	resetAuthForTests();
	({ close: closeTarget } = await useTestDatabase());
	await syncModules();
	await bootstrapAdmin(SEED_ADMIN_EMAIL, SEED_PASSWORD);
	const [a] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, SEED_ADMIN_EMAIL));
	const target = await ctxOf(a!.id);
	await installFakeStorage(target);
	setFileRepoForTests(undefined);

	preview = await previewBackup(target, bytes);
	status = await runRestore(target, preview, { takeSmtp: true });
}, 240_000);

afterAll(async () => {
	await closeTarget?.();
	process.env.APP_SECRET = OLD_SECRET;
	resetEnvForTests();
	resetAuthForTests();
});

describe('anderer Server-Schlüssel', () => {
	it('Vorschau erkennt den Schlüsselwechsel, Konto „same“ mit Abmeldung', () => {
		expect(keyCheckValue()).not.toBe(keyBefore);
		expect(preview.secretChanged).toBe(true);
		expect(preview.warnings.join(' ')).toMatch(/anderem Schlüssel/);
		expect(preview.account).toMatchObject({ case: 'same', willLogout: true });
		expect(preview.scopes.filter((s) => !s.available)).toEqual([]);
	});

	it('Ergebnis: Hashes neu berechnet, nichts unwiederbringlich', () => {
		const r = status.result!;
		expect(r.loggedOut).toBe(true);
		// 1 Zahler-IBAN + 1 Gegenpartei-IBAN + 1 Datei-Link
		expect(r.rehash).toEqual({ updated: 3, unrecoverable: 0 });
		expect(r.files.failed).toBe(0);
		expect(r.files.uploaded).toBeGreaterThan(0);
	});

	it('Kasse: IBAN entschlüsselbar, IBAN-Suche trifft', async () => {
		const [p] = (
			await getDb().execute(
				sql`SELECT iban_enc, iban_hash FROM mod_treasury.payers WHERE id = ${world.ids.payerId}`
			)
		).rows as { iban_enc: string; iban_hash: string }[];
		const crypto = core.crypto.forModule('treasury');
		expect(crypto.decrypt(p!.iban_enc)).toBe(SEED_PAYER_IBAN);
		expect(p!.iban_hash).toBe(crypto.hash(SEED_PAYER_IBAN));
		const [t] = (
			await getDb().execute(
				sql`SELECT counterparty_iban_enc, counterparty_iban_hash FROM mod_treasury.transactions
					WHERE id = ${world.ids.transactionId}`
			)
		).rows as { counterparty_iban_enc: string; counterparty_iban_hash: string }[];
		expect(crypto.decrypt(t!.counterparty_iban_enc)).toBe(SEED_COUNTERPARTY_IBAN);
		expect(t!.counterparty_iban_hash).toBe(crypto.hash(SEED_COUNTERPARTY_IBAN));
	});

	it('alle Module der Sicherung sind wieder aktiv', async () => {
		const rows = (await getDb().execute(sql`SELECT id, enabled FROM "public"."module_state"`))
			.rows as { id: string; enabled: boolean }[];
		const inactive = rows.filter((r) => !r.enabled).map((r) => r.id);
		expect(inactive, JSON.stringify(status.result!.warnings)).toEqual([]);
		const iban = await world.call(
			'admin',
			'GET',
			`/modules/treasury/payers/${world.ids.payerId}/iban`
		);
		expect(iban.status, JSON.stringify(iban.body)).toBe(200);
		// Anzeige formatiert in Vierergruppen
		expect(JSON.stringify(iban.body.data).replace(/ /g, '')).toContain(SEED_PAYER_IBAN);
	});

	it('API-Keys gelten weiter; Empfänger-IBAN der Aktion über die API im Klartext', async () => {
		const payee = await world.call(
			'admin',
			'GET',
			`/modules/actions/actions/${world.ids.actionId}/accounting/payees/${world.ids.payeeId}/iban`
		);
		expect(payee.status, JSON.stringify(payee.body)).toBe(200);
		expect(JSON.stringify(payee.body.data)).toContain(SEED_PAYEE_IBAN);
	});

	it('Datei-Link-Token funktioniert, Datei-Inhalt kommt', async () => {
		const info = await world.call(
			null,
			'GET',
			`/modules/files/public/links/${world.ids.linkToken}`
		);
		expect(info.status, JSON.stringify(info.body)).toBe(200);
		const res = await world.call('admin', 'GET', `/modules/files/nodes/${world.ids.fileId}`);
		expect(res.status).toBe(200);
	});

	it('2FA: TOTP der zweiten Person verifizierbar', async () => {
		expect(await verifyTotp(world.userId, totpCode(SEED_TOTP_SECRET))).toBe(true);
		expect(
			await verifyTotp(world.userId, '000000' === totpCode(SEED_TOTP_SECRET) ? '111111' : '000000')
		).toBe(false);
	});

	it('SMTP-Passwort-Einstellung mit dem neuen Schlüssel lesbar (takeSmtp)', async () => {
		expect(await getSetting<string>('core.smtp.password')).toBe(SEED_SMTP_PASSWORD);
		const [row] = (
			await getDb().execute(
				sql`SELECT value::text AS v FROM "public"."setting" WHERE key = 'core.smtp.password'`
			)
		).rows as { v: string }[];
		expect(row!.v).toContain('enc:v1:');
		expect(row!.v).not.toContain(SEED_SMTP_PASSWORD);
	});
});
