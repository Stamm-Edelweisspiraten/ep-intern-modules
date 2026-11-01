/**
 * Einstellungen – Sicherheit:
 * #15 Ziel-gebundene Secrets (SMTP/KI/Storage) werden beim Ändern des Ziels verworfen; SMTP mit Anmeldung nur über TLS.
 * #59 Schreibrecht je Einstellung (`writePermission`, Modul-Schlüssel mit `<modul>.settings.manage`), atomares
 *     Speichern mehrerer Werte, höchstens 100 Schlüssel, `null` nur bei löschbaren Schlüsseln.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { getDb, schema } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { createApiKey } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import {
	getDefinition,
	getSetting,
	MAX_SETTINGS_PER_WRITE,
	setSetting,
	setSettings
} from '$testing';
import { sendMail, setMailTransportForTests, smtpTransportOptions } from '$testing';
import { defineModule } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import treasuryModule from '$modules/treasury/module';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'Sehr-Sicheres-Passwort-1';
let close: () => Promise<void>;
let admin: RequestContext;
let managerKey: string;
let managerCtx: RequestContext;

const ctxOf = async (id: string): Promise<RequestContext> => (await contextForUser(id))!.ctx;

/** Testmodul mit eigenem Einstellungsrecht */
const guarded = defineModule({
	manifest: {
		id: 'setguard',
		name: 'Geschützt',
		version: '1.0.0',
		dependencies: [],
		permissions: ['setguard.settings.manage'],
		permissionDescriptions: { 'setguard.settings.manage': 'Einstellungen verwalten' },
		navigation: []
	},
	settings: [
		{ key: 'setguard.holder', label: 'Inhaber', schema: z.string().max(50), default: '' },
		{ key: 'setguard.iban', label: 'IBAN', schema: z.string().max(34), default: '' },
		{ key: 'setguard.code', label: 'Code', schema: z.string().min(4) }
	],
	migrations: [],
	endpoints: []
});

/** Testmodul ohne eigenes Recht → `core.settings.manage` */
const plain = defineModule({
	manifest: {
		id: 'setplain',
		name: 'Einfach',
		version: '1.0.0',
		dependencies: [],
		permissions: [],
		navigation: []
	},
	settings: [{ key: 'setplain.note', label: 'Notiz', schema: z.string().max(20), default: '' }],
	migrations: [],
	endpoints: []
});

async function put(key: string, values: Record<string, unknown>) {
	const url = new URL('http://localhost/api/v1/settings');
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'PUT',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ values })
		}),
		url,
		ip: '127.0.0.1'
	});
	return {
		status: res.status,
		body: (await res.json().catch(() => null)) as { error?: { code?: string } }
	};
}

async function codeOf(p: Promise<unknown>): Promise<number | undefined> {
	try {
		await p;
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return 200;
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(guarded);
	registerModule(plain);
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	await syncModules();
	await bootstrapAdmin('admin@settings.test', PW);
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@settings.test'));
	const adminId = u!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'setguard');
	await enableModule(admin, 'setplain');
	admin = await ctxOf(adminId);
	// Person mit core.settings.manage, aber ohne Modulrecht
	const roleId = await createRole(admin, {
		name: 'Einstellungen',
		permissions: ['core.settings.view', 'core.settings.manage', 'core.api.manage']
	});
	const uid = await createUser(admin, {
		name: 'Einstellung',
		email: 'settings@settings.test',
		password: PW,
		roleIds: [roleId]
	});
	managerCtx = await ctxOf(uid);
	managerKey = (
		await createApiKey(managerCtx, {
			name: 'k',
			scopes: ['core.settings.view', 'core.settings.manage']
		})
	).key;
}, 120_000);

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close?.();
});

describe('#59 Schreibrecht je Einstellung', () => {
	it('Modul-Schlüssel mit eigenem Recht: writePermission; Kasse → treasury.settings.manage', () => {
		expect(getDefinition('setguard.iban').writePermission).toBe('setguard.settings.manage');
		expect(getDefinition('setplain.note').writePermission).toBe('core.settings.manage');
		expect(getDefinition('treasury.bank.iban').writePermission).toBe('treasury.settings.manage');
		expect(getDefinition('core.smtp.host').writePermission ?? 'core.settings.manage').toBe(
			'core.settings.manage'
		);
	});

	it('PUT /settings mit Modul-Schlüssel ohne Modulrecht → 403, nichts geändert', async () => {
		const r = await put(managerKey, { 'core.system.name': 'Neu', 'setguard.iban': 'DE00' });
		expect(r.status).toBe(403);
		expect(r.body.error?.code).toBe('forbidden');
		expect(await getSetting('core.system.name')).toBe('Kalypzo Atrium');
		expect(await getSetting('setguard.iban')).toBe('');
		const t = await put(managerKey, { 'treasury.bank.iban': 'DE02120300000000202051' });
		expect(t.status).toBe(403);
		// ohne eigenes Modulrecht reicht core.settings.manage
		expect((await put(managerKey, { 'setplain.note': 'ok' })).status).toBe(200);
		expect(await getSetting('setplain.note')).toBe('ok');
	});

	it('Admin darf Modul-Schlüssel; Systemkontext (Kassen-Endpunkt) ebenso', async () => {
		await setSettings(admin, { 'setguard.holder': 'Stamm', 'setguard.iban': 'DE11' });
		expect(await getSetting('setguard.iban')).toBe('DE11');
	});

	it('ungültiger zweiter Wert → 422, erster Wert unverändert', async () => {
		const r = await put(managerKey, {
			'core.system.name': 'Atomar',
			'core.design.accentColor': 'rot'
		});
		expect(r.status).toBe(422);
		expect(await getSetting('core.system.name')).toBe('Kalypzo Atrium');
		expect(
			await codeOf(setSettings(admin, { 'setguard.holder': 'X', 'setguard.iban': 'x'.repeat(40) }))
		).toBe(422);
		expect(await getSetting('setguard.holder')).toBe('Stamm');
	});

	it('mehr als 100 Schlüssel → 422', async () => {
		const values: Record<string, unknown> = {};
		for (let i = 0; i <= MAX_SETTINGS_PER_WRITE; i++) values[`x.y${i}`] = i;
		expect((await put(managerKey, values)).status).toBe(422);
		expect(await codeOf(setSettings(admin, values))).toBe(422);
	});

	it('null nur bei löschbaren Schlüsseln (Secret ja, Pflichtwert nein)', async () => {
		// Standardwert gültig → löschbar (zurück auf Standard); ohne gültigen Standard → 422
		await setSetting(admin, 'core.system.name', 'Testsystem');
		expect((await put(managerKey, { 'core.system.name': null })).status).toBe(200);
		expect(await getSetting('core.system.name')).toBe('Kalypzo Atrium');
		expect(await codeOf(setSettings(admin, { 'setguard.code': null }))).toBe(422);
		await setSetting(admin, 'core.ai.apiKey', 'sk-test');
		expect((await put(managerKey, { 'core.ai.apiKey': null })).status).toBe(200);
		expect(await getSetting('core.ai.apiKey')).toBe('');
	});
});

