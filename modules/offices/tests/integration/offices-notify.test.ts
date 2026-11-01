import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { setMailTransportForTests, type MailTransport } from '$testing';
import { core } from '$testing';
import { runJobNow } from '$testing';
import { defineModule } from '$lib/sdk/server';
import officesModule from '$modules/offices/module';
import { resetTemplateCacheForTests } from '$modules/offices/templates.service';
import type { OfficeNotification, OfficesService } from '$modules/offices/contract';
import type { Office } from '$modules/offices/schemas';
import {
	migrateLegacyPrefs,
	resetLegacyPrefsMigrationForTests
} from '$modules/offices/notify.service';
import { getMyPreferences, setMyPreference } from '$testing';
import type { RequestContext } from '$lib/sdk/types';

// Ämter aus Modul-Vorlagen und Benachrichtigungen an Inhaber*innen (Versand und Kanalwahl über core.notifications).

const BASE = 'http://localhost:5173/api/v1/modules/offices';
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

/** Test-Modul, das das Amt „Kasse“ als Vorlage mitbringt */
const notifyTestModule = defineModule({
	manifest: {
		id: 'notifytest',
		name: 'Benachrichtigungstest',
		description: 'Nur für Tests',
		version: '1.0.0',
		dependencies: [],
		optionalDependencies: ['offices'],
		permissions: ['notifytest.item.view'],
		permissionDescriptions: { 'notifytest.item.view': 'Testrecht' },
		navigation: [],
		offices: [
			{
				key: 'kasse',
				name: 'Kasse',
				description: 'Verwaltet das Geld',
				notifications: [
					{ key: 'payable-created', label: 'Neue Überweisung steht an' },
					{ key: 'accounting-closed', label: 'Abrechnung abgeschlossen', description: 'Auch ZA' }
				]
			}
		]
	}
});

type SentMail = Parameters<MailTransport['sendMail']>[0];
const mails: SentMail[] = [];
let failMail = false;

let close: () => Promise<void>;
let admin: RequestContext;
let adminKey: string;
let utaId: string;
let benId: string;
let carlId: string;
let kasse: Office;

interface ApiResult<T = unknown> {
	status: number;
	data: T;
	error: { code: string; message: string; details?: unknown } | undefined;
}

async function api<T = unknown>(
	key: string,
	method: string,
	path: string,
	body?: unknown
): Promise<ApiResult<T>> {
	resetAllForTests();
	const url = new URL(`${BASE}${path}`);
	const headers: Record<string, string> = { authorization: `Bearer ${key}` };
	if (body !== undefined) headers['content-type'] = 'application/json';
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined
		}),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	const json = text ? (JSON.parse(text) as { data?: T; error?: ApiResult['error'] }) : {};
	return { status: res.status, data: json.data as T, error: json.error };
}

async function listOffices(): Promise<Office[]> {
	resetTemplateCacheForTests();
	const r = await api<Office[]>(adminKey, 'GET', '/offices');
	expect(r.status, JSON.stringify(r.error)).toBe(200);
	return r.data;
}

async function service(): Promise<OfficesService> {
	const s = await core.modules.useOptional<OfficesService>('offices', 'notifytest');
	expect(s).not.toBeNull();
	return s!;
}

const event = (e: string, subject: string, extra: Partial<OfficeNotification> = {}) => ({
	module: 'notifytest',
	office: 'kasse',
	event: e,
	subject,
	text: `Text zu ${subject}`,
	link: '/modules/treasury?tab=payables',
	...extra
});

const recipients = () => mails.map((m) => m.to).sort();

const scopeOf = (eventKey: string) => `notifytest:kasse:${eventKey}`;

async function setPref(
	userId: string,
	eventKey: string,
	channel: 'off' | 'email',
	delivery: 'immediate' | 'daily' = 'immediate'
) {
	return setMyPreference(await ctxOf(userId), {
		type: 'offices.template',
		scope: scopeOf(eventKey),
		channel,
		delivery
	});
}

async function officeScopes(userId: string): Promise<string[]> {
	const p = await getMyPreferences(await ctxOf(userId));
	return p.groups.find((g) => g.id === 'offices')?.items.map((i) => i.scope) ?? [];
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(officesModule);
	registerModule(notifyTestModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'offices');
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'admin', scopes: [...admin.permissions] })).key;

	const base = await createRole(admin, {
		name: 'Basis',
		permissions: ['core.api.manage', 'offices.office.view']
	});
	const mk = (name: string, email: string) =>
		createUser(admin, { name, email, password: 'correct-horse-battery-2', roleIds: [base] });
	utaId = await mk('Uta Kasse', 'uta@example.test');
	benId = await mk('Ben Kasse', 'ben@example.test');
	carlId = await mk('Carl Ohne', 'carl@example.test');

	setMailTransportForTests({
		sendMail: async (m) => {
			if (failMail) throw new Error('SMTP kaputt');
			mails.push(m);
		}
	});
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close();
});

beforeEach(() => {
	mails.length = 0;
	failMail = false;
});

