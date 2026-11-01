import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { confirmIfNeeded } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
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
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { STANDARD_FORM_KEYS } from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';
import type { FormConfig, PublicForm, PublicSubmitResult } from '$modules/actions/schemas';

const BASE = '/modules/actions';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let actionId: string;

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
const as = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: keys[who], ...init });
const pub = (path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}/public/forms${path}`, init);

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const sent: { from: string; to: string; subject: string; text: string }[] = [];
let failMail = false;

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function newAction(name: string) {
	const res = await as('owner', '/actions', {
		method: 'POST',
		json: { name, location: 'Cuxhaven', startsOn: '2026-07-10', endsOn: '2026-07-17' }
	});
	return (await data<{ id: string }>(res, 201)).id;
}

async function saveForm(id: string, over: Record<string, unknown> = {}, who = 'owner') {
	const cfg = await data<FormConfig>(await as('owner', `/actions/${id}/form`));
	return as(who, `/actions/${id}/form`, {
		method: 'PUT',
		json: {
			enabled: true,
			opensAt: null,
			closesAt: null,
			maxParticipants: null,
			intro: 'Willkommen',
			disclaimerTemplate: cfg.disclaimerTemplate,
			privacyUrl: 'https://example.org/datenschutz',
			definition: cfg.definition,
			...over
		}
	});
}

const person = (over: Record<string, unknown> = {}) => ({
	[STANDARD_FORM_KEYS.name]: 'Max Mustermann',
	[STANDARD_FORM_KEYS.group]: 'Wölflinge',
	[STANDARD_FORM_KEYS.birthDate]: '2016-05-04',
	[STANDARD_FORM_KEYS.bremenResident]: 'yes',
	[STANDARD_FORM_KEYS.diet]: 'vegetarian',
	[STANDARD_FORM_KEYS.allergies]: 'Nüsse',
	[STANDARD_FORM_KEYS.notes]: '',
	[STANDARD_FORM_KEYS.email]: 'eltern@example.test',
	[STANDARD_FORM_KEYS.privacy]: true,
	[STANDARD_FORM_KEYS.disclaimer]: true,
	...over
});

/** Anmelden und (Double-Opt-in) über den Link aus der Mail bestätigen – wie früher „sofort angemeldet“ */
const submit = async (token: string, values: Record<string, unknown>, extra: object = {}) => {
	resetAllForTests();
	const before = sent.length;
	const res = await pub(`/${token}/submit`, { method: 'POST', json: { values, ...extra } });
	return confirmIfNeeded(res, sent, api, before);
};

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			// Benachrichtigungen (core.notifications, z. B. „Neue Anmeldung“) prüft notifications-modules.test.ts
			if (m.headers?.['X-EP-Intern'] === 'notification') return;
			if (failMail) throw new Error('SMTP down');
			sent.push(m);
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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'members');
	await enableModule(admin, 'actions');
	admin = await ctxOf(u!.id);

	const base = ['core.api.manage', 'actions.action.view'];
	const roles: Record<string, string[]> = {
		// `members.data.export`: CSV mit Gesundheitsspalten (Ernährung/Allergien/Sonstiges)
		creator: [...base, 'actions.action.create', 'actions.action.delete', 'members.data.export'],
		viewer: base
	};
	const roleIds: Record<string, string> = {};
	for (const [n, perms] of Object.entries(roles)) {
		roleIds[n] = await createRole(admin, { name: `role-${n}`, permissions: perms });
	}
	for (const [name, role] of [
		['owner', 'creator'],
		['reader', 'viewer'],
		['stranger', 'viewer']
	] as const) {
		userIds[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleIds[role]!]
		});
		const ctx = await ctxOf(userIds[name]!);
		keys[name] = (await createApiKey(ctx, { name: `key-${name}`, scopes: roles[role]! })).key;
	}
	await setSetting(admin, 'actions.bank.holder', 'Stamm Test e.V.');
	await setSetting(admin, 'actions.bank.iban', 'DE02 1234 5678 9012 3456 78');
	await setSetting(admin, 'actions.bank.bic', 'GENODEF1TST');
	await setSetting(admin, 'actions.bank.name', 'Testbank');
	actionId = await newAction('Sommerlager "Süd"');
	// Beitrag übernehmen
	const calc = await data<{
		settings: { items: { amountCents: number }[]; includeSubsidy: boolean };
	}>(await as('owner', `/actions/${actionId}/calculation`));
	calc.settings.items[0]!.amountCents = 2500;
	calc.settings.includeSubsidy = false;
	await data(
		await as('owner', `/actions/${actionId}/calculation`, { method: 'PUT', json: calc.settings })
	);
	await data(await as('owner', `/actions/${actionId}/calculation/apply`, { method: 'POST' }), 201);
});

describe('Anmeldeformular: Konfiguration', () => {
	let token: string;

	it('liefert Standardwerte ohne gespeicherte Konfiguration', async () => {
		const cfg = await data<FormConfig>(await as('owner', `/actions/${actionId}/form`));
		expect(cfg.persisted).toBe(false);
		expect(cfg.token).toBeNull();
		expect(cfg.enabled).toBe(false);
		expect(cfg.submissions).toBe(0);
		const keysOf = cfg.definition.fields.map((f) => f.key);
		for (const k of Object.values(STANDARD_FORM_KEYS)) expect(keysOf).toContain(k);
		expect(cfg.fee?.participantCents).toBeGreaterThan(0);
		expect(cfg.disclaimerPreview).toContain('Stamm Test e.V.');
		expect(cfg.disclaimerPreview).not.toContain('{{');
	});

	it('speichert (Roundtrip), ergänzt fehlende Standardfelder und sperrt Typänderungen', async () => {
		const cfg = await data<FormConfig>(await as('owner', `/actions/${actionId}/form`));
		const fields = cfg.definition.fields
			.filter((f) => f.key !== STANDARD_FORM_KEYS.notes)
			.map((f) =>
				f.key === STANDARD_FORM_KEYS.diet
					? { id: f.id, key: f.key, label: f.label, type: 'text' }
					: f
			);
		fields.push({
			id: 'tshirt',
			key: 'tshirt',
			type: 'select',
			label: 'T-Shirt-Größe',
			required: false,
			options: [
				{ value: 's', label: 'S' },
				{ value: 'm', label: 'M' }
			]
		} as never);
		const saved = await data<FormConfig>(
			await saveForm(actionId, { definition: { ...cfg.definition, fields }, maxParticipants: 50 })
		);
		expect(saved.persisted).toBe(true);
		expect(saved.token!.length).toBeGreaterThanOrEqual(43);
		expect(saved.publicPath).toBe(`/p/actions/anmeldung/${saved.token}`);
		expect(saved.maxParticipants).toBe(50);
		const byKey = Object.fromEntries(saved.definition.fields.map((f) => [f.key, f]));
		expect(byKey[STANDARD_FORM_KEYS.notes]?.locked).toBe(true);
		expect(byKey[STANDARD_FORM_KEYS.diet]?.type).toBe('select');
		expect(byKey.tshirt).toBeDefined();
		token = saved.token!;

		const again = await data<FormConfig>(await as('owner', `/actions/${actionId}/form`));
		expect(again.token).toBe(token);
		expect(again.status).toBe('open');
	});

	it('Zugriff: reader darf lesen aber nicht speichern (403), stranger 404', async () => {
		await data(
			await as('owner', `/actions/${actionId}/shares/${userIds.reader}`, {
				method: 'PUT',
				json: { level: 'read' }
			})
		);
		expect((await as('reader', `/actions/${actionId}/form`)).status).toBe(200);
		expect((await saveForm(actionId, {}, 'reader')).status).toBe(403);
		expect((await as('stranger', `/actions/${actionId}/form`)).status).toBe(404);
		expect((await saveForm(actionId, {}, 'stranger')).status).toBe(404);
		expect(
			(await as('reader', `/actions/${actionId}/form/rotate-token`, { method: 'POST' })).status
		).toBe(403);
		expect((await api(`${BASE}/actions/${actionId}/form`)).status).toBe(401);
	});

	it('Token-Rotation macht den alten Link ungültig', async () => {
		expect((await pub(`/${token}`)).status).toBe(200);
		const rotated = await data<FormConfig>(
			await as('owner', `/actions/${actionId}/form/rotate-token`, { method: 'POST' }),
			201
		);
		expect(rotated.token).not.toBe(token);
		expect((await pub(`/${token}`)).status).toBe(404);
		expect((await pub(`/${rotated.token}`)).status).toBe(200);
		token = rotated.token!;
	});

	it('Audit ohne personenbezogene Details', async () => {
		const page = await listAudit({ limit: 100 });
		const actions = page.rows.map((e) => e.action);
		expect(actions).toContain('actions.form.updated');
		expect(actions).toContain('actions.form.token_rotated');
	});

	describe('öffentlich', () => {
		it('GET ohne Auth liefert Formular ohne interne Daten', async () => {
			const form = await data<PublicForm>(await pub(`/${token}`));
			expect(form.actionName).toBe('Sommerlager "Süd"');
			expect(form.status).toBe('open');
			expect(form.disclaimer).toContain('Testbank');
			expect(form.definition.fields.map((f) => f.key)).toContain('tshirt');
			const privacy = form.definition.fields.find((f) => f.key === 'privacy');
			expect(privacy).toMatchObject({ href: 'https://example.org/datenschutz' });
			const disc = form.definition.fields.find((f) => f.key === 'disclaimer');
			expect(disc).toMatchObject({ text: form.disclaimer });
			const raw = JSON.stringify(form);
			expect(raw).not.toContain(token);
			expect(raw).not.toContain('submissions');
			expect(raw).not.toContain('maxParticipants');
		});

		it('unbekanntes Token und deaktiviertes Formular: identisch 404', async () => {
			const unknown = await pub(`/${'x'.repeat(40)}`);
			expect(unknown.status).toBe(404);
			const id2 = await newAction('Deaktiviert');
			const cfg = await data<FormConfig>(await saveForm(id2, { enabled: false }));
			const off = await pub(`/${cfg.token}`);
			expect(off.status).toBe(404);
			expect((await unknown.clone().json()).error.message).toBe((await off.json()).error.message);
		});

		it('geschlossen / noch nicht offen / voll -> 409', async () => {
			const past = new Date(Date.now() - 86_400_000).toISOString();
			const future = new Date(Date.now() + 86_400_000).toISOString();
			const closedId = await newAction('Geschlossen');
			const closed = await data<FormConfig>(await saveForm(closedId, { closesAt: past }));
			expect((await submit(closed.token!, person())).status).toBe(409);
			const notOpen = await data<FormConfig>(
				await saveForm(await newAction('Später'), { opensAt: future })
			);
			expect((await data<PublicForm>(await pub(`/${notOpen.token}`))).status).toBe('not_open');
			expect((await submit(notOpen.token!, person())).status).toBe(409);

			const full = await data<FormConfig>(
				await saveForm(await newAction('Voll'), { maxParticipants: 1 })
			);
			await data(await submit(full.token!, person()), 201);
			const res = await submit(full.token!, person({ name: 'Erika Beispiel' }));
			expect(res.status).toBe(409);
			expect((await res.json()).error.message).toContain('Plätze');
		});

		it('erfolgreiche Anmeldung: Teilnehmer*in, Antworten, Mail mit Beitrag und Konto', async () => {
			sent.length = 0;
			const res = await submit(token, person({ tshirt: 'm' }));
			const out = await data<PublicSubmitResult>(res, 201);
			expect(out.name).toBe('Max Mustermann');
			expect(out.emailSent).toBe(true);
			expect(sent).toHaveLength(1);
			expect(sent[0]!.to).toBe('eltern@example.test');
			expect(sent[0]!.subject).toBe('Anmeldebestätigung: Sommerlager "Süd"');
			expect(sent[0]!.text).toContain('Testbank');
			// Betrag über formatEuro: geschütztes Leerzeichen vor „€“ (kein Umbruch zwischen Zahl und Währung, #34)
			expect(sent[0]!.text).toMatch(/\d+,\d{2}\u00a0€/);
			expect(sent[0]!.text).toContain('DE02 1234 5678 9012 3456 78');

			const list = await data<
				{
					name: string;
					source: string;
					contactEmail: string | null;
					role: string;
					groupLabel: string | null;
					bremenResident: boolean | null;
					birthDate: string | null;
				}[]
			>(await as('owner', `/actions/${actionId}/participants`));
			const p = list.find((x) => x.name === 'Max Mustermann')!;
			expect(p).toMatchObject({
				source: 'link',
				contactEmail: 'eltern@example.test',
				role: 'participant',
				groupLabel: 'Wölflinge',
				bremenResident: true,
				birthDate: '2016-05-04'
			});
		});

		it('Duplikat -> 409 (auch mit anderer Schreibweise)', async () => {
			const res = await submit(token, person({ name: '  max   MUSTERMANN ' }));
			expect(res.status).toBe(409);
			expect((await res.json()).error.code).toBe('conflict');
		});

		it('Validierungsfehler je Feld -> 422', async () => {
			const res = await submit(
				token,
				person({
					name: '',
					email: 'kein-mail',
					birthDate: '2999-01-01',
					diet: 'pizza',
					privacy: false
				})
			);
			expect(res.status).toBe(422);
			const body = await res.json();
			const details = JSON.stringify(body.error.details);
			for (const k of ['name', 'email', 'diet', 'privacy']) {
				expect(details).toContain(k);
			}
		});

		it('unplausibles Geburtsdatum -> 422', async () => {
			const res = await submit(token, person({ name: 'Zeit Reisende', birthDate: '2999-01-01' }));
			expect(res.status).toBe(422);
			expect(JSON.stringify((await res.json()).error.details)).toContain('birthDate');
		});

		it('unbekannte Schlüssel und fehlender JSON-Content-Type werden abgelehnt', async () => {
			expect((await submit(token, person({ evil: 'x' }))).status).toBe(422);
			const res = await pub(`/${token}/submit`, {
				method: 'POST',
				body: 'values=1',
				headers: { 'content-type': 'text/plain' }
			});
			expect(res.status).toBe(400);
		});

		it('Honeypot: Erfolgsantwort ohne Eintrag', async () => {
			const before = await data<unknown[]>(await as('owner', `/actions/${actionId}/participants`));
			sent.length = 0;
			const res = await submit(token, person({ name: 'Spam Bot' }), { website: 'http://spam' });
			const out = await data<PublicSubmitResult>(res, 201);
			expect(out.name).toBe('Spam Bot');
			const after = await data<unknown[]>(await as('owner', `/actions/${actionId}/participants`));
			expect(after).toHaveLength(before.length);
			expect(sent).toHaveLength(0);
		});

		it('Mailfehler: ohne Bestätigungs-Mail keine Anmeldung (503, nichts gespeichert)', async () => {
			failMail = true;
			try {
				const res = await submit(token, person({ name: 'Lena Ohnemail', birthDate: '2015-01-02' }));
				expect(res.status).toBe(503);
			} finally {
				failMail = false;
			}
			const list = await data<{ name: string }[]>(
				await as('owner', `/actions/${actionId}/participants`)
			);
			expect(list.some((p) => p.name === 'Lena Ohnemail')).toBe(false);
		});

		it('Audit der Anmeldung ohne personenbezogene Daten', async () => {
			const page = await listAudit({ limit: 200 });
			const entries = page.rows.filter((e) => e.action === 'actions.registration.submitted');
			expect(entries.length).toBeGreaterThan(0);
			const raw = JSON.stringify(entries);
			expect(raw).not.toContain('Mustermann');
			expect(raw).not.toContain('eltern@example.test');
			expect(raw).not.toContain('2016-05-04');
		});
	});
});

describe('Teilnehmenden-CSV', () => {
	it('liefert BOM, Escaping und Formel-Schutz', async () => {
		const id = await newAction('CSV-Test');
		const cfg = await data<FormConfig>(await saveForm(id));
		await data(
			await submit(
				cfg.token!,
				person({ name: '=HYPERLINK("x")', notes: 'Zeile1;"zwei"\nZeile3', birthDate: '2014-03-03' })
			),
			201
		);
		const res = await as('owner', `/actions/${id}/participants.csv`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(res.headers.get('content-disposition')).toContain('attachment; filename="CSV-Test');
		const bytes = new Uint8Array(await res.clone().arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const text = await res.text();
		expect(text.startsWith('Name;Gruppe;Geburtsdatum')).toBe(true);
		expect(text).toContain("'=HYPERLINK(");
		expect(text).toContain('""zwei""');
		expect(text).toContain(';Link;');
		expect((await as('stranger', `/actions/${id}/participants.csv`)).status).toBe(404);
		const audit = (await listAudit({ limit: 200 })).rows.map((e) => e.action);
		expect(audit).toContain('actions.participants.exported');
	});
});
