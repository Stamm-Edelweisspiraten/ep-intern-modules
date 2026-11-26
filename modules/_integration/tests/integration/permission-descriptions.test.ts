import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import membersModule from '$modules/members/module';
import treasuryModule from '$modules/treasury/module';
import {
	getDb,
	listPermissions,
	registerModule,
	schema,
	syncModules,
	syncPermissions,
	useTestDatabase
} from '$testing';

const MODULES = [membersModule, actionsModule, treasuryModule, eventsModule, galleriesModule];

let close: () => Promise<void>;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	for (const m of MODULES) registerModule(m);
	await syncModules();
});

afterAll(async () => {
	await close();
});

describe('Beschreibungen der Berechtigungen', () => {
	it('jedes Modul beschreibt genau seine Rechte', () => {
		for (const m of MODULES) {
			const { id, permissions, permissionDescriptions = {} } = m.manifest;
			expect(Object.keys(permissionDescriptions).sort(), id).toEqual([...permissions].sort());
			for (const key of permissions) {
				const text = permissionDescriptions[key];
				const de = typeof text === 'string' ? text : text?.de;
				expect(de?.trim().length ?? 0, key).toBeGreaterThan(5);
			}
		}
	});

	it('alle Rechte (Core und Module) haben in der Datenbank eine Beschreibung', async () => {
		const missing = (await listPermissions()).filter((p) => !p.description?.trim());
		expect(missing.map((p) => p.key)).toEqual([]);
	});

	it('Beschreibungen bestehender Rechte werden aktualisiert, ohne Angabe bleibt die alte', async () => {
		const key = 'events.event.view';
		await getDb()
			.update(schema.permission)
			.set({ description: null })
			.where(eq(schema.permission.key, key));
		await syncModules();
		const after = (await listPermissions()).find((p) => p.key === key);
		expect<unknown>(after?.description).toBe(eventsModule.manifest.permissionDescriptions?.[key]);

		await syncPermissions([{ key, moduleId: 'events' }]);
		const kept = (await listPermissions()).find((p) => p.key === key);
		expect(kept?.description).toBe(after?.description);
	});
});