describe('Vorlagen', () => {
	it('legt kein Amt an, solange das Vorlagen-Modul inaktiv ist', async () => {
		const offices = await listOffices();
		expect(offices.filter((o) => o.source)).toHaveLength(0);
	});

	it('legt das Vorlagen-Amt einmal an (mit Herkunft und Ereignissen)', async () => {
		await enableModule(admin, 'notifytest');
		const first = await listOffices();
		const fromTemplate = first.filter((o) => o.source);
		expect(fromTemplate).toHaveLength(1);
		kasse = fromTemplate[0]!;
		expect(kasse.name).toBe('Kasse');
		expect(kasse.description).toBe('Verwaltet das Geld');
		expect(kasse.source).toEqual({
			module: 'notifytest',
			moduleName: 'Benachrichtigungstest',
			key: 'kasse'
		});
		expect(kasse.notifications.map((n) => n.key)).toEqual(['payable-created', 'accounting-closed']);
		expect(kasse.notifications[1]!.description).toBe('Auch ZA');

		const again = await listOffices();
		expect(again.filter((o) => o.source)).toHaveLength(1);
		await runJobNow(admin, 'offices.sync-grants');
		expect((await listOffices()).filter((o) => o.source)).toHaveLength(1);

		const holders = await api<Office>(adminKey, 'PUT', `/offices/${kasse.id}/holders`, {
			holders: [{ userId: utaId }, { userId: benId }]
		});
		expect(holders.status, JSON.stringify(holders.error)).toBe(200);
	});

	it('zeigt keine Ereignisse, wenn das Vorlagen-Modul inaktiv ist', async () => {
		await disableModule(admin, 'notifytest');
		try {
			const office = (await listOffices()).find((o) => o.id === kasse.id)!;
			expect(office.source?.module).toBe('notifytest');
			expect(office.notifications).toEqual([]);
			expect(await officeScopes(utaId)).toEqual([]);
		} finally {
			await enableModule(admin, 'notifytest');
		}
	});
});

describe('Sofort-Benachrichtigung', () => {
	it('schickt allen Inhaber*innen eine Mail an die Konto-Adresse', async () => {
		const r = await (
			await service()
		).notify(admin, [event('payable-created', 'Überweisung an Bob')]);
		expect(r).toEqual({ sent: 2, queued: 0, skipped: 0 });
		expect(recipients()).toEqual(['ben@example.test', 'uta@example.test']);
		const m = mails[0]!;
		expect(m.subject).toBe('Überweisung an Bob');
		expect(m.text).toContain('Text zu Überweisung an Bob');
		expect(m.text).toContain(`${core.app.origin()}/modules/treasury?tab=payables`);
		expect(recipients()).not.toContain('carl@example.test');
	});

	it('bündelt mehrere Ereignisse eines Aufrufs zu einer Mail je Person', async () => {
		const r = await (
			await service()
		).notify(admin, [
			event('payable-created', 'Überweisung 1'),
			event('accounting-closed', 'Abrechnung Sommerlager')
		]);
		expect(r.sent).toBe(2);
		expect(mails).toHaveLength(2);
		expect(mails[0]!.subject).toBe('2 neue Benachrichtigungen');
		expect(mails[0]!.text).toContain('Amt „Kasse“');
		expect(mails[0]!.text).toContain('Überweisung 1');
		expect(mails[0]!.text).toContain('Abrechnung Sommerlager');
	});

	it('kürzt Betreff (eine Zeile, ≤ 150) und verwirft fremde Links', async () => {
		await (
			await service()
		).notify(admin, [
			event('payable-created', `Zeile 1\nZeile 2 ${'x'.repeat(300)}`, {
				link: 'https://evil.example/x'
			})
		]);
		const m = mails[0]!;
		expect(m.subject.includes('\n')).toBe(false);
		expect(m.subject.length).toBeLessThanOrEqual(150);
		expect(m.text).not.toContain('evil.example');
	});

	it('ignoriert unbekannte Ereignisse und Vorlagen ohne zu werfen', async () => {
		const r = await (
			await service()
		).notify(admin, [
			event('gibt-es-nicht', 'X'),
			event('payable-created', 'Y', { office: 'fremd' }),
			event('payable-created', 'Z', { module: 'unbekannt' })
		]);
		expect(r).toEqual({ sent: 0, queued: 0, skipped: 3 });
		expect(mails).toHaveLength(0);
	});

	it('zählt Versandfehler als übersprungen', async () => {
		failMail = true;
		const r = await (await service()).notify(admin, [event('payable-created', 'Fehlschlag')]);
		expect(r.sent).toBe(0);
	});
});

