import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { confirmIfNeeded } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { STANDARD_FORM_KEYS as K } from '$modules/actions/schemas';
import { decryptHealthText } from '$modules/actions/health';
import type { FormConfig, PublicForm, PublicSubmitResult } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';

const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let actionId: string;
let token: string;
let kidId: string;
let otherKidId: string;
const sent: { to: string; subject: string; text: string }[] = [];

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token: bearer, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (bearer) headers.set('authorization', `Bearer ${bearer}`);
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
const actions = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, { token: keys[who], ...init });
const members = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: keys[who], ...init });
const pubGet = (who?: string) => {
	resetAllForTests();
	return api(`/modules/actions/public/forms/${token}`, { token: who ? keys[who] : undefined });
};
/** Anmelden; ohne Mitglied (Double-Opt-in) über den Link aus der Mail bestätigen */
const pubSubmit = async (
	who: string | undefined,
	values: Record<string, unknown>,
	extra: object = {}
) => {
	resetAllForTests();
	const before = sent.length;
	const res = await api(`/modules/actions/public/forms/${token}/submit`, {
		method: 'POST',
		token: who ? keys[who] : undefined,
		json: { values, ...extra }
	});
	return confirmIfNeeded(res, sent, api, before);
};
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function ctxOf(userId: string) {
	return (await contextForUser(userId))!.ctx;
}

const memberBody = (over: Record<string, unknown> = {}) => ({
	firstName: 'Kind',
	lastName: 'Muster',
	birthDate: '2016-05-04',
	street: 'Musterweg 1',
	postalCode: '28357',
	city: 'Bremen',
	stage: 'woelfling',
	...over
});

/** Antworten, wie sie eine Anmeldung MIT Mitglied sendet (keine Stammdaten) */
const memberValues = (over: Record<string, unknown> = {}) => ({
	[K.diet]: 'vegetarian',
	[K.allergies]: 'Pollen',
	[K.notes]: '',
	[K.privacy]: true,
	[K.disclaimer]: true,
	...over
});

async function participantRows() {
	return core.database.forModule('actions').transaction(async (tx) => {
		const r = (await tx.execute(
			sql`SELECT name, group_label, to_char(birth_date,'YYYY-MM-DD') AS birth_date, bremen_resident, juleica,
					diet, allergies, contact_email, member_id, user_id, source
				FROM action_participants WHERE action_id = ${actionId} ORDER BY created_at, name`
		)) as unknown as { rows: Record<string, unknown>[] };
		// Gesundheitsfelder sind verschlüsselt gespeichert
		return r.rows.map((row): Record<string, unknown> => ({
			...row,
			diet: decryptHealthText(row.diet),
			allergies: decryptHealthText(row.allergies)
		}));
	});
}

