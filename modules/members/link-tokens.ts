/**
 * Verknüpfungs-Token (Brief-Link/QR, `member_link_codes`) nie im Klartext speichern (#67, 01b-14, Muster
 * `files/links.service.ts`):
 * - `token_hash` = `core.crypto.forModule('members').hash(token)` – gesucht wird nur darüber;
 * - `token_enc` = verschlüsselt, damit derselbe Brief erneut gedruckt werden kann;
 * - Altspalte `token` bleibt `NULL`. Altbestand (vor Migration 0014) wird idempotent umgestellt
 *   (`hashStoredLinkTokens`: `onEnable` + stündlicher Job); bis dahin findet die Suche ihn noch über `token`.
 * - Datensicherung: `membersBackup.rehash` berechnet `token_hash` mit dem Schlüssel des Zielservers neu.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, type ModuleBackupHooks, moduleDb, type Tx } from '$lib/sdk/server';
import { MODULE_ID } from './schemas';

const crypt = () => core.crypto.forModule(MODULE_ID);

export const hashLinkToken = (token: string): string => crypt().hash(token);

/** Spaltenwerte für ein neues Token */
export function linkTokenValues(token: string): { hash: string; enc: string } {
	return { hash: hashLinkToken(token), enc: crypt().encrypt(token) };
}

/** WHERE-Bedingung „Code gehört zu diesem Token“ (Tabellenalias `c`); Altzeilen ohne Hash über den Klartext */
export function tokenMatchSql(token: string): SQL {
	return sql`(c.token_hash = ${hashLinkToken(token)} OR (c.token_hash IS NULL AND c.token = ${token}))`;
}

/** Klartext-Token einer Zeile (für den Brief); `null`, wenn nicht entschlüsselbar */
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
	const res = (await tx.execute(
		sql`SELECT member_id, token FROM member_link_codes WHERE token IS NOT NULL FOR UPDATE`
	)) as unknown as { rows: Record<string, unknown>[] };
	for (const r of res.rows) {
		const { hash, enc } = linkTokenValues(String(r.token));
		await tx.execute(
			sql`UPDATE member_link_codes SET token_hash = ${hash}, token_enc = ${enc}, token = NULL
				WHERE member_id = ${String(r.member_id)}`
		);
	}
	return { updated: res.rows.length };
}

export async function hashStoredLinkTokens(): Promise<{ updated: number }> {
	return moduleDb(MODULE_ID).transaction((tx) => hashLinkTokensInTx(tx));
}

/**
 * Datensicherung: `token_hash` aus `token_enc` (beim Import mit dem Zielschlüssel neu verschlüsselt) neu
 * berechnen. Nicht entschlüsselbare Codes werden gelöscht (`unrecoverable`) – die Verwaltung erzeugt beim
 * nächsten Brief automatisch einen neuen. Idempotent.
 */
export const membersBackup: ModuleBackupHooks = {
	async rehash(tx, helpers) {
		const res = (await tx.execute(
			sql`SELECT member_id, token, token_hash, token_enc FROM member_link_codes`
		)) as unknown as { rows: Record<string, unknown>[] };
		let updated = 0;
		let unrecoverable = 0;
		for (const r of res.rows) {
			const id = String(r.member_id);
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
				await tx.execute(sql`DELETE FROM member_link_codes WHERE member_id = ${id}`);
				unrecoverable++;
				continue;
			}
			const next = helpers.hash(plain);
			if (next === r.token_hash) continue;
			await tx.execute(
				sql`UPDATE member_link_codes SET token_hash = ${next} WHERE member_id = ${id}`
			);
			updated++;
		}
		return { updated, unrecoverable };
	}
};
