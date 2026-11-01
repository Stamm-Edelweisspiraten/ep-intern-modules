import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import membersModule from '$modules/members/module';
import { membersService } from '$modules/members/fields.service';
import type { RequestContext } from '$lib/sdk/types';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PW = 'correct-horse-battery';
const BASE = '/modules/members';

let admin: RequestContext;
let adminId: string;
let fullKey: string;
let viewKey: string;

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
let leader: MemberDto;
let group: GroupDto;

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
	viewKey = (
		await createApiKey(admin, {
			name: 'view',
			scopes: ['members.member.view', 'members.group.view']
		})
	).key;
});

describe('Bootstrap: Mitglieder und Gruppen', () => {
	it('legt das erste Mitglied ohne Gruppe an (Mehrfach-Telefon/E-Mail)', async () => {
		leader = await data<MemberDto>(
			await call('/members', { method: 'POST', json: memberBody() }),
			201
		);
		expect(leader.phones).toEqual([
			{ name: 'Mutter', value: '0123 456' },
			{ name: null, value: '0987 654' }
		]);
		expect(leader.emails).toEqual([
			{ name: null, value: 'max@example.test' },
			{ name: 'Eltern', value: 'eltern@example.test' }
		]);
		expect(leader.groups).toEqual([]);
	});

	it('legt eine Gruppe mit diesem Mitglied als Leiter an', async () => {
		group = await data<GroupDto>(
			await call('/groups', {
				method: 'POST',
				json: {
					name: 'Wolfsrudel',
					type: 'meute',
					leaderIds: [leader.id],
					meetingPlace: 'Heim',
					meetingTime: '16:30'
				}
			}),
			201
		);
		expect(group.leaders.map((l) => l.id)).toEqual([leader.id]);
		const list = await data<GroupDto[]>(await call('/groups'));
		expect(list.some((g) => g.id === group.id)).toBe(true);
	});

	it('Gruppen sind optional (auch wenn bereits Gruppen existieren)', async () => {
		const res = await call('/members', {
			method: 'POST',
			json: memberBody({ firstName: 'Ohne', groupIds: [] })
		});
		expect(res.status).toBe(201);
		expect((await data<MemberDto>(res, 201)).groups).toEqual([]);
		const unknown = await call('/members', {
			method: 'POST',
			json: memberBody({ firstName: 'X', groupIds: [crypto.randomUUID()] })
		});
		expect(unknown.status).toBe(422);
	});
});

