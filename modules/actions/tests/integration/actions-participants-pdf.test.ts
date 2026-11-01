import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { setPdfRendererForTests } from '$testing';
import { core } from '$lib/sdk/server';
import { eq, sql } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

let admin: RequestContext;
const keys: Record<string, string> = {};
let adminKey: string;
let html = '';

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
	api(`/modules/actions${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status?: number): Promise<T> {
	const body = await res.json();
	if (status) expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const BASE_PERMS = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	owner: [...BASE_PERMS, 'actions.action.create', 'members.data.export'],
	noexport: [...BASE_PERMS, 'actions.action.create'],
	stranger: [...BASE_PERMS, 'members.data.export']
};

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const mdb = () => core.database.forModule('actions');

async function createAction(who: string, name: string): Promise<string> {
	return (
		await data<{ id: string }>(
			await as(who, '/actions', {
				method: 'POST',
				json: {
					name,
					description: null,
					location: 'Wald',
					startsOn: '2026-07-10',
					startsTime: null,
					endsOn: '2026-07-17',
					endsTime: null
				}
			}),
			201
		)
	).id;
}
const addParticipant = async (actionId: string, json: Record<string, unknown>) =>
	(
		await data<{ id: string }>(
			await as('owner', `/actions/${actionId}/participants`, { method: 'POST', json }),
			201
		)
	).id;

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
	adminKey = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...membersModule.manifest.permissions]
		})
	).key;
	for (const [name, perms] of Object.entries(ROLES)) {
		const role = await createRole(admin, { name: `role-${name}`, permissions: perms });
		const id = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [role]
		});
		keys[name] = (await createApiKey(await ctxOf(id), { name: `key-${name}`, scopes: perms })).key;
	}
	setPdfRendererForTests(async (h) => {
		html = h;
		return new TextEncoder().encode('%PDF-fake');
	});
});

afterAll(() => setPdfRendererForTests(undefined));

describe('GET /actions/:id/participants.pdf', () => {
	it('Liste (Fahrt) für Teilnehmende (manuell) und Team getrennt, mit Gesundheitsangaben', async () => {
		const id = await createAction('owner', 'Sommerlager PDF');
		await addParticipant(id, {
			name: 'Paula Pfad',
			birthDate: '2013-04-02',
			groupLabel: 'Sippe Falke',
			role: 'participant',
			diet: 'vegan',
			allergies: 'Erdnüsse',
			notes: 'Braucht Nachtlicht'
		});
		await addParticipant(id, { name: 'Tim Team', role: 'team', juleica: true });

		const res = await as('owner', `/actions/${id}/participants.pdf`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-disposition')).toMatch(/Sommerlager-PDF-teilnehmende\.pdf/);
		expect(res.headers.get('cache-control')).toContain('no-store');
		expect(html).toContain('Teilnehmende – Sommerlager PDF');
		expect(html).toContain('Team – Sommerlager PDF');
		expect(html.indexOf('Paula Pfad')).toBeLessThan(html.indexOf('Tim Team'));
		expect(html).toContain('Erdnüsse');
		expect(html).toContain('Braucht Nachtlicht');
		expect(html).toContain('Vegan');
		expect(html).toContain('Sippe Falke');
		expect(html).toContain('Vertraulich');
		const { rows } = await listAudit({ action: 'actions.participants.sheet', limit: 5 });
		expect(rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/Paula|Erdn/);
	});

	it('verknüpftes Mitglied: Anschrift, Telefon und Zusatzfelder kommen aus den Mitgliedsdaten', async () => {
		const id = await createAction('owner', 'Fahrt mit Mitglied');
		const member = (
			await data<{ id: string }>(
				await api('/modules/members/members', {
					token: adminKey,
					method: 'POST',
					json: {
						firstName: 'Mira',
						lastName: 'Mitglied',
						birthDate: '2012-05-17',
						street: 'Hauptstraße 5',
						postalCode: '28195',
						city: 'Bremen',
						stage: 'pfadfinder',
						phones: [{ name: 'Vater', value: '+49 421 555123' }],
						custom: { medikamente: 'Insulin' }
					}
				}),
				201
			)
		).id;
		const pid = await addParticipant(id, { name: 'Mira Mitglied', role: 'participant' });
		await mdb().transaction((tx) =>
			tx.execute(sql`UPDATE action_participants SET member_id = ${member} WHERE id = ${pid}`)
		);
		// Voreinstellung „Fahrt“: Notfall-Telefon und Medikamente aus dem Mitglied, ohne Anschrift
		const fahrt = await as('owner', `/actions/${id}/participants.pdf`);
		expect(fahrt.status).toBe(200);
		expect(html).toContain('Vater: +49 421 555123');
		expect(html).toContain('Insulin');
		expect(html).not.toContain('Hauptstraße 5');
		const res = await as('owner', `/actions/${id}/participants.pdf`, {
			method: 'POST',
			json: {
				selection: { columns: ['name', 'role', 'address', 'phone', 'field.medikamente'] }
			}
		});
		expect(res.status).toBe(200);
		expect(html).toContain('Hauptstraße 5');
		expect(html).toContain('+49 421 555123');
		expect(html).toContain('Insulin');
		expect(html).toContain('Teilnehmer*in');
	});

	it('POST mit Spaltenauswahl: nur gewählte Spalten, Aktionsspalten, Audit mit Spaltenzahl', async () => {
		const id = await createAction('owner', 'Auswahlfahrt');
		await addParticipant(id, {
			name: 'Sven Spalte',
			role: 'participant',
			allergies: 'Gluten',
			notes: 'Hinweis X'
		});
		const res = await as('owner', `/actions/${id}/participants.pdf`, {
			method: 'POST',
			json: { selection: { columns: ['name', 'notes'], hideEmpty: true } }
		});
		expect(res.status).toBe(200);
		expect(html).toContain('Hinweise');
		expect(html).toContain('Hinweis X');
		expect(html).not.toContain('Gluten');
		const { rows } = await listAudit({ action: 'actions.participants.sheet', limit: 1 });
		expect(JSON.stringify(rows[0]!.metadata)).toContain('"columns":2');
		const bad = (selection: unknown) =>
			as('owner', `/actions/${id}/participants.pdf`, { method: 'POST', json: { selection } });
		expect((await bad({ columns: [] })).status).toBe(422);
		expect(
			(
				await as('owner', `/actions/${id}/participants.pdf`, {
					method: 'POST',
					json: { selection: { columns: ['name'] }, extra: 1 }
				})
			).status
		).toBe(422);
		expect(
			(
				await as('noexport', `/actions/${id}/participants.pdf`, {
					method: 'POST',
					json: {}
				})
			).status
		).toBe(404);
	});

	it('GET participants/pdf-columns: Katalog mit Aktionsspalten, Rechte wie die PDF-Erzeugung', async () => {
		const id = await createAction('owner', 'Katalogfahrt');
		const cat = await data<{
			columns: { key: string; group: string }[];
			presets: { id: string; keys: string[] }[];
		}>(await as('owner', `/actions/${id}/participants/pdf-columns`), 200);
		const keys = cat.columns.map((c) => c.key);
		expect(keys.slice(0, 2)).toEqual(['name', 'role']);
		expect(keys).toEqual(expect.arrayContaining(['fee', 'juleica', 'notes', 'field.allergien']));
		expect(cat.presets.find((p) => p.id === 'fahrt')!.keys).toContain('notes');
		const own = await createAction('noexport', 'Eigener Katalog');
		expect((await as('noexport', `/actions/${own}/participants/pdf-columns`)).status).toBe(403);
		expect((await as('stranger', `/actions/${id}/participants/pdf-columns`)).status).toBe(404);
		expect((await api(`/modules/actions/actions/${id}/participants/pdf-columns`)).status).toBe(401);
	});

	it('Rechte: ohne members.data.export 403, fremde Aktion 404, ohne Anmeldung 401', async () => {
		const id = await createAction('owner', 'Geheime Fahrt');
		await addParticipant(id, { name: 'Gina Geheim', role: 'participant' });
		expect((await as('noexport', `/actions/${id}/participants.pdf`)).status).toBe(404);
		// eigene Aktion, aber ohne Sonderrecht → 403
		const own = await createAction('noexport', 'Eigene Fahrt');
		expect((await as('noexport', `/actions/${own}/participants.pdf`)).status).toBe(403);
		// fremde Aktion hat Vorrang vor dem Rechtetest: 404 statt 403
		expect((await as('stranger', `/actions/${id}/participants.pdf`)).status).toBe(404);
		expect((await api(`/modules/actions/actions/${id}/participants.pdf`)).status).toBe(401);
		expect((await as('owner', `/actions/${crypto.randomUUID()}/participants.pdf`)).status).toBe(
			404
		);
	});

	it('leere Aktion liefert trotzdem ein PDF', async () => {
		const id = await createAction('owner', 'Leere Fahrt');
		const res = await as('owner', `/actions/${id}/participants.pdf`);
		expect(res.status).toBe(200);
		expect(html).toContain('Keine Personen.');
	});
});
