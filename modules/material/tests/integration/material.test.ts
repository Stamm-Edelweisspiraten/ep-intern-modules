import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { runJobNow } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import materialModule from '$modules/material/module';
import type {
	Catalog,
	Category,
	CodeTarget,
	Inventory,
	Item,
	ItemDetail,
	LabelTemplate,
	LineAvailability,
	Location,
	MaterialType,
	Overview,
	Reservation,
	ReservationListItem,
	ReservationPage
} from '$modules/material/schemas';
import type { RequestContext } from '$lib/sdk/types';

// Modul „Material“ v2: Kategorien (Icon/Farbe), Lagerorte, Typen und Lagerartikel, Reservierungen nach Typ
// und Artikel mit Verfügbarkeit, Zweck, Rechte, Zustand melden, Codes, Exporte, Etiketten, Modul aus.

const PW = 'material-password-123';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
let lastPdfHtml = '';

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

let zelte: Category;
let kiste1: Location;
let keller: Location;
let kohtenbahn: MaterialType;
let bahnen: Item[] = [];
let tampen: Item;
let ersteReservierung: Reservation;

const period = { startsOn: '2026-07-01', endsOn: '2026-07-05' };

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
	await mkUser('nurlesen', ['core.api.manage', 'material.inventory.view']);
	setPdfRendererForTests(async (html) => {
		lastPdfHtml = html;
		return new TextEncoder().encode('%PDF-1.7 test');
	});
	setTodayForTests('2026-06-01');
});

afterAll(async () => {
	setPdfRendererForTests(undefined);
	setTodayForTests(null);
	await close();
});

describe('Lager', () => {
	it('Kategorien mit Icon und Farbe, unbekanntes Icon → 422', async () => {
		zelte = await data<Category>(
			await post('/categories', 'admin', { name: 'Zelte', icon: 'tent', color: '#16A34A' }),
			201
		);
		expect(zelte).toMatchObject({ name: 'Zelte', icon: 'tent', color: '#16a34a', count: 0 });
		const err = await fail(
			await post('/categories', 'admin', { name: 'X', icon: 'gibt-es-nicht-xyz' }),
			422
		);
		expect(err.code).toBe('validation_failed');
		await fail(await post('/categories', 'nurlesen', { name: 'Y' }), 403);
	});

	it('Lagerorte flach mit Code, Reihenfolge', async () => {
		kiste1 = await data<Location>(await post('/locations', 'admin', { name: 'Kiste 1' }), 201);
		keller = await data<Location>(await post('/locations', 'admin', { name: 'Keller' }), 201);
		expect(kiste1.code).toMatch(/^L-\d{6}$/);
		const list = await data<Location[]>(
			await M('/locations/order', 'admin', { method: 'PUT', json: { ids: [keller.id, kiste1.id] } })
		);
		expect(list.map((l) => l.name)).toEqual(['Keller', 'Kiste 1']);
	});

	it('Typ und mehrere nummerierte Artikel, Artikel ohne Typ mit Anzahl', async () => {
		kohtenbahn = await data<MaterialType>(
			await post('/types', 'admin', { name: 'Kohtenbahn', categoryId: zelte.id }),
			201
		);
		bahnen = await data<Item[]>(
			await post('/items', 'admin', {
				typeId: kohtenbahn.id,
				name: 'K1.',
				count: 3,
				locationId: keller.id,
				// mit Typ wird eine eigene Kategorie ignoriert
				categoryId: zelte.id
			}),
			201
		);
		expect(bahnen.map((b) => b.name)).toEqual(['K1.1', 'K1.2', 'K1.3']);
		expect(new Set(bahnen.map((b) => b.code)).size).toBe(3);
		expect(bahnen[0]).toMatchObject({
			typeName: 'Kohtenbahn',
			locationName: 'Keller',
			category: { name: 'Zelte' }
		});
		tampen = (
			await data<Item[]>(
				await post('/items', 'admin', { name: 'Tampen', quantity: 21, locationId: kiste1.id }),
				201
			)
		)[0]!;
		expect(tampen.quantity).toBe(21);
		// eigener Code nur einzeln, doppelt → 422
		await fail(await post('/items', 'admin', { name: 'X', code: 'kk-1', count: 2 }), 422);
		await data(await post('/items', 'admin', { name: 'Kochkiste', code: 'kk-1' }), 201);
		await fail(await post('/items', 'admin', { name: 'Kochkiste 2', code: 'KK-1' }), 422);
		await fail(await post('/items', 'admin', { name: 'X', typeId: zelte.id }), 422);
	});

	it('Lagertabelle gruppiert nach Typ und filtert', async () => {
		const inv = await data<Inventory>(await get('/inventory', 'nurlesen'));
		expect(inv.types).toHaveLength(1);
		expect(inv.types[0]!).toMatchObject({
			name: 'Kohtenbahn',
			totalQuantity: 3,
			usableQuantity: 3
		});
		expect(inv.types[0]!.items).toHaveLength(3);
		expect(inv.items.map((i) => i.name).sort()).toEqual(['Kochkiste', 'Tampen']);
		const inKiste = await data<Inventory>(
			await get(`/inventory?locationId=${kiste1.id}`, 'nurlesen')
		);
		expect(inKiste.types).toHaveLength(0);
		expect(inKiste.items.map((i) => i.name)).toEqual(['Tampen']);
		const search = await data<Inventory>(await get('/inventory?search=K1.2', 'nurlesen'));
		expect(search.types[0]!.items.map((i) => i.name)).toEqual(['K1.2']);
	});

	it('Umlagern und Codes auflösen (Code, Scan-URL, Ort)', async () => {
		await data(
			await post('/items/move', 'admin', { itemIds: [bahnen[2]!.id], locationId: kiste1.id }),
			201
		);
		const code = bahnen[2]!.code;
		const t = await data<CodeTarget>(await get(`/codes/${code.toLowerCase()}`, 'nurlesen'));
		expect(t).toMatchObject({ type: 'item', id: bahnen[2]!.id });
		const url = encodeURIComponent(
			`https://intern.example.org/modules/material/scan/${kiste1.code}`
		);
		expect(await data<CodeTarget>(await get(`/codes/${url}`, 'nurlesen'))).toMatchObject({
			type: 'location',
			id: kiste1.id
		});
		await fail(await get('/codes/M-999999', 'nurlesen'), 404);
		const detail = await data<ItemDetail>(await get(`/items/${bahnen[2]!.id}`, 'nurlesen'));
		expect(detail.locationName).toBe('Kiste 1');
	});
});

