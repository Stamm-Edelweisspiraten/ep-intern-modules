/**
 * Rückzahlung spenden: Jede Person kann ihren Anteil ganz oder teilweise (ganze Euro) dem Stamm spenden –
 * intern in der Abrechnung oder selbst über den Link im Brief (QR-Code). Standard ist „auszahlen“.
 * Die Rückzahlungs-Buchung (`refund`) umfasst immer nur die Auszahlungen; spendet jede Person alles,
 * entfällt sie (Snapshot bleibt). Die Kasse zahlt über `listRefundItems` nur noch den Rest aus.
 */
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import { core, errors, rowsOf, type Tx } from '$lib/sdk/server';
import type { TreasuryService } from '$lib/modules/treasury/contract';
import { loadRefundSnapshot } from './accounting-core';
import { donationTotals, validateDonation } from './refund';
import { MODULE_ID } from './schemas';

/** Schlüssel der Auszahlung in der Kasse (`treasury/payables.ts`) */
export const refundPayableRef = (actionId: string, itemId: string): string =>
	`refund:${actionId}:${itemId}`;

export const TREASURY_PAID_TEXT =
	'Die Kasse hat die Rückzahlung bereits überwiesen – die Wahl lässt sich nicht mehr ändern.';

/**
 * Von der Kasse bereits überwiesene Beträge je Rückzahlungs-Posten (nur > 0). Ohne aktive Kasse leer.
 * VOR bzw. NACH der Modul-Transaktion aufrufen (Dienst eines anderen Moduls).
 */
export async function treasuryPaidByItem(
	actionId: string,
	itemIds: string[]
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (!itemIds.length) return out;
	const treasury = await core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);
	if (!treasury) return out;
	const status = await treasury.payableStatus(itemIds.map((i) => refundPayableRef(actionId, i)));
	for (const itemId of itemIds) {
		const s = status[refundPayableRef(actionId, itemId)];
		if (s && s.paidCents > 0) out.set(itemId, s.paidCents);
	}
	return out;
}

const euros = (cents: number): string => `${Math.floor(cents / 100)}`;

/** Buchungstext der Rückzahlung aus dem Snapshot */
export function refundEntryText(snap: {
	mode: 'auto' | 'manual';
	payingCount: number;
	perHeadCents: number;
	items: { amountCents: number; donatedCents: number }[];
}): string {
	const totals = donationTotals(snap.items);
	if (totals.donorCount > 0) {
		const payers = snap.items.filter((i) => i.amountCents - i.donatedCents > 0).length;
		return `Rückzahlung an Teilnehmende (${payers} ${payers === 1 ? 'Person' : 'Personen'}, ${totals.donorCount} gespendet: ${euros(totals.donatedCents)} €)`;
	}
	const same = new Set(snap.items.map((i) => i.amountCents)).size <= 1;
	const head =
		snap.mode === 'manual'
			? `${snap.payingCount} × ${euros(snap.perHeadCents)} €`
			: `${snap.items.length} × ${same ? '' : 'bis zu '}${euros(snap.perHeadCents)} €`;
	return `Rückzahlung an Teilnehmende (${head})`;
}

/**
 * Rückzahlungs-Buchung an die Spenden anpassen: Betrag = Summe der Auszahlungen. Bei 0 wird die Buchung
 * gelöscht, kommt wieder eine Auszahlung dazu, neu angelegt (Datum heute). Innerhalb der Transaktion.
 */
export async function syncRefundEntry(tx: Tx, actionId: string, by: string | null): Promise<void> {
	const snap = await loadRefundSnapshot(tx, actionId);
	if (!snap) return;
	const description = refundEntryText(snap);
	if (snap.payoutCents > 0) {
		if (snap.entryId) {
			await tx.execute(
				sql`UPDATE accounting_entries SET amount_cents = ${snap.payoutCents},
						description = ${description}, updated_at = now()
					WHERE id = ${snap.entryId}`
			);
			return;
		}
		const entryId = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO accounting_entries (id, action_id, type, category, description,
					amount_cents, entry_date, paid_by, payee_id, created_by)
				VALUES (${entryId}, ${actionId}, 'expense', 'refund', ${description}, ${snap.payoutCents},
					${todayBerlin()}, 'club', NULL, ${by})`
		);
		await tx.execute(
			sql`UPDATE action_refund_booking SET entry_id = ${entryId} WHERE action_id = ${actionId}`
		);
		await tx.execute(
			sql`UPDATE accounting_refunds SET entry_id = ${entryId} WHERE action_id = ${actionId}`
		);
		return;
	}
	// Alles gespendet: keine Ausgabe mehr (FKs setzen entry_id auf NULL)
	if (snap.entryId) {
		await tx.execute(sql`DELETE FROM accounting_entries WHERE id = ${snap.entryId}`);
	}
}

export interface RefundItemRow {
	id: string;
	actionId: string;
	name: string;
	amountCents: number;
	donatedCents: number;
}

/** Posten unter Sperre lesen (`null` = unbekannt bzw. gehört nicht zur Aktion) */
export async function lockRefundItem(
	tx: Tx,
	actionId: string,
	itemId: string
): Promise<RefundItemRow | null> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT id, action_id, name, amount_cents, donated_cents FROM accounting_refunds
			WHERE id = ${itemId} AND action_id = ${actionId} FOR UPDATE`
	);
	if (!r) return null;
	return {
		id: String(r.id),
		actionId: String(r.action_id),
		name: String(r.name),
		amountCents: Number(r.amount_cents),
		donatedCents: Number(r.donated_cents ?? 0)
	};
}

/**
 * Spende setzen (Prüfung, Speichern, Buchung anpassen). Aufrufer hat Zugriff und `assertOpen` geprüft und
 * VOR der Transaktion `treasuryPaidByItem` befragt (`paid` > 0 → 409).
 */
export async function applyDonation(
	tx: Tx,
	item: RefundItemRow,
	input: {
		donatedCents: number;
		via: 'internal' | 'link';
		by: string | null;
		note?: string | null;
		paidCents: number;
	}
): Promise<{ changed: boolean }> {
	if (input.paidCents > 0) throw errors.conflict(TREASURY_PAID_TEXT);
	const problem = validateDonation(item.amountCents, input.donatedCents);
	if (problem) throw errors.validation([{ path: ['donatedCents'], message: problem }]);
	const changed = item.donatedCents !== input.donatedCents;
	await tx.execute(
		sql`UPDATE accounting_refunds SET donated_cents = ${input.donatedCents}, decided_at = now(),
				decided_via = ${input.via}, decided_by = ${input.via === 'internal' ? input.by : null}
				${input.note !== undefined ? sql`, donor_note = ${input.note || null}` : sql``}
			WHERE id = ${item.id}`
	);
	if (changed) await syncRefundEntry(tx, item.actionId, input.by);
	return { changed };
}
