import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { createRole } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import type { MembersService } from '$modules/members/contract';
import type { RequestContext } from '$lib/sdk/types';

const BASE = '/modules/members';
let admin: RequestContext;
let fullKey: string;
let viewKey: string;
let parentCtx: RequestContext;
let otherCtx: RequestContext;
const service = membersModule.provides as unknown as MembersService;

function api(path: string, token: string, init: RequestInit & { json?: unknown } = {}) {
	resetAllForTests();
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${BASE}${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const memberBody = (over: Record<string, unknown> = {}) => ({
	firstName: 'Max',
	lastName: 'Muster',
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '28357',
	city: 'Bremen',
	stage: 'pfadfinder',
	...over
});
const createMember = async (over: Record<string, unknown> = {}) =>
	(
		await data<{ id: string; custom: Record<string, unknown> }>(
			await api('/members', fullKey, { method: 'POST', json: memberBody(over) }),
			201
		)
	).id;

interface Def {
	key: string;
	active: boolean;
	preset: boolean;
	field: Record<string, unknown>;
}
const getDefs = async () => (await data<{ fields: Def[] }>(await api('/fields', fullKey))).fields;
const asList = (defs: Def[]) => defs.map((d) => ({ active: d.active, field: d.field }));
const putDefs = (fields: { active?: boolean; field: Record<string, unknown> }[]) =>
	api('/fields', fullKey, { method: 'PUT', json: { fields } });

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);
	fullKey = (
		await createApiKey(admin, { name: 'full', scopes: [...membersModule.manifest.permissions] })
	).key;
	viewKey = (await createApiKey(admin, { name: 'v', scopes: ['members.member.view'] })).key;
	const role = await createRole(admin, { name: 'leer', permissions: [] });
	const mk = async (n: string) =>
		ctxOf(
			await createUser(admin, {
				name: n,
				email: `${n}@example.test`,
				password: 'parent-password-123',
				roleIds: [role]
			})
		);
	parentCtx = await mk('eltern');
	otherCtx = await mk('fremd');
});

describe('Zusatzfelder (Vorlagen und eigene)', () => {
	it('liefert die vordefinierten Felder in fester Reihenfolge', async () => {
		const defs = await getDefs();
		expect(defs.map((d) => d.key)).toEqual([
			'ernaehrung',
			'allergien',
			'medikamente',
			'gesundheit',
			'schwimmen',
			'zecken',
			'tetanus',
			'krankenkasse',
			'notfallkontakt',
			'juleica'
		]);
		expect(defs.every((d) => d.preset && d.active)).toBe(true);
		const diet = defs[0]!.field as { options: { value: string }[]; type: string };
		expect(diet.type).toBe('select');
		expect(diet.options.map((o) => o.value)).toEqual(['meat', 'vegetarian', 'vegan']);
	});

	it('PUT: umbenennen, deaktivieren, eigenes Feld; Vorlagen nicht löschbar, Typ fest', async () => {
		const list = asList(await getDefs());
		const renamed = list.map((d) =>
			d.field.key === 'allergien' ? { ...d, field: { ...d.field, label: 'Allergien (neu)' } } : d
		);
		renamed.find((d) => d.field.key === 'tetanus')!.active = false;
		const tshirt = {
			active: true,
			field: {
				id: 'tshirt',
				key: 'tshirt',
				type: 'select',
				label: 'T-Shirt-Größe',
				options: [
					{ value: 's', label: 'S' },
					{ value: 'm', label: 'M' }
				]
			}
		};
		await data(await putDefs([...renamed, tshirt]));
		const after = await getDefs();
		expect(after.find((d) => d.key === 'allergien')!.field.label).toBe('Allergien (neu)');
		expect(after.find((d) => d.key === 'tetanus')!.active).toBe(false);
		expect(after.at(-1)).toMatchObject({ key: 'tshirt', preset: false, active: true });

		const all = [...renamed, tshirt];
		expect((await putDefs(all.filter((d) => d.field.key !== 'juleica'))).status).toBe(422);
		const retyped = all.map((d) =>
			d.field.key === 'zecken' ? { ...d, field: { ...d.field, type: 'text' } } : d
		);
		expect((await putDefs(retyped)).status).toBe(422);
		expect((await putDefs([...all, tshirt])).status).toBe(422);
		const number = { active: true, field: { id: 'z', key: 'zahl', type: 'number', label: 'Zahl' } };
		expect((await putDefs([...all, number])).status).toBe(422);
	});

	it('eigenes Feld lässt sich entfernen; nur members.field.manage ändert', async () => {
		const keep = asList((await getDefs()).filter((d) => d.key !== 'tshirt'));
		await data(await putDefs(keep));
		expect((await getDefs()).some((d) => d.key === 'tshirt')).toBe(false);
		expect((await api('/fields', viewKey)).status).toBe(200);
		const res = await api('/fields', viewKey, { method: 'PUT', json: { fields: keep } });
		expect(res.status).toBe(403);
	});
});

