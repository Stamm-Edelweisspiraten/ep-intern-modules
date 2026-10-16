/** Gegenpartei einer Buchung: Zahler und IBAN (verschluesselt + HMAC) */
import { sql } from 'drizzle-orm';
import { errors, type Tx } from '$lib/sdk/server';
import { storeIban } from './bank';
import { rows } from './db';

/** IBAN der Gegenpartei und Zahler speichern; ohne eigene IBAN wird die des Zahlers uebernommen */
export async function applyCounterparty(
	tx: Tx,
	id: string,
	input: { payerId: string | null; counterpartyIban?: string }
): Promise<void> {
	if (input.payerId) {
		const [p] = await rows(tx, sql`SELECT id FROM payers WHERE id = ${input.payerId}`);
		if (!p) throw errors.validation([{ path: ['payerId'], message: 'Zahler nicht gefunden' }]);
	}
	await tx.execute(sql`UPDATE transactions SET payer_id = ${input.payerId} WHERE id = ${id}`);
	const bank = storeIban(input.counterpartyIban);
	if (bank) {
		await tx.execute(
			sql`UPDATE transactions SET counterparty_iban_enc = ${bank.enc}, counterparty_iban_hash = ${bank.hash},
				counterparty_iban_last4 = ${bank.last4} WHERE id = ${id}`
		);
	}
	if (input.payerId && !bank?.enc) {
		await tx.execute(
			sql`UPDATE transactions t SET counterparty_iban_enc = p.iban_enc, counterparty_iban_hash = p.iban_hash,
				counterparty_iban_last4 = p.iban_last4
			FROM payers p WHERE t.id = ${id} AND p.id = ${input.payerId} AND p.iban_enc IS NOT NULL
				AND t.counterparty_iban_enc IS NULL`
		);
	}
}
