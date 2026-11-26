/**
 * Bankverbindungen aus der Kasse als Vorschläge für andere Module (`TreasuryService.searchBankAccounts`
 * / `bankAccount`): Zahler mit IBAN und Empfänger manueller Auszahlungen bzw. Lieferanten. OHNE
 * Rechteprüfung – der Aufrufer prüft (z. B. `actions`: `actions.payout.view` + `treasury.bank.view`).
 * Suche liefert nur die Maske; den Klartext gibt es einzeln über `bankAccount(ref)`.
 */
import { sql } from 'drizzle-orm';
import { decryptIban } from './bank';
import type { BankAccountDetails, BankAccountSuggestion } from './contract';
import { mdb, rows, str } from './db';
import { formatIban, maskIban } from './iban';

const MAX_LIMIT = 20;

function likePattern(search: string): string {
	return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchBankAccounts(query: {
	search: string;
	limit?: number;
}): Promise<BankAccountSuggestion[]> {
	const search = query.search.trim();
	if (search.length < 2) return [];
	const limit = Math.min(Math.max(query.limit ?? 10, 1), MAX_LIMIT);
	const like = likePattern(search);
	const found = await mdb().transaction(async (tx) => {
		const payers = await rows(
			tx,
			sql`SELECT id, name, account_holder, iban_last4, bic FROM payers
				WHERE iban_enc IS NOT NULL
					AND (name ILIKE ${like} OR coalesce(account_holder, '') ILIKE ${like})
				ORDER BY name LIMIT ${limit}`
		);
		// Je Empfänger (Name + IBAN-Ende) nur die jüngste Auszahlung; automatische Posten aus `actions`
		// (Auslagen/Rückzahlung) stammen ohnehin aus den Aktionen und werden nicht vorgeschlagen.
		const payables = await rows(
			tx,
			sql`SELECT DISTINCT ON (lower(recipient_name), iban_last4) id, recipient_name, iban_last4, bic
				FROM payables
				WHERE iban_enc IS NOT NULL AND source IN ('manual', 'order')
					AND recipient_name ILIKE ${like}
				ORDER BY lower(recipient_name), iban_last4, created_at DESC
				LIMIT ${limit}`
		);
		return { payers, payables };
	});
	const out: BankAccountSuggestion[] = found.payers.map((p) => ({
		ref: `payer:${String(p.id)}`,
		kind: 'payer',
		name: String(p.name),
		holder: str(p.account_holder),
		ibanMasked: maskIban(str(p.iban_last4)) ?? '',
		bic: str(p.bic)
	}));
	const seen = new Set(out.map((s) => `${(s.holder ?? s.name).toLowerCase()}|${s.ibanMasked}`));
	for (const p of found.payables) {
		const s: BankAccountSuggestion = {
			ref: `payable:${String(p.id)}`,
			kind: 'payable',
			name: String(p.recipient_name),
			holder: null,
			ibanMasked: maskIban(str(p.iban_last4)) ?? '',
			bic: str(p.bic)
		};
		const key = `${s.name.toLowerCase()}|${s.ibanMasked}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s);
	}
	return out.slice(0, limit);
}

export async function bankAccount(ref: string): Promise<BankAccountDetails | null> {
	const m = /^(payer|payable):([\w-]{1,100})$/.exec(ref);
	if (!m) return null;
	const [, kind, id] = m;
	const row = await mdb().transaction(async (tx) => {
		const [r] =
			kind === 'payer'
				? await rows(
						tx,
						sql`SELECT coalesce(nullif(account_holder, ''), name) AS holder, iban_enc, bic
							FROM payers WHERE id = ${id}`
					)
				: await rows(
						tx,
						sql`SELECT recipient_name AS holder, iban_enc, bic FROM payables
							WHERE id = ${id} AND source IN ('manual', 'order')`
					);
		return r ?? null;
	});
	if (!row) return null;
	const iban = decryptIban(row.iban_enc);
	if (!iban) return null;
	return { holder: String(row.holder), iban: formatIban(iban), bic: str(row.bic) };
}
