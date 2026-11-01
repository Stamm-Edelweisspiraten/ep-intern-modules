/**
 * Löschkonzept und Datenauskunft (#30):
 * - `actions.purge-health`: Gesundheitsdaten N Tage nach Aktionsende leeren (Einstellung, 0 = nie)
 * - Mitglied löschen → `onMemberDeleted` anonymisiert verknüpfte Teilnehmende in `actions`
 * - Löschfrist nach Austritt: Vorschlagsliste + Sammel-Anonymisieren (nur `members.member.delete`)
 * - Datenauskunft `/admin/privacy`: Export aus Core + allen aktiven Modulen, Recht `core.privacy.export`
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { getDb, schema } from '$testing';
import { setSetting } from '$testing';
import { runJobNow } from '$testing';
import { exportSubject, findPrivacySubjects } from '$testing';
import { resetAllForTests } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import { purgeExpiredHealthData } from '$modules/actions/privacy';
import type { Member } from '$modules/members/schemas';
import type { RequestContext } from '$lib/sdk/types';

const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let adminId: string;

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

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

const memberBody = (firstName: string, lastName: string, over: Record<string, unknown> = {}) => ({
	firstName,
	lastName,
	scoutName: null,
	birthDate: '2012-05-17',
	street: 'Musterweg 1',
	postalCode: '12345',
	city: 'Musterstadt',
	country: 'DE',
	phones: [{ name: 'Mutter', value: '0123 456' }],
	emails: [{ name: null, value: `${firstName.toLowerCase()}@example.test` }],
	stage: 'pfadfinder',
	groupIds: [],
	consentSocialMedia: false,
	consentWebsite: true,
	consentPrint: false,
	...over
});

const isoDaysAgo = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function createMember(over: Record<string, unknown> & { firstName: string }) {
	const { firstName, ...rest } = over;
	return data<Member>(
		await api('/modules/members/members', {
			method: 'POST',
			token: keys.admin,
			json: memberBody(firstName, 'Muster', rest)
		}),
		201
	);
}

async function createAction(name: string, startsOn: string, endsOn: string | null) {
	return (
		await data<{ id: string }>(
			await api('/modules/actions/actions', {
				method: 'POST',
				token: keys.admin,
				json: { name, startsOn, endsOn, isPast: true }
			}),
			201
		)
	).id;
}

async function addParticipant(actionId: string, name: string, memberId?: string, userId?: string) {
	const p = await data<{ id: string }>(
		await api(`/modules/actions/actions/${actionId}/participants`, {
			method: 'POST',
			token: keys.admin,
			json: {
				name,
				birthDate: '2012-05-17',
				diet: 'vegan',
				allergies: 'Erdnüsse',
				notes: 'Asthma-Spray'
			}
		}),
		201
	);
	if (memberId || userId) {
		await getDb().execute(
			sql`UPDATE mod_actions.action_participants
				SET member_id = ${memberId ?? null}, user_id = ${userId ?? null} WHERE id = ${p.id}`
		);
	}
	return p.id;
}

async function participantRow(id: string) {
	const [r] = (
		await getDb().execute(
			sql`SELECT name, contact_email, diet, allergies, notes, health_answers, answers::text AS answers,
					member_id, user_id, to_char(birth_date, 'YYYY-MM-DD') AS birth_date
				FROM mod_actions.action_participants WHERE id = ${id}`
		)
	).rows as Record<string, string | null>[];
	return r;
}

beforeAll(async () => {
	await useTestDatabase();
	resetAllForTests();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	await enableModule(admin, 'offices');
	admin = await ctxOf(adminId);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...admin.permissions].filter((p) => !p.startsWith('core.system'))
		})
	).key;
	const roles: Record<string, string[]> = {
		/** darf Mitglieder sehen/bearbeiten, aber nicht löschen/anonymisieren */
		editor: ['core.api.manage', 'members.member.view', 'members.member.edit'],
		parent: ['core.api.manage']
	};
	for (const [name, perms] of Object.entries(roles)) {
		const role = await createRole(admin, { name: `role-${name}`, permissions: perms });
		const id = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [role]
		});
		userIds[name] = id;
		keys[name] = (await createApiKey(await ctxOf(id), { name: `key-${name}`, scopes: perms })).key;
	}
});

