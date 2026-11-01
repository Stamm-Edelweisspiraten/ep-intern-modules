/**
 * Modul `events` (Termine) – umfassende Integrationstests über `handleApiRequest` mit API-Keys:
 * Zugriffsmatrix (Freigaben an Stamm/Gruppe/Leitung/Rolle/Benutzer/Mitglied, view-all, edit-all,
 * Fremde, ohne Basisrecht, ausgetretene Mitglieder), Anlegen + Validierung, Website-API,
 * Freigabe-Kandidaten/Gruppen/Tags, Audit, `members` deaktiviert, `events` deaktiviert.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { listAudit } from '$testing';
import { setSetting } from '$testing';
import { core } from '$testing';
import eventsModule from '$modules/events/module';
import membersModule from '$modules/members/module';
import { todayBerlin } from '$modules/events/website.endpoints';
import {
	DEFAULT_STAMM_NAME,
	STAMM_NAME_SETTING,
	type EventDetail,
	type EventGroupRef,
	type EventList,
	type WebsiteEvent
} from '$modules/events/schemas';
import type { PrincipalInfo } from '$lib/sdk/types/sharing';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let adminId: string;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'events'
): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${moduleId}${path}`);
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

function fail(res: Res, status: number, code: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body.error?.code).toBe(code);
}

/** Feldpfade aus `error.details` (Zod-Issues bzw. `errors.validation([...])`) */
function paths(res: Res): string[] {
	const details = res.body.error?.details;
	if (!Array.isArray(details)) return [];
	return details.map((d: { path?: (string | number)[] }) => (d.path ?? []).join('.'));
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

const base = (over: Record<string, unknown> = {}) => ({
	title: 'Gruppenstunde',
	description: 'Basteln mit Holz',
	location: 'Heim',
	color: '#2563EB',
	startsOn: '2026-11-03',
	startsTime: '17:00',
	endsOn: '2026-11-03',
	endsTime: '19:00',
	tags: ['Basteln'],
	groupIds: [],
	shares: [],
	onWebsite: false,
	...over
});

// Mitglieder / Gruppen (members)
let lea: string; // Leitung (Falke, Wolf, Otter)
let anna: string; // in Falke → Benutzer b
let carl: string; // leitet Wolf (nur group_leaders) → Benutzer c
let fritz: string; // ohne Gruppe → Benutzer f (Freigabe member)
let egon: string; // ausgetreten, in Otter → Benutzer k
let falke: string;
let wolf: string;
let otter: string;
let editorsRole: string;

// Termine
let eMain: string; // Freigaben an Gruppe/Leitung/Rolle(edit)/Benutzer/Mitglied
let eEvery: string; // Freigabe everyone read
let ePrivate: string; // ohne Freigabe

let mainShares: { type: string; id: string; level: 'read' | 'edit' }[];
const mainBody = (over: Record<string, unknown> = {}) =>
	base({
		title: 'Sippenstunde Falke',
		tags: ['Sippe', 'Draußen'],
		groupIds: [falke],
		shares: mainShares,
		...over
	});

async function membersPost(path: string, json: unknown): Promise<string> {
	return ok<{ id: string }>(await call('admin', 'POST', path, json, 'members'), 201).id;
}

const createMember = (over: Record<string, unknown>) =>
	membersPost('/members', {
		birthDate: '2012-05-17',
		street: 'Musterweg 1',
		postalCode: '28357',
		city: 'Bremen',
		stage: 'pfadfinder',
		...over
	});

async function link(memberId: string, userId: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation)
				VALUES (${memberId}, ${userId}, 'Mutter')`
		);
	});
}

async function addUser(who: string, name: string, roleId: string, scopes: string[]) {
	const id = await createUser(admin, {
		name,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	userIds[who] = id;
	keys[who] = (await createApiKey(await ctxOf(id), { name: who, scopes })).key;
	return id;
}

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'members');
	await enableModule(admin, 'events');
	admin = await ctxOf(adminId);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...membersModule.manifest.permissions, ...eventsModule.manifest.permissions]
		})
	).key;

	// Mitglieder und Gruppen
	lea = await createMember({ firstName: 'Lea', lastName: 'Leitung' });
	falke = await membersPost('/groups', {
		name: 'Sippe Falke',
		type: 'sippe',
		leaderIds: [lea],
		color: '#16a34a',
		meetingWeekday: 2,
		meetingTime: '18:00',
		meetingEndTime: '19:30',
		meetingPlace: 'Pfadiheim Kellerraum'
	});
	wolf = await membersPost('/groups', { name: 'Meute Wolf', type: 'sippe', leaderIds: [lea] });
	otter = await membersPost('/groups', { name: 'Sippe Otter', type: 'sippe', leaderIds: [lea] });
	anna = await createMember({ firstName: 'Anna', lastName: 'Albrecht', groupIds: [falke] });
	carl = await createMember({ firstName: 'Carl', lastName: 'Chef' });
	fritz = await createMember({ firstName: 'Fritz', lastName: 'Frei' });
	egon = await createMember({
		firstName: 'Egon',
		lastName: 'Weg',
		groupIds: [otter],
		exitDate: '2020-01-01'
	});
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO group_leaders (group_id, member_id) VALUES (${wolf}, ${carl})`
		);
	});

	// Rollen
	const viewPerms = ['core.api.manage', 'events.event.view'];
	// Mitgliedsnamen und E-Mails in Freigaben/Suche nur mit diesen Rechten (siehe principals-privacy.test.ts)
	const ownerPerms = [
		...viewPerms,
		'events.event.create',
		'events.event.publish',
		'members.member.view',
		'core.users.view'
	];
	// Eigentümer*in ohne Veröffentlichungsrecht (#67, 01b-06)
	const noPublishPerms = [...viewPerms, 'events.event.create'];
	const noPublishRole = await createRole(admin, {
		name: 'Ohne Veröffentlichen',
		permissions: noPublishPerms
	});
	const ownerRole = await createRole(admin, { name: 'Terminplanung', permissions: ownerPerms });
	const viewerRole = await createRole(admin, { name: 'Lesende', permissions: viewPerms });
	editorsRole = await createRole(admin, { name: 'Redaktion', permissions: viewPerms });
	const viewAllRole = await createRole(admin, {
		name: 'Alle sehen',
		permissions: [...viewPerms, 'events.event.view-all']
	});
	const editAllRole = await createRole(admin, {
		name: 'Alle bearbeiten',
		permissions: [...viewPerms, 'events.event.edit-all']
	});
	const noViewRole = await createRole(admin, { name: 'Ohne', permissions: ['core.api.manage'] });
	const createOnlyRole = await createRole(admin, {
		name: 'Nur anlegen',
		permissions: ['core.api.manage', 'events.event.create']
	});
	const websiteRole = await createRole(admin, {
		name: 'Website',
		permissions: ['core.api.manage', 'events.website.read']
	});

	// Benutzer
	await addUser('owner', 'Olga Owner', ownerRole, ownerPerms);
	await addUser('a', 'Alle Anna', viewerRole, viewPerms);
	await addUser('b', 'Gruppen Bernd', viewerRole, viewPerms);
	await addUser('c', 'Leitungs Clara', viewerRole, viewPerms);
	await addUser('d', 'Rollen Dora', editorsRole, viewPerms);
	await addUser('e', 'Benutzer Emil', viewerRole, viewPerms);
	await addUser('f', 'Mitglieds Frieda', viewerRole, viewPerms);
	await addUser('g', 'Viewall Gina', viewAllRole, [...viewPerms, 'events.event.view-all']);
	await addUser('h', 'Editall Hans', editAllRole, [...viewPerms, 'events.event.edit-all']);
	await addUser('i', 'Fremd Ingo', viewerRole, viewPerms);
	await addUser('j', 'Ohne Jana', noViewRole, ['core.api.manage']);
	await addUser('k', 'Ausgetreten Kai', viewerRole, viewPerms);
	await addUser('n', 'Nur Anlegen Nils', createOnlyRole, [
		'core.api.manage',
		'events.event.create'
	]);
	await addUser('web', 'Website', websiteRole, ['events.website.read']);
	await addUser('q', 'Quentin Ohne Publish', noPublishRole, noPublishPerms);
	keys.webNoScope = (
		await createApiKey(await ctxOf(userIds.web!), { name: 'kein', scopes: ['core.api.manage'] })
	).key;

	await link(anna, userIds.b!);
	await link(carl, userIds.c!);
	await link(fritz, userIds.f!);
	await link(egon, userIds.k!);

	mainShares = [
		{ type: 'group', id: falke, level: 'read' },
		{ type: 'group', id: wolf, level: 'read' },
		{ type: 'role', id: editorsRole, level: 'edit' },
		{ type: 'user', id: userIds.e!, level: 'read' },
		{ type: 'member', id: fritz, level: 'read' },
		{ type: 'group', id: otter, level: 'read' },
		{ type: 'member', id: egon, level: 'read' }
	];

	eMain = ok<EventDetail>(await call('owner', 'POST', '/events', mainBody()), 201).id;
	eEvery = ok<EventDetail>(
		await call(
			'owner',
			'POST',
			'/events',
			base({
				title: 'Stammesversammlung',
				tags: ['Stamm'],
				groupIds: ['stamm'],
				shares: [{ type: 'everyone', id: '*', level: 'read' }]
			})
		),
		201
	).id;
	ePrivate = ok<EventDetail>(
		await call('owner', 'POST', '/events', base({ title: 'Leiterrunde privat' })),
		201
	).id;
});

