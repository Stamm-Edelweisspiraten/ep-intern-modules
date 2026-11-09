/**
 * Modul `tasks` v1.1 (Aufgaben 2.0) mit `actions` (aus `modules/tasks/tests/integration/tasks-planning.test.ts`
 * hierher verschoben, seit die Basismodule in atrium-basic-modules liegen): Vorlagen mit Bezugsdatum aus der Aktion
 * (Daten relativ zu Beginn und Ende), eigene Vorlage aus einem Aktions-Board, Mitverschieben nach geänderter Aktion,
 * Meilensteine im Kalender-Abo (events), Audit der Vorlagen/Verschiebungen ohne Inhalte.
 * Phasen, Zeitraum, Meilensteine, Abhängigkeiten und Vorlagen ohne Aktion prüft atrium-basic-modules
 * `modules/tasks/tests/integration/tasks-planning.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { listAudit } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import tasksModule from '$modules/tasks/module';
import type { CalendarFeed } from '$modules/events/schemas';
import type { BoardDetail, TemplateSummary } from '$modules/tasks/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; details?: { path?: unknown[] }[] } };
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'tasks'
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

function issuePaths(res: Res): string[] {
	expect(res.status, JSON.stringify(res.body)).toBe(422);
	return (res.body.error?.details ?? []).map((d) => (d.path ?? []).join('.'));
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function addUser(who: string, roleId: string) {
	const id = await createUser(admin, {
		name: `Person ${who}`,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	userIds[who] = id;
	const ctx = await ctxOf(id);
	keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
}

beforeAll(async () => {
	setTodayForTests('2027-01-10');
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(eventsModule);
	registerModule(tasksModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'actions', 'events', 'tasks']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);

	const base = ['core.api.manage', 'tasks.board.view', 'events.event.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'tasks.board.create', 'actions.action.view', 'actions.action.create']
	});
	const viewer = await createRole(admin, { name: 'Mitmachen', permissions: base });
	await addUser('owner', planner);
	await addUser('other', planner);
	await addUser('reader', viewer);
	await addUser('stranger', viewer);
});

afterAll(async () => {
	setTodayForTests(null);
	await close?.();
});

describe('Vorlagen und Mitverschieben', () => {
	let actionId: string;
	let campBoard: BoardDetail;
	let ownTemplate: TemplateSummary;

	it('liefert die mitgelieferten Vorlagen; nur mit Anlege-Recht', async () => {
		const list = ok<TemplateSummary[]>(await call('owner', 'GET', '/templates'));
		expect(list.map((t) => t.id)).toEqual(['builtin:fahrt', 'builtin:tagesaktion']);
		expect(list[0]).toMatchObject({ builtin: true, canDelete: false });
		expect(list[0]!.phases.map((p) => p.name)).toEqual([
			'Planung',
			'Anmeldung',
			'Vorbereitung',
			'Lager',
			'Nachbereitung'
		]);
		expect((await call('reader', 'GET', '/templates')).status).toBe(403);
	});

	it('Board aus Vorlage zur Aktion: Daten relativ zu Beginn und Ende', async () => {
		actionId = ok<{ id: string }>(
			await call(
				'owner',
				'POST',
				'/actions',
				{ name: 'Pfingstlager 2027', startsOn: '2027-05-14', endsOn: '2027-05-17' },
				'actions'
			),
			201
		).id;
		campBoard = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Pfingstlager 2027',
				actionId,
				templateId: 'builtin:fahrt'
			}),
			201
		);
		expect(campBoard.anchorOn).toBe('2027-05-14');
		expect(campBoard.actionStartsOn).toBe('2027-05-14');
		expect(campBoard.actionShift).toBeNull();
		expect(campBoard.columns.map((c) => c.name)).toEqual(['Offen', 'In Arbeit', 'Erledigt']);
		const lager = campBoard.phases.find((p) => p.name === 'Lager')!;
		expect([lager.startsOn, lager.endsOn]).toEqual(['2027-05-14', '2027-05-17']);
		const nach = campBoard.phases.find((p) => p.name === 'Nachbereitung')!;
		expect([nach.startsOn, nach.endsOn]).toEqual(['2027-05-18', '2027-06-28']);
		const schluss = campBoard.tasks.find((t) => t.title === 'Anmeldeschluss')!;
		expect(schluss).toMatchObject({ isMilestone: true, dueOn: '2027-03-15', startsOn: null });
		expect(schluss.phaseId).toBe(campBoard.phases.find((p) => p.name === 'Anmeldung')!.id);
		const zelt = campBoard.tasks.find((t) => t.title === 'Zeltplatz oder Haus anfragen')!;
		expect(zelt.checklist).toEqual({ done: 0, total: 3 });
		expect(
			issuePaths(
				await call('owner', 'POST', '/boards', { name: 'x', templateId: 'builtin:gibtsnicht' })
			)
		).toEqual(['templateId']);
	});

	it('Board als eigene Vorlage speichern, nur für sich sichtbar, auf neues Datum anwenden', async () => {
		ownTemplate = ok<TemplateSummary>(
			await call('owner', 'POST', `/boards/${campBoard.id}/template`, { name: 'Unser Lager' }),
			201
		);
		expect(ownTemplate).toMatchObject({ builtin: false, canDelete: true, taskCount: 14 });
		expect(
			ok<TemplateSummary[]>(await call('other', 'GET', '/templates')).some(
				(t) => t.id === ownTemplate.id
			)
		).toBe(false);
		expect(
			issuePaths(
				await call('other', 'POST', '/boards', { name: 'Kopie', templateId: ownTemplate.id })
			)
		).toEqual(['templateId']);

		const copy = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Pfingstlager 2028',
				templateId: ownTemplate.id,
				anchorOn: '2028-06-02'
			}),
			201
		);
		expect(copy.anchorOn).toBe('2028-06-02');
		// ohne Aktion = eintägig: Nachbereitung beginnt am Tag nach dem Bezugsdatum
		expect(copy.phases.find((p) => p.name === 'Nachbereitung')?.startsOn).toBe('2028-06-03');
		expect(copy.tasks.find((t) => t.title === 'Anmeldeschluss')?.dueOn).toBe('2028-04-03');

		expect((await call('other', 'DELETE', `/templates/${ownTemplate.id}`)).status).toBe(404);
		ok(await call('owner', 'DELETE', `/templates/${ownTemplate.id}`));
		expect((await call('owner', 'GET', '/templates')).body.data).toHaveLength(2);
	});

	it('verschobene Aktion: Hinweis, Mitverschieben oder nur Bezugsdatum übernehmen', async () => {
		ok(
			await call(
				'owner',
				'PUT',
				`/actions/${actionId}`,
				{ name: 'Pfingstlager 2027', startsOn: '2027-05-21', endsOn: '2027-05-24' },
				'actions'
			)
		);
		let b = ok<BoardDetail>(await call('owner', 'GET', `/boards/${campBoard.id}`));
		expect(b.actionShift).toBe(7);
		b = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${campBoard.id}/shift`, { days: 7 }),
			201
		);
		expect(b.actionShift).toBeNull();
		expect(b.anchorOn).toBe('2027-05-21');
		expect(b.tasks.find((t) => t.title === 'Anmeldeschluss')?.dueOn).toBe('2027-03-22');
		expect(b.phases.find((p) => p.name === 'Lager')?.startsOn).toBe('2027-05-21');

		ok(
			await call(
				'owner',
				'PUT',
				`/actions/${actionId}`,
				{ name: 'Pfingstlager 2027', startsOn: '2027-05-20', endsOn: '2027-05-24' },
				'actions'
			)
		);
		b = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${campBoard.id}/shift`, { days: -1, apply: false }),
			201
		);
		expect(b.actionShift).toBeNull();
		expect(b.tasks.find((t) => t.title === 'Anmeldeschluss')?.dueOn).toBe('2027-03-22');
		expect(
			(await call('stranger', 'POST', `/boards/${campBoard.id}/shift`, { days: 1 })).status
		).toBe(404);
	});

	it('Meilensteine im Kalender-Abo nur mit Schalter am Board', async () => {
		const schluss = campBoard.tasks.find((t) => t.title === 'Anmeldeschluss')!;
		const feed = ok<CalendarFeed>(
			await call(
				'owner',
				'POST',
				'/calendar-feeds',
				{ name: 'Alles', includeTasks: true },
				'events'
			),
			201
		);
		expect(feed.includeTasks).toBe(true);
		const fetchIcs = async () => {
			const url = new URL(feed.url!);
			const res = await handleApiRequest({ request: new Request(url), url, ip: '127.0.0.1' });
			expect(res.status).toBe(200);
			return (await res.text()).replace(/\r\n /g, '');
		};
		expect(await fetchIcs()).not.toContain('Anmeldeschluss');
		const b = ok<BoardDetail>(
			await call('owner', 'PATCH', `/boards/${campBoard.id}`, {
				calendarMilestones: true,
				defaultView: 'timeline'
			})
		);
		expect(b).toMatchObject({ calendarMilestones: true, defaultView: 'timeline' });
		const text = await fetchIcs();
		expect(text).toContain('SUMMARY:◆ Anmeldeschluss');
		expect(text).toContain(`milestone-${schluss.id}@tasks.`);
		expect(text).toContain('DTSTART;VALUE=DATE:20270322');
	});
});

describe('Audit', () => {
	it('Vorlagen und Verschieben ohne Inhalte', async () => {
		const { rows: audit } = await listAudit({ action: 'tasks.', limit: 500 });
		const items = audit.filter((e) => /^tasks\.(template|board\.shifted)/.test(e.action));
		expect(new Set(items.map((e) => e.action))).toEqual(
			new Set(['tasks.template.created', 'tasks.template.deleted', 'tasks.board.shifted'])
		);
		expect(JSON.stringify(items)).not.toContain('Unser Lager');
	});
});
