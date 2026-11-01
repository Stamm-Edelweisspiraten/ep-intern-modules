/**
 * Gesundheitsdaten der Teilnehmenden (Issue #7): Ohne `members.data.export` liefern JSON-Liste, CSV,
 * ZIP-Export und PDF keine Ernährung/Allergien/Sonstiges/gesundheitsbezogenen Antworten; mit Recht
 * vollständig. In der Datenbank stehen die Felder verschlüsselt, der Altbestand wird migriert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { getDb, schema } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { resetEnvForTests } from '$testing';
import { loadTableInfo } from '$testing';
import { decodeRowSecrets, encodeRowSecrets } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import membersModule from '$modules/members/module';
import { parseArchive } from '$modules/actions/action-archive';
import { encryptStoredHealthData, isHealthAnswerKey } from '$modules/actions/health';
import {
	STANDARD_FORM_KEYS as K,
	type FormConfig,
	type Participant
} from '$modules/actions/schemas';
import type { RequestContext } from '$lib/sdk/types';

const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let actionId: string;
let html = '';

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
	api(`/modules/actions${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

const BASE = ['core.api.manage', 'actions.action.view'];
const ROLES: Record<string, string[]> = {
	owner: [...BASE, 'actions.action.create', 'members.data.export'],
	/** Lese-Freigabe, ohne Sonderrecht */
	reader: BASE,
	/** Lese-Freigabe, mit Sonderrecht */
	healthReader: [...BASE, 'members.data.export'],
	/** Bearbeiten-Freigabe, ohne Sonderrecht */
	editor: BASE,
	/** darf importieren, ohne Sonderrecht */
	importer: [...BASE, 'actions.action.create']
};

const HEALTH_VALUES = ['Erdnüsse', 'Asthma-Spray', 'Insulin', 'Tetanus 2024', 'Laktose', 'Ritalin'];

async function share(userKey: string, level: 'read' | 'edit') {
	await getDb().execute(
		sql`INSERT INTO mod_actions.action_shares (action_id, principal_type, principal_id, level)
			VALUES (${actionId}, 'user', ${userIds[userKey]!}, ${level})`
	);
}

async function rawParticipants() {
	return (
		await getDb().execute(
			sql`SELECT id, name, diet, allergies, notes, answers::text AS answers, health_answers
				FROM mod_actions.action_participants WHERE action_id = ${actionId} ORDER BY created_at`
		)
	).rows as Record<string, string | null>[];
}

