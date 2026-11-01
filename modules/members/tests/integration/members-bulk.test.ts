import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import membersModule from '$modules/members/module';
import type { RequestContext } from '$lib/sdk/types';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PW = 'correct-horse-battery';
const BASE = '/modules/members';

let admin: RequestContext;
let adminId: string;
let fullKey: string;

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

const call = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: fullKey, ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const memberBody = (over: Record<string, unknown> = {}) => ({
	firstName: 'Max',
	lastName: 'Muster',
	scoutName: 'Fuchs',
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [
		{ name: 'Mutter', value: '0123 456' },
		{ name: null, value: '0987 654' }
	],
	emails: [
		{ name: null, value: 'max@example.test' },
		{ name: 'Eltern', value: 'eltern@example.test' }
	],
	stage: 'pfadfinder',
	groupIds: [],
	consentSocialMedia: true,
	consentWebsite: false,
	consentPrint: true,
	...over
});

interface MemberDto {
	id: string;
	phones: { name: string | null; value: string }[];
	emails: { name: string | null; value: string }[];
	groups: { id: string; color: string | null }[];
}
interface GroupDto {
	id: string;
	name: string;
	meetingWeekday: number | null;
	meetingTime: string | null;
	color: string | null;
	hasImage: boolean;
	imageVersion: string | null;
	leaders: { id: string }[];
	memberCount: number;
}

// Gemeinsamer Zustand über die Tests hinweg (Bootstrap-Fluss)

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin(ADMIN_EMAIL, ADMIN_PW);
	const [u] = await getDb().select().from(schema.user).where(eq(schema.user.email, ADMIN_EMAIL));
	adminId = u!.id;
	const ctxOf = async () => {
		const r = await contextForUser(adminId);
		if (!r) throw new Error('Kontext nicht auflösbar');
		return r.ctx;
	};
	admin = await ctxOf();
	await enableModule(admin, 'members');
	admin = await ctxOf(); // neue Modulrechte wirksam
	const perms = membersModule.manifest.permissions;
	fullKey = (await createApiKey(admin, { name: 'full', scopes: [...perms] })).key;
});

let editKey: string;
const bulk = (json: unknown, token = fullKey) =>
	api(`${BASE}/members/bulk`, { method: 'POST', token, json });

const mk = async (firstName: string, groupIds: string[]) =>
	(
		await data<MemberDto>(
			await call('/members', { method: 'POST', json: memberBody({ firstName, groupIds }) }),
			201
		)
	).id;
const get = async (id: string) =>
	data<MemberDto & { stage: string; consentWebsite: boolean; consentPrint: boolean }>(
		await call(`/members/${id}`)
	);
const mkGroup = async (name: string, leaderId: string) =>
	(
		await data<GroupDto>(
			await call('/groups', {
				method: 'POST',
				json: { name, type: 'sippe', leaderIds: [leaderId] }
			}),
			201
		)
	).id;

describe('Sammelaktionen auf Mitgliedern', () => {
	let leaderId: string;
	let g1: string;
	let g2: string;
	let a: string;
	let b: string;

	it('Aufbau', async () => {
		leaderId = await mk('Leiter', []);
		g1 = await mkGroup('Gruppe 1', leaderId);
		g2 = await mkGroup('Gruppe 2', leaderId);
		a = await mk('Anna', [g1]);
		b = await mk('Ben', [g1]);
		editKey = (
			await createApiKey(admin, {
				name: 'edit',
				scopes: ['members.member.view', 'members.member.edit']
			})
		).key;
	});

	it('fügt Gruppen hinzu (idempotent, zählt nur Änderungen)', async () => {
		let r = await data<{ affected: number; skipped: unknown[] }>(
			await bulk({ action: 'add-groups', ids: [a, b], groupIds: [g2] }),
			201
		);
		expect(r.affected).toBe(2);
		expect((await get(a)).groups.map((g) => g.id).sort()).toEqual([g1, g2].sort());
		r = await data(await bulk({ action: 'add-groups', ids: [a, b], groupIds: [g2] }), 201);
		expect(r.affected).toBe(0);
	});

	it('entfernt Gruppen (auch die letzte; Gruppen sind optional)', async () => {
		await bulk({ action: 'remove-groups', ids: [a], groupIds: [g1] });
		expect((await get(a)).groups.map((g) => g.id)).toEqual([g2]);
		const r = await data<{ affected: number; skipped: { id: string; reason: string }[] }>(
			await bulk({ action: 'remove-groups', ids: [a, b], groupIds: [g1, g2] }),
			201
		);
		expect(r.affected).toBe(2);
		expect(r.skipped).toEqual([]);
		expect((await get(b)).groups).toHaveLength(0);
		await bulk({ action: 'add-groups', ids: [a, b], groupIds: [g1, g2] });
	});

	it('setzt Stand und Einwilligungen teilweise', async () => {
		await bulk({ action: 'set-stage', ids: [a, b], stage: 'knappe' });
		expect((await get(a)).stage).toBe('knappe');
		await bulk({
			action: 'set-consent',
			ids: [a, b],
			consent: { consentWebsite: true, consentPrint: false }
		});
		const m = await get(b);
		expect(m.consentWebsite).toBe(true);
		expect(m.consentPrint).toBe(false);
	});

	it('validiert Eingaben (422) und unbekannte IDs (404)', async () => {
		expect((await bulk({ action: 'set-stage', ids: [], stage: 'knappe' })).status).toBe(422);
		expect((await bulk({ action: 'set-stage', ids: [a], stage: 'x' })).status).toBe(422);
		expect((await bulk({ action: 'set-consent', ids: [a], consent: {} })).status).toBe(422);
		expect((await bulk({ action: 'nix', ids: [a] })).status).toBe(422);
		expect(
			(await bulk({ action: 'add-groups', ids: [a], groupIds: [crypto.randomUUID()] })).status
		).toBe(422);
		const r = await bulk({ action: 'set-stage', ids: [a, crypto.randomUUID()], stage: 'spaeher' });
		expect(r.status).toBe(404);
		expect((await get(a)).stage).toBe('knappe'); // nichts geändert
	});

	it('Löschen braucht das Löschrecht und überspringt einzige Leiter', async () => {
		expect((await bulk({ action: 'delete', ids: [b] }, editKey)).status).toBe(403);
		expect((await bulk({ action: 'set-stage', ids: [b], stage: 'spaeher' }, editKey)).status).toBe(
			201
		);
		const r = await data<{ affected: number; skipped: { id: string }[] }>(
			await bulk({ action: 'delete', ids: [a, b, leaderId] }),
			201
		);
		expect(r.affected).toBe(2);
		expect(r.skipped.map((s) => s.id)).toEqual([leaderId]);
		expect((await call(`/members/${a}`)).status).toBe(404);
	});

	it('schreibt Audit ohne Namen', async () => {
		const { rows } = await listAudit({ action: 'members.member.bulk' });
		expect(rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(rows)).not.toContain('Anna');
	});
});
