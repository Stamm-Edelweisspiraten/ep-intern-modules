/**
 * Schutz vor Rechteausweitung bei Kontoänderungen (#4): Wer `core.users.edit`/`.delete` hat, darf nur Konten
 * ändern, deren wirksame Rechte (inkl. Modul-Verleihungen aus `user_role_grant`) er selbst besitzt.
 * Zusätzlich: Hinweismail an die alte Adresse beim administrativen E-Mail-Wechsel, Audit nur maskiert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { settleMails } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser, systemContext } from '$testing';
import {
	bootstrapAdmin,
	createUser,
	deleteUser,
	setUserActive,
	setUserRoles,
	updateUser
} from '$testing';
import { removeUserAvatar, setUserAvatar } from '$testing';
import { canManageUser } from '$testing';
import { createRole } from '$testing';
import { replaceModuleRoleGrants } from '$testing';
import { ADMIN_ROLE_ID } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { setMailTransportForTests } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import officesModule from '$modules/offices/module';
import type { RequestContext } from '$lib/sdk/types';

const PW = 'correct-horse-battery';
// Echtes 1×1-PNG: Profilbilder laufen durch `core.images` (#19)
const PNG = new Uint8Array(
	Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
		'base64'
	)
);

interface Mail {
	to: string;
	subject: string;
	text: string;
}
const mails: Mail[] = [];

let close: () => Promise<void>;
let admin: RequestContext;
const ids: Record<string, string> = {};
let n = 0;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function expectCode(p: Promise<unknown>, status: number) {
	await expect(p).rejects.toMatchObject({ status });
}

/** Neues Konto mit Rollen anlegen */
async function user(label: string, roleIds: string[]): Promise<string> {
	n++;
	return createUser(admin, {
		name: `${label} ${n}`,
		email: `${label.toLowerCase()}-${n}@example.test`,
		password: PW,
		roleIds
	});
}

let roles: { editOnly: string; editDelete: string; member: string; editMember: string };