describe('Reservieren', () => {
	it('Katalog: Typen und Artikel ohne Typ mit freier Anzahl', async () => {
		const cat = await data<Catalog>(await get('/catalog?from=2026-07-01&to=2026-07-05', 'leitung'));
		const bahn = cat.entries.find((e) => e.kind === 'type')!;
		expect(bahn).toMatchObject({ name: 'Kohtenbahn', total: 3, free: 3 });
		expect(bahn.items).toHaveLength(3);
		expect(cat.entries.find((e) => e.name === 'Tampen')).toMatchObject({ kind: 'item', free: 21 });
		await fail(await get('/catalog?from=2026-07-05&to=2026-07-01', 'leitung'), 422);
	});

	it('nach Typ und konkretem Artikel; Überbuchung → 409 mit Zeilen', async () => {
		ersteReservierung = await data<Reservation>(
			await post('/reservations', 'leitung', {
				title: 'Sommerlager',
				...period,
				lines: [
					{ kind: 'type', typeId: kohtenbahn.id, quantity: 2 },
					{ kind: 'item', itemId: bahnen[0]!.id, quantity: 1 },
					{ kind: 'item', itemId: tampen.id, quantity: 10 },
					{ kind: 'item', itemId: tampen.id, quantity: 5 }
				]
			}),
			201
		);
		expect(ersteReservierung.lines).toHaveLength(3);
		expect(ersteReservierung.lines.find((l) => l.itemId === tampen.id)!.quantity).toBe(15);
		expect(ersteReservierung).toMatchObject({ purpose: 'other', state: 'upcoming', canEdit: true });

		const err = await fail(
			await post('/reservations', 'andere', {
				title: 'Wochenende',
				startsOn: '2026-07-05',
				endsOn: '2026-07-06',
				lines: [
					{ kind: 'type', typeId: kohtenbahn.id, quantity: 1 },
					{ kind: 'item', itemId: tampen.id, quantity: 6 }
				]
			}),
			409
		);
		const lines = (err.details as { lines: LineAvailability[] }).lines;
		expect(lines.map((l) => [l.ok, l.available])).toEqual([
			[false, 0],
			[true, 6]
		]);
		// danach ist wieder alles frei
		await data(
			await post('/reservations', 'andere', {
				title: 'Später',
				startsOn: '2026-07-06',
				endsOn: '2026-07-06',
				lines: [{ kind: 'type', typeId: kohtenbahn.id, quantity: 3 }]
			}),
			201
		);
		const cat = await data<Catalog>(await get('/catalog?from=2026-07-01&to=2026-07-01', 'leitung'));
		expect(cat.entries.find((e) => e.name === 'Tampen')!.free).toBe(6);
	});

	it('Verfügbarkeit ohne Speichern, eigene Reservierung beim Bearbeiten ausgenommen', async () => {
		const res = await data<LineAvailability[]>(
			await post('/availability', 'leitung', {
				...period,
				excludeReservationId: ersteReservierung.id,
				lines: [{ kind: 'type', typeId: kohtenbahn.id, quantity: 3 }]
			}),
			201
		);
		expect(res[0]).toMatchObject({ ok: true, available: 3 });
	});

	it('Zweck: Gruppe ohne aktives Mitglieder-Modul → 422, Aktion ohne Pflichtfeld → 422', async () => {
		const base = {
			title: 'Gruppenstunde',
			...period,
			lines: [{ kind: 'item', itemId: tampen.id, quantity: 1 }]
		};
		const g = await fail(
			await post('/reservations', 'leitung', {
				...base,
				purpose: 'group',
				groupId: '00000000-0000-4000-8000-000000000001'
			}),
			422
		);
		expect(JSON.stringify(g.details)).toContain('groupId');
		await fail(await post('/reservations', 'leitung', { ...base, purpose: 'action' }), 422);
	});

	it('Rechte: nur lesen darf nicht reservieren; fremde Reservierungen nicht ändern; alle nur mit Verwaltung', async () => {
		await fail(
			await post('/reservations', 'nurlesen', {
				title: 'X',
				...period,
				lines: [{ kind: 'item', itemId: tampen.id, quantity: 1 }]
			}),
			403
		);
		const body = {
			title: 'Sommerlager (geändert)',
			...period,
			lines: [{ kind: 'type', typeId: kohtenbahn.id, quantity: 3 }]
		};
		await fail(await patch(`/reservations/${ersteReservierung.id}`, 'andere', body), 403);
		const changed = await data<Reservation>(
			await patch(`/reservations/${ersteReservierung.id}`, 'leitung', body)
		);
		expect(changed.title).toBe('Sommerlager (geändert)');
		expect(changed.lines).toHaveLength(1);
		await fail(await get('/reservations?scope=all', 'leitung'), 403);
		const all = await data<ReservationPage>(await get('/reservations?scope=all', 'admin'));
		expect(all.total).toBe(2);
		const mine = await data<ReservationPage>(await get('/reservations', 'leitung'));
		expect(mine.items.map((r) => r.title)).toEqual(['Sommerlager (geändert)']);
		expect(mine.items[0]!.itemSummary).toBe('3 × Kohtenbahn');
		const my = await data<ReservationListItem[]>(await get('/my/reservations', 'leitung'));
		expect(my).toHaveLength(1);
	});

	it('Stornieren gibt frei; Löschen nur storniert oder vergangen', async () => {
		await fail(await del(`/reservations/${ersteReservierung.id}`, 'leitung'), 409);
		const c = await data<Reservation>(
			await post(`/reservations/${ersteReservierung.id}/cancel`, 'leitung'),
			201
		);
		expect(c).toMatchObject({ status: 'cancelled', state: 'cancelled', canEdit: false });
		const cat = await data<Catalog>(await get('/catalog?from=2026-07-01&to=2026-07-06', 'leitung'));
		expect(cat.entries.find((e) => e.kind === 'type')!.free).toBe(0); // „Später“ (6.7.) belegt alle 3
		const first = await data<Catalog>(
			await get('/catalog?from=2026-07-01&to=2026-07-04', 'leitung')
		);
		expect(first.entries.find((e) => e.kind === 'type')!.free).toBe(3);
		await data(await del(`/reservations/${ersteReservierung.id}`, 'leitung'));
		await fail(await get(`/reservations/${ersteReservierung.id}`, 'leitung'), 404);
	});
});

