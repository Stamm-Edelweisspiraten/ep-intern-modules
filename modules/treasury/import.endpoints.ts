import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { core, errors, type ApiEndpoint, type RequestContext } from '$lib/sdk/server';
import { loadMatchLines } from './allocation';
import { ibanHash, storeIban } from './bank';
import {
	applyMapping,
	detectDelimiter,
	guessMapping,
	parseCsv,
	type ParsedRow
} from './csv-import';
import {
	NEEDS_ALLOCATION_SQL,
	idList,
	loadTransactionsWhere,
	mdb,
	payerByIbanHash,
	num,
	requireAccount,
	rows
} from './db';
import { suggestMatch } from './logic';
import {
	MAX_IMPORT_BYTES,
	MAX_IMPORT_ROWS,
	importMappingSchema,
	type ImportMapping,
	type ImportPreview,
	type ImportResult,
	type MatchSuggestion
} from './schemas';
import { syncIfStale } from './sync';

const TAGS = ['Modul: treasury'];

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');

function decode(bytes: Uint8Array): string {
	const utf8 = new TextDecoder('utf-8').decode(bytes);
	// Viele Banken exportieren noch Windows-1252/Latin-1
	return utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

interface ParsedUpload {
	accountId: string;
	fileName: string;
	headers: string[];
	mapping: ImportMapping;
	rows: (ParsedRow & {
		hash: string | null;
		ibanRef: { hash: string; last4: string } | null;
		ibanStore: { enc: string | null } | undefined;
	})[];
}

async function readUpload(request: Request): Promise<ParsedUpload> {
	const form = await request.formData().catch(() => {
		throw errors.badRequest('Ungültige Formulardaten');
	});
	const file = form.get('file');
	const accountId = String(form.get('accountId') ?? '');
	if (!(file instanceof File)) throw errors.badRequest('Feld "file" fehlt');
	if (!/^[0-9a-f-]{36}$/.test(accountId)) {
		throw errors.validation([{ path: ['accountId'], message: 'Bitte ein Konto wählen' }]);
	}
	if (file.size === 0) throw errors.badRequest('Datei ist leer');
	if (file.size > MAX_IMPORT_BYTES) throw errors.tooLarge('Datei überschreitet 5 MB');
	const text = decode(new Uint8Array(await file.arrayBuffer()));
	const delimiter = detectDelimiter(text);
	let mapping: ImportMapping | null = null;
	const rawMapping = form.get('mapping');
	if (typeof rawMapping === 'string' && rawMapping.trim()) {
		let json: unknown;
		try {
			json = JSON.parse(rawMapping);
		} catch {
			throw errors.badRequest('Spaltenzuordnung ist kein JSON');
		}
		const parsed = importMappingSchema.safeParse(json);
		if (!parsed.success) {
			throw errors.validation(
				parsed.error.issues.map((i) => ({
					path: ['mapping', ...i.path.map(String)],
					message: i.message
				}))
			);
		}
		mapping = parsed.data;
	}
	const table = parseCsv(text, mapping?.delimiter ?? delimiter);
	const headers = table[0] ?? [];
	if (!headers.length)
		throw errors.validation([{ path: ['file'], message: 'Keine Kopfzeile gefunden' }]);
	if (table.length - 1 > MAX_IMPORT_ROWS) {
		throw errors.tooLarge(`Höchstens ${MAX_IMPORT_ROWS} Zeilen je Import`);
	}
	mapping ??= guessMapping(headers, table[1], delimiter);
	if (!mapping) {
		throw errors.validation(
			{
				issues: [{ path: ['mapping'], message: 'Spalten für Datum und Betrag nicht erkannt' }],
				headers
			},
			'Spalten für Datum und Betrag nicht erkannt - bitte zuordnen'
		);
	}
	for (const col of [mapping.date, mapping.amount, mapping.counterparty, mapping.purpose]) {
		if (col && !headers.includes(col)) {
			throw errors.validation([
				{ path: ['mapping'], message: `Spalte „${col}“ fehlt in der Datei` }
			]);
		}
	}
	const parsedRows = applyMapping(table, mapping).map((r) => ({
		...r,
		hash: r.key ? hashOf(`${accountId}|${r.key}`) : null,
		ibanRef: ibanHash(r.iban),
		ibanStore: r.iban && ibanHash(r.iban) ? storeIban(r.iban) : undefined
	}));
	return {
		accountId,
		fileName: (file.name || 'import.csv').slice(0, 200),
		headers,
		mapping,
		rows: parsedRows
	};
}

async function existingHashes(accountId: string, hashes: string[]): Promise<Set<string>> {
	if (!hashes.length) return new Set();
	return mdb().transaction(async (tx) => {
		await requireAccount(tx, accountId);
		const found: string[] = [];
		for (let i = 0; i < hashes.length; i += 500) {
			const chunk = hashes.slice(i, i + 500);
			const r = await rows(
				tx,
				sql`SELECT import_hash FROM transactions WHERE account_id = ${accountId} AND import_hash IN (${idList(chunk)})`
			);
			found.push(...r.map((x) => String(x.import_hash)));
		}
		return new Set(found);
	});
}

/** Vorschläge für alle (oder bestimmte) nicht vollständig zugeordneten Einnahmen */
export async function bulkSuggestions(
	ctx: RequestContext,
	transactionIds?: string[]
): Promise<MatchSuggestion[]> {
	await syncIfStale(ctx);
	const raw = await mdb().transaction((tx) =>
		loadTransactionsWhere(
			tx,
			sql`${NEEDS_ALLOCATION_SQL}
				${transactionIds?.length ? sql`AND t.id IN (${idList(transactionIds)})` : sql``}`,
			{ limit: 200, offset: 0 }
		)
	);
	if (!raw.length) return [];
	const { match } = await loadMatchLines();
	const byIban = await payerByIbanHash();
	// Bereits für eine Buchung vorgeschlagene Posten nicht doppelt anbieten (älteste Buchung zuerst)
	const used = new Map<string, number>();
	const out: MatchSuggestion[] = [];
	for (const t of [...raw].reverse()) {
		const available = match
			.map((l) => ({ ...l, openCents: l.openCents - (used.get(l.lineId) ?? 0) }))
			.filter((l) => l.openCents > 0);
		const m = suggestMatch(
			{
				amountCents: num(t.row.amount_cents) - num(t.row.allocated_cents),
				purpose: t.row.purpose ? String(t.row.purpose) : null,
				counterparty: t.row.counterparty ? String(t.row.counterparty) : null,
				payerId: byIban.get(String(t.row.counterparty_iban_hash ?? '')) ?? null
			},
			available
		);
		if (!m) continue;
		for (const a of m.allocations) used.set(a.lineId, (used.get(a.lineId) ?? 0) + a.amountCents);
		out.push({ transactionId: String(t.row.id), ...m });
	}
	return out.reverse();
}

export const importEndpoints = [
	{
		method: 'POST',
		path: '/import/preview',
		summary: 'Kontoauszug (CSV) prüfen: Spalten, Zeilen, Duplikate',
		description: 'multipart: `file`, `accountId`, optional `mapping` (JSON). Speichert nichts.',
		tags: TAGS,
		permission: 'treasury.transaction.edit',
		handler: async ({ request }) => {
			const up = await readUpload(request);
			const dup = await existingHashes(
				up.accountId,
				up.rows.flatMap((r) => (r.hash ? [r.hash] : []))
			);
			const previewRows = up.rows.map((r) => ({
				line: r.line,
				bookedOn: r.bookedOn,
				amountCents: r.amountCents,
				counterparty: r.counterparty,
				purpose: r.purpose,
				duplicate: !!r.hash && dup.has(r.hash),
				error: r.error
			}));
			return {
				headers: up.headers,
				mapping: up.mapping,
				rows: previewRows,
				valid: previewRows.filter((r) => !r.error && !r.duplicate).length,
				duplicates: previewRows.filter((r) => r.duplicate).length,
				errors: previewRows.filter((r) => r.error).length
			} satisfies ImportPreview;
		}
	},
	{
		method: 'POST',
		path: '/import',
		summary: 'Kontoauszug (CSV) importieren; Duplikate werden übersprungen',
		tags: TAGS,
		permission: 'treasury.transaction.edit',
		handler: async ({ ctx, request }) => {
			const up = await readUpload(request);
			const valid = up.rows.filter((r) => !r.error && r.hash);
			const batchId = crypto.randomUUID();
			const res = await mdb().transaction(async (tx) => {
				await requireAccount(tx, up.accountId);
				await tx.execute(
					sql`INSERT INTO import_batches (id, account_id, file_name, created_by)
					VALUES (${batchId}, ${up.accountId}, ${up.fileName}, ${ctx.userId})`
				);
				let imported = 0;
				const newIds: string[] = [];
				for (const r of valid) {
					const id = crypto.randomUUID();
					const inserted = await rows(
						tx,
						sql`INSERT INTO transactions (id, account_id, booked_on, amount_cents, counterparty, purpose,
							import_hash, import_batch_id, counterparty_iban_hash, counterparty_iban_last4,
							counterparty_iban_enc, created_by)
						VALUES (${id}, ${up.accountId}, ${r.bookedOn}, ${r.amountCents}, ${r.counterparty}, ${r.purpose},
							${r.hash}, ${batchId}, ${r.ibanRef?.hash ?? null}, ${r.ibanRef?.last4 ?? null},
							${r.ibanStore?.enc ?? null}, ${ctx.userId})
						ON CONFLICT (account_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING
						RETURNING id`
					);
					if (inserted.length) {
						imported++;
						if ((r.amountCents ?? 0) > 0) newIds.push(id);
					}
				}
				const duplicates = valid.length - imported;
				const errorsCount = up.rows.length - valid.length;
				await tx.execute(
					sql`UPDATE import_batches SET imported = ${imported}, duplicates = ${duplicates}, errors = ${errorsCount}
					WHERE id = ${batchId}`
				);
				return { imported, duplicates, errors: errorsCount, newIds };
			});
			const suggestions = res.newIds.length ? (await bulkSuggestions(ctx, res.newIds)).length : 0;
			await core.audit.logFromContext(ctx, 'treasury.import.completed', {
				target: batchId,
				metadata: {
					accountId: up.accountId,
					imported: res.imported,
					duplicates: res.duplicates,
					errors: res.errors
				}
			});
			return {
				batchId,
				imported: res.imported,
				duplicates: res.duplicates,
				errors: res.errors,
				suggestions
			} satisfies ImportResult;
		}
	},
	{
		method: 'GET',
		path: '/suggestions',
		summary: 'Zuordnungsvorschläge für alle offenen Einnahmen',
		tags: TAGS,
		permission: 'treasury.cash.view',
		handler: ({ ctx }) => bulkSuggestions(ctx)
	}
] as ApiEndpoint[];