beforeAll(async () => {
	setMailTransportForTests({
		sendMail: async (m) => {
			mails.push({ to: m.to, subject: m.subject, text: m.text });
		}
	});
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(officesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', PW);
	const [a] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	ids.admin = a!.id;
	admin = await ctxOf(a!.id);
	await enableModule(admin, 'offices');
	admin = await ctxOf(a!.id);
	await installFakeStorage(admin);

	const base = ['core.users.view', 'core.api.manage'];
	roles = {
		editOnly: await createRole(admin, {
			name: 'Nur bearbeiten',
			permissions: [...base, 'core.users.edit']
		}),
		editDelete: await createRole(admin, {
			name: 'Bearbeiten und löschen',
			permissions: [...base, 'core.users.edit', 'core.users.delete']
		}),
		member: await createRole(admin, { name: 'Wenig', permissions: ['core.users.view'] }),
		editMember: await createRole(admin, {
			name: 'Bearbeiten + Rollen',
			permissions: [...base, 'core.users.edit', 'core.roles.assign', 'core.roles.view']
		})
	};
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	uninstallFakeStorage();
	await close?.();
});

describe('Zugriffsmatrix Kontoänderungen', () => {
	it('Nicht-Admin mit core.users.edit → 403 bei E-Mail/Status/Profilbild eines Admin-Kontos', async () => {
		const actor = await ctxOf(await user('Edit', [roles.editOnly]));
		const target = await user('Admin', [ADMIN_ROLE_ID]);
		await expectCode(updateUser(actor, target, { email: 'boese@example.test' }), 403);
		await expectCode(updateUser(actor, target, { name: 'Umbenannt' }), 403);
		await expectCode(setUserActive(actor, target, false), 403);
		await expectCode(setUserAvatar(actor, target, { data: PNG, contentType: 'image/png' }), 403);
		await expectCode(removeUserAvatar(actor, target), 403);
		const [t] = await getDb().select().from(schema.user).where(eq(schema.user.id, target));
		expect(t!.email).not.toBe('boese@example.test');
		expect(t!.active).toBe(true);
		expect(await canManageUser(actor, target)).toBe(false);
	});

	it('Nicht-Admin mit core.users.delete → 403 beim Löschen eines Kontos mit mehr Rechten', async () => {
		const actor = await ctxOf(await user('Del', [roles.editDelete]));
		const target = await user('Admin', [ADMIN_ROLE_ID]);
		await expectCode(deleteUser(actor, target), 403);
		const [t] = await getDb().select().from(schema.user).where(eq(schema.user.id, target));
		expect(t).toBeTruthy();
	});

	it('gleichrangige und weniger privilegierte Konten bleiben bearbeitbar', async () => {
		const actor = await ctxOf(await user('Del', [roles.editDelete]));
		const peer = await user('Peer', [roles.editDelete]);
		const lower = await user('Low', [roles.member]);
		const none = await user('None', []);
		await updateUser(actor, peer, { email: `peer-neu-${n}@example.test` });
		await setUserActive(actor, lower, false);
		await setUserActive(actor, lower, true);
		const image = await setUserAvatar(actor, lower, { data: PNG, contentType: 'image/png' });
		expect(image).toMatch(/^\/avatar\//);
		await removeUserAvatar(actor, lower);
		await deleteUser(actor, none);
		expect(await canManageUser(actor, peer)).toBe(true);
	});

	it('Rechte aus Ämtern (user_role_grant) zählen mit', async () => {
		const actor = await ctxOf(await user('Edit', [roles.editOnly]));
		const holder = await user('Amt', [roles.member]);
		// vorher: weniger Rechte → erlaubt
		expect(await canManageUser(actor, holder)).toBe(true);
		await replaceModuleRoleGrants('offices', [{ userId: holder, roleIds: [ADMIN_ROLE_ID] }]);
		expect(await canManageUser(actor, holder)).toBe(false);
		await expectCode(updateUser(actor, holder, { email: 'amt-boese@example.test' }), 403);
		await expectCode(setUserActive(actor, holder, false), 403);
		await replaceModuleRoleGrants('offices', []);
		expect(await canManageUser(actor, holder)).toBe(true);
	});

	it('Rollen eines höher privilegierten Kontos ändern → 403 (auch mit zuweisbaren Rollen)', async () => {
		const actor = await ctxOf(await user('Rollen', [roles.editMember]));
		const target = await user('Admin', [ADMIN_ROLE_ID]);
		await expectCode(setUserRoles(actor, target, [ADMIN_ROLE_ID, roles.member]), 403);
		const lower = await user('Low', [roles.member]);
		await setUserRoles(actor, lower, [roles.member, roles.editMember]);
	});

	it('Admin und System dürfen alles; eigenes Konto ist ausgenommen', async () => {
		const target = await user('Admin', [ADMIN_ROLE_ID]);
		await updateUser(admin, target, { name: 'Durch Admin' });
		await setUserActive(systemContext('test'), target, false);
		await setUserActive(admin, target, true);
		const selfId = await user('Self', [roles.editOnly]);
		const self = await ctxOf(selfId);
		await updateUser(self, selfId, { name: 'Selbst geändert' });
	});

	it('REST: PATCH /users/:id auf ein Admin-Konto → 403', async () => {
		const actorId = await user('Api', [roles.editOnly]);
		const actorCtx = await ctxOf(actorId);
		const key = (await createApiKey(actorCtx, { name: 'k', scopes: [...actorCtx.permissions] }))
			.key;
		const target = await user('Admin', [ADMIN_ROLE_ID]);
		resetAllForTests();
		const url = new URL(`http://localhost:5173/api/v1/users/${target}`);
		const res = await handleApiRequest({
			request: new Request(url, {
				method: 'PATCH',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ email: 'api-boese@example.test' })
			}),
			url,
			ip: '127.0.0.1'
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.code).toBe('forbidden');
	});
});

describe('Administrativer E-Mail-Wechsel', () => {
	it('schickt einen Hinweis an die alte Adresse; Audit nur maskiert', async () => {
		const target = await user('Mail', [roles.member]);
		const [before] = await getDb().select().from(schema.user).where(eq(schema.user.id, target));
		mails.length = 0;
		await updateUser(admin, target, { email: 'neu-adresse@example.org' });
		await expect
			.poll(() => mails.find((m) => m.to === before!.email), { timeout: 2000 })
			.toBeTruthy();
		const mail = mails.find((m) => m.to === before!.email)!;
		expect(mail.subject).toContain('E-Mail-Adresse');
		expect(mail.text).toContain('n***@example.org');
		expect(mail.text).not.toContain('neu-adresse@example.org');

		const { rows } = await listAudit({ target, limit: 20 });
		const entry = rows.find((r) => r.action === 'core.user.updated');
		expect(entry).toBeTruthy();
		const meta = JSON.stringify(entry!.metadata);
		expect(meta).toContain('n***@example.org');
		expect(meta).not.toContain('neu-adresse@example.org');
		expect(meta).not.toContain(before!.email);
		const created = rows.find((r) => r.action === 'core.user.created');
		expect(JSON.stringify(created?.metadata ?? {})).not.toContain(before!.email);
	});

	it('ohne Adressänderung keine Mail', async () => {
		const target = await user('Mail', [roles.member]);
		mails.length = 0;
		await updateUser(admin, target, { name: 'Nur Name' });
		await settleMails();
		expect(mails).toHaveLength(0);
	});
});