async function saveForm(over: Record<string, unknown> = {}) {
	const cfg = await data<FormConfig>(await actions('owner', `/actions/${actionId}/form`));
	return actions('owner', `/actions/${actionId}/form`, {
		method: 'PUT',
		json: {
			enabled: true,
			opensAt: null,
			closesAt: null,
			maxParticipants: null,
			intro: null,
			disclaimerTemplate: cfg.disclaimerTemplate,
			privacyUrl: 'https://example.org/datenschutz',
			definition: cfg.definition,
			requireLogin: false,
			...over
		}
	});
}

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			// Benachrichtigungen (core.notifications, z. B. „Neue Anmeldung“) prüft notifications-modules.test.ts
			if (m.headers?.['X-EP-Intern'] === 'notification') return;
			sent.push(m);
		}
	});
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
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...membersModule.manifest.permissions]
		})
	).key;

	const roles: Record<string, string[]> = {
		creator: ['core.api.manage', 'actions.action.view', 'actions.action.create'],
		plain: ['core.api.manage']
	};
	const roleIds: Record<string, string> = {};
	for (const [n, perms] of Object.entries(roles)) {
		roleIds[n] = await createRole(admin, { name: `role-${n}`, permissions: perms });
	}
	for (const [name, role] of [
		['owner', 'creator'],
		['parent', 'plain'],
		['stranger', 'plain']
	] as const) {
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		keys[name] = (
			await createApiKey(await ctxOf(userIds[name]!), { name: name, scopes: roles[role]! })
		).key;
	}

	// Mitglieder: Leiter + Gruppe, Kind (verknüpft mit „parent“), fremdes Kind
	const leader = (
		await data<{ id: string }>(
			await members('admin', '/members', {
				method: 'POST',
				json: memberBody({ firstName: 'Leiter' })
			}),
			201
		)
	).id;
	const group = (
		await data<{ id: string }>(
			await members('admin', '/groups', {
				method: 'POST',
				json: { name: 'Wölflinge', type: 'meute', leaderIds: [leader] }
			}),
			201
		)
	).id;
	kidId = (
		await data<{ id: string }>(
			await members('admin', '/members', {
				method: 'POST',
				json: memberBody({
					groupIds: [group],
					emails: [{ value: 'kind@example.test' }],
					custom: { ernaehrung: 'vegetarian', allergien: 'Pollen', juleica: true }
				})
			}),
			201
		)
	).id;
	otherKidId = (
		await data<{ id: string }>(
			await members('admin', '/members', {
				method: 'POST',
				json: memberBody({ firstName: 'Fremd', birthDate: '2015-01-02' })
			}),
			201
		)
	).id;
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id) VALUES (${kidId}, ${userIds.parent})`
		);
	});

	actionId = (
		await data<{ id: string }>(
			await actions('owner', '/actions', {
				method: 'POST',
				json: {
					name: 'Sommerlager',
					location: 'Cuxhaven',
					startsOn: '2026-07-10',
					endsOn: '2026-07-17'
				}
			}),
			201
		)
	).id;
	const cfg = await data<FormConfig>(await saveForm({ requireLogin: true }).then((r) => r), 200);
	token = cfg.token!;
});

describe('Formular-Konfiguration', () => {
	it('speichert „Anmeldung erzwingen“ und bindet Ernährung/Allergien an Mitgliedsfelder', async () => {
		const cfg = await data<FormConfig>(await actions('owner', `/actions/${actionId}/form`));
		expect(cfg.requireLogin).toBe(true);
		const f = (key: string) => cfg.definition.fields.find((x) => x.key === key)!;
		expect(f(K.diet).memberKey).toBe('ernaehrung');
		expect(f(K.allergies).memberKey).toBe('allergien');
	});

	it('Mitgliedsfelder lassen sich für den Builder abrufen (Bearbeiten-Recht nötig)', async () => {
		const r = await data<{ fields: { key: string }[] }>(
			await actions('owner', `/actions/${actionId}/form/member-fields`)
		);
		expect(r.fields.map((x) => x.key)).toContain('medikamente');
		const res = await actions('stranger', `/actions/${actionId}/form/member-fields`);
		expect([403, 404]).toContain(res.status);
	});
});

describe('Öffentliches Formular mit Konto', () => {
	it('anonym: Login-Pflicht erkennbar, keine Mitglieder', async () => {
		const f = await data<PublicForm>(await pubGet());
		expect(f.requireLogin).toBe(true);
		expect(f.viewer).toBeNull();
		expect(f.members).toEqual([]);
	});

	it('mit Konto: nur verknüpfte Mitglieder samt Vorbelegung', async () => {
		const f = await data<PublicForm>(await pubGet('parent'));
		expect(f.viewer).toEqual({ name: expect.any(String) });
		expect(f.members).toHaveLength(1);
		expect(f.members[0]).toMatchObject({
			id: kidId,
			name: 'Kind Muster',
			registered: false,
			prefill: { [K.diet]: 'vegetarian', [K.allergies]: 'Pollen' }
		});
		expect((await data<PublicForm>(await pubGet('stranger'))).members).toEqual([]);
	});
});

describe('Anmeldung erzwungen', () => {
	it('ohne Konto 401, ohne Mitglied 422, fremdes/nicht verknüpftes Mitglied 404', async () => {
		expect((await pubSubmit(undefined, memberValues())).status).toBe(401);
		expect((await pubSubmit(undefined, memberValues(), { memberId: kidId })).status).toBe(401);
		expect((await pubSubmit('parent', memberValues())).status).toBe(422);
		expect((await pubSubmit('parent', memberValues(), { memberId: otherKidId })).status).toBe(404);
		expect((await pubSubmit('stranger', memberValues(), { memberId: kidId })).status).toBe(404);
		expect((await pubSubmit('parent', memberValues(), { memberId: 'kein-uuid' })).status).toBe(422);
		expect(await participantRows()).toHaveLength(0);
	});

	it('Stammdaten kommen vom Server; Client-Stammdaten werden abgelehnt', async () => {
		const res = await pubSubmit('parent', memberValues({ [K.name]: 'Hacker' }), {
			memberId: kidId
		});
		expect(res.status).toBe(422);
		expect(await participantRows()).toHaveLength(0);
	});

	it('legt die Anmeldung aus dem Mitgliedsprofil an und schreibt Änderungen zurück', async () => {
		const r = await data<PublicSubmitResult>(
			await pubSubmit(
				'parent',
				memberValues({ [K.diet]: 'vegan', [K.allergies]: 'Pollen, Nüsse' }),
				{
					memberId: kidId
				}
			),
			201
		);
		expect(r.name).toBe('Kind Muster');
		expect(r.memberUpdated).toBe(true);
		const [p] = await participantRows();
		expect(p).toMatchObject({
			name: 'Kind Muster',
			group_label: 'Wölflinge',
			birth_date: '2016-05-04',
			bremen_resident: true,
			juleica: true,
			diet: 'vegan',
			allergies: 'Pollen, Nüsse',
			contact_email: 'kind@example.test',
			member_id: kidId,
			user_id: userIds.parent,
			source: 'link'
		});
		expect(sent.at(-1)!.to).toBe('kind@example.test');
		// am Mitglied gespeichert
		const m = await data<{ custom: Record<string, unknown> }>(
			await members('admin', `/members/${kidId}`)
		);
		expect(m.custom).toMatchObject({ ernaehrung: 'vegan', allergien: 'Pollen, Nüsse' });
		// Vorbelegung zeigt jetzt die neuen Werte und „angemeldet“
		const f = await data<PublicForm>(await pubGet('parent'));
		expect(f.members[0]).toMatchObject({
			registered: true,
			prefill: { [K.diet]: 'vegan', [K.allergies]: 'Pollen, Nüsse' }
		});
	});

	it('dasselbe Mitglied kann nicht zweimal angemeldet werden (409)', async () => {
		const res = await pubSubmit('parent', memberValues(), { memberId: kidId });
		expect(res.status).toBe(409);
		expect(await participantRows()).toHaveLength(1);
	});

	it('Datenschutz-Zustimmung bleibt Pflicht', async () => {
		const res = await pubSubmit('parent', memberValues({ [K.privacy]: false }), {
			memberId: kidId
		});
		expect(res.status).toBe(422);
	});
});

describe('Anmeldung optional (Gäste anderer Stämme)', () => {
	const guest = (over: Record<string, unknown> = {}) => ({
		[K.name]: 'Gast Fremdstamm',
		[K.group]: 'Anderer Stamm',
		[K.birthDate]: '2015-03-03',
		[K.bremenResident]: 'no',
		[K.diet]: 'meat',
		[K.allergies]: '',
		[K.notes]: '',
		[K.email]: 'gast@example.test',
		[K.privacy]: true,
		[K.disclaimer]: true,
		...over
	});

	it('Erzwingen aus: anonym normal, ohne Mitglied-Bezug', async () => {
		await data(await saveForm({ requireLogin: false }));
		expect((await data<PublicForm>(await pubGet())).requireLogin).toBe(false);
		const r = await data<PublicSubmitResult>(await pubSubmit(undefined, guest()), 201);
		expect(r.name).toBe('Gast Fremdstamm');
		expect(r.memberUpdated).toBeUndefined();
		const rows = await participantRows();
		expect(rows.find((x) => x.name === 'Gast Fremdstamm')).toMatchObject({
			member_id: null,
			user_id: null
		});
	});

	it('eingeloggt darf trotzdem „andere Person“ anmelden (ohne memberId)', async () => {
		const r = await data<PublicSubmitResult>(
			await pubSubmit(
				'parent',
				guest({ [K.name]: 'Freund Fremd', [K.email]: 'freund@example.test' })
			),
			201
		);
		expect(r.name).toBe('Freund Fremd');
	});

	it('deaktiviertes Mitgliedsfeld: Anmeldung klappt, Rückschreiben entfällt', async () => {
		const defs = await data<{
			fields: { key: string; active: boolean; field: Record<string, unknown> }[];
		}>(await members('admin', '/fields'));
		await data(
			await members('admin', '/fields', {
				method: 'PUT',
				json: {
					fields: defs.fields.map((d) => ({ active: d.key !== 'allergien', field: d.field }))
				}
			})
		);
		await core.database.forModule('actions').transaction(async (tx) => {
			await tx.execute(sql`DELETE FROM action_participants WHERE member_id IS NOT NULL`);
		});
		const r = await data<PublicSubmitResult>(
			await pubSubmit('parent', memberValues({ [K.diet]: 'vegan', [K.allergies]: 'Neu' }), {
				memberId: kidId
			}),
			201
		);
		// Ernährung unverändert, Allergien-Feld inaktiv → nichts zu speichern
		expect(r.memberUpdated).toBe(false);
	});
});

describe('Abhängigkeit zwischen den Modulen', () => {
	it('Mitglieder lässt sich nicht deaktivieren, solange Aktionen aktiv ist', async () => {
		await expect(disableModule(admin, 'members')).rejects.toMatchObject({ status: 409 });
	});

	it('Aktionen nicht aktivierbar ohne Mitglieder; Dienstabruf prüft Abhängigkeit und Status', async () => {
		await disableModule(admin, 'actions');
		await disableModule(admin, 'members');
		await expect(enableModule(admin, 'actions')).rejects.toMatchObject({ status: 409 });
		await expect(core.modules.use('members', 'actions')).rejects.toMatchObject({
			code: 'module_disabled'
		});
		await expect(core.modules.use('actions', 'members')).rejects.toThrow(/Abhängigkeit/);
		await enableModule(admin, 'members');
		await enableModule(admin, 'actions');
		expect(await core.modules.use('members', 'actions')).toBeTruthy();
	});
});
