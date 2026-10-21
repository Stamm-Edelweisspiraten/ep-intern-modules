import { sql } from 'drizzle-orm';
import { core, errors, isUniqueViolation, type ApiEndpoint, type Tx } from '$lib/sdk/server';
import { loadAccounts, mdb, num, rows } from './db';
import {
	DEFAULT_INVOICE_BODY,
	DEFAULT_INVOICE_SUBJECT,
	DEFAULT_PAID_BODY,
	DEFAULT_PAID_SUBJECT,
	DEFAULT_REMINDER_BODY,
	DEFAULT_REMINDER_SUBJECT,
	SETTING_KEYS,
	accountInput,
	categoryInput,
	categoryParams,
	idParams,
	settingsInput,
	type AccountInput,
	type Category,
	type CategoryInput,
	type CategoryKind,
	type TreasurySettings
} from './schemas';

const TAGS = ['Modul: treasury'];
const VIEW = 'treasury.cash.view';
const MANAGE = 'treasury.account.manage';

/** Eindeutige Namen (UNIQUE lower(name)) → 409 mit deutschem Text */
async function uniqueName<T>(fn: () => Promise<T>, what: string): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (isUniqueViolation(e)) {
			throw errors.conflict(`${what} mit diesem Namen existiert bereits`);
		}
		throw e;
	}
}

/** Ohne Standardkonto wird das älteste nicht archivierte Konto Standard. */
async function ensureDefault(tx: Tx): Promise<void> {
	await tx.execute(
		sql`UPDATE accounts SET is_default = true
		WHERE id = (SELECT id FROM accounts WHERE archived_at IS NULL ORDER BY created_at, id LIMIT 1)
			AND NOT EXISTS (SELECT 1 FROM accounts WHERE is_default)`
	);
}

async function loadCategories(tx: Tx): Promise<Category[]> {
	const found = await rows(
		tx,
		sql`SELECT id, name, kind, built_in, archived_at FROM categories ORDER BY archived_at NULLS FIRST, position, name`
	);
	return found.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		kind: r.kind as CategoryKind,
		builtIn: Boolean(r.built_in),
		archived: r.archived_at != null
	}));
}

const SETTING_MAP: [keyof TreasurySettings, string, unknown][] = [
	['bankHolder', SETTING_KEYS.bankHolder, ''],
	['bankIban', SETTING_KEYS.bankIban, ''],
	['bankBic', SETTING_KEYS.bankBic, ''],
	['bankName', SETTING_KEYS.bankName, ''],
	['daysBeforeStart', SETTING_KEYS.daysBeforeStart, 14],
	['minDays', SETTING_KEYS.minDays, 14],
	['remindersEnabled', SETTING_KEYS.remindersEnabled, true],
	['firstDays', SETTING_KEYS.firstDays, 7],
	['secondDays', SETTING_KEYS.secondDays, 14],
	['paidMailEnabled', SETTING_KEYS.paidMailEnabled, true],
	['paidSubject', SETTING_KEYS.paidSubject, DEFAULT_PAID_SUBJECT],
	['paidBody', SETTING_KEYS.paidBody, DEFAULT_PAID_BODY],
	['reminderSubject', SETTING_KEYS.reminderSubject, DEFAULT_REMINDER_SUBJECT],
	['reminderBody', SETTING_KEYS.reminderBody, DEFAULT_REMINDER_BODY],
	['invoiceSubject', SETTING_KEYS.invoiceSubject, DEFAULT_INVOICE_SUBJECT],
	['invoiceBody', SETTING_KEYS.invoiceBody, DEFAULT_INVOICE_BODY]
];

export async function loadSettings(): Promise<TreasurySettings> {
	const s = await core.settings.getMany(SETTING_MAP.map(([, key]) => key));
	const out: Record<string, unknown> = {};
	for (const [field, key, fallback] of SETTING_MAP) {
		const v = s[key];
		out[field] = v === undefined || v === null || v === '' ? fallback : v;
	}
	return out as TreasurySettings;
}