async function listIds(who: string): Promise<string[]> {
	return ok<EventList>(await call(who, 'GET', '/events')).items.map((i) => i.id);
}

/** Lesezugriff: GET 200 (ohne Freigaben), in der Liste, PUT/DELETE 403 */
async function expectRead(who: string, id: string, body: unknown) {
	const detail = ok<EventDetail>(await call(who, 'GET', `/events/${id}`));
	expect(detail.access).toEqual({ level: 'read', isOwner: false });
	expect(detail.shares).toEqual([]);
	expect(await listIds(who)).toContain(id);
	const listed = ok<EventList>(await call(who, 'GET', '/events')).items.find((i) => i.id === id);
	expect(listed?.access.level).toBe('read');
	fail(await call(who, 'PUT', `/events/${id}`, body), 403, 'forbidden');
	fail(await call(who, 'DELETE', `/events/${id}`), 403, 'forbidden');
}

/** Kein Zugriff: GET/PUT/DELETE 404, nicht in der Liste */
async function expectNone(who: string, id: string, body: unknown) {
	fail(await call(who, 'GET', `/events/${id}`), 404, 'not_found');
	fail(await call(who, 'PUT', `/events/${id}`, body), 404, 'not_found');
	fail(await call(who, 'DELETE', `/events/${id}`), 404, 'not_found');
	expect(await listIds(who)).not.toContain(id);
}

