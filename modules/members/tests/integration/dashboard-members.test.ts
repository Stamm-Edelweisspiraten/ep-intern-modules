/**
 * Übersicht (`/dashboard`): Gruppenstunden aus `members` im Wochenstreifen (eigene Mitglieder,
 * Gruppenleitung, ausgetretene ignoriert) und Kachel-Endpunkt `GET /led/overview` (nur geleitete
 * Gruppen, aktive Mitglieder, Geburtstage der nächsten 14 Tage).
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
import { resetAllForTests } from '$testing';
import { setSetting } from '$testing';
import { collectDashboardFeed } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import membersUi from '$modules/members/ui';
import { nextBirthday } from '$modules/members/dashboard';
import {
	LED_VIEW,
	type GroupRef,
	type LedGroupOverview,
	type Member
} from '$modules/members/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Woche Mo 02.11. – So 08.11.2026
const TODAY = '2026-11-04';
const PW = 'dashboard-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
let adminKey = '';
const userIds: Record<string, string> = {};

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1/modules/members${path}`);
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
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(path, { token: adminKey, ...init });
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
async function keyOf(name: string) {
	const ctx = await ctxOf(userIds[name]!);
	return (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}
const meetingsOf = async (name: string) =>
	(await collectDashboardFeed(await ctxOf(userIds[name]!), { today: TODAY })).agenda.filter(
		(a) => a.moduleId === 'members'
	);

async function mkMember(firstName: string, over: Record<string, unknown> = {}) {
	return data<Member>(
		await A('/members', {
			method: 'POST',
			json: {
				firstName,
				lastName: 'Muster',
				scoutName: null,
				birthDate: '2012-05-17',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				country: 'DE',
				phones: [],
				emails: [],
				stage: 'pfadfinder',
				groupIds: [],
				...over
			}
		}),
		201
	);
}
async function mkGroup(name: string, leaderIds: string[], over: Record<string, unknown> = {}) {
	return data<GroupRef>(
		await A('/groups', { method: 'POST', json: { name, type: 'sippe', leaderIds, ...over } }),
		201
	);
}
async function link(memberId: string, user: string, self = false) {
	await data(
		await A(`/members/${memberId}/links`, {
			method: 'POST',
			json: { userId: userIds[user], relation: self ? 'selbst' : 'Mutter' }
		}),
		201
	);
	if (self) {
		await data(
			await A(`/members/${memberId}/links/${userIds[user]}`, {
				method: 'PUT',
				json: { self: true }
			})
		);
	}
}

let fuechse: GroupRef;
let woelfe: GroupRef;
let anna: Member;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setTodayForTests(TODAY);
	await setSetting(admin, 'members.address.openPlzUrl', '');
	await setSetting(admin, 'members.address.photonUrl', '');

	for (const [name, perms] of [
		['mutter', ['core.api.manage', 'members.own.view']],
		['leiter', ['core.api.manage']],
		['fremd', ['core.api.manage', 'members.own.view']]
	] as const) {
		const role = await createRole(admin, { name: `r-${name}`, permissions: [...perms] });
		userIds[name] = await createUser(admin, {
			name,
			email: `${name}@example.test`,
			password: PW,
			roleIds: [role]
		});
	}

	const lea = await mkMember('Lea', { birthDate: '2004-03-01', stage: 'kreuzpfadfinder' });
	const ben = await mkMember('Ben', { birthDate: '2003-03-01', stage: 'kreuzpfadfinder' });
	fuechse = await mkGroup('Füchse', [lea.id], {
		meetingWeekday: 3,
		meetingTime: '17:00',
		meetingEndTime: '18:30'
	});
	woelfe = await mkGroup('Wölfe', [ben.id], { meetingWeekday: 5, meetingTime: '18:00' });
	const ohneTag = await mkGroup('Ohne Tag', [ben.id]);
	// Anna: Geburtstag in 6 Tagen (wird 10)
	anna = await mkMember('Anna', {
		birthDate: '2016-11-10',
		groupIds: [fuechse.id, ohneTag.id]
	});
	await mkMember('Dora', { birthDate: '2015-12-30', groupIds: [fuechse.id] });
	// Ausgetreten: zählt nirgends
	const carl = await mkMember('Carl', {
		birthDate: '2014-11-05',
		groupIds: [woelfe.id, fuechse.id],
		entryDate: '2020-01-01',
		exitDate: '2026-10-01'
	});
	await mkMember('Bert', { groupIds: [woelfe.id] });

	await link(anna.id, 'mutter');
	await link(carl.id, 'mutter');
	await link(lea.id, 'leiter', true);
});
afterAll(async () => {
	setTodayForTests(null);
	await close();
});
beforeEach(() => resetAllForTests());

describe('members: Gruppenstunden in „Diese Woche“', () => {
	it('Eltern: nur Gruppen der eigenen, aktiven Mitglieder mit Vornamen', async () => {
		const items = await meetingsOf('mutter');
		// Füchse (Mittwoch); Wölfe nur über den ausgetretenen Carl → fehlt; „Ohne Tag“ ohne Wochentag
		expect(items).toEqual([
			expect.objectContaining({
				id: `${fuechse.id}:2026-11-04`,
				kind: 'meeting',
				title: 'Gruppenstunde Füchse',
				date: '2026-11-04',
				startTime: '17:00',
				endTime: '18:30',
				detail: 'Anna',
				href: '/profile'
			})
		]);
	});

	it('Gruppenleitung: geleitete Gruppe mit Anzahl aktiver Mitglieder', async () => {
		expect((await ctxOf(userIds.leiter!)).permissions.has(LED_VIEW)).toBe(true);
		const items = await meetingsOf('leiter');
		expect(items).toEqual([
			expect.objectContaining({
				title: 'Gruppenstunde Füchse',
				date: '2026-11-04',
				detail: '2 Mitglieder',
				href: `/modules/members?groupId=${fuechse.id}`
			})
		]);
	});

	it('ohne verknüpfte Mitglieder und ohne Leitung: nichts', async () => {
		expect(await meetingsOf('fremd')).toEqual([]);
	});
});

describe('members: Kachel „Meine Gruppe“', () => {
	it('ist für Gruppenleitungen deklariert', () => {
		expect(membersUi.dashboardWidgets?.find((w) => w.id === 'my-group')).toMatchObject({
			title: 'Meine Gruppe',
			order: 21,
			size: 'sm',
			permission: LED_VIEW
		});
	});

	it('GET /led/overview liefert nur geleitete Gruppen mit Geburtstagen der nächsten 14 Tage', async () => {
		const key = await keyOf('leiter');
		const o = await data<LedGroupOverview>(await api('/led/overview', { token: key }));
		expect(o.today).toBe(TODAY);
		expect(o.groups).toEqual([
			{
				id: fuechse.id,
				name: 'Füchse',
				memberCount: 2,
				meetingWeekday: 3,
				meetingTime: '17:00',
				meetingEndTime: '18:30',
				meetingPlace: null,
				nextMeeting: '2026-11-04',
				birthdays: [
					{
						memberId: anna.id,
						firstName: 'Anna',
						lastName: 'Muster',
						scoutName: null,
						date: '2026-11-10',
						days: 6,
						age: 10
					}
				]
			}
		]);
		// Keine Gesundheits- oder Kontaktdaten
		expect(JSON.stringify(o)).not.toMatch(/phones|emails|custom|birthDate/);
	});

	it('ohne Leitungsrecht 403', async () => {
		const res = await api('/led/overview', { token: await keyOf('mutter') });
		expect(res.status).toBe(403);
	});
});

describe('nextBirthday', () => {
	it('Grenzen: heute, Jahreswechsel, 29.02.', () => {
		expect(nextBirthday('2016-11-04', '2026-11-04')).toEqual({
			date: '2026-11-04',
			days: 0,
			age: 10
		});
		expect(nextBirthday('2016-01-02', '2026-12-30')).toEqual({
			date: '2027-01-02',
			days: 3,
			age: 11
		});
		expect(nextBirthday('2012-02-29', '2027-02-20')).toEqual({
			date: '2027-02-28',
			days: 8,
			age: 15
		});
	});
});