describe('Gesundheitsdaten nach Aktionsende (actions.purge-health)', () => {
	it('leert nach Ablauf der Frist, lässt jüngere Aktionen unberührt; 0 = nie', async () => {
		const old = await createAction('Altes Lager', isoDaysAgo(120), isoDaysAgo(100));
		const recent = await createAction('Neues Lager', isoDaysAgo(40), isoDaysAgo(30));
		const noEnd = await createAction('Tagesaktion alt', isoDaysAgo(95), null);
		const pOld = await addParticipant(old, 'Paula Alt');
		const pRecent = await addParticipant(recent, 'Paula Neu');
		const pNoEnd = await addParticipant(noEnd, 'Paula Tag');

		// 0 = nie löschen
		await setSetting(admin, 'actions.health.retentionDays', 0);
		expect((await purgeExpiredHealthData()).cleared).toBe(0);
		expect((await participantRow(pOld))!.allergies).not.toBeNull();

		// Standard 90 Tage, über den Job
		await setSetting(admin, 'actions.health.retentionDays', 90);
		await runJobNow(admin, 'actions.purge-health');
		for (const id of [pOld, pNoEnd]) {
			const r = (await participantRow(id))!;
			expect(r).toMatchObject({ diet: null, allergies: null, notes: null, health_answers: null });
			// Name und Geburtsdatum bleiben (Abrechnung, Zuschuss)
			expect(r.birth_date).toBe('2012-05-17');
		}
		const r = (await participantRow(pRecent))!;
		expect(r.allergies).not.toBeNull();
		expect(r.diet).not.toBeNull();

		// Idempotent; kürzere Frist erfasst auch die jüngere Aktion
		expect((await purgeExpiredHealthData()).cleared).toBe(0);
		expect((await purgeExpiredHealthData(10)).cleared).toBe(1);
		expect((await participantRow(pRecent))!.allergies).toBeNull();
	});
});

describe('Mitglied löschen → Teilnehmende anonymisiert (onMemberDeleted)', () => {
	it('verknüpfte Teilnahme verliert Name, Kontakt, Gesundheitsdaten und Verknüpfung', async () => {
		const m = await createMember({ firstName: 'Lena' });
		const action = await createAction('Sommerlager', isoDaysAgo(20), isoDaysAgo(15));
		const linked = await addParticipant(action, 'Lena Muster', m.id, userIds.parent);
		const other = await addParticipant(action, 'Max Fremd');
		await data(
			await api(`/modules/members/members/${m.id}`, { method: 'DELETE', token: keys.admin })
		);
		const r = (await participantRow(linked))!;
		expect(r).toMatchObject({
			name: 'Anonymisiert',
			contact_email: null,
			diet: null,
			allergies: null,
			notes: null,
			health_answers: null,
			answers: '{}',
			member_id: null,
			user_id: null
		});
		expect((await participantRow(other))!.name).toBe('Max Fremd');
	});
});

describe('Löschfrist nach Austritt (members)', () => {
	let due: Member;
	let recent: Member;
	let active: Member;
	let participation: string;

	beforeAll(async () => {
		due = await createMember({
			firstName: 'Olga',
			scoutName: 'Eule',
			entryDate: '2010-01-01',
			exitDate: isoDaysAgo(5 * 366),
			custom: {}
		});
		recent = await createMember({
			firstName: 'Rita',
			entryDate: '2010-01-01',
			exitDate: isoDaysAgo(200)
		});
		active = await createMember({ firstName: 'Anton' });
		await getDb().execute(
			sql`INSERT INTO mod_members.member_user_links (member_id, user_id, relation)
				VALUES (${due.id}, ${userIds.parent!}, 'Mutter')`
		);
		const action = await createAction('Herbstfahrt', isoDaysAgo(2000), isoDaysAgo(1995));
		participation = await addParticipant(action, 'Olga Muster', due.id);
	});

	it('Liste nur mit members.member.delete; nur fällige, nicht anonymisierte', async () => {
		const forbidden = await api('/modules/members/retention', { token: keys.editor });
		expect(forbidden.status).toBe(403);
		const list = await data<{ years: number; items: { id: string }[]; total: number }>(
			await api('/modules/members/retention', { token: keys.admin })
		);
		expect(list.years).toBe(3);
		const ids = list.items.map((i) => i.id);
		expect(ids).toContain(due.id);
		expect(ids).not.toContain(recent.id);
		expect(ids).not.toContain(active.id);
	});

	it('Anonymisieren: fällige werden anonymisiert, andere übersprungen; Audit ohne Namen', async () => {
		const forbidden = await api('/modules/members/retention/anonymize', {
			method: 'POST',
			token: keys.editor,
			json: { ids: [due.id] }
		});
		expect(forbidden.status).toBe(403);

		const res = await data<{ affected: number; skipped: { id: string }[] }>(
			await api('/modules/members/retention/anonymize', {
				method: 'POST',
				token: keys.admin,
				json: { ids: [due.id, recent.id, active.id] }
			}),
			201
		);
		expect(res.affected).toBe(1);
		expect(res.skipped.map((s) => s.id).sort()).toEqual([recent.id, active.id].sort());

		const m = await data<Member>(
			await api(`/modules/members/members/${due.id}`, { token: keys.admin })
		);
		expect(m).toMatchObject({
			firstName: 'Anonymisiert',
			lastName: '',
			scoutName: null,
			birthDate: '2012-01-01',
			street: '',
			city: '',
			phones: [],
			emails: [],
			groups: [],
			consentWebsite: false,
			linkCount: 0,
			custom: {}
		});
		expect(m.anonymizedAt).toBeTruthy();
		expect(m.exitDate).toBe(due.exitDate);
		// Kopie in actions anonymisiert
		expect((await participantRow(participation))!.name).toBe('Anonymisiert');
		// Nicht noch einmal in der Liste
		const list = await data<{ items: { id: string }[] }>(
			await api('/modules/members/retention', { token: keys.admin })
		);
		expect(list.items.map((i) => i.id)).not.toContain(due.id);

		const { rows } = await listAudit({ action: 'members.member.anonymized' });
		expect(rows.length).toBe(1);
		const text = JSON.stringify(rows);
		for (const secret of ['Olga', 'Eule', 'Muster']) expect(text).not.toContain(secret);
	});

	it('Frist ist einstellbar', async () => {
		await setSetting(admin, 'members.retention.exitYears', 30);
		const list = await data<{ years: number; items: unknown[] }>(
			await api('/modules/members/retention', { token: keys.admin })
		);
		expect(list.years).toBe(30);
		expect(list.items).toEqual([]);
		await setSetting(admin, 'members.retention.exitYears', 3);
	});
});

