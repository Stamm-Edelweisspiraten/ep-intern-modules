import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, navigationFor, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { runJobNow } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { setSetting } from '$testing';
import { core } from '$lib/sdk/server';
import { setTodayForTests } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import { LED_EDIT, LED_EXPORT, LED_VIEW, LEADER_ROLE_NAME } from '$modules/members/schemas';
import type { GroupRef, Member, MemberLinks, MemberList } from '$modules/members/schemas';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'leader-password-1234';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};

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
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
/** API-Key mit allen aktuell wirksamen Rechten (Scopes werden beim Anlegen festgehalten) */
async function keyOf(name: string) {
	const ctx = await ctxOf(userIds[name]!);
	return (await createApiKey(ctx, { name: `k-${Date.now()}`, scopes: [...ctx.permissions] })).key;
}
let adminKey = '';
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: adminKey, ...init });
const as = (key: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/members${path}`, { token: key, ...init });

const memberBody = (firstName: string, over: Record<string, unknown> = {}) => ({
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
});
async function mkMember(firstName: string, over: Record<string, unknown> = {}) {
	return data<Member>(
		await A('/members', { method: 'POST', json: memberBody(firstName, over) }),
		201
	);
}
async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
}
const permsOf = async (name: string) => (await ctxOf(userIds[name]!)).permissions;
const grantedUsers = async () =>
	(await core.roles.listModuleGrants('members')).map((g) => g.userId).sort();

let gruen: GroupRef;
let blau: GroupRef;
let lea: Member; // leitet Grün, eigenes Konto „leiter“, Konto „mutter“ = Elternteil
let ben: Member; // leitet Blau
let anna: Member; // Grün
let bert: Member; // Blau
let carl: Member; // Grün + Blau

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
	setTodayForTests('2026-06-01');
	// Keine externen Adressdienste im Test
	await setSetting(admin, 'members.address.openPlzUrl', '');
	await setSetting(admin, 'members.address.photonUrl', '');
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));

	await mkUser('leiter', ['core.api.manage']);
	await mkUser('mutter', ['core.api.manage']);
	await mkUser('verwaltung', [
		'core.api.manage',
		'members.member.view',
		'members.member.edit',
		'members.group.view',
		'members.group.edit',
		'members.link.view',
		'members.link.manage'
	]);

	lea = await mkMember('Lea', { birthDate: '2004-03-01', stage: 'kreuzpfadfinder' });
	ben = await mkMember('Ben', { birthDate: '2003-03-01', stage: 'kreuzpfadfinder' });
	const mkGroup = async (name: string, leader: string) =>
		data<GroupRef>(
			await A('/groups', { method: 'POST', json: { name, type: 'sippe', leaderIds: [leader] } }),
			201
		);
	gruen = await mkGroup('Grün', lea.id);
	blau = await mkGroup('Blau', ben.id);
	anna = await mkMember('Anna', { groupIds: [gruen.id] });
	bert = await mkMember('Bert', { groupIds: [blau.id] });
	carl = await mkMember('Carl', { groupIds: [gruen.id, blau.id] });
	for (const [user, relation] of [
		['leiter', 'selbst'],
		['mutter', 'Mutter']
	] as const) {
		await data<MemberLinks>(
			await A(`/members/${lea.id}/links`, {
				method: 'POST',
				json: { userId: userIds[user], relation }
			}),
			201
		);
	}
});
afterAll(async () => {
	setTodayForTests(null);
	setPdfRendererForTests(undefined);
	uninstallFakeStorage();
	await close();
});
beforeEach(() => resetAllForTests());

describe('Gruppenleitung: Rechte über das eigene Konto', () => {
	it('Rechte und Rolle sind deklariert', () => {
		const m = membersModule.manifest;
		expect(m.permissions).toEqual(expect.arrayContaining([LED_VIEW, LED_EDIT, LED_EXPORT]));
		expect(m.defaultRoleGrants?.[LEADER_ROLE_NAME]).toEqual(
			expect.arrayContaining([LED_VIEW, LED_EDIT, LED_EXPORT, 'members.storage.write'])
		);
	});

	it('ohne Markierung „eigenes Konto“ bekommt niemand Leitungsrechte – auch die Eltern nicht', async () => {
		expect(await grantedUsers()).toEqual([]);
		expect((await permsOf('leiter')).has(LED_VIEW)).toBe(false);
		expect((await permsOf('mutter')).has(LED_VIEW)).toBe(false);
	});

	it('eigenes Konto markieren verleiht die Rolle „Gruppenleitung“', async () => {
		const links = await data<MemberLinks>(
			await A(`/members/${lea.id}/links/${userIds.leiter}`, { method: 'PUT', json: { self: true } })
		);
		expect(links.users.find((u) => u.id === userIds.leiter)?.self).toBe(true);
		expect(links.users.find((u) => u.id === userIds.mutter)?.self).toBe(false);
		expect(await grantedUsers()).toEqual([userIds.leiter]);
		const perms = await permsOf('leiter');
		for (const p of [LED_VIEW, LED_EDIT, LED_EXPORT, 'members.storage.read']) {
			expect(perms.has(p), p).toBe(true);
		}
		expect(perms.has('members.member.view')).toBe(false);
		expect((await permsOf('mutter')).has(LED_VIEW)).toBe(false);
		const audit = await listAudit({ action: 'members.link.self-changed' });
		expect(audit.rows[0]?.metadata).toEqual({
			memberId: lea.id,
			userId: userIds.leiter,
			self: true
		});
	});

	it('je Mitglied und je Konto nur ein eigenes Konto (409), unbekannte Verknüpfung 404', async () => {
		expect(
			await errCode(
				await A(`/members/${lea.id}/links/${userIds.mutter}`, {
					method: 'PUT',
					json: { self: true }
				}),
				409
			)
		).toBe('conflict');
		expect(
			await errCode(
				await A(`/members/${anna.id}/links/${userIds.leiter}`, {
					method: 'PUT',
					json: { self: true }
				}),
				404
			)
		).toBe('not_found');
	});

	it('Navigation „Mitglieder“ erscheint auch für die Gruppenleitung, nicht für Eltern', async () => {
		const nav = async (name: string) =>
			(await navigationFor(await ctxOf(userIds[name]!))).map((n) => n.path);
		expect(await nav('leiter')).toContain('/modules/members');
		expect(await nav('mutter')).not.toContain('/modules/members');
	});
});

describe('Gruppenleitung: Zugriff nur auf die eigenen Gruppen', () => {
	let key = '';
	beforeAll(async () => {
		key = await keyOf('leiter');
	});

	it('GET /led/groups liefert nur die geleitete Gruppe', async () => {
		const groups = await data<GroupRef[]>(await as(key, '/led/groups'));
		expect(groups.map((g) => g.name)).toEqual(['Grün']);
	});

	it('GET /led/members liefert nur Mitglieder der eigenen Gruppen', async () => {
		const list = await data<MemberList>(await as(key, '/led/members'));
		expect(list.items.map((m) => m.firstName).sort()).toEqual(['Anna', 'Carl']);
		expect(list.total).toBe(2);
		// Filter auf eine fremde Gruppe: nur eigene Mitglieder, die zusätzlich dort sind
		const other = await data<MemberList>(await as(key, `/led/members?groupId=${blau.id}`));
		expect(other.items.map((m) => m.firstName)).toEqual(['Carl']);
	});

	it('Einzelabruf: eigenes Mitglied 200, fremdes 404', async () => {
		const m = await data<Member>(await as(key, `/led/members/${carl.id}`));
		expect(m.groups.map((g) => g.name).sort()).toEqual(['Blau', 'Grün']);
		expect(await errCode(await as(key, `/led/members/${bert.id}`), 404)).toBe('not_found');
	});

	it('Verwaltungs-Endpunkte bleiben gesperrt (403)', async () => {
		expect(await errCode(await as(key, '/members'), 403)).toBe('forbidden');
		expect(await errCode(await as(key, `/members/${anna.id}`), 403)).toBe('forbidden');
		expect(await errCode(await as(key, '/groups'), 403)).toBe('forbidden');
		expect(
			await errCode(await as(key, '/members', { method: 'POST', json: memberBody('Neu') }), 403)
		).toBe('forbidden');
		expect(await errCode(await as(key, `/members/${anna.id}`, { method: 'DELETE' }), 403)).toBe(
			'forbidden'
		);
	});

	it('Bearbeiten ändert Personendaten, aber nie Gruppen oder Mitgliedschaftsdaten', async () => {
		const saved = await data<Member>(
			await as(key, `/led/members/${anna.id}`, {
				method: 'PUT',
				json: memberBody('Anna-Lena', {
					stage: 'spaeher',
					phones: [{ name: 'Mutter', value: '+49 170 7654321' }],
					custom: { allergien: 'Nüsse' },
					groupIds: [blau.id],
					entryDate: '2020-01-01',
					exitDate: '2026-05-01',
					secondaryMember: true,
					feeLevels: ['stamm']
				})
			})
		);
		expect(saved.firstName).toBe('Anna-Lena');
		expect(saved.stage).toBe('spaeher');
		expect(saved.phones).toEqual([{ name: 'Mutter', value: '+49 170 7654321' }]);
		expect(saved.custom).toMatchObject({ allergien: 'Nüsse' });
		expect(saved.groups.map((g) => g.id)).toEqual([gruen.id]);
		expect(saved.entryDate).toBeNull();
		expect(saved.exitDate).toBeNull();
		expect(saved.secondaryMember).toBe(false);
		expect(saved.feeLevels).toEqual(['stamm', 'gau', 'landesmark', 'bund']);
		const audit = await listAudit({ action: 'members.member.updated' });
		expect(audit.rows.find((e) => e.target === anna.id)?.metadata).toEqual({
			asGroupLeader: true
		});
	});

	it('fremdes Mitglied bearbeiten → 404', async () => {
		expect(
			await errCode(
				await as(key, `/led/members/${bert.id}`, { method: 'PUT', json: memberBody('X') }),
				404
			)
		).toBe('not_found');
	});

	it('Dokumente: Upload/Abruf/Löschen nur für eigene Mitglieder', async () => {
		await installFakeStorage(admin);
		const form = () => {
			const f = new FormData();
			f.set(
				'file',
				new File(['%PDF-1.4\n%%EOF\n'], 'datenschutz.pdf', { type: 'application/pdf' })
			);
			return f;
		};
		expect(
			await errCode(
				await as(key, `/led/members/${bert.id}/documents/privacy`, {
					method: 'POST',
					body: form()
				}),
				404
			)
		).toBe('not_found');
		const up = await data<{ name: string }>(
			await as(key, `/led/members/${anna.id}/documents/privacy`, { method: 'POST', body: form() }),
			201
		);
		expect(up.name).toBe('datenschutz.pdf');
		const dl = await as(key, `/led/members/${anna.id}/documents/privacy`);
		expect(dl.status).toBe(200);
		expect(await errCode(await as(key, `/led/members/${bert.id}/documents/privacy`), 404)).toBe(
			'not_found'
		);
		await data(await as(key, `/led/members/${anna.id}/documents/privacy`, { method: 'DELETE' }));
	});

	it('PDF-Listen nur für eigene Mitglieder und Gruppen', async () => {
		const ok = await as(key, '/led/members/sheets.pdf', {
			method: 'POST',
			json: { ids: [anna.id, carl.id] }
		});
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('application/pdf');
		expect(
			await errCode(
				await as(key, '/led/members/sheets.pdf', {
					method: 'POST',
					json: { ids: [anna.id, bert.id] }
				}),
				404
			)
		).toBe('not_found');
		expect(
			(
				await as(key, '/led/groups/sheets.pdf', {
					method: 'POST',
					json: { groupIds: [gruen.id] }
				})
			).status
		).toBe(200);
		expect(
			await errCode(
				await as(key, '/led/groups/sheets.pdf', {
					method: 'POST',
					json: { groupIds: [blau.id] }
				}),
				404
			)
		).toBe('not_found');
	});

	it('Zusatzfelder und Adressvorschläge ohne Anschriften anderer Mitglieder', async () => {
		const fields = await data<{ fields: unknown[] }>(await as(key, '/led/fields'));
		expect(fields.fields.length).toBeGreaterThan(0);
		const admin = await data<{ items: { source: string }[] }>(
			await A('/address/suggest?q=Musterweg')
		);
		expect(admin.items.some((i) => i.source === 'members')).toBe(true);
		const led = await data<{ items: { source: string }[] }>(
			await as(key, '/led/address/suggest?q=Musterweg')
		);
		expect(led.items.some((i) => i.source === 'members')).toBe(false);
	});

	it('Eltern des leitenden Mitglieds haben keinen Zugriff', async () => {
		const mk = await keyOf('mutter');
		expect(await errCode(await as(mk, '/led/members'), 403)).toBe('forbidden');
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'members');
		try {
			expect((await as(key, '/led/members')).status).toBe(404);
		} finally {
			await enableModule(admin, 'members');
		}
	});
});

describe('Gruppenleitung: Rechte kommen und gehen', () => {
	it('Leitung entfernt → Rolle und Bereich weg; wieder eingetragen → zurück', async () => {
		const key = await keyOf('leiter');
		await data(
			await A(`/groups/${gruen.id}`, {
				method: 'PUT',
				json: { name: 'Grün', type: 'sippe', leaderIds: [ben.id] }
			})
		);
		expect(await grantedUsers()).toEqual([]);
		expect((await permsOf('leiter')).has(LED_VIEW)).toBe(false);
		expect(await errCode(await as(key, '/led/members'), 403)).toBe('forbidden');
		await data(
			await A(`/groups/${gruen.id}`, {
				method: 'PUT',
				json: { name: 'Grün', type: 'sippe', leaderIds: [lea.id] }
			})
		);
		expect(await grantedUsers()).toEqual([userIds.leiter]);
	});

	it('Austritt der Leitung entzieht die Rolle sofort; Job gleicht Fristabläufe nach', async () => {
		await data(
			await A(`/members/${lea.id}`, {
				method: 'PUT',
				json: memberBody('Lea', {
					birthDate: '2004-03-01',
					stage: 'kreuzpfadfinder',
					exitDate: '2026-05-31'
				})
			})
		);
		expect(await grantedUsers()).toEqual([]);
		// Austritt in der Zukunft: noch Leitung, bis der Tag erreicht ist
		await data(
			await A(`/members/${lea.id}`, {
				method: 'PUT',
				json: memberBody('Lea', {
					birthDate: '2004-03-01',
					stage: 'kreuzpfadfinder',
					exitDate: '2026-07-01'
				})
			})
		);
		expect(await grantedUsers()).toEqual([userIds.leiter]);
		setTodayForTests('2026-07-01');
		try {
			// Bereich wirkt sofort (frisch je Aufruf), die Rolle erst nach dem Abgleich
			const key = await keyOf('leiter');
			expect((await data<GroupRef[]>(await as(key, '/led/groups'))).length).toBe(0);
			await runJobNow(admin, 'members.sync-leader-grants');
			expect(await grantedUsers()).toEqual([]);
		} finally {
			setTodayForTests('2026-06-01');
		}
		await data(
			await A(`/members/${lea.id}`, {
				method: 'PUT',
				json: memberBody('Lea', { birthDate: '2004-03-01', stage: 'kreuzpfadfinder' })
			})
		);
		expect(await grantedUsers()).toEqual([userIds.leiter]);
	});

	it('Verknüpfung lösen entzieht die Rolle', async () => {
		await data(await A(`/members/${lea.id}/links/${userIds.leiter}`, { method: 'DELETE' }));
		expect(await grantedUsers()).toEqual([]);
		await data(
			await A(`/members/${lea.id}/links`, {
				method: 'POST',
				json: { userId: userIds.leiter, relation: null }
			}),
			201
		);
		// Neue Verknüpfung ist nie automatisch „eigenes Konto“
		expect(await grantedUsers()).toEqual([]);
	});
});

describe('Gruppenleitung: Schutz vor Rechteausweitung', () => {
	let key = '';
	beforeAll(async () => {
		key = await keyOf('verwaltung');
	});

	it('ohne die Rechte der Rolle kein „eigenes Konto“ für eine Leitung (403)', async () => {
		expect(
			await errCode(
				await as(key, `/members/${lea.id}/links/${userIds.leiter}`, {
					method: 'PUT',
					json: { self: true }
				}),
				403
			)
		).toBe('forbidden');
		// Mitglied ohne Leitung: Markieren ist unkritisch
		await data(
			await A(`/members/${anna.id}/links`, {
				method: 'POST',
				json: { userId: userIds.mutter, relation: 'Mutter' }
			}),
			201
		);
		await data(
			await as(key, `/members/${anna.id}/links/${userIds.mutter}`, {
				method: 'PUT',
				json: { self: true }
			})
		);
	});

	it('ohne die Rechte der Rolle keine Leitung mit eigenem Konto eintragen (403)', async () => {
		expect(
			await errCode(
				await as(key, `/groups/${blau.id}`, {
					method: 'PUT',
					json: { name: 'Blau', type: 'sippe', leaderIds: [ben.id, anna.id] }
				}),
				403
			)
		).toBe('forbidden');
		// Leitung ohne eigenes Konto (Ben) bleibt erlaubt
		await data(
			await as(key, `/groups/${blau.id}`, {
				method: 'PUT',
				json: { name: 'Blau', type: 'sippe', leaderIds: [ben.id] }
			})
		);
		// Administrator*in darf
		await data(
			await A(`/groups/${blau.id}`, {
				method: 'PUT',
				json: { name: 'Blau', type: 'sippe', leaderIds: [ben.id, anna.id] }
			})
		);
		expect(await grantedUsers()).toEqual([userIds.mutter]);
	});

	it('Konto gelöscht → Rolle weg (Abgleich nach dem Commit)', async () => {
		await deleteUser(admin, userIds.mutter!);
		expect(await grantedUsers()).toEqual([]);
	});
});
