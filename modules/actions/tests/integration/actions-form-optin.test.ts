/**
 * Öffentliche Formulare gehärtet (Issues #17, #28):
 * - Anmeldelink ohne Konto = Double-Opt-in: Die erste Mail enthält keinen Freitext/keine URL aus dem
 *   Formular; Teilnehmer*in (und damit Rechnung) erst nach Bestätigung; Bestätigungslink einmalig.
 * - Tageslimit für Bitten um Bestätigung je Formular.
 * - Datenschutz-Einwilligung und Disclaimer nicht ausblendbar/optional; Aktivieren ohne
 *   Datenschutz-URL → 422 (globale Einstellung `core.legal.privacyUrl` als Ersatz).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { optInToken } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { listAudit } from '$testing';
import { setSetting } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$testing';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { STANDARD_FORM_KEYS as K } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';
import type {
	FormConfig,
	PublicConfirmResult,
	PublicForm,
	PublicSubmitResult
} from '$modules/actions/schemas';

let admin: RequestContext;
let key = '';
const sent: { to: string; subject: string; text: string; html?: string }[] = [];

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
const A = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/actions${path}`, { token: key, ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

async function newAction(name: string) {
	const res = await A('/actions', {
		method: 'POST',
		json: { name, location: 'Cuxhaven', startsOn: '2026-07-10', endsOn: '2026-07-17' }
	});
	return (await data<{ id: string }>(res, 201)).id;
}

function formBody(cfg: FormConfig, over: Record<string, unknown> = {}) {
	return {
		enabled: true,
		opensAt: null,
		closesAt: null,
		maxParticipants: null,
		intro: null,
		disclaimerTemplate: cfg.disclaimerTemplate,
		privacyUrl: 'https://example.org/datenschutz',
		definition: cfg.definition,
		...over
	};
}

async function openForm(id: string, over: Record<string, unknown> = {}) {
	const cfg = await data<FormConfig>(await A(`/actions/${id}/form`));
	return data<FormConfig>(
		await A(`/actions/${id}/form`, { method: 'PUT', json: formBody(cfg, over) })
	);
}

const EVIL = 'Klick hier https://evil.example/phish und www.boese.example';
const person = (over: Record<string, unknown> = {}) => ({
	[K.name]: EVIL,
	[K.group]: 'Sonstige',
	[K.birthDate]: '2016-05-04',
	[K.bremenResident]: 'yes',
	[K.diet]: 'vegetarian',
	[K.allergies]: 'Freitext-Allergie',
	[K.notes]: '',
	[K.email]: 'fremd@example.test',
	[K.privacy]: true,
	[K.disclaimer]: true,
	...over
});

function submit(token: string, values: Record<string, unknown>) {
	resetAllForTests();
	return api(`/modules/actions/public/forms/${token}/submit`, {
		method: 'POST',
		json: { values }
	});
}
function confirm(token: string) {
	resetAllForTests();
	return api(`/modules/actions/public/registrations/${token}/confirm`, {
		method: 'POST',
		json: {}
	});
}
const participants = async (id: string) =>
	data<{ name: string }[]>(await A(`/actions/${id}/participants`));

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			// Benachrichtigungen (core.notifications, z. B. „Neue Anmeldung“) prüft notifications-modules.test.ts
			if (m.headers?.['X-Atrium'] === 'notification') return;
			sent.push(m as (typeof sent)[number]);
		}
	});
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
	const ctxOf = async () => (await contextForUser(u!.id))!.ctx;
	admin = await ctxOf();
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf();
	key = (
		await createApiKey(admin, {
			name: 'k',
			scopes: ['actions.action.view', 'actions.action.create', 'members.data.export']
		})
	).key;
}, 120_000);

describe('Anmeldelink: Double-Opt-in (Issue #17)', () => {
	let actionId: string;
	let token: string;
	let confirmToken: string;

	it('erste Mail ohne Freitext/URL, noch keine Teilnehmer*in', async () => {
		actionId = await newAction('Sommerlager');
		token = (await openForm(actionId)).token!;
		sent.length = 0;
		const out = await data<PublicSubmitResult>(await submit(token, person()), 201);
		expect(out.confirmationRequired).toBe(true);
		expect(out.emailSent).toBe(true);
		expect(sent).toHaveLength(1);
		const mail = sent[0]!;
		expect(mail.to).toBe('fremd@example.test');
		expect(mail.subject).toBe('Bitte Anmeldung bestätigen: Sommerlager');
		const all = `${mail.subject}\n${mail.text}\n${mail.html ?? ''}`;
		for (const bad of ['evil.example', 'boese', 'Klick hier', 'Freitext-Allergie', 'Sonstige']) {
			expect(all).not.toContain(bad);
		}
		expect(mail.text).toContain('10.07.2026 – 17.07.2026');
		confirmToken = optInToken(mail.text)!;
		expect(confirmToken).toMatch(/^[0-9a-f]{64}$/);
		expect(await participants(actionId)).toHaveLength(0);
	});

	it('Bestätigung legt die Teilnehmer*in an; Anmeldebestätigung mit neutralisierten Links', async () => {
		sent.length = 0;
		const out = await data<PublicConfirmResult>(await confirm(confirmToken), 201);
		expect(out.actionName).toBe('Sommerlager');
		expect(out.emailSent).toBe(true);
		const list = await participants(actionId);
		expect(list.map((p) => p.name)).toEqual([EVIL]);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.subject).toBe('Anmeldebestätigung: Sommerlager');
		expect(sent[0]!.text).not.toContain('https://evil.example');
		expect(sent[0]!.text).not.toContain('www.boese.example');
		expect(sent[0]!.text).toContain('evil[.]example');
	});

	it('Link ist einmalig; unbekannter Token → 404', async () => {
		expect((await confirm(confirmToken)).status).toBe(404);
		expect((await confirm('a'.repeat(64))).status).toBe(404);
	});

	it('erneute Anmeldung derselben Person → 409 (Duplikat)', async () => {
		expect((await submit(token, person())).status).toBe(409);
	});

	it('Audit ohne personenbezogene Daten', async () => {
		const rows = (await listAudit({ limit: 200 })).rows.filter((e) =>
			['actions.registration.pending', 'actions.registration.submitted'].includes(e.action)
		);
		expect(rows.map((r) => r.action)).toEqual(
			expect.arrayContaining(['actions.registration.pending', 'actions.registration.submitted'])
		);
		const raw = JSON.stringify(rows);
		expect(raw).not.toContain('fremd@example.test');
		expect(raw).not.toContain('evil');
	});

	it('abgelaufene Bestätigung → 404, Job räumt auf', async () => {
		sent.length = 0;
		await data(await submit(token, person({ [K.name]: 'Spät Dran' })), 201);
		const late = optInToken(sent[0]!.text)!;
		await core.database
			.forModule('actions')
			.transaction((tx) =>
				tx.execute(sql`UPDATE pending_registrations SET expires_at = now() - interval '1 minute'`)
			);
		expect((await confirm(late)).status).toBe(404);
		const { purgeExpiredRegistrations } = await import('$modules/actions/form.endpoints');
		expect((await purgeExpiredRegistrations()).deleted).toBeGreaterThanOrEqual(1);
	});

	it('Tageslimit je Formular: darüber keine Mail, nichts gespeichert (409)', async () => {
		const id = await newAction('Limitlager');
		const t = (await openForm(id)).token!;
		await core.database.forModule('actions').transaction((tx) =>
			tx.execute(
				sql`INSERT INTO public_mail_counters (action_id, kind, day, count)
						VALUES (${id}, 'registration-optin', CURRENT_DATE, 100)`
			)
		);
		sent.length = 0;
		const res = await submit(t, person({ [K.name]: 'Zu Viel' }));
		expect(res.status).toBe(409);
		expect(sent).toHaveLength(0);
		const [c] = (
			(await core.database
				.forModule('actions')
				.transaction((tx) =>
					tx.execute(sql`SELECT count(*) AS n FROM pending_registrations WHERE action_id = ${id}`)
				)) as unknown as { rows: { n: unknown }[] }
		).rows;
		expect(Number(c!.n)).toBe(0);
		// Ein anderes Formular ist nicht betroffen
		const other = (await openForm(await newAction('Anderes Lager'))).token!;
		expect((await submit(other, person({ [K.name]: 'Andere Person' }))).status).toBe(201);
	});
});

describe('Datenschutz (Issue #28)', () => {
	it('Aktivieren ohne Datenschutz-URL → 422; mit globaler Einstellung erlaubt', async () => {
		const id = await newAction('Ohne Link');
		const cfg = await data<FormConfig>(await A(`/actions/${id}/form`));
		const res = await A(`/actions/${id}/form`, {
			method: 'PUT',
			json: formBody(cfg, { privacyUrl: null })
		});
		expect(res.status).toBe(422);
		expect(JSON.stringify((await res.json()).error.details)).toContain('privacyUrl');
		// deaktiviert speichern geht
		await data(
			await A(`/actions/${id}/form`, {
				method: 'PUT',
				json: formBody(cfg, { privacyUrl: null, enabled: false })
			})
		);
		await setSetting(admin, 'core.legal.privacyUrl', 'https://stamm.example/datenschutz');
		try {
			const saved = await data<FormConfig>(
				await A(`/actions/${id}/form`, { method: 'PUT', json: formBody(cfg, { privacyUrl: null }) })
			);
			resetAllForTests();
			const pub = await data<PublicForm>(await api(`/modules/actions/public/forms/${saved.token}`));
			expect(pub.privacyUrl).toBe('https://stamm.example/datenschutz');
			expect(pub.definition.fields.find((f) => f.key === K.privacy)).toMatchObject({
				href: 'https://stamm.example/datenschutz'
			});
		} finally {
			await setSetting(admin, 'core.legal.privacyUrl', '');
		}
	});

	it('Datenschutz und Disclaimer lassen sich weder ausblenden noch optional machen', async () => {
		const id = await newAction('Versteckt');
		const cfg = await data<FormConfig>(await A(`/actions/${id}/form`));
		const definition = {
			...cfg.definition,
			fields: cfg.definition.fields.map((f) =>
				f.key === K.privacy || f.key === K.disclaimer
					? { ...f, hidden: true, required: false, mandatory: false }
					: f
			)
		};
		const saved = await data<FormConfig>(
			await A(`/actions/${id}/form`, { method: 'PUT', json: formBody(cfg, { definition }) })
		);
		for (const k of [K.privacy, K.disclaimer]) {
			expect(saved.definition.fields.find((f) => f.key === k)).toMatchObject({
				hidden: false,
				required: true,
				mandatory: true
			});
		}
		const res = await submit(
			saved.token!,
			person({ [K.name]: 'Ohne Zustimmung', [K.privacy]: false })
		);
		expect(res.status).toBe(422);
		expect(JSON.stringify((await res.json()).error.details)).toContain('privacy');
	});
});

describe('Kennzeichen „Gesundheitsdaten“ im Formular-Builder (#7)', () => {
	it('isHealthAnswerKey berücksichtigt health zusätzlich zur Erkennung', async () => {
		const { isHealthAnswerKey } = await import('$modules/actions/health');
		const fields = [
			{
				id: 'a',
				key: 'frage',
				type: 'text' as const,
				label: 'Was sollen wir wissen?',
				health: true
			},
			{ id: 'b', key: 'tshirt', type: 'text' as const, label: 'T-Shirt-Größe' }
		];
		expect(isHealthAnswerKey('frage', fields)).toBe(true);
		expect(isHealthAnswerKey('tshirt', fields)).toBe(false);
	});
});