describe('Zugriffsmatrix', () => {
	it('Eigentümer*in: voller Zugriff, Freigaben sichtbar, alle eigenen Termine in der Liste', async () => {
		const detail = ok<EventDetail>(await call('owner', 'GET', `/events/${eMain}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: true });
		expect(detail.owner?.name).toBe('Olga Owner');
		expect(detail.shares).toHaveLength(mainShares.length);
		const byKey = new Map(detail.shares.map((s) => [`${s.type}:${s.id}`, s]));
		expect(byKey.get(`group:${falke}`)).toMatchObject({ name: 'Sippe Falke', color: '#16a34a' });
		expect(byKey.get(`role:${editorsRole}`)).toMatchObject({ name: 'Redaktion', level: 'edit' });
		expect(byKey.get(`user:${userIds.e}`)?.name).toBe('Benutzer Emil');
		expect(byKey.get(`member:${fritz}`)?.name).toBe('Fritz Frei');
		expect(detail.groups.map((g) => g.id)).toEqual([falke]);
		expect(detail.color).toBe('#2563eb');
		const ids = await listIds('owner');
		expect(ids).toEqual(expect.arrayContaining([eMain, eEvery, ePrivate]));
	});

	it('(a) Freigabe everyone read: sieht nur den Stammes-Termin', async () => {
		await expectRead('a', eEvery, base());
		await expectNone('a', eMain, mainBody());
		await expectNone('a', ePrivate, base());
	});

	it('(b) Freigabe Gruppe read über verknüpftes Mitglied', async () => {
		await expectRead('b', eMain, mainBody());
		await expectNone('b', ePrivate, base());
	});

	it('(c) Gruppe über Leitung (group_leaders)', async () => {
		await expectRead('c', eMain, mainBody());
		await expectNone('c', ePrivate, base());
	});

	it('(e) Freigabe Benutzer read', async () => {
		await expectRead('e', eMain, mainBody());
	});

	it('(f) Freigabe Mitglied read (verknüpftes Mitglied)', async () => {
		await expectRead('f', eMain, mainBody());
	});

	it('(d) Freigabe Rolle edit: sieht Freigaben, darf ändern und löschen', async () => {
		const detail = ok<EventDetail>(await call('d', 'GET', `/events/${eMain}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: false });
		expect(detail.shares).toHaveLength(mainShares.length);
		const listed = ok<EventList>(await call('d', 'GET', '/events')).items.find(
			(i) => i.id === eMain
		);
		expect(listed?.access).toEqual({ level: 'edit', isOwner: false });

		const updated = ok<EventDetail>(
			await call('d', 'PUT', `/events/${eMain}`, mainBody({ title: 'Sippenstunde (geändert)' }))
		);
		expect(updated.title).toBe('Sippenstunde (geändert)');
		expect(updated.access.level).toBe('edit');
		// Eigentümer*in bleibt unverändert
		expect(updated.owner?.id).toBe(userIds.owner);

		const del = ok<EventDetail>(
			await call(
				'owner',
				'POST',
				'/events',
				base({ title: 'Wegwerf D', shares: [{ type: 'role', id: editorsRole, level: 'edit' }] })
			),
			201
		).id;
		expect(ok(await call('d', 'DELETE', `/events/${del}`))).toEqual({ id: del, deleted: true });
		fail(await call('owner', 'GET', `/events/${del}`), 404, 'not_found');
		await expectNone('d', ePrivate, base());
	});

	it('(g) view-all: liest alles, ändert nichts', async () => {
		await expectRead('g', ePrivate, base());
		await expectRead('g', eMain, mainBody());
		expect(await listIds('g')).toEqual(expect.arrayContaining([eMain, eEvery, ePrivate]));
	});

	it('(h) edit-all: liest, ändert und löscht alles, sieht Freigaben', async () => {
		const detail = ok<EventDetail>(await call('h', 'GET', `/events/${ePrivate}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: false });
		const main = ok<EventDetail>(await call('h', 'GET', `/events/${eMain}`));
		expect(main.shares).toHaveLength(mainShares.length);
		expect(await listIds('h')).toEqual(expect.arrayContaining([eMain, eEvery, ePrivate]));
		const put = ok<EventDetail>(
			await call('h', 'PUT', `/events/${ePrivate}`, base({ title: 'Leiterrunde (Hans)' }))
		);
		expect(put.title).toBe('Leiterrunde (Hans)');
		expect(put.owner?.id).toBe(userIds.owner);
		const del = ok<EventDetail>(
			await call('owner', 'POST', '/events', base({ title: 'Wegwerf H' })),
			201
		).id;
		ok(await call('h', 'DELETE', `/events/${del}`));
		fail(await call('owner', 'GET', `/events/${del}`), 404, 'not_found');
	});

	it('(i) Fremde ohne Freigabe: 404 auf GET/PUT/DELETE, nicht in der Liste', async () => {
		await expectNone('i', eMain, mainBody());
		await expectNone('i', ePrivate, base());
		// Stammes-Termin bleibt sichtbar
		expect(await listIds('i')).toEqual([eEvery]);
	});

	it('(j) ohne events.event.view: 403 überall', async () => {
		fail(await call('j', 'GET', '/events'), 403, 'forbidden');
		fail(await call('j', 'GET', `/events/${eEvery}`), 403, 'forbidden');
		fail(await call('j', 'PUT', `/events/${eEvery}`, base()), 403, 'forbidden');
		fail(await call('j', 'DELETE', `/events/${eEvery}`), 403, 'forbidden');
		fail(await call('j', 'POST', '/events', base()), 403, 'forbidden');
		fail(await call('j', 'GET', '/groups'), 403, 'forbidden');
		fail(await call('j', 'GET', '/tags'), 403, 'forbidden');
		fail(await call('j', 'GET', '/principals?search=Stamm'), 403, 'forbidden');
	});

	it('(k) ausgetretenes Mitglied: keine Gruppen- und Mitgliedsrechte', async () => {
		await expectNone('k', eMain, mainBody());
		expect(await listIds('k')).toEqual([eEvery]);
	});

	it('Liste filtert nach Gruppe, Tag, Suche und Zeitraum', async () => {
		const byGroup = ok<EventList>(await call('owner', 'GET', `/events?groupId=${falke}`));
		expect(byGroup.items.map((i) => i.id)).toEqual([eMain]);
		const byTag = ok<EventList>(await call('owner', 'GET', '/events?tag=draußen'));
		expect(byTag.items.map((i) => i.id)).toEqual([eMain]);
		const bySearch = ok<EventList>(await call('owner', 'GET', '/events?search=versammlung'));
		expect(bySearch.items.map((i) => i.id)).toEqual([eEvery]);
		const wildcard = ok<EventList>(await call('owner', 'GET', '/events?search=%25'));
		expect(wildcard.total).toBe(0);
		const later = ok<EventList>(await call('owner', 'GET', '/events?from=2026-11-04'));
		expect(later.items.map((i) => i.id)).not.toContain(eMain);
	});
});

describe('Veröffentlichen auf der Website (#67, 01b-06)', () => {
	it('Eigentümer*in ohne events.event.publish: POST mit onWebsite → 403, ohne → 201, PUT auf öffentlich → 403', async () => {
		fail(
			await call('q', 'POST', '/events', base({ title: 'Q öffentlich', onWebsite: true })),
			403,
			'forbidden'
		);
		const id = ok<EventDetail>(
			await call('q', 'POST', '/events', base({ title: 'Q intern' })),
			201
		).id;
		fail(
			await call('q', 'PUT', `/events/${id}`, base({ title: 'Q intern', onWebsite: true })),
			403,
			'forbidden'
		);
		// Sonstige Änderungen ohne Veröffentlichen bleiben erlaubt
		ok(await call('q', 'PUT', `/events/${id}`, base({ title: 'Q intern 2' })));
	});

	it('edit-Freigabe ohne Publish-Recht → 403 beim Wechsel auf öffentlich; Zurücknehmen erlaubt', async () => {
		const id = ok<EventDetail>(
			await call(
				'owner',
				'POST',
				'/events',
				base({ title: 'Freigabe-Test', shares: [{ type: 'role', id: editorsRole, level: 'edit' }] })
			),
			201
		).id;
		const shares = [{ type: 'role', id: editorsRole, level: 'edit' }];
		fail(
			await call(
				'd',
				'PUT',
				`/events/${id}`,
				base({ title: 'Freigabe-Test', shares, onWebsite: true })
			),
			403,
			'forbidden'
		);
		// Eigentümer*in mit Recht veröffentlicht; danach darf d weiter bearbeiten und zurücknehmen
		ok(
			await call(
				'owner',
				'PUT',
				`/events/${id}`,
				base({ title: 'Freigabe-Test', shares, onWebsite: true })
			)
		);
		ok(
			await call(
				'd',
				'PUT',
				`/events/${id}`,
				base({ title: 'Freigabe-Test 2', shares, onWebsite: true })
			)
		);
		const back = ok<EventDetail>(
			await call('d', 'PUT', `/events/${id}`, base({ title: 'Freigabe-Test 2', shares }))
		);
		expect(back.onWebsite).toBe(false);
		const { rows } = await listAudit({ target: id, limit: 50 });
		const actions = rows.map((r) => r.action);
		expect(actions).toContain('events.event.published');
		expect(actions).toContain('events.event.unpublished');
	});

	it('edit-all ohne Publish-Recht → 403 beim Wechsel auf öffentlich', async () => {
		fail(
			await call(
				'h',
				'PUT',
				`/events/${ePrivate}`,
				base({ title: 'Leiterrunde', onWebsite: true })
			),
			403,
			'forbidden'
		);
	});
});

describe('Anlegen und Validierung', () => {
	it('POST nur mit events.event.create (und view)', async () => {
		fail(await call('a', 'POST', '/events', base()), 403, 'forbidden');
		// create ohne view → Handler verlangt zusätzlich view
		fail(await call('n', 'POST', '/events', base()), 403, 'forbidden');
		fail(await call('web', 'POST', '/events', base()), 403, 'forbidden');
	});

	it('422 bei ungültigen Daten mit error.code und Feldpfad', async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ startsOn: '2026-02-30' }, 'startsOn'],
			[{ startsOn: '03.11.2026' }, 'startsOn'],
			[{ endsOn: '2026-11-01' }, 'endsOn'],
			[{ endsOn: null, endsTime: '18:00' }, 'endsTime'],
			[{ startsTime: '25:00' }, 'startsTime'],
			[{ color: 'blau' }, 'color'],
			[{ title: '   ' }, 'title'],
			[{ tags: Array.from({ length: 21 }, (_, i) => `Tag ${i}`) }, 'tags'],
			[{ tags: ['x'.repeat(41)] }, 'tags.0'],
			[{ unbekannt: true }, ''],
			[{ shares: [{ type: 'everyone', id: 'alle', level: 'read' }] }, 'shares.0.id'],
			[{ shares: [{ type: 'user', id: userIds.e, level: 'admin' }] }, 'shares.0.level'],
			[
				{
					shares: [
						{ type: 'user', id: userIds.e, level: 'read' },
						{ type: 'user', id: userIds.e, level: 'edit' }
					]
				},
				'shares.1'
			]
		];
		for (const [over, path] of cases) {
			const res = await call('owner', 'POST', '/events', base(over));
			fail(res, 422, 'validation_failed');
			expect(paths(res), JSON.stringify(over)).toContain(path);
		}
	});

	it('21 Tags werden abgelehnt, 20 (auch mit Duplikaten) angenommen', async () => {
		const twenty = Array.from({ length: 20 }, (_, i) => `T${i}`);
		const created = ok<EventDetail>(
			await call('owner', 'POST', '/events', base({ tags: [...twenty] })),
			201
		);
		expect(created.tags).toHaveLength(20);
		ok(await call('owner', 'DELETE', `/events/${created.id}`));
	});

	it('422 bei unbekannter Gruppe und unbekanntem Principal (nach Zod)', async () => {
		const g = await call(
			'owner',
			'POST',
			'/events',
			base({ groupIds: ['stamm', 'gibt-es-nicht'] })
		);
		fail(g, 422, 'validation_failed');
		expect(paths(g)).toEqual(['groupIds.1']);

		for (const share of [
			{ type: 'user', id: 'niemand', level: 'read' },
			{ type: 'role', id: 'keine-rolle', level: 'read' },
			{ type: 'group', id: 'keine-gruppe', level: 'read' },
			{ type: 'member', id: 'kein-mitglied', level: 'read' }
		]) {
			const res = await call(
				'owner',
				'POST',
				'/events',
				base({ shares: [{ type: 'everyone', id: '*', level: 'read' }, share] })
			);
			fail(res, 422, 'validation_failed');
			expect(paths(res), share.type).toEqual(['shares.1.id']);
		}
		// Auch PUT validiert
		const put = await call(
			'owner',
			'PUT',
			`/events/${ePrivate}`,
			base({ shares: [{ type: 'user', id: 'niemand', level: 'read' }] })
		);
		fail(put, 422, 'validation_failed');
	});

	it('ungültige ID im Pfad → 422, unbekannte UUID → 404', async () => {
		fail(await call('owner', 'GET', '/events/keine-uuid'), 422, 'validation_failed');
		fail(await call('owner', 'GET', `/events/${crypto.randomUUID()}`), 404, 'not_found');
	});
});

describe('Website-API', () => {
	const today = todayBerlin();
	let webFuture: string;
	let webRunning: string;
	let webToday: string;

	beforeAll(async () => {
		webFuture = ok<EventDetail>(
			await call(
				'owner',
				'POST',
				'/events',
				base({
					title: 'Sommerfest',
					startsOn: addDays(today, 5),
					endsOn: addDays(today, 6),
					startsTime: '15:00',
					endsTime: null,
					tags: ['Fest', 'Öffentlich'],
					groupIds: [falke, 'stamm'],
					shares: [{ type: 'user', id: userIds.e!, level: 'edit' }],
					onWebsite: true
				})
			),
			201
		).id;
		webRunning = ok<EventDetail>(
			await call(
				'owner',
				'POST',
				'/events',
				base({
					title: 'Lager läuft',
					startsOn: addDays(today, -2),
					startsTime: null,
					endsOn: today,
					endsTime: null,
					onWebsite: true
				})
			),
			201
		).id;
		webToday = ok<EventDetail>(
			await call(
				'owner',
				'POST',
				'/events',
				base({
					title: 'Heute',
					startsOn: today,
					startsTime: null,
					endsOn: null,
					endsTime: null,
					onWebsite: true
				})
			),
			201
		).id;
		// vergangen und nicht auf der Website
		ok(
			await call(
				'owner',
				'POST',
				'/events',
				base({
					title: 'Vorbei',
					startsOn: addDays(today, -3),
					startsTime: null,
					endsOn: addDays(today, -1),
					endsTime: null,
					onWebsite: true
				})
			),
			201
		);
		ok(
			await call(
				'owner',
				'POST',
				'/events',
				base({
					title: 'Intern',
					startsOn: addDays(today, 5),
					startsTime: null,
					endsOn: null,
					endsTime: null,
					onWebsite: false
				})
			),
			201
		);
	});

	it('liefert nur on_website-Termine ab heute mit exakter Feldmenge', async () => {
		const list = ok<WebsiteEvent[]>(await call('web', 'GET', '/website/events'));
		expect(list.map((e) => e.id)).toEqual([webRunning, webToday, webFuture]);
		for (const e of list) {
			expect(Object.keys(e).sort()).toEqual(
				[
					'color',
					'description',
					'endsOn',
					'endsTime',
					'groupIds',
					'groups',
					'id',
					'location',
					'occurrenceDate',
					'recurring',
					'startsOn',
					'startsTime',
					'tags',
					'title'
				].sort()
			);
		}
		const fest = list.find((e) => e.id === webFuture)!;
		expect(fest).toEqual({
			id: webFuture,
			title: 'Sommerfest',
			description: 'Basteln mit Holz',
			location: 'Heim',
			color: '#2563eb',
			startsOn: addDays(today, 5),
			startsTime: '15:00',
			endsOn: addDays(today, 6),
			endsTime: null,
			tags: ['Fest', 'Öffentlich'],
			groups: [DEFAULT_STAMM_NAME, 'Sippe Falke'],
			groupIds: ['stamm', falke],
			recurring: false,
			occurrenceDate: null
		});
		const raw = JSON.stringify(list);
		expect(raw).not.toContain('Olga');
		expect(raw).not.toContain(userIds.e!);
		expect(raw).not.toContain('shares');
		expect(raw).not.toContain('owner');
		// Gruppenstunden gehören nicht auf die Website
		expect(raw).not.toContain('meeting');
		expect(raw).not.toContain('Pfadiheim Kellerraum');
	});

	it('Stammesname aus der Einstellung erscheint in den Gruppen', async () => {
		await setSetting(admin, STAMM_NAME_SETTING, 'Stamm Testpiraten');
		try {
			const list = ok<WebsiteEvent[]>(await call('web', 'GET', '/website/events'));
			expect(list.find((e) => e.id === webFuture)!.groups).toEqual([
				'Stamm Testpiraten',
				'Sippe Falke'
			]);
			const groups = ok<EventGroupRef[]>(await call('owner', 'GET', '/groups'));
			expect(groups[0]).toEqual({
				id: 'stamm',
				name: 'Stamm Testpiraten',
				color: null,
				meetingWeekday: null,
				meetingTime: null,
				meetingEndTime: null,
				meetingPlace: null
			});
		} finally {
			await setSetting(admin, STAMM_NAME_SETTING, null);
		}
		const after = ok<WebsiteEvent[]>(await call('web', 'GET', '/website/events'));
		expect(after.find((e) => e.id === webFuture)!.groups[0]).toBe(DEFAULT_STAMM_NAME);
	});

	it('Filter tag/from/to und 422 bei to < from', async () => {
		const byTag = ok<WebsiteEvent[]>(await call('web', 'GET', '/website/events?tag=öffentlich'));
		expect(byTag.map((e) => e.id)).toEqual([webFuture]);
		const window = ok<WebsiteEvent[]>(
			await call('web', 'GET', `/website/events?from=${today}&to=${today}`)
		);
		expect(window.map((e) => e.id)).toEqual([webRunning, webToday]);
		fail(
			await call('web', 'GET', `/website/events?from=${today}&to=${addDays(today, -1)}`),
			422,
			'validation_failed'
		);
	});

	it('Key ohne Scope → 403; Website-Key darf keine internen Endpoints', async () => {
		fail(await call('webNoScope', 'GET', '/website/events'), 403, 'forbidden');
		fail(await call('web', 'GET', '/events'), 403, 'forbidden');
		fail(await call('web', 'GET', `/events/${webFuture}`), 403, 'forbidden');
		fail(await call('web', 'GET', '/groups'), 403, 'forbidden');
		// interne Benutzer ohne Website-Scope ebenfalls nicht
		fail(await call('owner', 'GET', '/website/events'), 403, 'forbidden');
	});
});

describe('Freigabe-Kandidaten, Gruppen, Tags', () => {
	async function search(term: string) {
		return ok<PrincipalInfo[]>(
			await call('owner', 'GET', `/principals?search=${encodeURIComponent(term)}`)
		);
	}

	it('GET /principals findet Stamm, Gruppen, Rollen, Benutzer und Mitglieder', async () => {
		expect(await search('Stamm')).toContainEqual({
			type: 'everyone',
			id: '*',
			name: DEFAULT_STAMM_NAME
		});
		expect(await search('Falke')).toContainEqual({
			type: 'group',
			id: falke,
			name: 'Sippe Falke',
			color: '#16a34a',
			image: null
		});
		expect(await search('Redakt')).toContainEqual({
			type: 'role',
			id: editorsRole,
			name: 'Redaktion'
		});
		expect(await search('Benutzer Em')).toContainEqual({
			type: 'user',
			id: userIds.e,
			name: 'Benutzer Emil',
			detail: 'e@example.test',
			image: null
		});
		const members = await search('Albre');
		expect(members).toContainEqual({
			type: 'member',
			id: anna,
			name: 'Anna Albrecht',
			detail: 'Sippe Falke'
		});
		// ausgetretene Mitglieder werden nicht vorgeschlagen
		expect((await search('Egon')).some((p) => p.type === 'member')).toBe(false);
		// Reihenfolge: everyone, group, role, member, user
		const mixed = await search('al'); // „alle“ (Stamm), Albrecht, Alle Anna …
		const order = ['everyone', 'group', 'role', 'member', 'user'];
		const idx = mixed.map((p) => order.indexOf(p.type));
		expect([...idx].sort((x, y) => x - y)).toEqual(idx);
		expect(mixed[0]!.type).toBe('everyone');
	});

	it('GET /principals verlangt mindestens 2 Zeichen', async () => {
		fail(await call('owner', 'GET', '/principals?search=a'), 422, 'validation_failed');
		fail(await call('owner', 'GET', '/principals'), 422, 'validation_failed');
	});

	it('GET /groups: Stamm zuerst, dann Gruppen nach Name', async () => {
		const groups = ok<EventGroupRef[]>(await call('a', 'GET', '/groups'));
		expect(groups.map((g) => g.name)).toEqual([
			DEFAULT_STAMM_NAME,
			'Meute Wolf',
			'Sippe Falke',
			'Sippe Otter'
		]);
		expect(groups.find((g) => g.id === falke)).toEqual({
			id: falke,
			name: 'Sippe Falke',
			color: '#16a34a',
			meetingWeekday: 2,
			meetingTime: '18:00',
			meetingEndTime: '19:30',
			meetingPlace: 'Pfadiheim Kellerraum'
		});
		expect(groups.find((g) => g.id === wolf)).toMatchObject({
			meetingWeekday: null,
			meetingTime: null,
			meetingEndTime: null,
			meetingPlace: null
		});
		expect(groups[0]).toMatchObject({
			id: 'stamm',
			meetingWeekday: null,
			meetingTime: null,
			meetingEndTime: null,
			meetingPlace: null
		});
	});

	it('GET /tags: verwendete Tags, häufigste zuerst, Teilsuche', async () => {
		const tags = ok<string[]>(await call('a', 'GET', '/tags'));
		expect(tags[0]).toBe('Basteln');
		expect(tags).toEqual(expect.arrayContaining(['Sippe', 'Draußen', 'Stamm', 'Fest']));
		expect(new Set(tags.map((t) => t.toLowerCase())).size).toBe(tags.length);
		expect(ok<string[]>(await call('a', 'GET', '/tags?search=drau'))).toEqual(['Draußen']);
		expect(ok<string[]>(await call('a', 'GET', '/tags?search=%25'))).toEqual([]);
	});
});

describe('Audit', () => {
	it('created/updated/deleted ohne Titel, Namen oder E-Mail in metadata', async () => {
		const { rows } = await listAudit({ action: 'events.event.', limit: 200 });
		const actions = new Set(rows.map((r) => r.action));
		expect(actions).toEqual(
			new Set([
				'events.event.created',
				'events.event.updated',
				'events.event.deleted',
				'events.event.published',
				'events.event.unpublished'
			])
		);
		const created = rows.find((r) => r.action === 'events.event.created' && r.target === eMain);
		expect(created?.metadata).toEqual({
			onWebsite: false,
			tags: 2,
			groups: 1,
			shares: mainShares.length
		});
		const updated = rows.find((r) => r.action === 'events.event.updated' && r.target === eMain);
		// API-Key-Akteur: Name = Key-Name + Präfix (Key „d“ gehört Benutzer d)
		expect(updated?.actorType).toBe('api_key');
		expect(updated?.actorName).toMatch(/^d \(/);
		const meta = JSON.stringify(rows.map((r) => r.metadata));
		for (const secret of [
			'Sippenstunde',
			'Gruppenstunde',
			'Leiterrunde',
			'Sommerfest',
			'Basteln',
			'Olga',
			'Emil',
			'Fritz',
			'@example.test',
			'Sippe Falke'
		]) {
			expect(meta, secret).not.toContain(secret);
		}
	});
});

describe('members deaktiviert', () => {
	beforeAll(async () => {
		await disableModule(admin, 'members');
	});

	it('Termine mit Gruppenfreigabe bleiben für Eigentümer*in lesbar, Liste funktioniert', async () => {
		const detail = ok<EventDetail>(await call('owner', 'GET', `/events/${eMain}`));
		expect(detail.access).toEqual({ level: 'edit', isOwner: true });
		expect(detail.shares).toHaveLength(mainShares.length);
		// Gruppen-/Mitglieds-Principals lassen sich nicht mehr auflösen
		expect(detail.shares.find((s) => s.type === 'group')?.name).toBe('Unbekannt');
		expect(detail.shares.find((s) => s.type === 'role')?.name).toBe('Redaktion');
		expect(detail.groups).toEqual([]);
		expect(await listIds('owner')).toContain(eMain);
		ok<EventGroupRef[]>(await call('owner', 'GET', '/groups'));
		expect(ok<EventGroupRef[]>(await call('owner', 'GET', '/groups'))).toEqual([
			{
				id: 'stamm',
				name: DEFAULT_STAMM_NAME,
				color: null,
				meetingWeekday: null,
				meetingTime: null,
				meetingEndTime: null,
				meetingPlace: null
			}
		]);
		// Rollenfreigabe greift weiter, Gruppen-/Mitgliedsfreigaben nicht
		ok(await call('d', 'GET', `/events/${eMain}`));
		for (const who of ['b', 'f']) {
			fail(await call(who, 'GET', `/events/${eMain}`), 404, 'not_found');
			fail(await call(who, 'DELETE', `/events/${eMain}`), 404, 'not_found');
			expect(await listIds(who)).not.toContain(eMain);
		}
		const principals = ok<PrincipalInfo[]>(await call('owner', 'GET', '/principals?search=Falke'));
		expect(principals).toEqual([]);
	});

	it('neue Gruppenfreigabe oder Gruppenzuordnung → 422', async () => {
		const share = await call(
			'owner',
			'POST',
			'/events',
			base({ shares: [{ type: 'group', id: falke, level: 'read' }] })
		);
		fail(share, 422, 'validation_failed');
		expect(paths(share)).toEqual(['shares.0.id']);
		const group = await call('owner', 'POST', '/events', base({ groupIds: [falke] }));
		fail(group, 422, 'validation_failed');
		expect(paths(group)).toEqual(['groupIds.0']);
		// ohne Gruppen weiterhin möglich
		ok(
			await call(
				'owner',
				'POST',
				'/events',
				base({ groupIds: ['stamm'], shares: [{ type: 'role', id: editorsRole, level: 'read' }] })
			),
			201
		);
	});

	it('bestehende Gruppenfreigaben blockieren PUT nicht, neue schon', async () => {
		// Gespeicherte Gruppen-/Mitgliedsfreigaben und Gruppen gelten weiter als gültig
		const put = ok<EventDetail>(
			await call('owner', 'PUT', `/events/${eMain}`, mainBody({ title: 'Neu' }))
		);
		expect(put.title).toBe('Neu');
		const added = await call(
			'owner',
			'PUT',
			`/events/${eMain}`,
			mainBody({ shares: [...mainShares, { type: 'group', id: 'unbekannt-1', level: 'read' }] })
		);
		fail(added, 422, 'validation_failed');
		expect(paths(added)).toEqual([`shares.${mainShares.length}.id`]);
		const stripped = ok<EventDetail>(
			await call(
				'owner',
				'PUT',
				`/events/${eMain}`,
				mainBody({
					groupIds: [],
					shares: mainShares.filter((s) => s.type !== 'group' && s.type !== 'member')
				})
			)
		);
		expect(stripped.shares.map((s) => s.type).sort()).toEqual(['role', 'user']);
	});
});

describe('Modul events deaktiviert', () => {
	it('alle Endpoints → 404', async () => {
		await disableModule(admin, 'events');
		fail(await call('owner', 'GET', '/events'), 404, 'module_disabled');
		fail(await call('owner', 'GET', `/events/${eMain}`), 404, 'module_disabled');
		fail(await call('web', 'GET', '/website/events'), 404, 'module_disabled');
		fail(await call('owner', 'POST', '/events', base()), 404, 'module_disabled');
	});
});