describe('Mitglieder-CRUD', () => {
	let memberId: string;

	it('legt ein Mitglied mit Gruppe an und liefert es in Liste und Detail', async () => {
		const m = await data<MemberDto>(
			await call('/members', {
				method: 'POST',
				json: memberBody({ firstName: 'Lena', groupIds: [group.id] })
			}),
			201
		);
		memberId = m.id;
		expect(m.groups.map((g) => g.id)).toEqual([group.id]);
		const list = await data<{ items: MemberDto[]; total: number }>(
			await call('/members?limit=200&offset=0')
		);
		expect(list.total).toBeGreaterThanOrEqual(2);
		const detail = await data<MemberDto>(await call(`/members/${memberId}`));
		expect(detail.id).toBe(memberId);
		const g = (await data<GroupDto[]>(await call('/groups'))).find((x) => x.id === group.id);
		expect(g!.memberCount).toBeGreaterThanOrEqual(1);
	});

	it('aktualisiert Telefon- und E-Mail-Listen', async () => {
		const m = await data<MemberDto>(
			await call(`/members/${memberId}`, {
				method: 'PUT',
				json: memberBody({
					firstName: 'Lena',
					groupIds: [group.id],
					phones: [{ name: 'Oma', value: '+49 111 22233' }],
					emails: [
						{ value: 'a@example.test' },
						{ value: 'B@Example.test', name: 'Papa' },
						{ value: 'c@example.test' }
					]
				})
			})
		);
		expect(m.phones).toEqual([{ name: 'Oma', value: '+49 111 22233' }]);
		expect(m.emails).toHaveLength(3);
		expect(m.emails[1]).toEqual({ name: 'Papa', value: 'b@example.test' });
	});

	const post = (over: Record<string, unknown>) =>
		call('/members', {
			method: 'POST',
			json: memberBody({ groupIds: [group.id], ...over })
		});

	it('lehnt ungültige Telefonnummern ab (422)', async () => {
		expect((await post({ phones: [{ name: null, value: 'abc' }] })).status).toBe(422);
		expect((await post({ phones: [{ name: null, value: '12' }] })).status).toBe(422);
	});

	it('lehnt doppelte E-Mail-Adressen ab (422)', async () => {
		const res = await post({
			emails: [{ value: 'x@example.test' }, { value: 'X@example.test', name: 'Zweit' }]
		});
		expect(res.status).toBe(422);
	});

	it('lehnt ein Geburtsdatum in der Zukunft ab (422)', async () => {
		const future = `${new Date().getFullYear() + 1}-01-01`;
		expect((await post({ birthDate: future })).status).toBe(422);
		expect((await post({ birthDate: '2012-02-30' })).status).toBe(422);
	});

	it('validiert Eingaben (ungültige E-Mail, Stufe) mit 422', async () => {
		const bad = await call('/members', {
			method: 'POST',
			json: memberBody({ emails: [{ name: null, value: 'kaputt' }], groupIds: [group.id] })
		});
		expect(bad.status).toBe(422);
		const stage = await call('/members', {
			method: 'POST',
			json: memberBody({ stage: 'xyz', groupIds: [group.id] })
		});
		expect(stage.status).toBe(422);
	});

	it('kennt den Stand „Jungpfadfinder“ (Migration 0011)', async () => {
		const m = await data<{ id: string; stage: string }>(
			await call('/members', {
				method: 'POST',
				json: memberBody({ firstName: 'Jana', stage: 'jungpfadfinder', emails: [], phones: [] })
			}),
			201
		);
		expect(m.stage).toBe('jungpfadfinder');
		const list = await data<{ items: { id: string }[] }>(
			await call('/members?stage=jungpfadfinder')
		);
		expect(list.items.map((i) => i.id)).toContain(m.id);
	});

	it('löscht ein Mitglied', async () => {
		const res = await call(`/members/${memberId}`, { method: 'DELETE' });
		expect([200, 204]).toContain(res.status);
		expect((await call(`/members/${memberId}`)).status).toBe(404);
	});
});

describe('Gruppen-Regeln', () => {
	it('verlangt mindestens einen Leiter (422)', async () => {
		const res = await call('/groups', {
			method: 'POST',
			json: { name: 'Leer', type: 'sippe', leaderIds: [] }
		});
		expect(res.status).toBe(422);
	});

	it('aktualisiert eine Gruppe', async () => {
		const g = await data<GroupDto>(
			await call(`/groups/${group.id}`, {
				method: 'PUT',
				json: { name: 'Wolfsrudel Nord', type: 'meute', leaderIds: [leader.id] }
			})
		);
		expect(g.name).toBe('Wolfsrudel Nord');
	});

	it('sperrt das Löschen des einzigen Leiters (409)', async () => {
		const res = await call(`/members/${leader.id}`, { method: 'DELETE' });
		expect(res.status).toBe(409);
	});

	it('sperrt das Löschen einer Gruppe mit Mitgliedern (409)', async () => {
		const m = await data<MemberDto>(
			await call('/members', {
				method: 'POST',
				json: memberBody({ firstName: 'Kai', groupIds: [group.id] })
			}),
			201
		);
		expect((await call(`/groups/${group.id}`, { method: 'DELETE' })).status).toBe(409);
		// Mitglied entfernen, dann ist die Gruppe löschbar sofern keine Mitglieder übrig sind
		await call(`/members/${m.id}`, { method: 'DELETE' });
	});

	it('löscht eine leere Gruppe', async () => {
		const g = await data<GroupDto>(
			await call('/groups', {
				method: 'POST',
				json: { name: 'Temp', type: 'sippe', leaderIds: [leader.id] }
			}),
			201
		);
		const res = await call(`/groups/${g.id}`, { method: 'DELETE' });
		expect([200, 204]).toContain(res.status);
	});
});

