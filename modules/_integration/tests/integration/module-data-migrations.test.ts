/**
 * #64: Upgrade-Tests für datenverändernde Modul-Migrationen mit Bestandsdaten (Muster:
 * `files-migration.test.ts`): Migrationen bis N−1 → Altdaten → Migration N → Ergebnis prüfen.
 * - members 0004: Freitext-Adresse wird zur Straße, Land `DE`, `address` danach optional
 * - treasury 0002: ältestes nicht archiviertes Konto wird Standardkonto (genau eines)
 * - galleries 0002: Termin-Zuordnungen der Bilder wandern auf die Galerie (ohne Duplikate)
 * Die Zwischenabrechnungen (actions 0011/0016, `legacySnapshot`) prüft `actions-migrations.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { migrateModuleRest, migrateModuleTo, moduleSql } from '$testing';
import { registerModule } from '$testing';
import { splitSqlStatements } from '$testing';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import treasuryModule from '$modules/treasury/module';
import galleriesModule from '$modules/galleries/module';
import treasury0002 from '$modules/treasury/migrations/0002_extensions.sql?raw';

let close: () => Promise<void>;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerModule(membersModule);
	registerModule(actionsModule);
	registerModule(treasuryModule);
	registerModule(galleriesModule);
});

afterAll(async () => {
	await close();
});

describe('members 0004_address_fields', () => {
	it('übernimmt die Freitext-Adresse als Straße und macht `address` optional', async () => {
		await migrateModuleTo('members', '0003_user_links');
		await moduleSql(
			'members',
			sql`INSERT INTO members (id, first_name, last_name, birth_date, address, stage) VALUES
				('m1', 'Ada', 'Alt', '2014-03-01', 'Hauptstraße 1, 28195 Bremen', 'woelfling'),
				('m2', 'Bo', 'Bestand', '2012-07-15', '', 'knappe')`
		);
		expect(await migrateModuleTo('members', '0004_address_fields')).toEqual([
			'0004_address_fields'
		]);
		const rows = await moduleSql(
			'members',
			sql`SELECT id, address, street, postal_code, city, country FROM members ORDER BY id`
		);
		expect(rows).toEqual([
			{
				id: 'm1',
				address: 'Hauptstraße 1, 28195 Bremen',
				street: 'Hauptstraße 1, 28195 Bremen',
				postal_code: null,
				city: null,
				country: 'DE'
			},
			{ id: 'm2', address: '', street: '', postal_code: null, city: null, country: 'DE' }
		]);
		// Neue Mitglieder brauchen keine Freitext-Adresse mehr
		await moduleSql(
			'members',
			sql`INSERT INTO members (id, first_name, last_name, birth_date, stage, street, city)
				VALUES ('m3', 'Cleo', 'Neu', '2015-01-01', 'woelfling', 'Weg 2', 'Bremen')`
		);
		// Folgemigrationen laufen auf den umgeschriebenen Daten durch
		await migrateModuleRest('members');
		const [m1] = await moduleSql(
			'members',
			sql`SELECT street, country FROM members WHERE id = 'm1'`
		);
		expect(m1).toEqual({ street: 'Hauptstraße 1, 28195 Bremen', country: 'DE' });
	});
});

describe('treasury 0002_extensions', () => {
	it('macht das älteste nicht archivierte Konto zum Standardkonto', async () => {
		await migrateModuleTo('treasury', '0001_init');
		await moduleSql(
			'treasury',
			sql`INSERT INTO accounts (id, name, kind, opening_date, archived_at, created_at) VALUES
				('a-archiv', 'Altes Konto', 'giro', '2020-01-01', '2024-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
				('a-giro', 'Girokonto', 'giro', '2021-01-01', NULL, '2021-01-01T00:00:00Z'),
				('a-bar', 'Barkasse', 'cash', '2021-01-01', NULL, '2022-06-01T00:00:00Z')`
		);
		expect(await migrateModuleTo('treasury', '0002_extensions')).toEqual(['0002_extensions']);
		const defaults = async () =>
			moduleSql('treasury', sql`SELECT id FROM accounts WHERE is_default ORDER BY id`);
		expect(await defaults()).toEqual([{ id: 'a-giro' }]);

		// Idempotent: ein vorhandenes Standardkonto wird nicht überschrieben
		await moduleSql('treasury', sql`UPDATE accounts SET is_default = false`);
		await moduleSql('treasury', sql`UPDATE accounts SET is_default = true WHERE id = 'a-bar'`);
		for (const statement of splitSqlStatements(treasury0002)) {
			await moduleSql('treasury', sql.raw(statement));
		}
		expect(await defaults()).toEqual([{ id: 'a-bar' }]);
	});

	it('ohne aktive Konten gibt es kein Standardkonto', async () => {
		await moduleSql('treasury', sql`UPDATE accounts SET is_default = false`);
		await moduleSql('treasury', sql`UPDATE accounts SET archived_at = now()`);
		for (const statement of splitSqlStatements(treasury0002)) {
			await moduleSql('treasury', sql.raw(statement));
		}
		expect(await moduleSql('treasury', sql`SELECT id FROM accounts WHERE is_default`)).toEqual([]);
	});
});

describe('galleries 0002_gallery_events', () => {
	it('überträgt Termin-Zuordnungen der Bilder auf die Galerie und entfernt die Alt-Tabelle', async () => {
		await migrateModuleTo('galleries', '0001_init');
		const img = (id: string, gallery: string) =>
			sql`INSERT INTO gallery_images (id, gallery_id, original_name, content_type, width, height,
				size_bytes, thumb_path, web_path, full_path)
				VALUES (${id}, ${gallery}, 'bild.jpg', 'image/jpeg', 10, 10, 100, 't', 'w', 'f')`;
		await moduleSql(
			'galleries',
			sql`INSERT INTO galleries (id, title, owner_id) VALUES
				('g1', 'Sommerlager', 'u1'), ('g2', 'Herbstfahrt', 'u1'), ('g3', 'Ohne Termine', 'u1')`
		);
		for (const [id, g] of [
			['i1', 'g1'],
			['i2', 'g1'],
			['i3', 'g2'],
			['i4', 'g3']
		] as const) {
			await moduleSql('galleries', img(id, g));
		}
		await moduleSql(
			'galleries',
			sql`INSERT INTO gallery_image_events (image_id, event_id) VALUES
				('i1', 'e1'), ('i1', 'e2'), ('i2', 'e1'), ('i3', 'e3')`
		);
		expect(await migrateModuleTo('galleries', '0002_gallery_events')).toEqual([
			'0002_gallery_events'
		]);
		expect(
			await moduleSql(
				'galleries',
				sql`SELECT gallery_id, event_id FROM gallery_events ORDER BY gallery_id, event_id`
			)
		).toEqual([
			{ gallery_id: 'g1', event_id: 'e1' },
			{ gallery_id: 'g1', event_id: 'e2' },
			{ gallery_id: 'g2', event_id: 'e3' }
		]);
		expect(
			await moduleSql(
				'galleries',
				sql`SELECT to_regclass('gallery_image_events') IS NULL AS dropped`
			)
		).toEqual([{ dropped: true }]);
		// Bilder bleiben erhalten; Folgemigrationen laufen durch
		await migrateModuleRest('galleries');
		const [count] = await moduleSql(
			'galleries',
			sql`SELECT count(*)::int AS n FROM gallery_images`
		);
		expect(count).toEqual({ n: 4 });
	});
});

describe('actions 0022_principal_shares', () => {
	it('übernimmt alte Benutzer-Freigaben als Typ user', async () => {
		await migrateModuleTo('actions', '0021_camp_fees');
		await moduleSql(
			'actions',
			sql`INSERT INTO actions (id, name, starts_on, owner_id)
				VALUES ('a1', 'Alt', '2026-01-01', 'u-owner')`
		);
		await moduleSql(
			'actions',
			sql`INSERT INTO action_shares (action_id, user_id, level) VALUES ('a1', 'u-1', 'edit')`
		);
		expect(await migrateModuleRest('actions')).toContain('0022_principal_shares');
		const rows = await moduleSql(
			'actions',
			sql`SELECT action_id, principal_type, principal_id, level FROM action_shares`
		);
		expect(rows).toEqual([
			{ action_id: 'a1', principal_type: 'user', principal_id: 'u-1', level: 'edit' }
		]);
		await expect(
			moduleSql(
				'actions',
				sql`INSERT INTO action_shares (action_id, principal_type, principal_id, level)
					VALUES ('a1', 'kaputt', 'x', 'read')`
			)
		).rejects.toThrow();
	});
});
