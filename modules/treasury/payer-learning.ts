/**
 * Zahler aus eingehenden Buchungen lernen: Wird eine Einnahme mit IBAN (oder gewaehltem Zahler)
 * Rechnungen zugeordnet, legt die Kasse den Zahler an bzw. ergaenzt IBAN und Mitglieder.
 * Bestehende Zuordnungen von Mitgliedern zu anderen Zahlern bleiben unangetastet.
 */
import { sql } from 'drizzle-orm';
import { core, type RequestContext } from '$lib/sdk/server';
import { idList, mdb, membersService, rows, str } from './db';

export interface LearnedPayer {
	id: string;
	name: string;
	created: boolean;
}

export async function learnPayerFromTransaction(
	ctx: RequestContext,
	transactionId: string
): Promise<LearnedPayer | null> {
	const data = await mdb().transaction(async (tx) => {
		const [t] = await rows(
			tx,
			sql`SELECT counterparty, counterparty_iban_enc, counterparty_iban_hash, counterparty_iban_last4, payer_id
			FROM transactions WHERE id = ${transactionId}`
		);
		if (!t) return null;
		const members = (
			await rows(
				tx,
				sql`SELECT DISTINCT l.member_id FROM allocations a JOIN invoice_lines l ON l.id = a.line_id
				WHERE a.transaction_id = ${transactionId} AND l.member_id IS NOT NULL`
			)
		).map((r) => String(r.member_id));
		const byIban = t.counterparty_iban_hash
			? await rows(
					tx,
					sql`SELECT id FROM payers WHERE iban_hash = ${String(t.counterparty_iban_hash)} LIMIT 1`
				)
			: [];
		const byMember = members.length
			? await rows(
					tx,
					sql`SELECT payer_id FROM payer_members WHERE member_id IN (${idList(members)}) LIMIT 1`
				)
			: [];
		return { t, members, byIban, byMember };
	});
	if (!data) return null;
	const { t, members, byIban, byMember } = data;
	const hasIban = t.counterparty_iban_hash != null;
	if (!hasIban && !t.payer_id) return null;
	let payerId = str(t.payer_id) ?? str(byIban[0]?.id) ?? str(byMember[0]?.payer_id);
	if (!payerId && !members.length) return null;

	let name = '';
	if (!payerId) {
		const contacts = await (await membersService()).listMemberContacts({ ids: members });
		const lastNames = [...new Set(contacts.map((c) => c.lastName))];
		name =
			lastNames.length === 1
				? `Familie ${lastNames[0]}`
				: (str(t.counterparty) ?? contacts.map((c) => c.firstName).join(', ')) || 'Zahler';
	}

	const created = !payerId;
	const result = await mdb().transaction(async (tx) => {
		if (!payerId) {
			payerId = crypto.randomUUID();
			await tx.execute(
				sql`INSERT INTO payers (id, name, account_holder, iban_enc, iban_last4, iban_hash)
				VALUES (${payerId}, ${name.slice(0, 120)}, ${str(t.counterparty)?.slice(0, 100) ?? null},
					${str(t.counterparty_iban_enc)}, ${str(t.counterparty_iban_last4)}, ${str(t.counterparty_iban_hash)})`
			);
		} else if (hasIban) {
			// IBAN nur ergaenzen, nie eine vorhandene ueberschreiben
			await tx.execute(
				sql`UPDATE payers SET iban_enc = ${str(t.counterparty_iban_enc)}, iban_last4 = ${str(t.counterparty_iban_last4)},
					iban_hash = ${str(t.counterparty_iban_hash)},
					account_holder = coalesce(account_holder, ${str(t.counterparty)?.slice(0, 100) ?? null}),
					updated_at = now()
				WHERE id = ${payerId} AND iban_enc IS NULL`
			);
		}
		for (const m of members) {
			await tx.execute(
				sql`INSERT INTO payer_members (payer_id, member_id) VALUES (${payerId}, ${m}) ON CONFLICT DO NOTHING`
			);
		}
		await tx.execute(
			sql`UPDATE transactions SET payer_id = ${payerId} WHERE id = ${transactionId}`
		);
		const [p] = await rows(tx, sql`SELECT name FROM payers WHERE id = ${payerId}`);
		return { id: payerId!, name: String(p?.name ?? name), created };
	});
	await core.audit.logFromContext(ctx, 'treasury.payer.learned', {
		target: result.id,
		metadata: { transactionId, created, members: members.length }
	});
	return result;
}