describe('Gruppen: Wochentag, Farbe, Bild', () => {
	let g: GroupDto;

	it('speichert Wochentag und normalisiert die Farbe', async () => {
		g = await data<GroupDto>(
			await call('/groups', {
				method: 'POST',
				json: {
					name: 'Adler',
					type: 'sippe',
					leaderIds: [leader.id],
					meetingWeekday: 3,
					meetingTime: '17:30',
					color: '#ABC'
				}
			}),
			201
		);
		expect(g.meetingWeekday).toBe(3);
		expect(g.meetingTime).toBe('17:30');
		expect(g.color).toBe('#aabbcc');
		expect(g.hasImage).toBe(false);
		expect(g.imageVersion).toBeNull();
		const listed = (await data<GroupDto[]>(await call('/groups'))).find((x) => x.id === g.id);
		expect(listed!.meetingWeekday).toBe(3);
		expect(listed!.color).toBe('#aabbcc');
	});

	it('lehnt ungültige Farbe und Wochentag ab (422)', async () => {
		const base = { name: 'Farbe', type: 'sippe', leaderIds: [leader.id] };
		expect(
			(await call('/groups', { method: 'POST', json: { ...base, color: 'rot' } })).status
		).toBe(422);
		expect(
			(await call('/groups', { method: 'POST', json: { ...base, meetingWeekday: 8 } })).status
		).toBe(422);
	});

	it('liefert die Gruppenfarbe in den Gruppen eines Mitglieds', async () => {
		const m = await data<MemberDto>(
			await call('/members', {
				method: 'POST',
				json: memberBody({ firstName: 'Farbig', groupIds: [g.id] })
			}),
			201
		);
		expect(m.groups[0]!.color).toBe('#aabbcc');
		await call(`/members/${m.id}`, { method: 'DELETE' });
	});

	it('Bild-Upload ohne verfügbaren Storage schlägt kontrolliert fehl', async () => {
		const form = new FormData();
		// echtes PNG: der Inhalt wird vor dem Speichern geprüft und bereinigt (#19)
		const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
			.png()
			.toBuffer();
		form.set('file', new File([new Uint8Array(png)], 'a.png', { type: 'image/png' }));
		const res = await call(`/groups/${g.id}/image`, { method: 'POST', body: form });
		expect(res.ok).toBe(false);
		expect([502, 503]).toContain(res.status);
	});

	it('lehnt falschen Content-Type ab', async () => {
		const form = new FormData();
		form.set('file', new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }));
		const res = await call(`/groups/${g.id}/image`, { method: 'POST', body: form });
		// einheitliche Upload-Regel (#33): falscher Typ → 422 mit Pfad `file`
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(JSON.stringify(body)).toContain('validation_failed');
	});

	it('liefert ohne Bild 404', async () => {
		expect((await call(`/groups/${g.id}/image`)).status).toBe(404);
		expect((await call(`/groups/${g.id}/image`, { method: 'DELETE' })).status).toBe(404);
	});
});

describe('Dokumente (ohne Storage)', () => {
	it('lehnt unbekannte Dokumentarten ab (422)', async () => {
		const res = await call(`/members/${leader.id}/documents/unknown`);
		expect(res.status).toBe(422);
	});

	it('liefert ohne Dokument keinen Erfolg', async () => {
		const res = await call(`/members/${leader.id}/documents/privacy`);
		expect(res.ok).toBe(false);
	});

	it('Upload mit falschem Inhalt (HTML als PDF) → 422, vor dem Storage (#67, 01b-11)', async () => {
		const form = new FormData();
		form.set(
			'file',
			new File(['<html><script>alert(1)</script></html>'], 'a.pdf', { type: 'application/pdf' })
		);
		const res = await call(`/members/${leader.id}/documents/privacy`, {
			method: 'POST',
			body: form
		});
		expect(res.status).toBe(422);
	});

	it('Upload ohne verfügbaren Storage schlägt kontrolliert fehl', async () => {
		const form = new FormData();
		form.set('file', new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }));
		const res = await call(`/members/${leader.id}/documents/privacy`, {
			method: 'POST',
			body: form
		});
		expect(res.ok).toBe(false);
		expect(res.status).toBeLessThan(600);
	});
});

