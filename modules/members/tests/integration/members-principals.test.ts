import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import membersModule from '$modules/members/module';
import type { MembersService } from '$modules/members/contract';
import type { RequestContext } from '$lib/sdk/types';

const service = membersModule.provides as unknown as MembersService;
let admin: RequestContext;
let key: string;

async function api(path: string, json: unknown): Promise<{ id: string }> {
	resetAllForTests();
	const url = new URL(`http://localhost:5173/api/v1/modules/members${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			body: JSON.stringify(json),
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.data as { id: string };
}

const createMember = async (over: Record<string, unknown>) =>
	(
		await api('/members', {
			birthDate: '2012-05-17',
			street: 'Musterweg 1',
			postalCode: '28357',
			city: 'Bremen',
			stage: 'pfadfinder',
			...over
		})
	).id;

const createGroup = async (name: string, leaderIds: string[], color?: string) =>
	(await api('/groups', { name, type: 'sippe', leaderIds, ...(color ? { color } : {}) })).id;

async function link(memberId: string, userId: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${memberId}, ${userId}, 'Mutter')`
		);
	});
}

let leader: string;
let anna: string;
let ben: string;
let egon: string;
let fiona: string;
let groupFalke: string;
let groupAdler: string;
let groupWolf: string;
let groupOtter: string;

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
	key = (await createApiKey(admin, { name: 'k', scopes: [...membersModule.manifest.permissions] }))
		.key;

	leader = await createMember({ firstName: 'Lea', lastName: 'Leitung', scoutName: 'Eule' });
	groupFalke = (
		await api('/groups', {
			name: 'Sippe Falke',
			type: 'sippe',
			leaderIds: [leader],
			color: '#16a34a',
			meetingWeekday: 3,
			meetingTime: '17:30',
			meetingPlace: 'Pfadiheim'
		})
	).id;
	groupAdler = await createGroup('Sippe Adler', [leader]);
	groupWolf = await createGroup('Meute Wolf', [leader]);
	groupOtter = await createGroup('Sippe Otter', [leader]);

	anna = await createMember({ firstName: 'Anna', lastName: 'Albrecht', groupIds: [groupFalke] });
	ben = await createMember({ firstName: 'Ben', lastName: 'Bunt', groupIds: [groupFalke] });
	// Ausgetreten, aber Mitglied der Gruppe Otter
	egon = await createMember({
		firstName: 'Egon',
		lastName: 'Weg',
		groupIds: [groupOtter],
		exitDate: '2020-01-01'
	});
	// Austritt in der Zukunft = noch aktiv
	fiona = await createMember({
		firstName: 'Fiona',
		lastName: 'Fern',
		exitDate: '2099-12-31'
	});
	// Ben leitet zusätzlich die Meute Wolf
	await api('/groups', { name: 'Sippe Dachs', type: 'sippe', leaderIds: [ben] });
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO group_leaders (group_id, member_id) VALUES (${groupWolf}, ${ben})`
		);
	});
});

describe('listGroups', () => {
	it('liefert alle Gruppen nach Name mit Farbe', async () => {
		const list = await service.listGroups();
		expect(list.map((g) => g.name)).toEqual([
			'Meute Wolf',
			'Sippe Adler',
			'Sippe Dachs',
			'Sippe Falke',
			'Sippe Otter'
		]);
		expect(list.find((g) => g.id === groupFalke)).toEqual({
			id: groupFalke,
			name: 'Sippe Falke',
			color: '#16a34a',
			image: null,
			meetingWeekday: 3,
			meetingTime: '17:30',
			meetingEndTime: null,
			meetingPlace: 'Pfadiheim'
		});
		expect(list.find((g) => g.id === groupAdler)).toMatchObject({
			color: null,
			meetingWeekday: null,
			meetingTime: null,
			meetingPlace: null
		});
	});

	it('macht leere Texte zu null; Uhrzeiten außerhalb HH:MM lehnt die DB ab (CHECK, members/0014)', async () => {
		await expect(
			core.database.forModule('members').transaction(async (tx) => {
				await tx.execute(sql`UPDATE groups SET meeting_time = '9:05:00' WHERE id = ${groupOtter}`);
			})
		).rejects.toThrow();
		await core.database.forModule('members').transaction(async (tx) => {
			await tx.execute(
				sql`UPDATE groups SET meeting_weekday = 7, meeting_time = '09:05', meeting_place = '   '
					WHERE id = ${groupOtter}`
			);
		});
		try {
			const otter = (await service.listGroups()).find((g) => g.id === groupOtter)!;
			expect(otter.meetingWeekday).toBe(7);
			expect(typeof otter.meetingWeekday).toBe('number');
			expect(otter.meetingTime).toBe('09:05');
			expect(otter.meetingPlace).toBeNull();
		} finally {
			await core.database.forModule('members').transaction(async (tx) => {
				await tx.execute(
					sql`UPDATE groups SET meeting_weekday = NULL, meeting_time = NULL, meeting_place = NULL
						WHERE id = ${groupOtter}`
				);
			});
		}
	});
});

describe('principalIdsForUser', () => {
	it('liefert Mitglieder und Gruppen (Mitgliedschaft + Leitung), ohne ausgetretene', async () => {
		const userId = 'user-eltern';
		await link(anna, userId);
		await link(ben, userId);
		await link(egon, userId);
		await link(fiona, userId);
		const res = await service.principalIdsForUser(userId);
		expect(new Set(res.memberIds)).toEqual(new Set([anna, ben, fiona]));
		const dachs = (await service.listGroups()).find((g) => g.name === 'Sippe Dachs')!.id;
		// Falke (Anna, Ben), Wolf + Dachs (Ben leitet), nicht Otter (Egon ausgetreten)
		expect(new Set(res.groupIds)).toEqual(new Set([groupFalke, groupWolf, dachs]));
		expect(res.groupIds.length).toBe(3); // dedupliziert
	});

	it('liefert leere Listen für unbekannte Benutzer', async () => {
		expect(await service.principalIdsForUser('niemand')).toEqual({
			memberIds: [],
			groupIds: []
		});
	});
});

describe('searchMembers', () => {
	it('sucht ab 2 Zeichen über Vor-, Nach-, Pfadname und vollen Namen', async () => {
		expect(await service.searchMembers({ search: 'a' })).toEqual([]);
		expect(await service.searchMembers({ search: '  ' })).toEqual([]);
		expect(await service.searchMembers({})).toEqual([]);

		const anna1 = await service.searchMembers({ search: 'Albre' });
		expect(anna1).toEqual([
			{ id: anna, name: 'Anna Albrecht', groups: [{ id: groupFalke, name: 'Sippe Falke' }] }
		]);
		expect((await service.searchMembers({ search: 'anna alb' })).map((m) => m.id)).toEqual([anna]);
		expect((await service.searchMembers({ search: 'eule' })).map((m) => m.id)).toEqual([leader]);
	});

	it('schließt ausgetretene bei der Suche aus, nicht bei IDs', async () => {
		expect(await service.searchMembers({ search: 'Egon' })).toEqual([]);
		expect((await service.searchMembers({ search: 'Fiona' })).map((m) => m.id)).toEqual([fiona]);
		const byIds = await service.searchMembers({ ids: [egon, anna, 'unbekannt'] });
		expect(new Set(byIds.map((m) => m.id))).toEqual(new Set([egon, anna]));
		expect(byIds.find((m) => m.id === egon)?.groups).toEqual([
			{ id: groupOtter, name: 'Sippe Otter' }
		]);
	});

	it('entfernt Platzhalterzeichen und beachtet das Limit', async () => {
		expect(await service.searchMembers({ search: '%%' })).toEqual([]);
		expect(await service.searchMembers({ search: '__' })).toEqual([]);
		expect((await service.searchMembers({ search: 'An%na' })).map((m) => m.id)).toEqual([anna]);

		for (let i = 0; i < 32; i++) {
			await createMember({ firstName: `Zora${i}`, lastName: 'Zett' });
		}
		expect(await service.searchMembers({ search: 'Zett' })).toHaveLength(20);
		expect(await service.searchMembers({ search: 'Zett', limit: 5 })).toHaveLength(5);
		expect(await service.searchMembers({ search: 'Zett', limit: 100 })).toHaveLength(30);
	});
});
