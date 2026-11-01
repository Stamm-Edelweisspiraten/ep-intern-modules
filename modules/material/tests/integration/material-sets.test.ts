import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { runJobNow } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import materialModule from '$modules/material/module';
import type {
	Catalog,
	Inventory,
	Item,
	LineAvailability,
	MaterialSet,
	MaterialType,
	Reservation,
	ReservationLine,
	Tent
} from '$modules/material/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Modul „Material“ v2.1: Sets (zusammengehörige Bahnen), Zelte als Bauplan, Reservieren von Zelten mit
// automatischer Zuteilung ganzer Sets, Umplanen bei gezielter Reservierung, Ausgabe, Zuteilung von Hand.

const PW = 'material-password-123';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	resetAllForTests();
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
const M = (path: string, who: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/material${path}`, { token: keys[who], ...init });
const get = (path: string, who: string) => M(path, who);
const post = (path: string, who: string, json: unknown = {}) =>
	M(path, who, { method: 'POST', json });
const put = (path: string, who: string, json: unknown) => M(path, who, { method: 'PUT', json });
const patch = (path: string, who: string, json: unknown) => M(path, who, { method: 'PATCH', json });
const del = (path: string, who: string) => M(path, who, { method: 'DELETE' });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function fail(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error as { code: string; message: string; details?: unknown };
}
const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	const id = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	const ctx = await ctxOf(id);
	keys[name] = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
}

let bahn: MaterialType;
let kj1: Item[];
let kj2: Item[];
let lose: Item[];
let seil: Item;
let setKj1: MaterialSet;
let jurte: Tent;
let lager: Reservation;

const period = { startsOn: '2026-07-01', endsOn: '2026-07-05' };
const parts = (r: Reservation) => r.lines.find((l) => l.kind === 'tent')!.parts;
const part = (r: Reservation, label: string) => parts(r).find((p) => p.label === label)!;
const assigned = (l: ReservationLine) => l.assignments.map((a) => a.name).sort();
const setsOf = (l: ReservationLine, slot: number) =>
	new Set(l.assignments.filter((a) => a.slot === slot).map((a) => a.setName));

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(materialModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'material');
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	await mkUser('leitung', [
		'core.api.manage',
		'material.inventory.view',
		'material.reservation.create'
	]);
	await mkUser('andere', [
		'core.api.manage',
		'material.inventory.view',
		'material.reservation.create'
	]);
	setTodayForTests('2026-06-01');
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Sets und Zelte pflegen', () => {
	it('legt Bahnen, Sets und ein Zelt an', async () => {
		bahn = await data<MaterialType>(await post('/types', 'admin', { name: 'Kohtenbahn' }), 201);
		const batch = (name: string, count: number) =>
			post('/items', 'admin', { typeId: bahn.id, name, count, numberFrom: 1 });
		kj1 = await data<Item[]>(await batch('KJ1.', 6), 201);
		kj2 = await data<Item[]>(await batch('KJ2.', 6), 201);
		lose = await data<Item[]>(await batch('L', 6), 201);
		seil = (
			await data<Item[]>(await post('/items', 'admin', { name: 'Abspannseil', quantity: 2 }), 201)
		)[0]!;

		await fail(await post('/sets', 'leitung', { name: 'KJ1' }), 403);
		setKj1 = await data<MaterialSet>(
			await post('/sets', 'admin', { name: 'KJ1', itemIds: kj1.map((i) => i.id) }),
			201
		);
		expect(setKj1).toMatchObject({ name: 'KJ1', total: 6, usable: 6, complete: true });
		// Zweites Set über das Feld am Artikel
		const setKj2 = await data<MaterialSet>(await post('/sets', 'admin', { name: 'KJ2' }), 201);
		for (const i of kj2) await data(await patch(`/items/${i.id}`, 'admin', { setId: setKj2.id }));
		const sets = await data<MaterialSet[]>(await get('/sets', 'leitung'));
		expect(sets.map((s) => [s.name, s.items.length])).toEqual([
			['KJ1', 6],
			['KJ2', 6]
		]);
		// Artikel bleiben normale Kohtenbahnen; Filter nach Set
		const inv = await data<Inventory>(await get(`/inventory?setId=${setKj1.id}`, 'leitung'));
		expect(inv.types[0]!.items.map((i) => i.setName)).toEqual(Array(6).fill('KJ1'));

		await fail(
			await post('/tents', 'admin', {
				name: 'Jurte',
				parts: [{ kind: 'type', typeId: crypto.randomUUID(), quantity: 6 }]
			}),
			422
		);
		jurte = await data<Tent>(
			await post('/tents', 'admin', {
				name: 'Jurte',
				description: 'Kleine Jurte',
				parts: [
					{ kind: 'type', typeId: bahn.id, label: 'Dach', quantity: 6, fromOneSet: true },
					{ kind: 'type', typeId: bahn.id, label: 'Wand', quantity: 2 },
					{ kind: 'item', itemId: seil!.id, quantity: 1 }
				]
			}),
			201
		);
		expect(jurte.parts.map((p) => [p.label, p.name, p.quantity, p.fromOneSet])).toEqual([
			['Dach', 'Kohtenbahn', 6, true],
			['Wand', 'Kohtenbahn', 2, false],
			['', 'Abspannseil', 1, false]
		]);
	});

	it('Katalog zeigt Zelte mit baubarer Anzahl und Sets je Typ', async () => {
		const cat = await data<Catalog>(await get('/catalog?from=2026-07-01&to=2026-07-05', 'leitung'));
		// 18 Bahnen / 8 je Jurte = 2, 2 Seile → 2
		expect(cat.entries.find((e) => e.kind === 'tent')).toMatchObject({
			name: 'Jurte',
			free: 2,
			total: 2
		});
		const t = cat.entries.find((e) => e.id === bahn.id)!;
		expect(t.sets.map((s) => [s.name, s.size, s.wholeFree])).toEqual([
			['KJ1', 6, true],
			['KJ2', 6, true]
		]);
		expect(t.items.find((i) => i.name === 'KJ1.1')!.setName).toBe('KJ1');
	});
});

describe('Zelt reservieren und zuteilen', () => {
	it('Vorschau nennt die Sets, drei Jurten gehen nicht', async () => {
		const ok = await data<LineAvailability[]>(
			await post('/availability', 'leitung', {
				...period,
				lines: [{ kind: 'tent', tentId: jurte.id, quantity: 2 }]
			}),
			201
		);
		expect(ok[0]).toMatchObject({ ok: true, note: 'aus den Sets KJ1, KJ2' });
		const tooMany = await data<LineAvailability[]>(
			await post('/availability', 'leitung', {
				...period,
				lines: [{ kind: 'tent', tentId: jurte.id, quantity: 3 }]
			}),
			201
		);
		expect(tooMany[0]).toMatchObject({ ok: false, available: 2 });
		expect(tooMany[0]!.message).toContain('Jurte');
	});

	it('2 × Jurte: je Dach ein ganzes Set, Wand aus losen Bahnen', async () => {
		lager = await data<Reservation>(
			await post('/reservations', 'leitung', {
				title: 'Sommerlager',
				...period,
				lines: [{ kind: 'tent', tentId: jurte.id, quantity: 2 }]
			}),
			201
		);
		expect(lager.lines).toHaveLength(1);
		expect(lager.lines[0]).toMatchObject({ kind: 'tent', name: 'Jurte', quantity: 2 });
		const dach = part(lager, 'Dach');
		expect(dach).toMatchObject({ quantity: 12, slotSize: 6, missing: 0, mixedSlots: 0 });
		expect([...setsOf(dach, 0), ...setsOf(dach, 1)].sort()).toEqual(['KJ1', 'KJ2']);
		expect(assigned(part(lager, 'Wand'))).toEqual(['L1', 'L2', 'L3', 'L4']);
		expect(parts(lager).find((p) => p.kind === 'item')).toMatchObject({ quantity: 2 });
		expect(lager.notices).toEqual([]);
		expect(lager.canHandOut).toBe(false);
	});

	it('gezielte Reservierung einer zugeteilten Bahn plant das Lager um', async () => {
		await data(
			await post('/reservations', 'andere', {
				title: 'Tagesaktion',
				startsOn: '2026-07-03',
				endsOn: '2026-07-03',
				lines: [{ kind: 'item', itemId: kj1[2]!.id, quantity: 1 }]
			}),
			201
		);
		lager = await data<Reservation>(await get(`/reservations/${lager.id}`, 'leitung'));
		const dach = part(lager, 'Dach');
		const all = [...dach.assignments, ...part(lager, 'Wand').assignments].map((a) => a.name);
		expect(all).not.toContain('KJ1.3');
		expect(all).toHaveLength(16);
		// KJ2 bleibt ein Dach, das andere Dach ist gemischt
		expect(dach.mixedSlots).toBe(1);
		expect(lager.notices).toEqual([
			'Jurte: 1 von 2 aus Teilen verschiedener Sets zusammengestellt'
		]);
	});

	it('Zelt löschen nur ohne Reservierungen, Seil im Zelt nicht löschbar', async () => {
		await fail(await del(`/tents/${jurte.id}`, 'admin'), 409);
		await fail(await del(`/items/${seil.id}`, 'admin'), 409);
		await fail(await del(`/types/${bahn.id}`, 'admin'), 409);
	});
});

describe('Ausgabe und Zuteilung von Hand', () => {
	it('Ausgabe nur mit Verwaltungsrecht, danach gesperrt', async () => {
		await fail(await post(`/reservations/${lager.id}/hand-out`, 'leitung'), 403);
		lager = await data<Reservation>(await post(`/reservations/${lager.id}/hand-out`, 'admin'), 201);
		expect(lager.handedOutAt).not.toBeNull();
		expect(lager.handedOutByName).toBeTruthy();
		expect(lager.canEdit).toBe(false);
		await fail(
			await patch(`/reservations/${lager.id}`, 'leitung', {
				title: 'Sommerlager',
				...period,
				lines: [{ kind: 'tent', tentId: jurte.id, quantity: 1 }]
			}),
			409
		);
		await fail(await post(`/reservations/${lager.id}/cancel`, 'leitung'), 409);
		// Ausgegebene Bahnen sind fest: gezielt reservieren geht nicht mehr
		const taken = part(lager, 'Dach').assignments[0]!;
		const err = await fail(
			await post('/reservations', 'andere', {
				title: 'Zu spät',
				startsOn: '2026-07-02',
				endsOn: '2026-07-02',
				lines: [{ kind: 'item', itemId: taken.itemId, quantity: 1 }]
			}),
			409
		);
		expect(err.code).toBe('conflict');
		const audit = await listAudit({ action: 'material.reservation.handed-out' });
		expect(audit.rows.map((a) => a.target)).toContain(lager.id);
	});

	it('Ausgabe zurücknehmen, Bahnen von Hand anheften, neu zuteilen', async () => {
		lager = await data<Reservation>(await del(`/reservations/${lager.id}/hand-out`, 'admin'));
		expect(lager.handedOutAt).toBeNull();
		const wand = part(lager, 'Wand');
		await fail(
			await put(`/reservations/${lager.id}/lines/${wand.id}/assignment`, 'leitung', {
				items: []
			}),
			403
		);
		await fail(
			await put(`/reservations/${lager.id}/lines/${wand.id}/assignment`, 'admin', {
				items: [{ itemId: seil.id, quantity: 1 }]
			}),
			422
		);
		// Eine Bahn des eigenen Dachs geht nicht (schon in dieser Reservierung)
		const ownRoof = part(lager, 'Dach').assignments[0]!;
		await fail(
			await put(`/reservations/${lager.id}/lines/${wand.id}/assignment`, 'admin', {
				items: [{ itemId: ownRoof.itemId, quantity: 1 }]
			}),
			409
		);
		// 18 Bahnen, KJ1.3 am 03.07. vergeben, 16 im Lager → genau eine frei
		const used = new Set([
			...part(lager, 'Dach').assignments.map((a) => a.itemId),
			...wand.assignments.map((a) => a.itemId),
			kj1[2]!.id
		]);
		const spare = [...kj1, ...kj2, ...lose].find((i) => !used.has(i.id))!;
		lager = await data<Reservation>(
			await put(`/reservations/${lager.id}/lines/${wand.id}/assignment`, 'admin', {
				items: [{ itemId: spare.id, quantity: 1 }]
			})
		);
		const pinned = part(lager, 'Wand').assignments.filter((a) => a.pinned);
		expect(pinned.map((a) => a.name)).toEqual([spare.name]);
		// Den Rest der Wand teilt das System zu
		expect(part(lager, 'Wand').assignments).toHaveLength(4);
		expect(part(lager, 'Wand').missing).toBe(0);

		lager = await data<Reservation>(await post(`/reservations/${lager.id}/reassign`, 'admin'), 201);
		expect(part(lager, 'Wand').assignments.some((a) => a.pinned)).toBe(false);
	});

	it('defekte Bahn wird ersetzt, der Job hält die Zuteilung aktuell', async () => {
		const victim = part(lager, 'Dach').assignments.find((a) => a.setName === 'KJ2')!;
		await data(
			await post(`/items/${victim.itemId}/condition`, 'leitung', { condition: 'defect' }),
			201
		);
		lager = await data<Reservation>(await get(`/reservations/${lager.id}`, 'leitung'));
		const names = [...part(lager, 'Dach').assignments, ...part(lager, 'Wand').assignments].map(
			(a) => a.itemId
		);
		expect(names).not.toContain(victim.itemId);
		expect(part(lager, 'Dach').missing + part(lager, 'Wand').missing).toBe(0);
		const job = await runJobNow(admin, 'material.assign-refresh');
		expect(job.lastStatus).toBe('ok');
	});

	it('Set auflösen lässt die Artikel im Lager', async () => {
		await data(await del(`/sets/${setKj1.id}`, 'admin'));
		const inv = await data<Inventory>(await get('/inventory', 'leitung'));
		const items = inv.types.find((t) => t.id === bahn.id)!.items;
		expect(items.filter((i) => i.name.startsWith('KJ1')).every((i) => i.setId === null)).toBe(true);
		expect(items).toHaveLength(18);
	});

	it('Stornieren gibt die Bahnen frei, Zelt danach archivierbar', async () => {
		await data(await post(`/reservations/${lager.id}/cancel`, 'leitung'), 201);
		const cat = await data<Catalog>(await get('/catalog?from=2026-07-01&to=2026-07-05', 'leitung'));
		// 17 nutzbare Bahnen, KJ1.3 am 03.07. belegt → 16 → 2 Jurten
		expect(cat.entries.find((e) => e.kind === 'tent')!.free).toBe(2);
		const archived = await data<Tent>(
			await patch(`/tents/${jurte.id}`, 'admin', { archived: true })
		);
		expect(archived.archived).toBe(true);
		const after = await data<Catalog>(
			await get('/catalog?from=2026-07-01&to=2026-07-05', 'leitung')
		);
		expect(after.entries.some((e) => e.kind === 'tent')).toBe(false);
	});
});