describe('Dokumente löschen (DELETE /members/:id/documents/:kind, #61)', () => {
	beforeAll(async () => {
		await installFakeStorage(admin);
	});
	afterAll(() => {
		uninstallFakeStorage();
	});

	it('löscht das Dokument samt Datei, danach 404; Rechte und Audit ohne Dateinamen', async () => {
		const form = new FormData();
		form.set(
			'file',
			new File(['%PDF-1.4\n% Einwilligung'], 'Einwilligung Max.pdf', { type: 'application/pdf' })
		);
		await data(
			await call(`/members/${leader.id}/documents/privacy`, { method: 'POST', body: form }),
			201
		);
		expect((await call(`/members/${leader.id}/documents/privacy`)).status).toBe(200);
		const stored = fakeObjects.size;
		expect(stored).toBeGreaterThan(0);

		// Nur Leserecht → 403, Dokument bleibt
		const denied = await api(`${BASE}/members/${leader.id}/documents/privacy`, {
			method: 'DELETE',
			token: viewKey
		});
		expect(denied.status).toBe(403);
		expect((await call(`/members/${leader.id}/documents/privacy`)).status).toBe(200);

		// Unbekannte Art → 422, unbekanntes Mitglied → 404
		expect(
			(await call(`/members/${leader.id}/documents/unknown`, { method: 'DELETE' })).status
		).toBe(422);
		expect(
			(await call(`/members/${crypto.randomUUID()}/documents/privacy`, { method: 'DELETE' })).status
		).toBe(404);

		expect(
			await data<{ deleted: boolean }>(
				await call(`/members/${leader.id}/documents/privacy`, { method: 'DELETE' })
			)
		).toEqual({ deleted: true });
		expect(fakeObjects.size).toBe(stored - 1);
		expect((await call(`/members/${leader.id}/documents/privacy`)).status).toBe(404);
		const member = await data<{ privacyConsent: unknown }>(await call(`/members/${leader.id}`));
		expect(member.privacyConsent).toBeNull();

		// Zweites Löschen: nichts mehr vorhanden → 404
		const again = await call(`/members/${leader.id}/documents/privacy`, { method: 'DELETE' });
		expect(again.status).toBe(404);
		expect((await again.json()).error.code).toBe('not_found');

		const { rows } = await listAudit({ action: 'members.document.deleted' });
		const entry = rows.find((r) => r.target === leader.id);
		expect(entry?.metadata).toEqual({ kind: 'privacy' });
		expect(JSON.stringify(entry)).not.toContain('Einwilligung');
	});
});

