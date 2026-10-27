/**
 * Öffentliche Link-Tokens (Anmeldelink `action_forms`, Kosten-Link `expense_links`) nie im Klartext speichern
 * (#67, 01b-14, Muster `files/links.service.ts`):
 * - `token_hash` = `core.crypto.forModule('actions').hash(token)` – gesucht wird nur darüber;
 * - `token_enc` = AES-256-GCM-verschlüsselt, damit Bearbeitende die URL weiterhin sehen/kopieren können;
 * - Altspalte `token` bleibt `NULL`. Altbestand (vor Migration 0020) wird idempotent umgestellt
 *   (`hashStoredLinkTokens`: `onEnable` + stündlicher Job); bis dahin findet die Suche ihn noch über `token`.
 * - Datensicherung: `actionsBackup.rehash` berechnet `token_hash` mit dem Schlüssel des Zielservers neu.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, type ModuleBackupHooks, moduleDb, type Tx } from '$lib/sdk/server';
import { MODULE_ID } from './schemas';

const crypt = () => core.crypto.forModule(MODULE_ID);

/** Tabellen mit Link-Token (Primärschlüssel jeweils `action_id`) */
export const LINK_TOKEN_TABLES = ['action_forms', 'expense_links'] as const;
export type LinkTokenTable = (typeof LINK_TOKEN_TABLES)[number];

export const hashLinkToken = (token: string): string => crypt().hash(token);

/** Spaltenwerte für ein neues Token */
export function linkTokenValues(token: string): { hash: string; enc: string } {
	return { hash: hashLinkToken(token), enc: crypt().encrypt(token) };
}

/**
 * WHERE-Bedingung „Zeile gehört zu diesem Token“ (`alias` = Tabellenalias oder leer). Altzeilen ohne Hash
 * (vor der Umstellung) werden noch über den Klartext gefunden.
 */
export function tokenMatchSql(token: string, alias = ''): SQL {
	const p = alias ? `${alias}.` : '';
	return sql`(${sql.raw(`${p}token_hash`)} = ${hashLinkToken(token)}
		OR (${sql.raw(`${p}token_hash`)} IS NULL AND ${sql.raw(`${p}token`)} = ${token}))`;
}

/** Klartext-Token einer Zeile (für die Link-URL); `null`, wenn nicht entschlüsselbar */
export function storedToken(row: Record<string, unknown>): string | null {
	if (typeof row.token_enc === 'string' && row.token_enc) {
		try {
			return crypt().decrypt(row.token_enc);
		} catch {
			return null;
		}
	}
	return typeof row.token === 'string' && row.token ? row.token : null;
}

/** Altbestand umstellen: Hash + verschlüsseltes Token setzen, Klartext leeren (idempotent). */
export async function hashLinkTokensInTx(tx: Tx): Promise<{ updated: number }> {
	let updated = 0;
	for (const table of LINK_TOKEN_TABLES) {
		const res = (await tx.execute(
			sql`SELECT action_id, token FROM ${sql.raw(table)} WHERE token IS NOT NULL FOR UPDATE`
		)) as unknown as { rows: Record<string, unknown>[] };
		for (const r of res.rows) {
			const { hash, enc } = linkTokenValues(String(r.token));
			await tx.execute(
				sql`UPDATE ${sql.raw(table)} SET token_hash = ${hash}, token_enc = ${enc}, token = NULL
					WHERE action_id = ${String(r.action_id)}`
			);
			updated++;
		}
	}
	return { updated };
}

export async function hashStoredLinkTokens(): Promise<{ updated: number }> {
	return moduleDb(MODULE_ID).transaction((tx) => hashLinkTokensInTx(tx));
}

/**
 * Datensicherung: `token_hash` aus `token_enc` (beim Import mit dem Zielschlüssel neu verschlüsselt) neu
 * berechnen. Nicht entschlüsselbare Links werden deaktiviert (`enabled = false`) und als `unrecoverable`
 * gezählt; Bearbeitende können sie erneuern. Idempotent.
 */
export const actionsBackup: ModuleBackupHooks = {
	async rehash(tx, helpers) {
		let updated = 0;
		let unrecoverable = 0;
		for (const table of LINK_TOKEN_TABLES) {
			const res = (await tx.execute(
				sql`SELECT action_id, token, token_hash, token_enc, enabled FROM ${sql.raw(table)}`
			)) as unknown as { rows: Record<string, unknown>[] };
			for (const r of res.rows) {
				const id = String(r.action_id);
				let plain: string | null = null;
				if (typeof r.token_enc === 'string' && r.token_enc) {
					try {
						plain = helpers.decrypt(r.token_enc);
					} catch {
						plain = null;
					}
				} else if (typeof r.token === 'string' && r.token) {
					plain = r.token;
				}
				if (plain === null) {
					if (r.enabled === true || r.enabled === 't') {
						await tx.execute(
							sql`UPDATE ${sql.raw(table)} SET enabled = false WHERE action_id = ${id}`
						);
						unrecoverable++;
					}
					continue;
				}
				const next = helpers.hash(plain);
				if (next === r.token_hash && !r.token) continue;
				await tx.execute(
					sql`UPDATE ${sql.raw(table)} SET token_hash = ${next},
						token_enc = ${r.token_enc ?? null}, token = ${r.token_enc ? null : plain}
						WHERE action_id = ${id}`
				);
				updated++;
			}
		}
		// Rückzahlungs-Links je Person (seit 0024, nur Hash + Chiffrat); nicht entschlüsselbar → Link entfällt
		const refunds = (await tx.execute(
			sql`SELECT id, token_hash, token_enc FROM accounting_refunds WHERE token_enc IS NOT NULL`
		)) as unknown as { rows: Record<string, unknown>[] };
		for (const r of refunds.rows) {
			const id = String(r.id);
			let plain: string | null;
			try {
				plain = helpers.decrypt(String(r.token_enc));
			} catch {
				plain = null;
			}
			if (plain === null) {
				await tx.execute(
					sql`UPDATE accounting_refunds SET token_hash = NULL, token_enc = NULL WHERE id = ${id}`
				);
				unrecoverable++;
				continue;
			}
			const next = helpers.hash(plain);
			if (next === r.token_hash) continue;
			await tx.execute(sql`UPDATE accounting_refunds SET token_hash = ${next} WHERE id = ${id}`);
			updated++;
		}
		return { updated, unrecoverable };
	}
};
