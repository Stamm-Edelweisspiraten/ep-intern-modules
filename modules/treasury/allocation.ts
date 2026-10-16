/**
 * Zuordnung von Einnahmen zu Rechnungsposten (auch Sammelzahlungen fuer Geschwister) und die
 * Datengrundlage fuer Zuordnungsvorschlaege.
 */
import { sql } from 'drizzle-orm';
import { errors, type Tx } from '$lib/sdk/server';
import {
	collectIds,
	idList,
	loadPayerNames,
	loadRawInvoices,
	mdb,
	num,
	resolveNames,
	rows,
	str
} from './db';
import { lineOpen, normalizeName, type MatchLine } from './logic';
import { CONTRIBUTIONS_CATEGORY_ID, type OpenLine } from './schemas';

/**
 * Ersetzt alle Zuordnungen einer Buchung. Prueft: Einnahme (keine Umbuchung), Summe ≤ Betrag,
 * je Posten keine Ueberzahlung, keine stornierten Rechnungen. Liefert betroffene Rechnungen.
 */
export async function replaceAllocations(
	tx: Tx,
	transactionId: string,
	allocations: { lineId: string; amountCents: number }[],
	userId: string | null
): Promise<{ invoiceIds: string[]; allocatedCents: number; amountCents: number }> {
	const [t] = await rows(
		tx,
		sql`SELECT id, amount_cents, transfer_id FROM transactions WHERE id = ${transactionId} FOR UPDATE`
	);
	if (!t) throw errors.notFound('Buchung nicht gefunden');
	const amount = num(t.amount_cents);
	if (allocations.length && (amount <= 0 || t.transfer_id)) {
		throw errors.conflict('Nur Einnahmen koennen Rechnungen zugeordnet werden');
	}
	const merged = new Map<string, number>();
	for (const a of allocations) merged.set(a.lineId, (merged.get(a.lineId) ?? 0) + a.amountCents);
	const total = [...merged.values()].reduce((s, v) => s + v, 0);
	if (total > amount) {
		throw errors.validation([
			{ path: ['allocations'], message: 'Zugeordnet ist mehr als der Buchungsbetrag' }
		]);
	}
	const before = await rows(
		tx,
		sql`SELECT DISTINCT l.invoice_id FROM allocations a JOIN invoice_lines l ON l.id = a.line_id
			WHERE a.transaction_id = ${transactionId}`
	);
	const invoiceIds = new Set(before.map((r) => String(r.invoice_id)));
	if (merged.size) {
		const ids = sql.join(
			[...merged.keys()].map((v) => sql`${v}`),
			sql`, `
		);
		const lines = await rows(
			tx,
			sql`SELECT l.id, l.invoice_id, l.amount_cents, l.waived_cents, i.cancelled_at, i.number,
				coalesce((SELECT sum(a.amount_cents) FROM allocations a
					WHERE a.line_id = l.id AND a.transaction_id <> ${transactionId}), 0) AS paid_others
			FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
			WHERE l.id IN (${ids}) FOR UPDATE OF l`
		);
		for (const [lineId, cents] of merged) {
			const l = lines.find((x) => x.id === lineId);
			if (!l) throw errors.notFound('Posten nicht gefunden');
			if (l.cancelled_at != null) {
				throw errors.conflict(`Rechnung ${String(l.number)} ist storniert`);
			}
			const open = lineOpen({
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_others)
			});
			if (cents > open) {
				throw errors.validation([
					{
						path: ['allocations'],
						message: `Für Rechnung ${String(l.number)} sind nur noch ${(open / 100).toFixed(2).replace('.', ',')} € offen`
					}
				]);
			}
			invoiceIds.add(String(l.invoice_id));
		}
	}
	await tx.execute(sql`DELETE FROM allocations WHERE transaction_id = ${transactionId}`);
	for (const [lineId, cents] of merged) {
		await tx.execute(
			sql`INSERT INTO allocations (id, transaction_id, line_id, amount_cents, created_by)
			VALUES (${crypto.randomUUID()}, ${transactionId}, ${lineId}, ${cents}, ${userId})`
		);
	}
	if (merged.size) {
		// Fehlende Kategorie/Aktion ergaenzen (nie ueberschreiben): Beitraege aus Aktionen
		const meta = await rows(
			tx,
			sql`SELECT DISTINCT coalesce(l.action_id, i.action_id) AS action_id
			FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
			WHERE l.id IN (${idList([...merged.keys()])})`
		);
		const actionIds = meta.map((r) => str(r.action_id));
		const allFromActions = actionIds.length > 0 && actionIds.every(Boolean);
		await tx.execute(
			sql`UPDATE transactions SET
				category_id = coalesce(category_id, ${allFromActions ? CONTRIBUTIONS_CATEGORY_ID : null}),
				action_id = coalesce(action_id, ${actionIds.length === 1 ? actionIds[0]! : null}),
				updated_at = now()
			WHERE id = ${transactionId}`
		);
	}
	if (invoiceIds.size) {
		await tx.execute(
			sql`UPDATE invoices SET updated_at = now() WHERE id IN (${sql.join(
				[...invoiceIds].map((v) => sql`${v}`),
				sql`, `
			)})`
		);
	}
	return { invoiceIds: [...invoiceIds], allocatedCents: total, amountCents: amount };
}

