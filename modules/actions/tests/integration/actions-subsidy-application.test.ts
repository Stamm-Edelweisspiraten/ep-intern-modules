import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { setSettings } from '$testing';
import { getDb, schema } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';
import type { SubsidyApplicationDto } from '$modules/actions/schemas';

const BASE = '/modules/actions';
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let actionId: string;
const team: Record<string, string> = {};
let childId: string;

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
	api(`${BASE}${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const PERMS = ['core.api.manage', 'actions.action.view', 'actions.action.create'];
const appUrl = () => `/actions/${actionId}/subsidy-application`;

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
	await setSettings(admin, { 'actions.subsidy.parish': 'Gemeinde Süd' });

	const roleId = await createRole(admin, { name: 'role-creator', permissions: PERMS });
	for (const name of ['owner', 'reader', 'stranger']) {
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: PERMS })).key;
	}
	const a = await data<{ id: string }>(
		await as('owner', '/actions', {
			method: 'POST',
			json: {
				name: 'Sommerlager 2026',
				description: null,
				location: 'Zeltplatz',
				startsOn: '2026-07-10',
				startsTime: null,
				endsOn: '2026-07-16',
				endsTime: null
			}
		}),
		201
	);
	actionId = a.id;
	await data(
		await as('owner', `/actions/${actionId}/shares/${userIds.reader}`, {
			method: 'PUT',
			json: { level: 'read' }
		})
	);
	const add = async (json: Record<string, unknown>) =>
		(
			await data<{ id: string }>(
				await as('owner', `/actions/${actionId}/participants`, { method: 'POST', json }),
				201
			)
		).id;
	childId = await add({ name: 'Kind Eins', birthDate: '2017-03-01', bremenResident: true });
	await add({ name: 'Jugend Eins', birthDate: '2011-03-01', bremenResident: true });
	for (const n of ['Anna', 'Ben']) {
		team[n] = await add({
			name: n,
			role: 'team',
			juleica: n === 'Anna',
			birthDate: '2004-01-01',
			bremenResident: true
		});
	}
});

describe('Zuschussantrag', () => {
	it('liefert Vorschlagswerte und einen Antrag mit Warnung ohne Leitungspaar', async () => {
		const d = await data<SubsidyApplicationDto>(await as('reader', appUrl()));
		expect(d.persisted).toBe(false);
		expect(d.topic).toBe('Sommerlager 2026');
		expect(d.parish).toBe('Gemeinde Süd');
		expect(d.team.map((t) => t.name)).toEqual(['Anna', 'Ben']);
		expect(d.plan.forms).toHaveLength(1);
		expect(d.plan.warnings.join(' ')).toMatch(/Leitung/);
	});

	it('speichert Angaben und Leitungen (edit), Lesende bekommen 403, Fremde 404', async () => {
		const body = {
			freizeitArt: 'Zeltlager',
			topic: 'Wikinger',
			inclusion: true,
			leaders: [
				{ participantId: team.Anna, gender: 'female' },
				{ participantId: team.Ben, gender: 'male' }
			]
		};
		expect((await as('reader', appUrl(), { method: 'PUT', json: body })).status).toBe(403);
		expect((await as('stranger', appUrl())).status).toBe(404);
		expect((await as('stranger', `${appUrl()}.pdf`)).status).toBe(404);

		const d = await data<SubsidyApplicationDto>(
			await as('owner', appUrl(), { method: 'PUT', json: body })
		);
		expect(d.persisted).toBe(true);
		expect(d.inclusion).toBe(true);
		expect(d.plan.warnings).toEqual([]);
		const f = d.plan.forms[0]!;
		expect(f.femaleLeaders.map((x) => x.name)).toEqual(['Anna']);
		expect(f.maleLeaders.map((x) => x.name)).toEqual(['Ben']);
		expect(f.children).toHaveLength(1);
		expect(f.youth).toHaveLength(3);

		const audit = await listAudit({
			action: 'actions.subsidy.application_updated',
			target: actionId
		});
		const entry = audit.rows[0];
		expect(entry?.metadata).toEqual({ female: 1, male: 1, forms: 1 });
	});

	it('lehnt Personen ab, die nicht zum Team gehören (422)', async () => {
		const res = await as('owner', appUrl(), {
			method: 'PUT',
			json: {
				freizeitArt: '',
				topic: '',
				inclusion: false,
				leaders: [{ participantId: childId, gender: 'female' }]
			}
		});
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error.code).toBe('validation_failed');
	});

	it('liefert das PDF auch an Lesende und protokolliert ohne Namen', async () => {
		const res = await as('reader', `${appUrl()}.pdf`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Zuschussantrag/);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

		const audit = await listAudit({
			action: 'actions.subsidy.application_generated',
			target: actionId
		});
		const entry = audit.rows[0];
		// `unassigned` = Personen auf keinem Antrag (fehlendes Taschengeld zählt nicht)
		expect(entry?.metadata).toEqual({ forms: 1, persons: 4, unassigned: 0 });
		expect(JSON.stringify(entry)).not.toMatch(/Anna|Ben/);
	});

	it('nutzt nur das eigene Konto für Zuschussanträge (kein Rückfall auf das Stammkonto)', async () => {
		await setSettings(admin, {
			'actions.bank.holder': 'Stammkasse',
			'actions.bank.iban': 'DE89370400440532013000',
			'actions.bank.name': 'Stammbank'
		});
		const empty = await data<SubsidyApplicationDto>(await as('owner', appUrl()));
		expect(empty.bank).toEqual({ holder: '', name: '', iban: '', bic: '' });

		await setSettings(admin, {
			'actions.subsidy.bank.holder': 'Förderverein',
			'actions.subsidy.bank.name': 'Sparkasse Bremen',
			'actions.subsidy.bank.iban': 'de02120300000000202051',
			'actions.subsidy.bank.bic': 'byladem1001'
		});
		const d = await data<SubsidyApplicationDto>(await as('owner', appUrl()));
		expect(d.bank).toEqual({
			holder: 'Förderverein',
			name: 'Sparkasse Bremen',
			iban: 'DE02 1203 0000 0000 2020 51',
			bic: 'BYLADEM1001'
		});
	});

	it('lehnt eine ungültige IBAN für Zuschussanträge ab', async () => {
		await expect(
			setSettings(admin, { 'actions.subsidy.bank.iban': 'DE00123' })
		).rejects.toMatchObject({ status: 422 });
	});

	it('Löschen eines Teammitglieds entfernt seine Leitungsangabe', async () => {
		await data(
			await as('owner', `/actions/${actionId}/participants/${team.Ben}`, { method: 'DELETE' })
		);
		const d = await data<SubsidyApplicationDto>(await as('owner', appUrl()));
		expect(d.team.map((t) => t.name)).toEqual(['Anna']);
		expect(d.plan.forms[0]!.maleLeaders).toEqual([]);
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'actions');
		expect((await as('owner', appUrl())).status).toBe(404);
		await enableModule(admin, 'actions');
	});
});
