/**
 * Globale Suche – Quellen der Module `files`, `offices`, `orders`, `treasury`:
 * Treffer nur für Sichtbares (Freigaben, eigene Datensätze, Rechte), Papierkorb nie,
 * Kasse ohne Recht keine Treffer bzw. mit `own.view` nur eigene, deaktiviertes Modul → keine Treffer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { setMailTransportForTests } from '$testing';
import { resetAllForTests } from '$testing';
import { searchEverything } from '$testing';
import { core } from '$lib/sdk/server';
import actionsModule from '$modules/actions/module';
import filesModule from '$modules/files/module';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import ordersModule from '$modules/orders/module';
import treasuryModule from '$modules/treasury/module';
import { setTodayForTests } from '$lib/sdk/dates';
import type { FileNode } from '$modules/files/schemas';
import type { InvoiceDetail } from '$modules/treasury/schemas';
import type { RequestContext } from '$lib/sdk/types';
import type { SearchHit } from '$lib/sdk/types/search';

const PW = 'search-modules-b-password';
let close: () => Promise<void>;
let admin: RequestContext;
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
const memberIds: Record<string, string> = {};

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
const ctxFor = (name: string) => ctxOf(userIds[name]!);

function api(path: string, who: string, init: RequestInit & { json?: unknown } = {}) {
	resetAllForTests();
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set('authorization', `Bearer ${keys[who]}`);
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

async function data<R>(res: Response, status = 200): Promise<R> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as R;
}

async function mkUser(name: string, fullName: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	const id = await createUser(admin, {
		name: fullName,
		email: `${name}@example.test`,
		password: PW,
		roleIds: [role]
	});
	userIds[name] = id;
	const ctx = await ctxOf(id);
	keys[name] = (await createApiKey(ctx, { name: 'k', scopes: [...ctx.permissions] })).key;
}

async function mkMember(firstName: string, lastName: string) {
	const m = await data<{ id: string }>(
		await api('/modules/members/members', 'admin', {
			method: 'POST',
			json: {
				firstName,
				lastName,
				birthDate: '2014-03-12',
				street: 'Lindenweg 4',
				postalCode: '28195',
				city: 'Bremen',
				stage: 'woelfling',
				emails: [{ name: null, value: `${firstName.toLowerCase()}@familie.test` }]
			}
		}),
		201
	);
	memberIds[firstName] = m.id;
}

async function link(memberId: string, user: string) {
	await core.database.forModule('members').transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO member_user_links (member_id, user_id, relation) VALUES (${memberId}, ${userIds[user]!}, 'Mutter')`
		);
	});
}

async function folder(who: string, name: string, parentId: string | null = null) {
	return (
		await data<FileNode>(
			await api('/modules/files/folders', who, { method: 'POST', json: { parentId, name } }),
			201
		)
	).id;
}

async function upload(who: string, parentId: string, name: string): Promise<string> {
	const fd = new FormData();
	fd.set('file', new File([new TextEncoder().encode('Inhalt')], name, { type: 'text/plain' }));
	const encoded = new Response(fd);
	const bytes = new Uint8Array(await encoded.arrayBuffer());
	resetAllForTests();
	const url = new URL(`http://localhost:5173/api/v1/modules/files/nodes/${parentId}/upload`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${keys[who]}`,
				'content-type': encoded.headers.get('content-type')!,
				'content-length': String(bytes.byteLength)
			},
			body: bytes
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return (body.data.node ?? body.data).id as string;
}

async function hits(who: string | RequestContext, q: string, source: string): Promise<SearchHit[]> {
	const ctx = typeof who === 'string' ? await ctxFor(who) : who;
	const res = await searchEverything(ctx, q);
	return res.groups.find((g) => g.source === source)?.hits ?? [];
}

const ids: Record<string, string> = {};

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	for (const m of [
		membersModule,
		actionsModule,
		treasuryModule,
		officesModule,
		ordersModule,
		filesModule
	])
		registerModule(m);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	userIds.admin = u!.id;
	admin = await ctxOf(u!.id);
	for (const m of ['members', 'actions', 'treasury', 'offices', 'orders', 'files'])
		await enableModule(admin, m);
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	await installFakeStorage(admin);
	setMailTransportForTests({ sendMail: async () => undefined });
	setTodayForTests('2026-06-01');

	const base = ['core.api.manage', 'files.file.view', 'offices.office.view', 'orders.order.view'];
	await mkUser('owner', 'Olivia Owner', [...base, 'orders.order.create', 'treasury.own.view']);
	await mkUser('reader', 'Rita Reader', base);
	await mkUser('stranger', 'Sven Stranger', [...base, 'treasury.own.view']);
	await mkUser('kasse', 'Karl Kasse', ['core.api.manage', 'treasury.cash.view']);
	await mkUser('nobody', 'Nora Nobody', ['core.api.manage']);

	await mkMember('Kira', 'Muster');
	await mkMember('Otto', 'Zander');
	await link(memberIds.Kira!, 'owner');

	// --- Dateien ---
	ids.shared = await folder('owner', 'Sommerlager Fotos');
	ids.secret = await folder('owner', 'Sommerlager Geheim');
	ids.plan = await upload('owner', ids.shared, 'Sommerlager-Plan.txt');
	ids.list = await upload('owner', ids.secret, 'Sommerlager-Liste.txt');
	ids.old = await upload('owner', ids.shared, 'Sommerlager-alt.txt');
	ids.strangerFile = await upload('stranger', 'root', 'Sommerlager-privat.txt');
	await data(
		await api(`/modules/files/nodes/${ids.shared}/shares`, 'owner', {
			method: 'PUT',
			json: { shares: [{ type: 'user', id: userIds.reader, level: 'read' }] }
		})
	);
	await data(
		await api(`/modules/files/nodes/${ids.list}/shares`, 'owner', {
			method: 'PUT',
			json: { shares: [{ type: 'user', id: userIds.reader, level: 'read' }] }
		})
	);
	await data(
		await api('/modules/files/nodes/trash', 'owner', { method: 'POST', json: { ids: [ids.old] } }),
		201
	);

	// --- Ämter ---
	const office = await data<{ id: string }>(
		await api('/modules/offices/offices', 'admin', {
			method: 'POST',
			json: { name: 'Materialwart', description: 'Zelte und Kochgeschirr', emails: [], roleIds: [] }
		}),
		201
	);
	ids.office = office.id;
	await data(
		await api(`/modules/offices/offices/${office.id}/holders`, 'admin', {
			method: 'PUT',
			json: { holders: [{ userId: userIds.owner }] }
		})
	);

	// --- Bestellungen (direkt in der DB) ---
	await core.database.forModule('orders').transaction(async (tx) => {
		const a1 = crypto.randomUUID();
		const a2 = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO articles (id, title, active) VALUES (${a1}, 'Halstuch', true)`
		);
		await tx.execute(
			sql`INSERT INTO articles (id, title, active) VALUES (${a2}, 'Halstuch alt', false)`
		);
		const v1 = crypto.randomUUID();
		for (const [v, a, price] of [
			[v1, a1, 1200],
			[crypto.randomUUID(), a2, 900]
		] as const) {
			await tx.execute(
				sql`INSERT INTO article_variants (id, article_id, label, price_cents, position)
					VALUES (${v}, ${a}, '', ${price}, 0)`
			);
		}
		const orders: [string, string, string, string][] = [
			['B-2026-0001', memberIds.Kira!, 'Kira Muster', userIds.admin!],
			['B-2026-0002', memberIds.Otto!, 'Otto Zander', userIds.admin!]
		];
		for (const [i, [number, memberId, name, by]] of orders.entries()) {
			const id = crypto.randomUUID();
			await tx.execute(
				sql`INSERT INTO orders (id, number, year, seq, member_id, member_name, ordered_by)
					VALUES (${id}, ${number}, 2026, ${i + 1}, ${memberId}, ${name}, ${by})`
			);
			await tx.execute(
				sql`INSERT INTO order_items (id, order_id, variant_id, article_title, unit_price_cents, quantity)
					VALUES (${crypto.randomUUID()}, ${id}, ${v1}, 'Halstuch', 1200, 1)`
			);
		}
	});

	// --- Kasse ---
	for (const [recipient, member] of [
		['Familie Muster', 'Kira'],
		['Familie Zander', 'Otto']
	] as const) {
		await data<InvoiceDetail>(
			await api('/modules/treasury/invoices', 'admin', {
				method: 'POST',
				json: {
					recipientName: recipient,
					issuedOn: '2026-05-01',
					dueOn: '2026-06-15',
					lines: [{ description: 'Beitrag', amountCents: 123450, memberId: memberIds[member] }]
				}
			}),
			201
		);
	}
	await data(
		await api('/modules/treasury/payers', 'admin', {
			method: 'POST',
			json: { name: 'Familie Zander', memberIds: [memberIds.Otto] }
		}),
		201
	);
});

afterAll(async () => {
	setMailTransportForTests(undefined);
	setTodayForTests(null);
	uninstallFakeStorage();
	await close();
});

describe('files', () => {
	it('Eigentümer*in findet eigene Ordner und Dateien, nie den Papierkorb', async () => {
		const list = await hits('owner', 'sommerlager', 'files');
		const titles = list.map((h) => h.title);
		expect(titles).toEqual(
			expect.arrayContaining([
				'Sommerlager Fotos',
				'Sommerlager Geheim',
				'Sommerlager-Plan.txt',
				'Sommerlager-Liste.txt'
			])
		);
		expect(titles).not.toContain('Sommerlager-alt.txt');
		expect(titles).not.toContain('Sommerlager-privat.txt');
		const folderHit = list.find((h) => h.title === 'Sommerlager Fotos')!;
		expect(folderHit).toMatchObject({
			type: 'Ordner',
			href: `/modules/files?folder=${ids.shared}`
		});
		const fileHit = list.find((h) => h.title === 'Sommerlager-Plan.txt')!;
		expect(fileHit.type).toBe('Datei');
		expect(fileHit.href).toBe(`/modules/files?folder=${ids.shared}`);
		expect(fileHit.subtitle).toContain('Dateien / Sommerlager Fotos');
	});

	it('Freigabe: nur Freigegebenes; Datei ohne sichtbaren Ordner verlinkt auf die Wurzel', async () => {
		const list = await hits('reader', 'sommerlager', 'files');
		const titles = list.map((h) => h.title).sort();
		expect(titles).toEqual(['Sommerlager Fotos', 'Sommerlager-Liste.txt', 'Sommerlager-Plan.txt']);
		expect(list.find((h) => h.title === 'Sommerlager-Plan.txt')!.href).toBe(
			`/modules/files?folder=${ids.shared}`
		);
		const lone = list.find((h) => h.title === 'Sommerlager-Liste.txt')!;
		expect(lone.href).toBe('/modules/files');
		expect(lone.subtitle).not.toContain('Geheim');
	});

	it('fremde, nicht freigegebene Datei taucht nicht auf', async () => {
		const list = await hits('stranger', 'sommerlager', 'files');
		expect(list.map((h) => h.title)).toEqual(['Sommerlager-privat.txt']);
		expect(await hits('nobody', 'sommerlager', 'files')).toEqual([]);
	});
});

describe('offices', () => {
	it('findet Ämter nach Name, Beschreibung und Inhaber*in', async () => {
		const byName = await hits('reader', 'materialw', 'offices');
		expect(byName).toEqual([
			expect.objectContaining({
				id: ids.office,
				title: 'Materialwart',
				subtitle: 'Olivia Owner',
				href: '/modules/offices',
				type: 'Amt'
			})
		]);
		expect((await hits('reader', 'kochgeschirr', 'offices')).map((h) => h.id)).toEqual([
			ids.office
		]);
		expect((await hits('reader', 'Olivia', 'offices')).map((h) => h.id)).toEqual([ids.office]);
	});

	it('ohne Recht keine Treffer', async () => {
		expect(await hits('nobody', 'Materialwart', 'offices')).toEqual([]);
		expect(await hits('kasse', 'Materialwart', 'offices')).toEqual([]);
	});
});

describe('orders', () => {
	it('Katalog: aktive Artikel, Link auf die Katalog-Suche', async () => {
		const list = await hits('owner', 'halstuch', 'orders');
		const articles = list.filter((h) => h.type === 'Artikel');
		expect(articles.map((h) => h.title)).toEqual(['Halstuch']);
		expect(articles[0]!.href).toBe('/modules/orders?q=Halstuch');
		expect(articles[0]!.subtitle).toContain('12,00');
	});

	it('Artikelverwaltung sieht auch inaktive Artikel', async () => {
		const list = (await hits(admin, 'halstuch', 'orders')).filter((h) => h.type === 'Artikel');
		expect(list.map((h) => h.title).sort()).toEqual(['Halstuch', 'Halstuch alt']);
		expect(list.every((h) => h.href === '/modules/orders?tab=artikel')).toBe(true);
	});

	it('Bestellungen: eigene (verknüpftes Mitglied) ja, fremde ohne manage nein', async () => {
		const own = (await hits('owner', 'B-2026', 'orders')).filter((h) => h.type === 'Bestellung');
		expect(own.map((h) => h.title)).toEqual(['B-2026-0001']);
		expect(own[0]!.href).toBe('/modules/orders?tab=meine');
		expect(await hits('owner', 'Zander', 'orders')).toEqual([]);
		expect(
			(await hits('reader', 'B-2026', 'orders')).filter((h) => h.type === 'Bestellung')
		).toEqual([]);
	});

	it('mit manage alle Bestellungen', async () => {
		const all = (await hits(admin, 'B-2026', 'orders')).filter((h) => h.type === 'Bestellung');
		expect(all.map((h) => h.title).sort()).toEqual(['B-2026-0001', 'B-2026-0002']);
		expect(all.every((h) => h.href === '/modules/orders?tab=bestellungen')).toBe(true);
		const byName = await hits(admin, 'Otto Zan', 'orders');
		expect(byName.map((h) => h.title)).toEqual(['B-2026-0002']);
	});
});

describe('treasury', () => {
	it('Kasse: Rechnungen nach Nummer, Empfänger*in und Mitgliedsname; Zahler', async () => {
		const byNumber = await hits('kasse', 'R-2026', 'treasury');
		expect(byNumber.filter((h) => h.type === 'Rechnung')).toHaveLength(2);
		const first = byNumber[0]!;
		expect(first.href).toMatch(/^\/modules\/treasury\/invoices\/[0-9a-f-]+$/);
		expect(first.subtitle).toContain('offen 1.234,50');
		expect(first.subtitle).toContain('fällig 15.06.2026');
		expect(first.subtitle).not.toContain('@');

		const byMember = await hits('kasse', 'Kira', 'treasury');
		expect(byMember.map((h) => h.subtitle)).toEqual([expect.stringContaining('Familie Muster')]);

		const zander = await hits('kasse', 'Zander', 'treasury');
		expect(zander.map((h) => h.type).sort()).toEqual(['Rechnung', 'Zahler']);
		const payer = zander.find((h) => h.type === 'Zahler')!;
		expect(payer.href).toMatch(/^\/modules\/treasury\?tab=income&view=families&payer=/);
		expect(payer.subtitle).toBe('1 Mitglied');
	});

	it('ohne Recht keine Treffer, mit own.view nur eigene', async () => {
		expect(await hits('nobody', 'R-2026', 'treasury')).toEqual([]);
		expect(await hits('reader', 'R-2026', 'treasury')).toEqual([]);
		const own = await hits('owner', 'R-2026', 'treasury');
		expect(own).toHaveLength(1);
		expect(own[0]).toMatchObject({ type: 'Rechnung', href: '/dashboard' });
		expect(own[0]!.subtitle).toContain('Kira Muster');
		expect(own[0]!.subtitle).not.toContain('Zander');
		expect(await hits('owner', 'Zander', 'treasury')).toEqual([]);
		expect(await hits('stranger', 'R-2026', 'treasury')).toEqual([]);
	});
});

describe('Modul deaktiviert', () => {
	it('liefert keine Treffer mehr', async () => {
		expect(await hits('owner', 'sommerlager', 'files')).not.toEqual([]);
		await disableModule(admin, 'files');
		expect(await hits('owner', 'sommerlager', 'files')).toEqual([]);
		await disableModule(admin, 'offices');
		expect(await hits('reader', 'Materialwart', 'offices')).toEqual([]);
	});
});