const mails: { text: string }[] = [];

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			mails.push(m);
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
	for (const [name, perms] of Object.entries(ROLES)) {
		const role = await createRole(admin, { name: `role-${name}`, permissions: perms });
		const id = await createUser(admin, {
			name: `${name} Test`,
			email: `${name.toLowerCase()}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [role]
		});
		userIds[name] = id;
		keys[name] = (await createApiKey(await ctxOf(id), { name: `key-${name}`, scopes: perms })).key;
	}
	setPdfRendererForTests(async (h) => {
		html = h;
		return new TextEncoder().encode('%PDF-fake');
	});

	actionId = (
		await data<{ id: string }>(
			await as('owner', '/actions', {
				method: 'POST',
				json: { name: 'Pfingstlager', startsOn: '2026-06-01', endsOn: '2026-06-05' }
			}),
			201
		)
	).id;
	await share('reader', 'read');
	await share('healthReader', 'read');
	await share('editor', 'edit');

	// 1) Manuell erfasst
	await data(
		await as('owner', `/actions/${actionId}/participants`, {
			method: 'POST',
			json: {
				name: 'Paula Pfad',
				birthDate: '2014-03-02',
				diet: 'vegan',
				allergies: 'Erdnüsse',
				notes: 'Asthma-Spray'
			}
		}),
		201
	);

	// 2) Über das Anmeldeformular mit Mitgliedsfeld (Medikamente), Gesundheitsbegriff im Label und freiem Feld
	const cfg = await data<FormConfig>(await as('owner', `/actions/${actionId}/form`));
	const definition = {
		...cfg.definition,
		fields: [
			...cfg.definition.fields,
			{
				id: 'mf_medikamente',
				key: 'mf_medikamente',
				type: 'textarea',
				label: 'Medikamente',
				memberKey: 'medikamente'
			},
			{ id: 'impf', key: 'impf', type: 'text', label: 'Impfstatus (Tetanus)' },
			{ id: 'tshirt', key: 'tshirt', type: 'text', label: 'T-Shirt-Größe' }
		]
	};
	const saved = await data<FormConfig>(
		await as('owner', `/actions/${actionId}/form`, {
			method: 'PUT',
			json: {
				enabled: true,
				opensAt: null,
				closesAt: null,
				maxParticipants: null,
				intro: null,
				disclaimerTemplate: cfg.disclaimerTemplate,
				privacyUrl: 'https://example.org/datenschutz',
				requireLogin: false,
				definition
			}
		})
	);
	resetAllForTests();
	await data(
		await confirmIfNeeded(
			await api(`/modules/actions/public/forms/${saved.token}/submit`, {
				method: 'POST',
				json: {
					values: {
						[K.name]: 'Max Mustermann',
						[K.group]: 'Sonstige',
						[K.birthDate]: '2015-05-04',
						[K.bremenResident]: 'yes',
						[K.diet]: 'vegetarian',
						[K.allergies]: 'Laktose',
						[K.notes]: '',
						[K.email]: 'eltern@example.test',
						[K.privacy]: true,
						[K.disclaimer]: true,
						mf_medikamente: 'Insulin',
						impf: 'Tetanus 2024',
						tshirt: 'M'
					}
				}
			}),
			mails,
			api
		),
		201
	);
}, 120_000);

afterAll(() => {
	setPdfRendererForTests(undefined);
	setMailTransportForTests(undefined);
});

describe('Erkennung gesundheitsbezogener Antworten', () => {
	it('Mitgliedsfelder (außer Juleica), Vorlagen-Schlüssel und Gesundheitsbegriffe', () => {
		expect(isHealthAnswerKey('mf_medikamente')).toBe(true);
		expect(isHealthAnswerKey('mf_schwimmen')).toBe(true);
		expect(isHealthAnswerKey('mf_juleica')).toBe(false);
		expect(isHealthAnswerKey('krankenkasse')).toBe(true);
		expect(
			isHealthAnswerKey('x1', [
				{ id: 'x1', key: 'x1', type: 'text', label: 'Allergien (sonstige)' }
			])
		).toBe(true);
		expect(
			isHealthAnswerKey('x2', [{ id: 'x2', key: 'x2', type: 'text', label: 'T-Shirt-Größe' }])
		).toBe(false);
	});
});

describe('Speicherung verschlüsselt', () => {
	it('diet/allergies/notes und gesundheitsbezogene Antworten stehen nicht im Klartext', async () => {
		const rows = await rawParticipants();
		expect(rows).toHaveLength(2);
		const dump = JSON.stringify(rows);
		for (const v of HEALTH_VALUES) expect(dump).not.toContain(v);
		for (const v of ['vegan', 'vegetarian']) expect(dump).not.toContain(`"${v}"`);
		for (const r of rows) {
			expect(r.diet).toMatch(/^enc:v1:/);
			expect(r.allergies).toMatch(/^enc:v1:/);
		}
		expect(rows[0]!.notes).toMatch(/^enc:v1:/);
		const linked = rows[1]!;
		expect(JSON.parse(linked.answers!)).toEqual({ tshirt: 'M' });
		expect(linked.health_answers).toMatch(/^enc:v1:/);
	});
});

describe('Ohne Sonderrecht (Lese-Freigabe)', () => {
	it('JSON-Liste: Gesundheitsfelder null, healthHidden', async () => {
		const list = await data<Participant[]>(await as('reader', `/actions/${actionId}/participants`));
		expect(list).toHaveLength(2);
		for (const p of list) {
			expect(p).toMatchObject({ diet: null, allergies: null, notes: null, healthHidden: true });
		}
		expect(JSON.stringify(list)).not.toMatch(/Erdnüsse|Laktose|Asthma/);
	});

	it('CSV ohne Gesundheitsspalten', async () => {
		const res = await as('reader', `/actions/${actionId}/participants.csv`);
		expect(res.status).toBe(200);
		const csv = await res.text();
		expect(csv).toContain('Paula Pfad');
		expect(csv).not.toMatch(/Ernährung|Allergien|Sonstiges/);
		for (const v of HEALTH_VALUES) expect(csv).not.toContain(v);
		expect(csv).not.toContain('Vegan');
	});

	it('ZIP-Export ohne Gesundheitsdaten, freie Antworten bleiben', async () => {
		const res = await as('reader', `/actions/${actionId}/export`);
		expect(res.status).toBe(200);
		const archive = parseArchive(new Uint8Array(await res.arrayBuffer()));
		expect(archive.manifest.contents.includesHealth).toBe(false);
		for (const p of archive.document.participants) {
			expect(p).toMatchObject({ diet: null, allergies: null, notes: null });
		}
		const linked = archive.document.participants.find((p) => p.name === 'Max Mustermann')!;
		expect(linked.answers).toEqual({ tshirt: 'M' });
		const json = JSON.stringify(archive.document);
		for (const v of HEALTH_VALUES) expect(json).not.toContain(v);
	});

	it('PDF bleibt 403', async () => {
		expect((await as('reader', `/actions/${actionId}/participants.pdf`)).status).toBe(403);
	});

	it('Bearbeiten ohne Sonderrecht lässt die Gesundheitsfelder unverändert', async () => {
		const [paula] = (
			await data<Participant[]>(await as('editor', `/actions/${actionId}/participants`))
		).filter((p) => p.name === 'Paula Pfad');
		const updated = await data<Participant>(
			await as('editor', `/actions/${actionId}/participants/${paula!.id}`, {
				method: 'PUT',
				json: { name: 'Paula Pfad', birthDate: '2014-03-02', groupLabel: 'Sippe Falke' }
			})
		);
		expect(updated).toMatchObject({
			groupLabel: 'Sippe Falke',
			allergies: null,
			healthHidden: true
		});
		const full = await data<Participant[]>(await as('owner', `/actions/${actionId}/participants`));
		expect(full.find((p) => p.id === paula!.id)).toMatchObject({
			diet: 'vegan',
			allergies: 'Erdnüsse',
			notes: 'Asthma-Spray'
		});
	});
});

describe('Mit Sonderrecht vollständig', () => {
	it('JSON-Liste entschlüsselt', async () => {
		const list = await data<Participant[]>(
			await as('healthReader', `/actions/${actionId}/participants`)
		);
		const paula = list.find((p) => p.name === 'Paula Pfad')!;
		expect(paula).toMatchObject({ diet: 'vegan', allergies: 'Erdnüsse', notes: 'Asthma-Spray' });
		expect(paula.healthHidden).toBeUndefined();
		expect(list.find((p) => p.name === 'Max Mustermann')).toMatchObject({
			diet: 'vegetarian',
			allergies: 'Laktose'
		});
	});

	it('CSV mit Gesundheitsspalten, Audit mit withHealth', async () => {
		const csv = await (await as('healthReader', `/actions/${actionId}/participants.csv`)).text();
		expect(csv).toContain('Allergien/Unverträglichkeiten');
		expect(csv).toContain('Erdnüsse');
		expect(csv).toContain('Vegan');
		const audit = await listAudit({ limit: 50 });
		const entries = audit.rows.filter((e) => e.action === 'actions.participants.exported');
		expect(entries.map((e) => (e.metadata as { withHealth?: boolean }).withHealth)).toEqual(
			expect.arrayContaining([true, false])
		);
		expect(JSON.stringify(entries)).not.toContain('Erdnüsse');
	});

	it('ZIP-Export vollständig; Import verschlüsselt wieder; Round-Trip', async () => {
		const bytes = new Uint8Array(
			await (await as('healthReader', `/actions/${actionId}/export`)).arrayBuffer()
		);
		const archive = parseArchive(bytes);
		expect(archive.manifest.contents.includesHealth).toBe(true);
		const linked = archive.document.participants.find((p) => p.name === 'Max Mustermann')!;
		expect(linked.answers).toEqual({
			tshirt: 'M',
			mf_medikamente: 'Insulin',
			impf: 'Tetanus 2024'
		});

		const fd = new FormData();
		fd.set('file', new File([bytes], 'export.zip', { type: 'application/zip' }));
		const imp = await data<{ id: string }>(
			await as('owner', '/actions/import', { method: 'POST', body: fd }),
			201
		);
		const rows = (
			await getDb().execute(
				sql`SELECT diet, allergies, notes, answers::text AS answers, health_answers
					FROM mod_actions.action_participants WHERE action_id = ${imp.id}`
			)
		).rows;
		const dump = JSON.stringify(rows);
		for (const v of HEALTH_VALUES) expect(dump).not.toContain(v);
		const again = parseArchive(
			new Uint8Array(await (await as('owner', `/actions/${imp.id}/export`)).arrayBuffer())
		);
		expect(again.document).toEqual(archive.document);
	});

	it('Import eines Archivs ohne Gesundheitsdaten funktioniert', async () => {
		const bytes = new Uint8Array(
			await (await as('reader', `/actions/${actionId}/export`)).arrayBuffer()
		);
		const fd = new FormData();
		fd.set('file', new File([bytes], 'export.zip', { type: 'application/zip' }));
		const imp = await data<{ id: string }>(
			await as('importer', '/actions/import', { method: 'POST', body: fd }),
			201
		);
		const list = await data<Participant[]>(await as('importer', `/actions/${imp.id}/participants`));
		expect(list).toHaveLength(2);
	});

	it('PDF enthält die entschlüsselten Werte', async () => {
		html = '';
		const res = await as('healthReader', `/actions/${actionId}/participants.pdf`, {
			method: 'POST',
			json: {}
		});
		expect(res.status).toBe(200);
		expect(html).toContain('Erdnüsse');
		expect(html).toContain('Insulin');
	});
});

describe('Bestandsmigration', () => {
	it('Klartext-Altbestand wird verschlüsselt, Anzeige identisch, idempotent', async () => {
		const pid = crypto.randomUUID();
		await getDb().execute(
			sql`INSERT INTO mod_actions.action_participants (id, action_id, name, diet, allergies, notes, answers)
				VALUES (${pid}, ${actionId}, 'Alt Bestand', 'meat', 'Laktose', 'Ritalin morgens',
					${JSON.stringify({ mf_medikamente: 'Ritalin', tshirt: 'L' })}::jsonb)`
		);
		// Altbestand ist schon vor der Migration ohne Sonderrecht nicht sichtbar
		const hidden = await data<Participant[]>(
			await as('reader', `/actions/${actionId}/participants`)
		);
		expect(JSON.stringify(hidden)).not.toMatch(/Laktose|Ritalin/);

		const first = await encryptStoredHealthData();
		expect(first.updated).toBe(1);
		const [row] = (
			await getDb().execute(
				sql`SELECT diet, allergies, notes, answers::text AS answers, health_answers
					FROM mod_actions.action_participants WHERE id = ${pid}`
			)
		).rows as Record<string, string>[];
		expect(row!.diet).toMatch(/^enc:v1:/);
		expect(row!.allergies).toMatch(/^enc:v1:/);
		expect(row!.notes).toMatch(/^enc:v1:/);
		expect(JSON.parse(row!.answers!)).toEqual({ tshirt: 'L' });
		expect(row!.health_answers).toMatch(/^enc:v1:/);
		expect(JSON.stringify(row)).not.toContain('Ritalin');

		const list = await data<Participant[]>(await as('owner', `/actions/${actionId}/participants`));
		expect(list.find((p) => p.id === pid)).toMatchObject({
			diet: 'meat',
			allergies: 'Laktose',
			notes: 'Ritalin morgens'
		});
		expect((await encryptStoredHealthData()).updated).toBe(0);
	});

	it('Job actions.encrypt-health ist registriert', () => {
		expect(actionsModule.jobs?.map((j) => j.id)).toContain('encrypt-health');
	});
});

describe('Datensicherung mit Schlüsselwechsel', () => {
	it('Gesundheitsspalten werden als Geheimnis exportiert und mit neuem Schlüssel verschlüsselt', async () => {
		const tables = await loadTableInfo(getDb(), ['mod_actions']);
		const t = tables.find((x) => x.table === 'action_participants')!;
		const [row] = (
			await getDb().execute(
				sql`SELECT * FROM mod_actions.action_participants WHERE name = 'Paula Pfad'
					AND action_id = ${actionId}`
			)
		).rows as Record<string, unknown>[];
		const { row: encoded, undecryptable } = await encodeRowSecrets(t, row!);
		expect(undecryptable).toBe(0);
		expect(JSON.stringify(encoded)).toContain('Erdnüsse');

		const old = process.env.APP_SECRET;
		process.env.APP_SECRET = 'ganz-anderer-server-schluessel-2026-health';
		resetEnvForTests();
		try {
			const decoded = await decodeRowSecrets(t, encoded);
			const crypt = core.crypto.forModule('actions');
			expect(decoded.allergies).toMatch(/^enc:v1:/);
			expect(decoded.allergies).not.toBe(row!.allergies);
			expect(crypt.decrypt(String(decoded.allergies))).toBe('Erdnüsse');
			expect(crypt.decrypt(String(decoded.diet))).toBe('vegan');
			expect(crypt.decrypt(String(decoded.notes))).toBe('Asthma-Spray');
		} finally {
			process.env.APP_SECRET = old;
			resetEnvForTests();
		}
	});
});