describe('Zustand, Archiv, Löschen', () => {
	it('Schaden melden: auch mit Reservierungsrecht, defekt zählt nicht mehr', async () => {
		await fail(
			await post(`/items/${bahnen[1]!.id}/condition`, 'nurlesen', { condition: 'defect' }),
			403
		);
		const item = await data<Item>(
			await post(`/items/${bahnen[1]!.id}/condition`, 'leitung', {
				condition: 'defect',
				note: 'Riss in der Bahn'
			}),
			201
		);
		expect(item.condition).toBe('defect');
		const detail = await data<ItemDetail>(await get(`/items/${bahnen[1]!.id}`, 'admin'));
		expect(detail.conditionReportedByName).toBe('leitung');
		const cat = await data<Catalog>(await get('/catalog?from=2026-08-01&to=2026-08-02', 'leitung'));
		expect(cat.entries.find((e) => e.kind === 'type')).toMatchObject({ total: 2, free: 2 });
		const overview = await data<Overview>(await get('/overview', 'admin'));
		expect(overview.damagedCount).toBe(1);
	});

	it('Artikel mit Reservierungen nicht löschbar, Archivieren geht; Typ mit Artikeln nicht löschbar', async () => {
		await data(
			await post('/reservations', 'leitung', {
				title: 'Tampen',
				startsOn: '2026-09-01',
				endsOn: '2026-09-02',
				lines: [{ kind: 'item', itemId: tampen.id, quantity: 2 }]
			}),
			201
		);
		await fail(await del(`/items/${tampen.id}`, 'admin'), 409);
		await fail(await del(`/types/${kohtenbahn.id}`, 'admin'), 409);
		const archived = await data<Item>(
			await patch(`/items/${tampen.id}`, 'admin', { archived: true })
		);
		expect(archived.archived).toBe(true);
		const inv = await data<Inventory>(await get('/inventory', 'admin'));
		expect(inv.items.map((i) => i.name)).not.toContain('Tampen');
		const withArchived = await data<Inventory>(await get('/inventory?archived=1', 'admin'));
		expect(withArchived.items.map((i) => i.name)).toContain('Tampen');
		await data(await patch(`/items/${tampen.id}`, 'admin', { archived: false }));
	});

	it('Lagerort löschen: Artikel sind danach ohne Ort', async () => {
		const tmp = await data<Location>(await post('/locations', 'admin', { name: 'Tmp' }), 201);
		await data(
			await post('/items/move', 'admin', { itemIds: [tampen.id], locationId: tmp.id }),
			201
		);
		const res = await data<{ itemsWithoutPlace: number }>(
			await del(`/locations/${tmp.id}`, 'admin')
		);
		expect(res.itemsWithoutPlace).toBe(1);
		const ohne = await data<Inventory>(await get('/inventory?locationId=none', 'admin'));
		expect(ohne.items.map((i) => i.name)).toContain('Tampen');
	});
});

