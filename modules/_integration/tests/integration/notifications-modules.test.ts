/**
 * Benachrichtigungen der Fachmodule über `core.notifications`: Empfänger aus Freigaben (`principalUserIds`),
 * Aktionen (geteilt, neue Anmeldung, Abrechnung), Termine (neu/geändert/abgesagt, Standard „Aus“), Galerien
 * und Dateien (geteilt). Nie an die handelnde Person, nur an Konten mit Leserecht.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { setMailTransportForTests, type MailTransport } from '$testing';
import { resetAllForTests } from '$testing';
import { setMyPreference } from '$testing';
import { principalUserIds } from '$lib/sdk/server';
import { addDays, todayBerlin } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import filesModule from '$modules/files/module';
import { notifyRegistration } from '$modules/actions/notify';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'notify-modules-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const ids: Record<string, string> = {};
const keys: Record<string, string> = {};
let roleId = '';

type Sent = Parameters<MailTransport['sendMail']>[0];
let mails: Sent[] = [];
const to = (email: string) => mails.filter((m) => m.to === email);

async function api(who: string, method: string, path: string, json?: unknown) {
	resetAllForTests();
	const url = new URL(`http://localhost:5173/api/v1/modules${path}`);
	const headers: Record<string, string> = { authorization: `Bearer ${keys[who]}` };
	if (json !== undefined) headers['content-type'] = 'application/json';
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = (await res.json()) as { data?: unknown; error?: unknown };
	expect(res.status, JSON.stringify(body.error)).toBeLessThan(300);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return body.data as any;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	for (const m of [membersModule, actionsModule, eventsModule, galleriesModule, filesModule]) {
		registerModule(m);
	}
	await syncModules();
	await bootstrapAdmin('admin@example.test', PW);
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	ids.admin = u!.id;
	admin = await ctxOf(ids.admin);
	for (const m of ['members', 'actions', 'events', 'galleries', 'files']) {
		await enableModule(admin, m);
	}
	admin = await ctxOf(ids.admin);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	roleId = await createRole(admin, {
		name: 'Leute',
		permissions: [
			'core.api.manage',
			'actions.action.view',
			'events.event.view',
			'galleries.gallery.view',
			'files.file.view'
		]
	});
	const noView = await createRole(admin, { name: 'Ohne', permissions: ['core.api.manage'] });
	ids.bob = await createUser(admin, {
		name: 'Bob Beispiel',
		email: 'bob@example.test',
		password: PW,
		roleIds: [roleId]
	});
	ids.carl = await createUser(admin, {
		name: 'Carl Ohne',
		email: 'carl@example.test',
		password: PW,
		roleIds: [noView]
	});
	const bob = await ctxOf(ids.bob);
	keys.bob = (await createApiKey(bob, { name: 'b', scopes: [...bob.permissions] })).key;
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	await close();
});

beforeEach(() => {
	mails = [];
});

describe('principalUserIds', () => {
	it('löst Personen und Rollen auf, filtert nach Leserecht und ohne handelnde Person', async () => {
		const users = await principalUserIds(
			'events',
			[
				{ type: 'role', id: roleId },
				{ type: 'user', id: ids.carl! },
				{ type: 'user', id: ids.admin! }
			],
			{ permission: 'events.event.view', exclude: [ids.admin] }
		);
		expect(users).toEqual([ids.bob]);
		const everyone = await principalUserIds('events', [{ type: 'everyone', id: '*' }], {
			permission: 'events.event.view',
			everyone: true
		});
		expect(everyone.sort()).toEqual([ids.admin, ids.bob].sort());
		expect(
			await principalUserIds('events', [{ type: 'everyone', id: '*' }], {
				permission: 'events.event.view'
			})
		).toEqual([]);
	});
});

describe('Aktionen', () => {
	let actionId = '';

	it('Freigabe benachrichtigt die neue Person einmal (gleiche Stufe erneut: nichts)', async () => {
		const a = await api('admin', 'POST', '/actions/actions', {
			name: 'Sommerlager',
			startsOn: addDays(todayBerlin(), 30)
		});
		actionId = a.id;
		await api('admin', 'PUT', `/actions/actions/${actionId}/shares/${ids.bob}`, { level: 'edit' });
		expect(to('bob@example.test').map((m) => m.subject)).toEqual([
			'Administrator hat „Sommerlager“ mit dir geteilt'
		]);
		mails = [];
		await api('admin', 'PUT', `/actions/actions/${actionId}/shares/${ids.bob}`, { level: 'edit' });
		expect(mails).toHaveLength(0);
	});

	it('neue Anmeldung geht an Eigentümer*in und Bearbeitende', async () => {
		await notifyRegistration(
			{ ...admin, actor: { type: 'system', id: 'public-form', name: 'Formular' }, userId: null },
			{ actionId, actionName: 'Sommerlager', participantName: 'Lea Lustig', memberId: null }
		);
		expect(mails.map((m) => m.to).sort()).toEqual(['admin@example.test', 'bob@example.test']);
		expect(mails[0]!.subject).toBe('Neue Anmeldung für Sommerlager');
		expect(mails[0]!.text).toContain('Lea Lustig');
	});

	it('Abschluss durch Bob → Eigentümer*in; Wieder-Öffnen durch Eigentümer*in → Bob', async () => {
		await api('bob', 'POST', `/actions/actions/${actionId}/accounting/close`, {});
		expect(mails.map((m) => [m.to, m.subject])).toEqual([
			['admin@example.test', 'Abrechnung abgeschlossen: Sommerlager']
		]);
		mails = [];
		await api('admin', 'POST', `/actions/actions/${actionId}/accounting/reopen`, {});
		expect(mails.map((m) => [m.to, m.subject])).toEqual([
			['bob@example.test', 'Abrechnung wieder geöffnet: Sommerlager']
		]);
	});
});

describe('Termine (Standard aus)', () => {
	it('ohne Einschalten keine Mail; eingeschaltet: neu, verschoben, abgesagt', async () => {
		const startsOn = addDays(todayBerlin(), 10);
		const input = {
			title: 'Elternabend',
			startsOn,
			shares: [{ type: 'user', id: ids.bob, level: 'read' }]
		};
		await api('admin', 'POST', '/events/events', input);
		expect(mails).toHaveLength(0);

		const bob = await ctxOf(ids.bob!);
		for (const type of ['events.event-new', 'events.event-changed', 'events.event-cancelled']) {
			await setMyPreference(bob, { type, scope: '', channel: 'email' });
		}
		const e = await api('admin', 'POST', '/events/events', input);
		expect(to('bob@example.test').map((m) => m.subject)).toEqual(['Neuer Termin: Elternabend']);
		mails = [];
		// nur Beschreibung geändert → nichts
		await api('admin', 'PUT', `/events/events/${e.id}`, { ...input, description: 'Mit Kuchen' });
		expect(mails).toHaveLength(0);
		await api('admin', 'PUT', `/events/events/${e.id}`, {
			...input,
			startsOn: addDays(startsOn, 1)
		});
		expect(to('bob@example.test').map((m) => m.subject)).toEqual(['Termin geändert: Elternabend']);
		mails = [];
		await api('admin', 'DELETE', `/events/events/${e.id}`);
		expect(to('bob@example.test').map((m) => m.subject)).toEqual(['Termin abgesagt: Elternabend']);
		// Carl ohne Leserecht bekommt nie etwas
		expect(to('carl@example.test')).toHaveLength(0);
	});
});

describe('Galerien und Dateien', () => {
	it('Galerie geteilt → neue Person; erneutes Speichern ohne neue Freigabe → nichts', async () => {
		const input = {
			title: 'Pfingstlager',
			shares: [{ type: 'role', id: roleId, level: 'read' }]
		};
		const g = await api('admin', 'POST', '/galleries/galleries', input);
		expect(to('bob@example.test').map((m) => m.subject)).toEqual(['Neue Galerie: Pfingstlager']);
		mails = [];
		await api('admin', 'PUT', `/galleries/galleries/${g.id}`, input);
		expect(mails).toHaveLength(0);
	});

	it('Ordner geteilt → neue Person, nicht bei „ganzer Stamm“', async () => {
		const folder = await api('admin', 'POST', '/files/folders', { parentId: null, name: 'Fotos' });
		await api('admin', 'PUT', `/files/nodes/${folder.id}/shares`, {
			shares: [{ type: 'everyone', id: '*', level: 'read' }]
		});
		expect(mails).toHaveLength(0);
		await api('admin', 'PUT', `/files/nodes/${folder.id}/shares`, {
			shares: [
				{ type: 'everyone', id: '*', level: 'read' },
				{ type: 'user', id: ids.bob, level: 'edit' }
			]
		});
		expect(to('bob@example.test').map((m) => m.subject)).toEqual(['Ordner geteilt: Fotos']);
	});
});