describe('Werte am Mitglied', () => {
	let id: string;

	it('speichert gültige Werte, lehnt unbekannte/ungültige ab', async () => {
		id = await createMember({ custom: { ernaehrung: 'vegan', allergien: 'Nüsse', zecken: true } });
		const m = await data<{ custom: Record<string, unknown> }>(await api(`/members/${id}`, fullKey));
		expect(m.custom).toEqual({ ernaehrung: 'vegan', allergien: 'Nüsse', zecken: true });
		for (const custom of [{ ernaehrung: 'pizza' }, { gibtsnicht: 'x' }, { zecken: 'ja' }]) {
			const bad = await api('/members', fullKey, {
				method: 'POST',
				json: memberBody({ firstName: 'Bad', custom })
			});
			expect(bad.status, JSON.stringify(custom)).toBe(422);
		}
	});

	it('Update führt zusammen (fehlende Schlüssel bleiben, leer löscht)', async () => {
		const res = await api(`/members/${id}`, fullKey, {
			method: 'PUT',
			json: memberBody({ custom: { medikamente: 'Ibu 400', allergien: '' } })
		});
		const m = await data<{ custom: Record<string, unknown> }>(res);
		expect(m.custom).toEqual({ ernaehrung: 'vegan', zecken: true, medikamente: 'Ibu 400' });
	});

	it('deaktiviertes Feld bleibt gespeichert, ist aber nicht mehr beschreibbar', async () => {
		const defs = await getDefs();
		await data(
			await putDefs(defs.map((d) => ({ active: d.key !== 'medikamente', field: d.field })))
		);
		const m = await data<{ custom: Record<string, unknown> }>(await api(`/members/${id}`, fullKey));
		expect(m.custom.medikamente).toBe('Ibu 400');
		const res = await api(`/members/${id}`, fullKey, {
			method: 'PUT',
			json: memberBody({ custom: { medikamente: 'neu' } })
		});
		expect(res.status).toBe(422);
		await data(await putDefs(asList(defs)));
	});
});

describe('Dienst für abhängige Module', () => {
	let kid: string;
	let kid2: string;

	it('Aufbau: Mitglieder mit Gruppe/E-Mail, Verknüpfung zu „eltern“', async () => {
		const leader = await createMember({ firstName: 'Leiter' });
		const g = await data<{ id: string }>(
			await api('/groups', fullKey, {
				method: 'POST',
				json: { name: 'Wölflinge', type: 'meute', leaderIds: [leader] }
			}),
			201
		);
		kid = await createMember({
			firstName: 'Kind',
			groupIds: [g.id],
			emails: [{ value: 'kind@example.test' }],
			custom: { ernaehrung: 'vegetarian' }
		});
		kid2 = await createMember({ firstName: 'Zweit' });
		await core.database.forModule('members').transaction(async (tx) => {
			await tx.execute(
				sql`INSERT INTO member_user_links (member_id, user_id) VALUES (${kid}, ${parentCtx.userId})`
			);
		});
	});

	it('listLinkedMembers/getLinkedMember liefern nur verknüpfte Mitglieder', async () => {
		const mine = await service.listLinkedMembers(parentCtx);
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({
			firstName: 'Kind',
			email: 'kind@example.test',
			city: 'Bremen',
			country: 'DE',
			custom: { ernaehrung: 'vegetarian' }
		});
		expect(mine[0]!.groups.map((x) => x.name)).toEqual(['Wölflinge']);
		await expect(service.getLinkedMember(parentCtx, kid2)).rejects.toMatchObject({ status: 404 });
		await expect(service.getLinkedMember(otherCtx, kid)).rejects.toMatchObject({ status: 404 });
		expect(await service.listLinkedMembers(otherCtx)).toEqual([]);
	});

	it('updateMemberFields: nur verknüpft, validiert, meldet Änderungen, Audit ohne Werte', async () => {
		const changed = await service.updateMemberFields(parentCtx, kid, {
			ernaehrung: 'vegan',
			allergien: 'Pollen',
			zecken: true
		});
		expect(changed.sort()).toEqual(['allergien', 'ernaehrung', 'zecken']);
		expect(await service.updateMemberFields(parentCtx, kid, { ernaehrung: 'vegan' })).toEqual([]);
		const m = await service.getLinkedMember(parentCtx, kid);
		expect(m.custom).toMatchObject({ ernaehrung: 'vegan', allergien: 'Pollen' });
		await expect(
			service.updateMemberFields(otherCtx, kid, { allergien: 'x' })
		).rejects.toMatchObject({ status: 404 });
		await expect(
			service.updateMemberFields(parentCtx, kid, { ernaehrung: 'pizza' })
		).rejects.toMatchObject({ status: 422 });
		await expect(service.updateMemberFields(parentCtx, kid, { nix: 'x' })).rejects.toMatchObject({
			status: 422
		});
		const { rows } = await listAudit({ action: 'members.member.fields' });
		expect(rows.length).toBeGreaterThan(0);
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toContain('Pollen');
		expect(text).toContain('allergien');
	});

	it('listFieldDefinitions nennt nur aktive Felder', async () => {
		const defs = await getDefs();
		await data(
			await putDefs(defs.map((d) => ({ active: d.key !== 'krankenkasse', field: d.field })))
		);
		const list = await service.listFieldDefinitions();
		expect(list.some((d) => d.key === 'krankenkasse')).toBe(false);
		expect(list.some((d) => d.key === 'ernaehrung')).toBe(true);
	});
});
