/**
 * Modul `members` – `GET /groups/:id/overview` (Gruppenseite): nächste Gruppenstunde und Geburtstage der
 * nächsten 14 Tage; Geburtstage nur mit `members.member.view`, sonst leer. 401/403/404.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { addDays, todayBerlin } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import { nextWeekdayFrom } from '$modules/members/dashboard';
import membersModule from '$modules/members/module';
import type { Group, GroupOverview, Member } from '$modules/members/schemas';
import {
	bootstrapAdmin,
	contextForUser,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	getDb,
	handleApiRequest,
	registerCoreApi,
	registerModule,
	resetAllForTests,
	schema,
	syncModules,
	useTestDatabase
} from '$testing';

const ROOT = 'http://localhost:5173/api/v1/modules/members';
const keys: Record<string, string> = {};
let admin: RequestContext;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; message: string } };
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function call<T = unknown>(
	who: string | null,
	method: string,
	path: string,
	json?: unknown
): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers();
	if (who) headers.set('authorization', `Bearer ${keys[who]}`);
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

const ROLES: Record<string, string[]> = {
	editor: [
		'members.member.view',
		'members.member.edit',
		'members.group.view',
		'members.group.edit',
		'core.api.manage'
	],
	groupsOnly: ['members.group.view', 'core.api.manage'],
	nothing: ['core.api.manage']
};

const today = todayBerlin();
/** Geburtsdatum mit Geburtstag in `days` Tagen (kein 29.02.), Alter dann 10 */
function birthDateIn(days: number): { birthDate: string; date: string } {
	let d = days;
	while (addDays(today, d).slice(5) === '02-29') d += 1;
	const date = addDays(today, d);
	return { birthDate: `${Number(date.slice(0, 4)) - 10}${date.slice(4)}`, date };
}

const memberBody = (firstName: string, birthDate: string, groupIds: string[] = []) => ({
	firstName,
	lastName: 'Test',
	scoutName: null,
	birthDate,
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [],
	emails: [],
	stage: 'pfadfinder',
	groupIds,
	consentSocialMedia: false,
	consentWebsite: false,
	consentPrint: false
});

let leader: Member;
let soon: { birthDate: string; date: string };
let withDay: Group;
let withoutDay: Group;

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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	admin = await ctxOf(u!.id);

	for (const [name, perms] of Object.entries(ROLES)) {
		const roleId = await createRole(admin, { name: `role-${name}`, permissions: perms });
		const userId = await createUser(admin, {
			name: `Benutzer ${name}`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
		keys[name] = (
			await createApiKey(await ctxOf(userId), { name: `key-${name}`, scopes: perms })
		).key;
	}

	leader = ok<Member>(
		await call('editor', 'POST', '/members', memberBody('Lea', '1990-01-01')),
		201
	);
	withDay = ok<Group>(
		await call('editor', 'POST', '/groups', {
			name: 'Sippe Falken',
			type: 'sippe',
			leaderIds: [leader.id],
			meetingWeekday: 5,
			meetingTime: '16:30'
		}),
		201
	);
	withoutDay = ok<Group>(
		await call('editor', 'POST', '/groups', {
			name: 'Meute Ohne Tag',
			type: 'meute',
			leaderIds: [leader.id]
		}),
		201
	);
	soon = birthDateIn(3);
	ok(
		await call('editor', 'POST', '/members', memberBody('Bald', soon.birthDate, [withDay.id])),
		201
	);
	// Geburtstag erst in 30 Tagen → nicht in der Übersicht
	ok(
		await call(
			'editor',
			'POST',
			'/members',
			memberBody('Spaet', birthDateIn(30).birthDate, [withDay.id])
		),
		201
	);
});

describe('GET /groups/:id/overview', () => {
	it('liefert nächste Gruppenstunde und Geburtstage der nächsten 14 Tage', async () => {
		const o = ok<GroupOverview>(await call('editor', 'GET', `/groups/${withDay.id}/overview`));
		expect(o.today).toBe(today);
		expect(o.nextMeeting).toBe(nextWeekdayFrom(today, 5));
		expect(o.birthdays.map((b) => b.firstName)).toEqual(['Bald']);
		expect(o.birthdays[0]).toMatchObject({ date: soon.date, age: 10 });
	});

	it('ohne Wochentag ist nextMeeting null', async () => {
		const o = ok<GroupOverview>(await call('editor', 'GET', `/groups/${withoutDay.id}/overview`));
		expect(o.nextMeeting).toBeNull();
		expect(o.birthdays).toEqual([]);
	});

	it('nur mit members.group.view: keine Geburtstage (keine Mitgliedernamen)', async () => {
		const o = ok<GroupOverview>(await call('groupsOnly', 'GET', `/groups/${withDay.id}/overview`));
		expect(o.nextMeeting).toBe(nextWeekdayFrom(today, 5));
		expect(o.birthdays).toEqual([]);
	});

	it('401 ohne Anmeldung, 403 ohne Recht, 404 bei unbekannter Gruppe', async () => {
		expect((await call(null, 'GET', `/groups/${withDay.id}/overview`)).status).toBe(401);
		expect((await call('nothing', 'GET', `/groups/${withDay.id}/overview`)).status).toBe(403);
		const missing = await call(
			'editor',
			'GET',
			'/groups/00000000-0000-4000-8000-000000000000/overview'
		);
		expect(missing.status).toBe(404);
	});
});
