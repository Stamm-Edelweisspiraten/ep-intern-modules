/**
 * KI-Schreibhilfe: Status je Person, Rechte `<modul>.ai.use`, Kontext nur mit Zugriff (fremde Aktion 404),
 * nur per Session, Maskieren von Kontaktdaten, Platzhalter-Prüfung, Varianten, Limit je Person, heikle
 * Daten nur mit Einstellung, Audit ohne Text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getAuth } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { setSettings } from '$testing';
import { setOpenAiClientFactoryForTests, type AiChatParams, type AiClient } from '$testing';
import { parseSseChunk } from '$lib/sdk/client/assist';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import messagesModule from '$modules/messages/module';
import notesModule from '$modules/notes/module';
import type { AssistEvent, AssistStatus, RequestContext } from '$lib/sdk/types';

const ORIGIN = 'http://localhost:5173';
const PW = 'assist-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const cookies: Record<string, string> = {};
let actionId = '';

let calls: AiChatParams[] = [];
let reply = '<p>Hallo {name}, wir fahren los.</p>';
let usage = { inputTokens: 100, outputTokens: 50 };

const fakeClient: AiClient = {
	async complete(p) {
		calls.push(p);
		return { text: reply, ...usage };
	},
	async *stream(p) {
		calls.push(p);
		for (const part of reply.match(/.{1,8}/gs) ?? []) yield { delta: part };
		yield { usage };
	}
};

async function signIn(email: string): Promise<string> {
	const res = await getAuth().api.signInEmail({
		body: { email, password: PW },
		returnHeaders: true
	});
	return res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
}

async function call(
	auth: { cookie?: string; key?: string },
	method: string,
	path: string,
	json?: unknown
) {
	resetAllForTests();
	const headers = new Headers();
	if (auth.key) headers.set('authorization', `Bearer ${auth.key}`);
	if (auth.cookie) {
		headers.set('cookie', auth.cookie);
		headers.set('origin', ORIGIN);
	}
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ORIGIN}/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
}

async function json(
	auth: { cookie?: string; key?: string },
	method: string,
	path: string,
	body?: unknown
) {
	const res = await call(auth, method, path, body);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { status: res.status, body: (await res.json()) as any };
}

/** Ruft `/ai/assist` auf und liest alle SSE-Ereignisse */
async function assist(name: string, body: Record<string, unknown>) {
	const res = await call({ cookie: cookies[name] }, 'POST', '/ai/assist', body);
	if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return { status: res.status, events: [] as AssistEvent[], error: (await res.json()) as any };
	}
	const events: AssistEvent[] = [];
	parseSseChunk((await res.text()) + '\n\n', (e) => events.push(e));
	return { status: res.status, events, error: null };
}

const done = (events: AssistEvent[]) =>
	events.find((e): e is Extract<AssistEvent, { type: 'done' }> => e.type === 'done');

async function user(name: string, email: string, roleIds: string[]) {
	await createUser(admin, { name, email, password: PW, roleIds });
	cookies[name] = await signIn(email);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(messagesModule);
	registerModule(notesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', PW);
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = (await contextForUser(u!.id))!.ctx;
	for (const m of ['members', 'actions', 'messages', 'notes']) await enableModule(admin, m);
	admin = (await contextForUser(u!.id))!.ctx;
	await setSettings(admin, { 'core.ai.apiKey': 'sk-test', 'core.ai.defaultModel': 'test-model' });
	setOpenAiClientFactoryForTests(() => fakeClient);

	const writer = await createRole(admin, {
		name: 'Schreibende',
		permissions: [
			'actions.action.view',
			'actions.action.create',
			'actions.ai.use',
			'messages.message.send',
			'messages.ai.use',
			'notes.note.view',
			'notes.note.create',
			'notes.ai.use',
			'core.api.manage'
		]
	});
	const stranger = await createRole(admin, {
		name: 'Fremde',
		permissions: [
			'actions.action.view',
			'actions.ai.use',
			'messages.message.send',
			'messages.ai.use',
			'notes.note.view',
			'notes.ai.use'
		]
	});
	const noAi = await createRole(admin, {
		name: 'Ohne KI',
		permissions: ['actions.action.view', 'actions.action.create', 'messages.message.send']
	});
	await user('Lea', 'lea@example.test', [writer]);
	await user('Max', 'max@example.test', [stranger]);
	await user('Ole', 'ole@example.test', [noAi]);

	const created = await json({ cookie: cookies.Lea }, 'POST', '/modules/actions/actions', {
		name: 'Herbstfahrt 2026',
		location: 'Jugendhof Steinkimmen',
		startsOn: '2026-11-13',
		endsOn: '2026-11-15'
	});
	expect(created.status).toBe(201);
	actionId = created.body.data.id;
	const p = await json(
		{ cookie: cookies.Lea },
		'POST',
		`/modules/actions/actions/${actionId}/participants`,
		{
			name: 'Mila Geheimname',
			role: 'participant'
		}
	);
	expect(p.status).toBe(201);
});

afterAll(async () => {
	setOpenAiClientFactoryForTests(undefined);
	await close();
});