export const accountEndpoints = [
	{
		method: 'GET',
		path: '/accounts',
		summary: 'Konten mit aktuellem Saldo',
		tags: TAGS,
		permission: VIEW,
		handler: () => mdb().transaction((tx) => loadAccounts(tx))
	},
	{
		method: 'POST',
		path: '/accounts',
		summary: 'Konto anlegen',
		tags: TAGS,
		permission: MANAGE,
		body: accountInput,
		handler: async ({ ctx, body }) => {
			const input = body as AccountInput;
			const id = crypto.randomUUID();
			const list = await uniqueName(
				() =>
					mdb().transaction(async (tx) => {
						await tx.execute(
							sql`INSERT INTO accounts (id, name, kind, iban, opening_balance_cents, opening_date, archived_at)
							VALUES (${id}, ${input.name}, ${input.kind}, ${input.iban}, ${input.openingBalanceCents},
								${input.openingDate}, ${input.archived ? new Date().toISOString() : null})`
						);
						await ensureDefault(tx);
						return loadAccounts(tx);
					}),
				'Ein Konto'
			);
			await core.audit.logFromContext(ctx, 'treasury.account.created', { target: id });
			return list.find((a) => a.id === id)!;
		}
	},
	{
		method: 'PUT',
		path: '/accounts/:id',
		summary: 'Konto ändern (Archivieren statt Löschen, sobald Buchungen existieren)',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		body: accountInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as AccountInput;
			const list = await uniqueName(
				() =>
					mdb().transaction(async (tx) => {
						const [cur] = await rows(
							tx,
							sql`SELECT archived_at, is_default FROM accounts WHERE id = ${id} FOR UPDATE`
						);
						if (!cur) throw errors.notFound('Konto nicht gefunden');
						if (input.archived && cur.is_default) {
							throw errors.conflict(
								'Das Standardkonto kann nicht archiviert werden. Bitte zuerst ein anderes Konto als Standard festlegen.'
							);
						}
						const archivedAt = input.archived
							? (cur.archived_at ?? new Date().toISOString())
							: null;
						await tx.execute(
							sql`UPDATE accounts SET name = ${input.name}, kind = ${input.kind}, iban = ${input.iban},
								opening_balance_cents = ${input.openingBalanceCents}, opening_date = ${input.openingDate},
								archived_at = ${archivedAt}, updated_at = now()
							WHERE id = ${id}`
						);
						return loadAccounts(tx);
					}),
				'Ein Konto'
			);
			await core.audit.logFromContext(ctx, 'treasury.account.updated', { target: id });
			return list.find((a) => a.id === id)!;
		}
	},
	{
		method: 'DELETE',
		path: '/accounts/:id',
		summary: 'Konto ohne Buchungen löschen',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			await mdb().transaction(async (tx) => {
				const [c] = await rows(
					tx,
					sql`SELECT (SELECT count(*)::int FROM transactions WHERE account_id = ${id}) AS n,
						(SELECT count(*)::int FROM accounts WHERE id = ${id}) AS e`
				);
				if (!num(c?.e)) throw errors.notFound('Konto nicht gefunden');
				if (num(c?.n) > 0) {
					throw errors.conflict('Konto hat Buchungen und kann nur archiviert werden');
				}
				await tx.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
				await ensureDefault(tx);
			});
			await core.audit.logFromContext(ctx, 'treasury.account.deleted', { target: id });
			return null;
		}
	},
	{
		method: 'PUT',
		path: '/accounts/:id/default',
		summary: 'Konto als Standardkonto festlegen (Vorbelegung in allen Dialogen)',
		tags: TAGS,
		permission: MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { id } = params as { id: string };
			const list = await mdb().transaction(async (tx) => {
				const [cur] = await rows(
					tx,
					sql`SELECT archived_at FROM accounts WHERE id = ${id} FOR UPDATE`
				);
				if (!cur) throw errors.notFound('Konto nicht gefunden');
				if (cur.archived_at) throw errors.conflict('Archivierte Konten können nicht Standard sein');
				await tx.execute(
					sql`UPDATE accounts SET is_default = false WHERE is_default AND id <> ${id}`
				);
				await tx.execute(
					sql`UPDATE accounts SET is_default = true, updated_at = now() WHERE id = ${id}`
				);
				return loadAccounts(tx);
			});
			await core.audit.logFromContext(ctx, 'treasury.account.default_set', { target: id });
			return list;
		}
	},
	{
		method: 'GET',
		path: '/categories',
		summary: 'Kategorien',
		tags: TAGS,
		permission: VIEW,
		handler: () => mdb().transaction((tx) => loadCategories(tx))
	},
	{
		method: 'POST',
		path: '/categories',
		summary: 'Kategorie anlegen',
		tags: TAGS,
		permission: MANAGE,
		body: categoryInput,
		handler: async ({ ctx, body }) => {
			const input = body as CategoryInput;
			const id = crypto.randomUUID();
			const list = await uniqueName(
				() =>
					mdb().transaction(async (tx) => {
						await tx.execute(
							sql`INSERT INTO categories (id, name, kind, position, archived_at)
							VALUES (${id}, ${input.name}, ${input.kind}, 100, ${input.archived ? new Date().toISOString() : null})`
						);
						return loadCategories(tx);
					}),
				'Eine Kategorie'
			);
			await core.audit.logFromContext(ctx, 'treasury.category.created', { target: id });
			return list.find((c) => c.id === id)!;
		}
	},
	{
		method: 'PUT',
		path: '/categories/:id',
		summary: 'Kategorie ändern/archivieren',
		tags: TAGS,
		permission: MANAGE,
		params: categoryParams,
		body: categoryInput,
		handler: async ({ ctx, params, body }) => {
			const { id } = params as { id: string };
			const input = body as CategoryInput;
			const list = await uniqueName(
				() =>
					mdb().transaction(async (tx) => {
						const [cur] = await rows(
							tx,
							sql`SELECT archived_at FROM categories WHERE id = ${id} FOR UPDATE`
						);
						if (!cur) throw errors.notFound('Kategorie nicht gefunden');
						await tx.execute(
							sql`UPDATE categories SET name = ${input.name}, kind = ${input.kind},
								archived_at = ${input.archived ? (cur.archived_at ?? new Date().toISOString()) : null}
							WHERE id = ${id}`
						);
						return loadCategories(tx);
					}),
				'Eine Kategorie'
			);
			await core.audit.logFromContext(ctx, 'treasury.category.updated', { target: id });
			return list.find((c) => c.id === id)!;
		}
	},
	{
		method: 'GET',
		path: '/settings',
		summary: 'Einstellungen der Kasse (Kontodaten, Fristen, Mailtexte)',
		tags: TAGS,
		permission: VIEW,
		handler: () => loadSettings()
	},
	{
		method: 'PUT',
		path: '/settings',
		summary: 'Einstellungen der Kasse speichern',
		tags: TAGS,
		permission: 'treasury.settings.manage',
		body: settingsInput,
		handler: async ({ ctx, body }) => {
			const input = body as TreasurySettings;
			// Atomar in EINER Transaktion: ein ungültiger Wert → nichts gespeichert. Mit dem Kontext der
			// Person, damit die Schreibrechte der Schlüssel (`treasury.settings.manage`) greifen.
			await core.settings.setMany(
				ctx,
				Object.fromEntries(SETTING_MAP.map(([field, key]) => [key, input[field]]))
			);
			await core.audit.logFromContext(ctx, 'treasury.settings.updated', {
				metadata: { keys: SETTING_MAP.length }
			});
			return loadSettings();
		}
	}
] as ApiEndpoint[];