describe('Mitgliedschaft: Eintritt, Austritt, Zweitmitglied', () => {
	interface Membership extends MemberDto {
		entryDate: string | null;
		exitDate: string | null;
		secondaryMember: boolean;
		feeLevels: string[];
	}
	const today = new Date().toISOString().slice(0, 10);
	let regular: Membership;
	let secondary: Membership;
	let left: Membership;

	it('legt Mitglieder mit Eintritt/Austritt und Zweitmitgliedschaft an', async () => {
		regular = await data<Membership>(
			await call('/members', {
				method: 'POST',
				json: memberBody({
					firstName: 'Regula',
					emails: [],
					phones: [],
					entryDate: '2020-09-01',
					// Nicht-Zweitmitglieder speichern immer alle Ebenen
					feeLevels: ['stamm']
				})
			}),
			201
		);
		expect(regular.entryDate).toBe('2020-09-01');
		expect(regular.exitDate).toBeNull();
		expect(regular.secondaryMember).toBe(false);
		expect(regular.feeLevels).toEqual(['stamm', 'gau', 'landesmark', 'bund']);

		secondary = await data<Membership>(
			await call('/members', {
				method: 'POST',
				json: memberBody({
					firstName: 'Zweita',
					emails: [{ name: null, value: 'zweita@example.test' }],
					phones: [],
					secondaryMember: true,
					feeLevels: ['bund', 'stamm']
				})
			}),
			201
		);
		expect(secondary.secondaryMember).toBe(true);
		expect(secondary.feeLevels).toEqual(['stamm', 'bund']);

		left = await data<Membership>(
			await call('/members', {
				method: 'POST',
				json: memberBody({
					firstName: 'Ausgetreten',
					emails: [],
					phones: [],
					entryDate: '2019-01-01',
					exitDate: today
				})
			}),
			201
		);
		expect(left.exitDate).toBe(today);
	});

	it('aktualisiert Austritt und Ebenen', async () => {
		const updated = await data<Membership>(
			await call(`/members/${secondary.id}`, {
				method: 'PUT',
				json: memberBody({
					firstName: 'Zweita',
					emails: [],
					phones: [],
					entryDate: '2021-03-01',
					exitDate: '2099-12-31',
					secondaryMember: true,
					feeLevels: ['gau']
				})
			})
		);
		expect(updated.entryDate).toBe('2021-03-01');
		expect(updated.exitDate).toBe('2099-12-31');
		expect(updated.feeLevels).toEqual(['gau']);
		const detail = await data<Membership>(await call(`/members/${secondary.id}`));
		expect(detail.feeLevels).toEqual(['gau']);
		expect(detail.secondaryMember).toBe(true);
	});

	it('lehnt Austritt vor Eintritt ab (422)', async () => {
		const res = await call('/members', {
			method: 'POST',
			json: memberBody({ emails: [], phones: [], entryDate: '2020-05-01', exitDate: '2020-04-30' })
		});
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error.code).toBe('validation_failed');
		expect(JSON.stringify(body.error.details)).toContain('exitDate');
	});

	it('lehnt Zweitmitglied ohne Ebene ab (422)', async () => {
		const res = await call('/members', {
			method: 'POST',
			json: memberBody({ emails: [], phones: [], secondaryMember: true, feeLevels: [] })
		});
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error.code).toBe('validation_failed');
		expect(JSON.stringify(body.error.details)).toContain('feeLevels');
	});

	it('filtert die Liste nach Status (Standard aktiv)', async () => {
		const ids = async (q: string) =>
			(await data<{ items: MemberDto[] }>(await call(`/members?limit=200${q}`))).items.map(
				(m) => m.id
			);
		const active = await ids('');
		expect(active).toContain(regular.id);
		expect(active).toContain(secondary.id); // Austritt liegt in der Zukunft
		expect(active).not.toContain(left.id);
		expect(await ids('&status=left')).toEqual([left.id]);
		expect(await ids('&status=all')).toEqual(
			expect.arrayContaining([regular.id, secondary.id, left.id])
		);
		expect((await call('/members?status=weg')).status).toBe(422);
	});

	it('listMemberContacts liefert Mitgliedschaftsfelder für alle (auch Ausgetretene)', async () => {
		const list = await membersService.listMemberContacts({
			ids: [regular.id, secondary.id, left.id]
		});
		const byId = new Map(list.map((c) => [c.id, c]));
		expect(byId.get(regular.id)).toMatchObject({
			entryDate: '2020-09-01',
			exitDate: null,
			secondaryMember: false,
			feeLevels: ['stamm', 'gau', 'landesmark', 'bund']
		});
		expect(byId.get(secondary.id)).toMatchObject({
			entryDate: '2021-03-01',
			exitDate: '2099-12-31',
			secondaryMember: true,
			feeLevels: ['gau'],
			emails: []
		});
		expect(byId.get(left.id)?.exitDate).toBe(today);
	});
});

describe('Berechtigungen und Modulstatus', () => {
	it('verweigert Schreibzugriff ohne Recht (403)', async () => {
		const res = await api(`${BASE}/groups`, {
			method: 'POST',
			token: viewKey,
			json: { name: 'X', type: 'sippe', leaderIds: [leader.id] }
		});
		expect(res.status).toBe(403);
		expect((await api(`${BASE}/groups`, { token: viewKey })).status).toBe(200);
	});

	it('verweigert Anfragen ohne Anmeldung (401)', async () => {
		expect((await api(`${BASE}/groups`)).status).toBe(401);
	});

	it('schreibt Audit-Einträge', async () => {
		for (const action of [
			'members.member.created',
			'members.member.updated',
			'members.member.deleted',
			'members.group.created',
			'members.group.updated',
			'members.group.deleted'
		]) {
			const { rows } = await listAudit({ action });
			expect(rows.length, action).toBeGreaterThan(0);
		}
	});

	it('deaktiviertes Modul ist nicht erreichbar (404)', async () => {
		await disableModule(admin, 'members');
		const res = await call('/groups');
		expect(res.status).toBe(404);
	});
});