beforeEach(() => {
	calls = [];
	reply = '<p>Hallo {name}, wir fahren los.</p>';
	usage = { inputTokens: 100, outputTokens: 50 };
});

describe('Status', () => {
	it('nennt nur Module mit Recht und deren Textstellen', async () => {
		const lea = await json({ cookie: cookies.Lea }, 'GET', '/ai/assist/status');
		const s = lea.body.data as AssistStatus;
		expect(s.configured).toBe(true);
		expect(s.modules.sort()).toEqual(['actions', 'messages', 'notes']);
		expect(s.purposes['messages:mail']?.format).toBe('rich');
		expect(s.purposes['actions:action-description']?.tasks).toContain('draft');
		expect(s.address).toBe('du');
		const ole = (await json({ cookie: cookies.Ole }, 'GET', '/ai/assist/status')).body
			.data as AssistStatus;
		expect(ole.modules).toEqual([]);
		expect(ole.purposes).toEqual({});
	});

	it('ohne Schlüssel: nicht eingerichtet, Anfrage 503', async () => {
		await setSettings(admin, { 'core.ai.apiKey': null });
		const s = (await json({ cookie: cookies.Lea }, 'GET', '/ai/assist/status')).body
			.data as AssistStatus;
		expect(s.configured).toBe(false);
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: 'x'
		});
		expect(r.status).toBe(503);
		await setSettings(admin, { 'core.ai.apiKey': 'sk-test' });
	});
});

describe('Vorschlag erzeugen', () => {
	it('streamt den Text, bereinigt ihn und meldet erhaltene Platzhalter', async () => {
		reply = '<p onclick="x()">Hallo {name}, wir fahren los.</p><script>bad()</script>';
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'friendly',
			text: '<p>Hallo {name}, Abfahrt.</p>'
		});
		expect(r.status).toBe(200);
		expect(r.events.some((e) => e.type === 'delta')).toBe(true);
		const d = done(r.events)!;
		expect(d.text).toBe('<p>Hallo {name}, wir fahren los.</p>');
		expect(d.checks).toContainEqual({ level: 'ok', message: 'Platzhalter erhalten: {name}' });
		expect(d.tokens).toBe(150);
		expect(calls[0]!.model).toBe('test-model');
	});

	it('maskiert Kontaktdaten vor dem Anbieter und setzt sie danach wieder ein', async () => {
		reply = '<p>Fragen an [E-Mail 1] oder [Telefon 1].</p>';
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'shorter',
			text: 'Fragen an lea@example.test oder 0421 123 4567, bitte.'
		});
		const sent = JSON.stringify(calls[0]!.messages);
		expect(sent).not.toContain('lea@example.test');
		expect(sent).not.toContain('4567');
		expect(done(r.events)!.text).toBe('<p>Fragen an lea@example.test oder 0421 123 4567.</p>');
	});

	it('holt Eckdaten der Aktion – ohne Teilnehmende', async () => {
		const r = await assist('Lea', {
			module: 'actions',
			purpose: 'action-description',
			task: 'draft',
			text: 'Schlafsack mitbringen',
			context: { module: 'actions', kind: 'action', id: actionId },
			extra: { location: 'Neuer Ort', unknown: 'darf nicht rein' }
		});
		expect(r.status).toBe(200);
		const d = done(r.events)!;
		expect(d.facts.Aktion).toBe('Herbstfahrt 2026');
		expect(d.facts.Zeitraum).toBe('13.11.2026 bis 15.11.2026');
		expect(d.facts['Ort (Formular)']).toBe('Neuer Ort');
		const sent = JSON.stringify(calls[0]!.messages);
		expect(sent).toContain('Jugendhof Steinkimmen');
		expect(sent).not.toContain('Mila Geheimname');
		expect(sent).not.toContain('darf nicht rein');
		// Textstelle mit reinem Text: HTML der Antwort wird entfernt
		expect(d.text).toBe('Hallo {name}, wir fahren los.');
	});

	it('Kontext aus Nachrichten heraus (Info-Mail an Teilnehmende)', async () => {
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: '',
			context: { module: 'actions', kind: 'action', id: actionId }
		});
		expect(done(r.events)!.facts.Ort).toBe('Jugendhof Steinkimmen');
	});

	it('liefert Betreff-Varianten', async () => {
		reply = JSON.stringify({ variants: ['Herbstfahrt 13.–15. November', 'Packliste Herbstfahrt'] });
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail-subject',
			task: 'subject',
			text: '<p>Herbstfahrt</p>'
		});
		expect(done(r.events)!.variants).toEqual([
			'Herbstfahrt 13.–15. November',
			'Packliste Herbstfahrt'
		]);
	});

	it('warnt, wenn ein Platzhalter im Disclaimer verloren geht', async () => {
		reply = 'Bitte überweist den Beitrag für {{aktion}}.';
		const r = await assist('Lea', {
			module: 'actions',
			purpose: 'registration-disclaimer',
			task: 'friendly',
			text: 'Bitte überweist {{beitrag}} für {{aktion}}.',
			context: { module: 'actions', kind: 'action', id: actionId }
		});
		expect(done(r.events)!.checks).toContainEqual({
			level: 'warning',
			message: 'Platzhalter fehlt: {{beitrag}}'
		});
	});

	it('schreibt das Audit nur mit Zählern und Verbrauch mit Person', async () => {
		await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'spelling',
			text: 'Geheimer Text'
		});
		const { rows } = await listAudit({ action: 'core.ai.assist_used' });
		const last = rows[0]!;
		expect(JSON.stringify(last)).not.toContain('Geheimer Text');
		expect(last.metadata).toMatchObject({ module: 'messages', purpose: 'mail', task: 'spelling' });
		const usageRows = await getDb().select().from(schema.aiUsage);
		expect(usageRows.some((u) => u.actorId && u.moduleId === 'messages')).toBe(true);
	});
});