describe('Einstellungen je Person (Core-Reiter „Benachrichtigungen“)', () => {
	it('Profil zeigt die Ereignisse der eigenen Vorlagen-Ämter, anderen nichts', async () => {
		expect(await officeScopes(utaId)).toEqual([
			scopeOf('payable-created'),
			scopeOf('accounting-closed')
		]);
		expect(await officeScopes(carlId)).toEqual([]);
		await expect(setPref(carlId, 'payable-created', 'off')).rejects.toMatchObject({ status: 404 });
	});

	it('täglich → Tageszusammenfassung des Cores, aus → nichts', async () => {
		await setPref(utaId, 'payable-created', 'email', 'daily');
		await setPref(benId, 'payable-created', 'off');

		const s = await service();
		const r1 = await s.notify(admin, [event('payable-created', 'Überweisung A')]);
		expect(r1).toEqual({ sent: 0, queued: 1, skipped: 1 });
		const r2 = await s.notify(admin, [
			event('payable-created', 'Überweisung B'),
			event('accounting-closed', 'Abrechnung C')
		]);
		// Uta: B in die Warteschlange, C sofort; Ben: B aus, C sofort
		expect(r2).toEqual({ sent: 2, queued: 1, skipped: 1 });
		expect(mails.map((m) => m.subject)).toEqual(['Abrechnung C', 'Abrechnung C']);

		mails.length = 0;
		await runJobNow(admin, 'core.notifications-digest');
		expect(mails).toHaveLength(1);
		expect(mails[0]!.to).toBe('uta@example.test');
		expect(mails[0]!.subject).toBe('Tageszusammenfassung: 2 Benachrichtigungen');
		expect(mails[0]!.text).toContain('Überweisung A');
		expect(mails[0]!.text).toContain('Überweisung B');
		expect(mails[0]!.text).toContain('Amt „Kasse“');

		mails.length = 0;
		await runJobNow(admin, 'core.notifications-digest');
		expect(mails).toHaveLength(0);
		await setPref(utaId, 'payable-created', 'email');
		await setPref(benId, 'payable-created', 'email');
	});

	it('übernimmt alte Einstellungen einmalig in den Core und leert die alte Tabelle', async () => {
		const tx = (q: ReturnType<typeof sql>) =>
			core.database.forModule('offices').transaction((t) => t.execute(q));
		await tx(sql`INSERT INTO notification_prefs (user_id, module_id, office_key, event_key, mode)
			VALUES (${utaId}, 'notifytest', 'kasse', 'accounting-closed', 'off'),
				(${benId}, 'notifytest', 'kasse', 'accounting-closed', 'daily')`);
		resetLegacyPrefsMigrationForTests();
		expect(await migrateLegacyPrefs()).toBe(2);
		const rest = (await tx(sql`SELECT 1 FROM notification_prefs`)) as unknown as {
			rows: unknown[];
		};
		expect(rest.rows).toHaveLength(0);
		const prefs = await getDb()
			.select()
			.from(schema.notificationPref)
			.where(eq(schema.notificationPref.scope, scopeOf('accounting-closed')));
		const byUser = new Map(prefs.map((p) => [p.userId, `${p.channel}/${p.delivery}`]));
		expect(byUser.get(utaId)).toBe('off/immediate');
		expect(byUser.get(benId)).toBe('email/daily');
		const r = await (await service()).notify(admin, [event('accounting-closed', 'Nach Übernahme')]);
		expect(r).toEqual({ sent: 0, queued: 1, skipped: 1 });
		await runJobNow(admin, 'core.notifications-digest');
	});

	it('arbeitet die alte Warteschlange noch ab (Job offices.notify-digest)', async () => {
		await core.database.forModule('offices').transaction((t) =>
			t.execute(sql`INSERT INTO notification_queue (id, user_id, module_id, office_key, event_key, subject, text)
				VALUES (${crypto.randomUUID()}, ${utaId}, 'notifytest', 'kasse', 'payable-created', 'Alt', 'Alter Eintrag')`)
		);
		mails.length = 0;
		await runJobNow(admin, 'offices.notify-digest');
		expect(mails.map((m) => m.to)).toEqual(['uta@example.test']);
		expect(mails[0]!.text).toContain('Alter Eintrag');
	});
});

describe('Gelöschtes Vorlagen-Amt', () => {
	it('kommt nicht zurück; Benachrichtigungen erreichen niemanden', async () => {
		const del = await api(adminKey, 'DELETE', `/offices/${kasse.id}`);
		expect(del.status, JSON.stringify(del.error)).toBe(200);
		expect((await listOffices()).filter((o) => o.source)).toHaveLength(0);
		await runJobNow(admin, 'offices.sync-grants');
		expect((await listOffices()).filter((o) => o.source)).toHaveLength(0);

		const r = await (await service()).notify(admin, [event('payable-created', 'Niemand')]);
		expect(r).toEqual({ sent: 0, queued: 0, skipped: 1 });
		expect(mails).toHaveLength(0);
	});
});

describe('Audit', () => {
	it('protokolliert Vorlage, Versand und Einstellungen ohne Mailadressen', async () => {
		const rows = await getDb()
			.select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
			.from(schema.auditLog)
			.where(like(schema.auditLog.action, 'offices.%'));
		const actions = new Set(rows.map((r) => r.action));
		expect(actions).toContain('offices.notification.sent');
		const created = rows.find(
			(r) =>
				r.action === 'offices.office.created' &&
				(r.metadata as Record<string, unknown> | null)?.template === 'notifytest.kasse'
		);
		expect(created).toBeTruthy();
		for (const r of rows) {
			const meta = JSON.stringify(r.metadata);
			expect(meta).not.toContain('@');
			expect(meta).not.toContain('Überweisung');
		}
	});
});
