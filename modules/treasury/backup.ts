/**
 * Datensicherung der Kasse: schlüsselgebundene IBAN-Hashes (`core.crypto.forModule('treasury').hash`) nach dem
 * Wiederherstellen mit dem Schlüssel des Zielservers neu berechnen.
 *
 * Betroffene Spalten (HMAC der normalisierten IBAN, siehe `bank.ts`):
 *   - `payers.iban_hash` aus `payers.iban_enc`
 *   - `transactions.counterparty_iban_hash` aus `transactions.counterparty_iban_enc`
 * `payables` speichert keinen Hash; `transactions.import_hash` ist ein ungeschlüsselter SHA-256 (bleibt gültig).
 *
 * Hash ohne (entschlüsselbare) Quelle → `unrecoverable`, Hash wird auf `NULL` gesetzt: Ein alter Hash passt nach
 * einem Schlüsselwechsel zu keiner neu erfassten IBAN mehr, würde aber in `payer-learning.ts` eine IBAN vortäuschen
 * (`hasIban`) und von dort an Zahler kopiert. `iban_last4` bleibt für die Anzeige erhalten.
 * Idempotent: Zeilen mit bereits korrektem Hash werden nicht geändert.
 */
import { sql } from 'drizzle-orm';
import type { ModuleBackupHooks, ModuleBackupRehashHelpers, Tx } from '$lib/sdk/server';
import { normalizeIban } from './iban';

interface HashColumn {
	table: 'payers' | 'transactions';
	enc: string;
	hash: string;
}

const COLUMNS: HashColumn[] = [
	{ table: 'payers', enc: 'iban_enc', hash: 'iban_hash' },
	{ table: 'transactions', enc: 'counterparty_iban_enc', hash: 'counterparty_iban_hash' }
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

async function rehashColumn(
	tx: Tx,
	col: HashColumn,
	h: ModuleBackupRehashHelpers
): Promise<{ updated: number; unrecoverable: number }> {
	const table = sql.identifier(col.table);
	const enc = sql.identifier(col.enc);
	const hash = sql.identifier(col.hash);
	const res = await tx.execute(
		sql`SELECT id, ${enc} AS enc, ${hash} AS hash FROM ${table}
			WHERE ${enc} IS NOT NULL OR ${hash} IS NOT NULL`
	);
	let updated = 0;
	let unrecoverable = 0;
	for (const r of res.rows as Record<string, unknown>[]) {
		const encValue = str(r.enc);
		const old = str(r.hash);
		let next: string | null = null;
		if (encValue) {
			try {
				next = h.hash(normalizeIban(h.decrypt(encValue)));
			} catch {
				next = null;
			}
		}
		if (next === null && old !== null) unrecoverable++;
		if (next === old) continue;
		await tx.execute(sql`UPDATE ${table} SET ${hash} = ${next} WHERE id = ${String(r.id)}`);
		if (next !== null) updated++;
	}
	return { updated, unrecoverable };
}

export const treasuryBackup: ModuleBackupHooks = {
	async rehash(tx, helpers) {
		let updated = 0;
		let unrecoverable = 0;
		for (const col of COLUMNS) {
			const r = await rehashColumn(tx, col, helpers);
			updated += r.updated;
			unrecoverable += r.unrecoverable;
		}
		return { updated, unrecoverable };
	}
};
