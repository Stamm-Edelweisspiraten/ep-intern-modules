/**
 * #68 (02-11): Globale Suche ermittelt die Principal-Schlüssel nur einmal je Suchrequest, obwohl
 * events, galleries und files je eigene Freigaben prüfen. Mit echtem Pool laufen die Quellen
 * parallel (gleiches Ergebnis, gleiche Reihenfolge); PGlite strikt nacheinander.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { databaseAllowsParallelQueries, getDb, schema, setDb } from '$testing';
import { searchEverything } from '$testing';
import { core, principalKeysFor } from '$lib/sdk/server';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import filesModule from '$modules/files/module';
import type { PrincipalProvider } from '$lib/sdk/types/sharing';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let adminId = '';
const ctxOf = async (): Promise<RequestContext> => (await contextForUser(adminId))!.ctx;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	for (const m of [membersModule, eventsModule, galleriesModule, filesModule]) registerModule(m);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	const admin = await ctxOf();
	for (const m of ['members', 'events', 'galleries', 'files']) await enableModule(admin, m);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
	await close();
});

describe('Principal-Schlüssel je Request (#68)', () => {
	it('globale Suche: Rollen und Mitglieds-Principals je Request genau einmal', async () => {
		const roles = vi.spyOn(core.users, 'roleIds');
		const memberIds = vi.spyOn(membersModule.provides as PrincipalProvider, 'principalIdsForUser');
		const ctx = await ctxOf();
		await searchEverything(ctx, 'Sommer');
		expect(roles).toHaveBeenCalledTimes(1);
		expect(memberIds).toHaveBeenCalledTimes(1);
		// Gleicher Kontext, anderes Modul: aus dem Memo
		await principalKeysFor(ctx, 'events');
		expect(roles).toHaveBeenCalledTimes(1);
		// Neuer Request → neue Ermittlung
		await searchEverything(await ctxOf(), 'Sommer');
		expect(roles).toHaveBeenCalledTimes(2);
	});

	it('Schlüssel sind je Modul gleich (members für alle erreichbar) und Kopien', async () => {
		const ctx = await ctxOf();
		const a = await principalKeysFor(ctx, 'events');
		const b = await principalKeysFor(ctx, 'files');
		expect([...a].sort()).toEqual([...b].sort());
		a.push('user:fremd');
		expect(await principalKeysFor(ctx, 'galleries')).not.toContain('user:fremd');
	});
});

describe('Parallele Suche (#68)', () => {
	it('PGlite: keine parallelen Abfragen', () => {
		expect(databaseAllowsParallelQueries()).toBe(false);
	});

	it('mit Pool-Flag: gleiche Gruppen in gleicher Reihenfolge, eine Principal-Ermittlung', async () => {
		const db = getDb();
		const serial = await searchEverything(await ctxOf(), 'Dat');
		setDb(db, async () => {}, { concurrent: true });
		try {
			expect(databaseAllowsParallelQueries()).toBe(true);
			const roles = vi.spyOn(core.users, 'roleIds');
			const parallel = await searchEverything(await ctxOf(), 'Dat');
			expect(parallel).toEqual(serial);
			expect(roles.mock.calls.length).toBeLessThanOrEqual(1);
		} finally {
			setDb(db, close);
		}
	});
});
