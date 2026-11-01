/**
 * #64: Upgrade-Test für `messages` 0005_spam – vom Mailserver markierter Altbestand bekommt die Quelle
 * `server`, übrige Mails bleiben ohne Quelle; neue Spalten haben Standardwerte, die Liste ist leer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { migrateModuleTo, moduleSql } from '$testing';
import { registerModule } from '$testing';
import membersModule from '$modules/members/module';
import messagesModule from '$modules/messages/module';

let close: () => Promise<void>;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerModule(membersModule);
	registerModule(messagesModule);
});

afterAll(async () => {
	await close();
});

describe('messages 0005_spam', () => {
	it('Altbestand: Server-Spam bekommt die Quelle „server“, Rest bleibt unverändert', async () => {
		await migrateModuleTo('messages', '0004_inbox_folders');
		await moduleSql(
			'messages',
			sql`INSERT INTO inbox_messages (id, mailbox_key, mailbox_address, dedupe_key, thread_id,
					from_address, received_at, spam)
				VALUES ('i1', 'stamm', 'stamm@x.test', 'd1', 'i1', 'a@spam.example', now(), true),
					('i2', 'stamm', 'stamm@x.test', 'd2', 'i2', 'b@gut.example', now(), false)`
		);
		expect(await migrateModuleTo('messages', '0005_spam')).toEqual(['0005_spam']);
		const rows = await moduleSql(
			'messages',
			sql`SELECT id, spam, spam_source, spam_score, spam_reasons FROM inbox_messages ORDER BY id`
		);
		expect(rows).toEqual([
			{ id: 'i1', spam: true, spam_source: 'server', spam_score: null, spam_reasons: [] },
			{ id: 'i2', spam: false, spam_source: null, spam_score: null, spam_reasons: [] }
		]);
		const [rules] = await moduleSql('messages', sql`SELECT count(*)::int AS n FROM sender_rules`);
		expect(Number(rules!.n)).toBe(0);
		// Unbekannte Quelle wird abgewiesen
		await expect(
			moduleSql('messages', sql`UPDATE inbox_messages SET spam_source = 'egal' WHERE id = 'i2'`)
		).rejects.toThrow();
	});
});