/**
 * Offene Posten (und die der Buchung `transactionId` bereits zugeordneten) mit Namen fuer
 * Auswahl und Vorschlaege. Laeuft selbst in Transaktion + Namensaufloesung danach.
 */
export async function loadMatchLines(transactionId?: string): Promise<{
	open: OpenLine[];
	match: MatchLine[];
}> {
	const { invoices, payers, own } = await mdb().transaction(async (tx) => ({
		invoices: await loadRawInvoices(tx, sql`i.cancelled_at IS NULL`),
		payers: await loadPayerNames(tx),
		own: transactionId
			? await rows(
					tx,
					sql`SELECT line_id, amount_cents FROM allocations WHERE transaction_id = ${transactionId}`
				)
			: []
	}));
	const ownByLine = new Map(own.map((r) => [String(r.line_id), num(r.amount_cents)]));
	const names = await resolveNames({ ...collectIds(invoices), payers });
	const open: OpenLine[] = [];
	const match: MatchLine[] = [];
	for (const inv of invoices) {
		const payerId = str(inv.row.payer_id);
		const payerName = payerId ? payers.get(payerId)?.name : undefined;
		for (const l of inv.lines) {
			const mine = ownByLine.get(String(l.id)) ?? 0;
			const openCents = lineOpen({
				amountCents: num(l.amount_cents),
				waivedCents: num(l.waived_cents),
				paidCents: num(l.paid_cents) - mine
			});
			if (openCents <= 0) continue;
			const memberId = str(l.member_id);
			const memberName = memberId ? names.members.get(memberId) : undefined;
			const recipient = String(inv.row.recipient_name);
			const base = {
				lineId: String(l.id),
				invoiceId: String(inv.row.id),
				invoiceNumber: String(inv.row.number),
				dueOn: String(inv.row.due_on),
				openCents
			};
			open.push({
				...base,
				description: String(l.description),
				recipientName: recipient,
				memberId,
				payerId
			});
			const last =
				normalizeName(memberName ?? recipient)
					.split(' ')
					.pop() ?? '';
			match.push({
				...base,
				order: `${String(inv.row.number)}-${String(l.position)}`,
				names: [recipient, ...(memberName ? [memberName] : []), ...(payerName ? [payerName] : [])],
				groupKey: payerId ? `payer:${payerId}` : `last:${last}`,
				topic:
					names.actions.get(str(l.action_id) ?? str(inv.row.action_id) ?? '') ??
					String(l.description)
			});
		}
	}
	return { open, match };
}
