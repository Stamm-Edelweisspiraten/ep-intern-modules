/**
 * Datenauskunft (#30): Beiträge der Module `events`, `files` und `orders` zum Export
 * (`ModuleDefinition.subjectExport`). Daten werden direkt per SQL angelegt; geprüft wird, dass
 * alles mit Bezug zur Person (Konto und/oder verknüpfte Mitglieder) enthalten ist, Daten Dritter
 * fehlen und keine Geheimnisse (Token, Hashes, Chiffrate, Speicherpfade) im Export stehen.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { exportSubject } from '$testing';
import { resetAllForTests } from '$testing';
import membersModule from '$modules/members/module';
import eventsModule from '$modules/events/module';
import filesModule from '$modules/files/module';
import ordersModule from '$modules/orders/module';
import type { RequestContext } from '$lib/sdk/types';

let admin: RequestContext;
let adminKey: string;
let parentId: string;
let otherId: string;
let childId: string;
let strangerMemberId: string;

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const db = () => getDb();

async function createMember(firstName: string): Promise<string> {
	const url = new URL('http://localhost:5173/api/v1/modules/members/members');
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				firstName,
				lastName: 'Muster',
				scoutName: null,
				birthDate: '2012-05-17',
				street: 'Musterweg 1',
				postalCode: '12345',
				city: 'Musterstadt',
				country: 'DE',
				phones: [],
				emails: [],
				stage: 'pfadfinder',
				groupIds: [],
				consentSocialMedia: false,
				consentWebsite: false,
				consentPrint: false
			})
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.data.id as string;
}

beforeAll(async () => {
	await useTestDatabase();
	resetAllForTests();
	registerCoreApi();
	registerModule(membersModule);
	registerModule(eventsModule);
	registerModule(filesModule);
	registerModule(ordersModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await db()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['members', 'events', 'files', 'orders']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	adminKey = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...admin.permissions].filter((p) => !p.startsWith('core.system'))
		})
	).key;
	parentId = await createUser(admin, {
		name: 'Eltern Test',
		email: 'eltern@example.test',
		password: 'a-long-enough-pw',
		roleIds: []
	});
	otherId = await createUser(admin, {
		name: 'Andere Person',
		email: 'andere@example.test',
		password: 'a-long-enough-pw',
		roleIds: []
	});
	childId = await createMember('Kira');
	strangerMemberId = await createMember('Fremd');
	await db().execute(
		sql`INSERT INTO mod_members.member_user_links (member_id, user_id) VALUES (${childId}, ${parentId})`
	);

	// --- Termine ---
	await db()
		.execute(sql`INSERT INTO mod_events.events (id, title, description, starts_on, owner_id, created_by)
		VALUES ('ev-own', 'Elternabend', 'Eigener Termin', '2026-11-01', ${parentId}, ${parentId}),
			('ev-shared', 'Sommerlager', NULL, '2026-07-01', ${otherId}, ${otherId}),
			('ev-child', 'Kinderfest', NULL, '2026-08-01', ${otherId}, ${otherId}),
			('ev-foreign', 'Fremder Termin', 'geheim', '2026-09-01', ${otherId}, ${otherId})`);
	await db().execute(
		sql`INSERT INTO mod_events.event_tags (event_id, tag, position) VALUES ('ev-own', 'Eltern', 0)`
	);
	await db()
		.execute(sql`INSERT INTO mod_events.event_shares (event_id, principal_type, principal_id, level)
		VALUES ('ev-shared', 'user', ${parentId}, 'read'),
			('ev-child', 'member', ${childId}, 'read'),
			('ev-foreign', 'user', ${otherId}, 'edit')`);

	// --- Dateien ---
	await db().execute(sql`INSERT INTO mod_files.nodes (id, kind, space, owner_id, name, storage_path,
			content_type, size_bytes, thumb_path, created_by)
		VALUES ('n-folder', 'folder', 'personal', ${parentId}, 'Meine Ablage', NULL, NULL, NULL, NULL, ${parentId}),
			('n-foreign', 'folder', 'personal', ${otherId}, 'Fremder Ordner', NULL, NULL, NULL, NULL, ${otherId})`);
	await db()
		.execute(sql`INSERT INTO mod_files.nodes (id, parent_id, kind, space, owner_id, name, storage_path,
			content_type, size_bytes, thumb_path, created_by)
		VALUES ('n-file', 'n-folder', 'file', 'personal', ${parentId}, 'Brief.pdf', 'secret/storage/path.pdf',
				'application/pdf', 1234, 'secret/thumb.webp', ${parentId}),
			('n-upload', 'n-foreign', 'file', 'personal', ${otherId}, 'Beitrag.jpg', 'x/y.jpg',
				'image/jpeg', 99, NULL, ${parentId}),
			('n-other', 'n-foreign', 'file', 'personal', ${otherId}, 'Privat.txt', 'x/z.txt',
				'text/plain', 5, NULL, ${otherId})`);
	await db()
		.execute(sql`INSERT INTO mod_files.node_shares (node_id, principal_type, principal_id, level)
		VALUES ('n-foreign', 'member', ${childId}, 'read')`);
	await db().execute(sql`INSERT INTO mod_files.share_links (id, node_id, token_hash, password_hash,
			token_enc, mode, created_by, access_count)
		VALUES ('l-1', 'n-folder', 'HASH-SECRET', 'PW-HASH-SECRET', 'ENC-SECRET', 'view-upload', ${parentId}, 3)`);

	// --- Bestellungen ---
	await db().execute(sql`INSERT INTO mod_orders.articles (id, title) VALUES ('a-1', 'Halstuch')`);
	await db()
		.execute(sql`INSERT INTO mod_orders.article_variants (id, article_id, label, price_cents, stock)
		VALUES ('v-1', 'a-1', 'M', 1200, 5)`);
	await db()
		.execute(sql`INSERT INTO mod_orders.orders (id, number, year, seq, member_id, member_name, ordered_by, note)
		VALUES ('o-child', 'B-2026-0001', 2026, 1, ${childId}, 'Kira Muster', ${parentId}, 'Bitte bald'),
			('o-stranger', 'B-2026-0002', 2026, 2, ${strangerMemberId}, 'Fremd Muster', ${parentId}, 'Daten Dritter'),
			('o-foreign', 'B-2026-0003', 2026, 3, ${strangerMemberId}, 'Fremd Muster', ${otherId}, NULL)`);
	await db()
		.execute(sql`INSERT INTO mod_orders.order_items (id, order_id, variant_id, article_title,
			variant_label, unit_price_cents, quantity, delivered_qty)
		VALUES ('i-1', 'o-child', 'v-1', 'Halstuch', 'M', 1200, 2, 1),
			('i-2', 'o-stranger', 'v-1', 'Halstuch', 'M', 1200, 1, 0)`);
	await db()
		.execute(sql`INSERT INTO mod_orders.stock_movements (id, variant_id, delta, kind, order_item_id)
		VALUES ('m-1', 'v-1', -1, 'handout', 'i-1')`);
});

describe('Datenauskunft: events, files, orders', () => {
	it('Konto: liefert eigene und freigegebene Daten aller drei Module, ohne Geheimnisse', async () => {
		const out = await exportSubject(admin, { userId: parentId });
		expect(out.errors).toEqual([]);
		expect(out.subject.memberIds).toEqual([childId]);

		const events = out.modules.events!.data as {
			events: { id: string; tags: string[]; isOwner: boolean }[];
			sharesToPerson: { eventId: string; principal: string }[];
		};
		expect(events.events.map((e) => e.id)).toEqual(['ev-own']);
		expect(events.events[0]!.tags).toEqual(['Eltern']);
		expect(events.events[0]!.isOwner).toBe(true);
		expect(events.sharesToPerson.map((s) => s.eventId).sort()).toEqual(['ev-child', 'ev-shared']);

		const files = out.modules.files!.data as {
			ownNodes: { id: string }[];
			uploadsToOtherFolders: { id: string }[];
			sharesToPerson: { nodeId: string; principal: string }[];
			publicLinks: { id: string; hasPassword: boolean; mode: string; accessCount: number }[];
		};
		expect(files.ownNodes.map((n) => n.id).sort()).toEqual(['n-file', 'n-folder']);
		expect(files.uploadsToOtherFolders.map((n) => n.id)).toEqual(['n-upload']);
		expect(files.sharesToPerson).toEqual([
			expect.objectContaining({ nodeId: 'n-foreign', principal: `member:${childId}` })
		]);
		expect(files.publicLinks).toEqual([
			expect.objectContaining({ id: 'l-1', hasPassword: true, mode: 'view-upload', accessCount: 3 })
		]);

		const orders = out.modules.orders!.data as {
			orders: {
				number: string;
				orderedBySelf: boolean;
				items: { quantity: number; handouts: { kind: string; quantity: number }[] }[];
			}[];
			ordersPlacedForOthers: Record<string, unknown>[];
		};
		expect(orders.orders.map((o) => o.number)).toEqual(['B-2026-0001']);
		expect(orders.orders[0]!.orderedBySelf).toBe(true);
		expect(orders.orders[0]!.items[0]!.handouts).toEqual([
			expect.objectContaining({ kind: 'handout', quantity: 1 })
		]);
		// Für Fremde aufgegeben: nur Nummer/Datum, kein Name/Notiz Dritter
		expect(orders.ordersPlacedForOthers).toEqual([
			expect.objectContaining({ number: 'B-2026-0002' })
		]);
		expect(Object.keys(orders.ordersPlacedForOthers[0]!).sort()).toEqual([
			'cancelledAt',
			'createdAt',
			'number'
		]);

		const json = JSON.stringify(out.modules);
		for (const secret of [
			'HASH-SECRET',
			'PW-HASH-SECRET',
			'ENC-SECRET',
			'secret/storage',
			'secret/thumb',
			'Fremder Termin',
			'Privat.txt',
			'Daten Dritter',
			'B-2026-0003'
		]) {
			expect(json).not.toContain(secret);
		}
	});

	it('Mitglied ohne Konto: Freigaben und Bestellungen des Mitglieds', async () => {
		const out = await exportSubject(admin, { memberId: childId });
		expect(out.errors).toEqual([]);
		const events = out.modules.events!.data as { events: unknown[]; sharesToPerson: unknown[] };
		expect(events.events).toEqual([]);
		expect(events.sharesToPerson).toHaveLength(1);
		const orders = out.modules.orders!.data as {
			orders: { number: string; orderedBySelf: boolean }[];
		};
		expect(orders.orders.map((o) => o.number)).toEqual(['B-2026-0001']);
		expect(orders.orders[0]!.orderedBySelf).toBe(false);
	});

	it('ohne Daten bzw. bei deaktiviertem Modul fehlt der Modulbeitrag', async () => {
		const none = await exportSubject(admin, { userId: admin.userId! });
		expect(none.modules.events).toBeUndefined();
		expect(none.modules.files).toBeUndefined();
		expect(none.modules.orders).toBeUndefined();

		await disableModule(admin, 'events');
		const out = await exportSubject(admin, { userId: parentId });
		expect(out.modules.events).toBeUndefined();
		expect(out.modules.files).toBeTruthy();
		await enableModule(admin, 'events');
	});
});