describe('Notizen', () => {
	let noteId = '';
	beforeAll(async () => {
		const n = await json({ cookie: cookies.Lea }, 'POST', '/modules/notes/notes', {
			title: 'Planung Herbstfahrt',
			markdown: '# Planung\n\nZelte prüfen'
		});
		expect(n.status).toBe(201);
		noteId = n.body.data.id;
	});

	it('Auswahl überarbeiten: Titel als Eckdaten, Tabellen bleiben erhalten', async () => {
		reply = '<table><tr><th>Was</th><td>Zelte</td></tr></table><p onclick="x()">Fertig</p>';
		const r = await assist('Lea', {
			module: 'notes',
			purpose: 'note-selection',
			task: 'shorter',
			text: '<p>Zelte prüfen und zählen</p>',
			context: { module: 'notes', kind: 'note', id: noteId }
		});
		expect(r.status).toBe(200);
		const d = done(r.events)!;
		expect(d.facts['Titel der Notiz']).toBe('Planung Herbstfahrt');
		expect(d.text).toBe('<table><tr><th>Was</th><td>Zelte</td></tr></table><p>Fertig</p>');
	});

	it('Aufgaben ableiten liefert Einträge', async () => {
		reply = JSON.stringify({ items: ['Zelte zählen', 'Heringe kaufen'] });
		const r = await assist('Lea', {
			module: 'notes',
			purpose: 'note-write',
			task: 'todos',
			text: 'Zelte prüfen, Heringe fehlen',
			context: { module: 'notes', kind: 'note', id: noteId }
		});
		expect(done(r.events)!.items).toEqual(['Zelte zählen', 'Heringe kaufen']);
	});

	it('fremde Notiz als Kontext 404', async () => {
		const r = await assist('Max', {
			module: 'notes',
			purpose: 'note-write',
			task: 'summarize',
			text: 'x',
			context: { module: 'notes', kind: 'note', id: noteId }
		});
		expect(r.status).toBe(404);
	});
});

describe('Rechte und Grenzen', () => {
	it('ohne <modul>.ai.use 403', async () => {
		const r = await assist('Ole', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: 'x'
		});
		expect(r.status).toBe(403);
	});

	it('fremde Aktion als Kontext 404', async () => {
		const r = await assist('Max', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: '',
			context: { module: 'actions', kind: 'action', id: actionId }
		});
		expect(r.status).toBe(404);
		expect(calls).toHaveLength(0);
	});

	it('nicht vorgesehener Kontext 400, unbekannte Textstelle 404, falsche Aufgabe 400', async () => {
		const ctxWrong = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: '',
			context: { module: 'messages', kind: 'inbox-message', id: 'x' }
		});
		expect(ctxWrong.status).toBe(400);
		expect(
			(await assist('Lea', { module: 'messages', purpose: 'gibts-nicht', task: 'draft', text: '' }))
				.status
		).toBe(404);
		expect(
			(
				await assist('Lea', {
					module: 'messages',
					purpose: 'mail-subject',
					task: 'draft',
					text: ''
				})
			).status
		).toBe(400);
	});

	it('„Nach Wunsch ändern“ ohne Wunsch 422', async () => {
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'rewrite',
			text: 'x'
		});
		expect(r.status).toBe(422);
	});

	it('per API-Key nicht erreichbar', async () => {
		const leaId = (
			await getDb().select().from(schema.user).where(eq(schema.user.email, 'lea@example.test'))
		)[0]!.id;
		const leaCtx = (await contextForUser(leaId))!.ctx;
		const { key } = await createApiKey(leaCtx, { name: 'k', scopes: ['messages.ai.use'] });
		const res = await call({ key }, 'POST', '/ai/assist', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: 'x'
		});
		expect(res.status).toBe(403);
	});

	it('Limit je Person 429', async () => {
		await setSettings(admin, { 'core.ai.userMonthlyTokenLimit': 1 });
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: 'x'
		});
		expect(r.status).toBe(429);
		await setSettings(admin, { 'core.ai.userMonthlyTokenLimit': 200_000 });
	});

	it('Modul deaktiviert: Textstelle unbekannt', async () => {
		await disableModule(admin, 'messages');
		const r = await assist('Lea', {
			module: 'messages',
			purpose: 'mail',
			task: 'draft',
			text: 'x'
		});
		expect(r.status).toBe(404);
		await enableModule(admin, 'messages');
	});
});