describe('Exporte und Etiketten', () => {
	it('Materialliste als CSV nach Kategorie und als PDF nach Lagerort', async () => {
		const csv = await post('/exports/inventory', 'nurlesen', {
			format: 'csv',
			groupBy: 'category'
		});
		expect(csv.status).toBe(200);
		expect(csv.headers.get('content-type')).toContain('text/csv');
		const text = await csv.text();
		expect(text).toContain('Zelte');
		expect(text).toContain('K1.1');
		expect(text).toContain('Ohne Kategorie');
		const pdf = await post('/exports/inventory', 'nurlesen', {
			format: 'pdf',
			groupBy: 'location'
		});
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toBe('application/pdf');
		expect(lastPdfHtml).toContain('Materialliste nach Lagerort');
		expect(lastPdfHtml).toContain('Keller');
	});

	it('Packliste und Übersicht der Reservierungen', async () => {
		const page = await data<ReservationPage>(await get('/reservations?scope=all', 'admin'));
		const r = page.items.find((x) => x.title === 'Später')!;
		const pdf = await get(`/reservations/${r.id}/packing-list?format=pdf`, 'leitung');
		expect(pdf.status).toBe(200);
		expect(lastPdfHtml).toContain('Packliste Später');
		// Typ-Zeilen stehen mit den zugeteilten Bahnen auf der Packliste; K1.2 ist inzwischen defekt,
		// die dritte Bahn fehlt deshalb und steht als „noch nicht zugeteilt“ darunter
		expect(lastPdfHtml).toContain('K1.1');
		expect(lastPdfHtml).toContain('K1.3');
		expect(lastPdfHtml).not.toContain('K1.2');
		expect(lastPdfHtml).toContain('Kohtenbahn (beliebige, noch nicht zugeteilt)');
		const csv = await get(`/reservations/${r.id}/packing-list?format=csv`, 'leitung');
		expect(await csv.text()).toContain('Keller');
		const all = await post('/exports/reservations', 'admin', {
			format: 'csv',
			from: '2026-06-01',
			to: '2026-12-31'
		});
		const text = await all.text();
		expect(text).toContain('Später');
		expect(text).toContain('Tampen');
		// ohne Verwaltungsrecht nur die eigenen
		const own = await post('/exports/reservations', 'leitung', {
			format: 'csv',
			from: '2026-06-01',
			to: '2026-12-31'
		});
		expect(await own.text()).not.toContain('Später');
	});

	it('Etikett für Artikel und Lagerort drucken', async () => {
		const tpl = await data<LabelTemplate>(
			await post('/label-templates', 'admin', {
				name: 'Standard',
				target: 'item',
				formatKey: 'avery-l7159',
				layout: {
					widthMm: 63.5,
					heightMm: 33.9,
					elements: [
						{
							id: 'n',
							type: 'text',
							x: 2,
							y: 2,
							w: 40,
							h: 8,
							text: '{type} {name} ({quantity})',
							fontSizePt: 10,
							bold: true,
							align: 'left',
							valign: 'top',
							maxLines: 1
						},
						{
							id: 'q',
							type: 'barcode',
							x: 42,
							y: 2,
							w: 20,
							h: 20,
							symbology: 'qrcode',
							value: '{url}'
						}
					]
				}
			}),
			201
		);
		const res = await post('/labels.pdf', 'admin', {
			templateId: tpl.id,
			target: 'item',
			ids: [bahnen[0]!.id, tampen.id]
		});
		expect(res.status).toBe(200);
		expect(lastPdfHtml).toContain('Kohtenbahn K1.1 (1)');
		expect(lastPdfHtml).toContain('Tampen (21)');
		await fail(
			await post('/labels.pdf', 'leitung', {
				templateId: tpl.id,
				target: 'item',
				ids: [tampen.id]
			}),
			403
		);
		const loc = await post('/labels.pdf', 'admin', {
			templateId: tpl.id,
			target: 'location',
			ids: [kiste1.id]
		});
		expect(loc.status).toBe(200);
		await fail(
			await post('/label-templates', 'admin', {
				name: 'Alt',
				target: 'unit',
				formatKey: 'avery-l7159',
				layout: tpl.layout
			}),
			422
		);
	});
});

describe('Audit, Job, Modul aus', () => {
	it('Audit ohne Personendaten', async () => {
		const audit = await listAudit({ action: 'material.reservation.created' });
		expect(audit.rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit.rows.map((r) => r.metadata))).not.toContain('Sommerlager');
	});

	it('Aufräum-Job läuft einmal und ist danach erledigt', async () => {
		const first = await runJobNow(admin, 'material.legacy-cleanup');
		expect(first.lastStatus).toBe('ok');
		const second = await runJobNow(admin, 'material.legacy-cleanup');
		expect(second.lastMessage).toBe('Nichts zu tun');
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'material');
		await fail(await get('/inventory', 'admin'), 404);
	});
});