describe('#15 Ziel-gebundene Secrets', () => {
	it('SMTP-Host ändern ohne neues Passwort → Passwort weg, Versand 503', async () => {
		await setSettings(admin, {
			'core.smtp.host': 'smtp.example.test',
			'core.smtp.user': 'stamm',
			'core.smtp.password': 'geheim-1',
			'core.smtp.from': 'noreply@example.test'
		});
		expect(await getSetting('core.smtp.password')).toBe('geheim-1');
		const res = await setSettings(managerCtx, { 'core.smtp.host': 'evil.example.test' });
		expect(res.clearedSecrets).toEqual(['core.smtp.password']);
		expect(await getSetting('core.smtp.password')).toBe('');
		setMailTransportForTests({ sendMail: async () => undefined });
		expect(await codeOf(sendMail({ to: 'a@example.test', subject: 'x', text: 'y' }))).toBe(503);
		setMailTransportForTests(undefined);
	});

	it('Host + Passwort gleichzeitig → beides gesetzt; nur Passwort → Host unverändert', async () => {
		await setSettings(admin, {
			'core.smtp.host': 'smtp2.example.test',
			'core.smtp.password': 'neu-2'
		});
		expect(await getSetting('core.smtp.host')).toBe('smtp2.example.test');
		expect(await getSetting('core.smtp.password')).toBe('neu-2');
		await setSettings(admin, { 'core.smtp.password': 'neu-3' });
		expect(await getSetting('core.smtp.host')).toBe('smtp2.example.test');
		expect(await getSetting('core.smtp.password')).toBe('neu-3');
	});

	it('gleicher Host (Formular sendet alle Felder) → Passwort bleibt; Port/Benutzer ändern → weg', async () => {
		await setSettings(admin, { 'core.smtp.host': 'smtp2.example.test', 'core.smtp.port': '587' });
		expect(await getSetting('core.smtp.password')).toBe('neu-3');
		await setSettings(admin, { 'core.smtp.port': 2525 });
		expect(await getSetting('core.smtp.password')).toBe('');
		await setSettings(admin, { 'core.smtp.password': 'neu-4' });
		await setSettings(admin, { 'core.smtp.user': 'anders' });
		expect(await getSetting('core.smtp.password')).toBe('');
	});

	it('KI-Base-URL ändern → KI-Key weg', async () => {
		await setSettings(admin, { 'core.ai.apiKey': 'sk-1', 'core.ai.baseUrl': '' });
		await setSettings(admin, { 'core.ai.baseUrl': 'https://evil.example.test/v1' });
		expect(await getSetting('core.ai.apiKey')).toBe('');
		await setSettings(admin, {
			'core.ai.baseUrl': 'https://llm.example.test/v1',
			'core.ai.apiKey': 'sk-2'
		});
		expect(await getSetting('core.ai.apiKey')).toBe('sk-2');
	});

	it('Storage-Endpoint ändern → Access-Key und Secret weg', async () => {
		await setSettings(admin, {
			'core.storage.endpoint': 'http://minio:9000',
			'core.storage.accessKeyId': 'AK',
			'core.storage.secretAccessKey': 'SK'
		});
		const res = await setSettings(admin, { 'core.storage.endpoint': 'http://169.254.169.254' });
		expect(res.clearedSecrets.sort()).toEqual([
			'core.storage.accessKeyId',
			'core.storage.secretAccessKey'
		]);
		expect(await getSetting('core.storage.accessKeyId')).toBe('');
		expect(await getSetting('core.storage.secretAccessKey')).toBe('');
	});

	it('SMTP-Transport: 465 → secure, Anmeldung ohne secure → requireTLS, ohne Anmeldung optional', () => {
		expect(smtpTransportOptions({ 'core.smtp.port': 465, 'core.smtp.user': 'a' })).toMatchObject({
			secure: true,
			requireTLS: false
		});
		expect(smtpTransportOptions({ 'core.smtp.port': 587, 'core.smtp.user': 'a' })).toMatchObject({
			secure: false,
			requireTLS: true
		});
		expect(smtpTransportOptions({ 'core.smtp.port': 25, 'core.smtp.user': '' })).toMatchObject({
			secure: false,
			requireTLS: false,
			auth: undefined
		});
	});
});