describe('Datenauskunft (core.privacy.export)', () => {
	it('Export für ein Konto enthält Core, verknüpfte Mitglieder, Teilnahmen und Ämter', async () => {
		const child = await createMember({ firstName: 'Kira', custom: {} });
		await getDb().execute(
			sql`INSERT INTO mod_members.member_user_links (member_id, user_id, relation)
				VALUES (${child.id}, ${userIds.parent!}, 'Vater')`
		);
		const action = await createAction('Pfingsten', isoDaysAgo(10), isoDaysAgo(8));
		await addParticipant(action, 'Kira Muster', child.id, userIds.parent);
		// Amt mit Inhaber*in
		const office = await data<{ id: string }>(
			await api('/modules/offices/offices', {
				method: 'POST',
				token: keys.admin,
				json: { name: 'Elternvertretung' }
			}),
			201
		);
		await data(
			await api(`/modules/offices/offices/${office.id}/holders`, {
				method: 'PUT',
				token: keys.admin,
				json: { holders: [{ userId: userIds.parent }] }
			})
		);

		const found = await findPrivacySubjects(admin, 'Kira');
		expect(found.some((c) => c.source === 'members' && c.subject.memberIds?.[0] === child.id)).toBe(
			true
		);
		expect((await findPrivacySubjects(admin, 'parent')).some((c) => c.source === 'core')).toBe(
			true
		);

		const out = await exportSubject(admin, { userId: userIds.parent });
		expect(out.format).toBe('ep-intern-datenauskunft');
		expect(out.errors).toEqual([]);
		expect(out.subject.memberIds).toContain(child.id);
		const core = out.core as { account: { email: string }; audit: unknown[] };
		expect(core.account.email).toBe('parent@example.test');
		const members = out.modules.members!.data.members as { id: string; custom: unknown }[];
		expect(members.map((m) => m.id)).toContain(child.id);
		const actions = out.modules.actions!.data.participations as {
			name: string;
			allergies: string | null;
		}[];
		const kira = actions.find((p) => p.name === 'Kira Muster')!;
		expect(kira.allergies).toBe('Erdnüsse');
		expect(out.modules.offices).toBeTruthy();
		expect(JSON.stringify(out.modules.offices)).toContain('Elternvertretung');

		const { rows } = await listAudit({ action: 'core.privacy.exported' });
		expect(rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(rows)).not.toContain('Kira');
	});

	it('Export für ein Mitglied ohne Konto; ohne Recht 403; unbekanntes Konto 404', async () => {
		const solo = await createMember({ firstName: 'Sven' });
		const out = await exportSubject(admin, { memberId: solo.id });
		expect(out.subject.userId).toBeNull();
		expect(out.modules.members).toBeTruthy();

		const editor = await ctxOf(userIds.editor!);
		await expect(exportSubject(editor, { memberId: solo.id })).rejects.toMatchObject({
			status: 403
		});
		await expect(exportSubject(admin, { userId: 'gibt-es-nicht' })).rejects.toMatchObject({
			status: 404
		});
		await expect(exportSubject(admin, {})).rejects.toMatchObject({ status: 422 });
	});
});
