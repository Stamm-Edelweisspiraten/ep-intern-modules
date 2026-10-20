/**
 * Abgleich mit der Kasse (Modul `treasury`, optional): Rechnungen zu Bestellungen und Auszahlungen für
 * Lieferantenrechnungen per Push. Alle Aufrufe AUSSERHALB offener Modul-Transaktionen.
 * Rechnungsfehler werden nie an die Nutzer*innen durchgereicht: Die Bestellung bleibt gültig und
 * `treasury_dirty` bleibt gesetzt, der stündliche Job versucht es erneut.
 */
import { sql } from 'drizzle-orm';
import { errors, type RequestContext } from '$lib/sdk/server';
import type { OrderInvoiceLine, OrderPayableInput } from '$lib/modules/treasury/contract';
import { invoiceLineRef, invoiceSourceKey, payableRef } from './schemas';
import { mdb, num, rows, str, treasuryService } from './db';
import { loadOrders } from './orders.service';
import { billableCents, lineDescription } from './stock';

export interface PushInvoiceResult {
	/** Rechnung steht aus (Kasse nicht aktiv oder Fehler) */
	pending: boolean;
	mailed: boolean;
	invoiceId: string | null;
	number: string | null;
}

/**
 * Überträgt die Posten einer Bestellung in die Kasse (anlegen, ändern oder – ohne Posten – stornieren).
 * `send` fehlt = nur bei erstmaliger Rechnung verschicken.
 */
export async function pushInvoice(
	ctx: RequestContext,
	orderId: string,
	opts: { send?: boolean } = {}
): Promise<PushInvoiceResult> {
	const pending: PushInvoiceResult = {
		pending: true,
		mailed: false,
		invoiceId: null,
		number: null
	};
	try {
		const [data] = await mdb().transaction((tx) => loadOrders(tx, [orderId]));
		if (!data) return { ...pending, pending: false };
		const o = data.order;
		const invoiceId = str(o.invoice_id);
		const lines: OrderInvoiceLine[] = data.items
			.map((r) => {
				const q = {
					quantity: num(r.quantity),
					deliveredQty: num(r.delivered_qty),
					cancelledQty: num(r.cancelled_qty),
					unitPriceCents: num(r.unit_price_cents)
				};
				return {
					ref: invoiceLineRef(orderId, String(r.id)),
					description: lineDescription(
						String(r.article_title),
						String(r.variant_label ?? ''),
						q.quantity - q.cancelledQty
					),
					amountCents: billableCents(q)
				};
			})
			.filter((l) => l.amountCents > 0);

		// Nichts zu berechnen und noch keine Rechnung: erledigt
		if (!lines.length && !invoiceId) {
			await markSynced(orderId, null, null);
			return { pending: false, mailed: false, invoiceId: null, number: null };
		}
		const treasury = await treasuryService();
		if (!treasury) {
			await markDirty(orderId);
			return { ...pending, invoiceId, number: str(o.invoice_number) };
		}
		const result = await treasury.upsertOrderInvoice(ctx, {
			sourceKey: invoiceSourceKey(orderId),
			memberId: String(o.member_id),
			orderNumber: String(o.number),
			recipientName: null,
			note: str(o.note),
			lines,
			send: opts.send ?? !invoiceId
		});
		await markSynced(
			orderId,
			result.invoiceId ?? invoiceId,
			result.number ?? str(o.invoice_number)
		);
		return {
			pending: false,
			mailed: result.mailed,
			invoiceId: result.invoiceId,
			number: result.number
		};
	} catch (e) {
		console.error(`[orders] Rechnung zur Bestellung ${orderId} nicht abgeglichen:`, e);
		await markDirty(orderId).catch(() => undefined);
		return pending;
	}
}

async function markSynced(orderId: string, invoiceId: string | null, number: string | null) {
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE orders SET invoice_id = ${invoiceId}, invoice_number = ${number},
				treasury_synced_at = now(), treasury_dirty = false WHERE id = ${orderId}`
		)
	);
}

async function markDirty(orderId: string) {
	await mdb().transaction((tx) =>
		tx.execute(sql`UPDATE orders SET treasury_dirty = true WHERE id = ${orderId}`)
	);
}

export interface PayableData {
	amountCents: number;
	recipientName: string;
	iban?: string;
	bic: string | null;
	dueOn: string | null;
	note: string | null;
}

/**
 * Legt die Lieferantenrechnung als Auszahlung in der Kasse an bzw. aktualisiert sie.
 * Kasse nicht aktiv → 409; Fehler der Kasse (z. B. Betrag unter Gezahltem) werden durchgereicht.
 */
export async function pushPayable(
	ctx: RequestContext,
	supplierOrderId: string,
	input: PayableData,
	receipt?: OrderPayableInput['receipt']
): Promise<{ payableId: string; ref: string }> {
	const treasury = await treasuryService();
	if (!treasury) throw errors.conflict('Kasse ist nicht aktiv');
	const [so] = await mdb().transaction((tx) =>
		rows(tx, sql`SELECT number, supplier FROM supplier_orders WHERE id = ${supplierOrderId}`)
	);
	if (!so) throw errors.notFound('Lieferantenbestellung nicht gefunden');
	const ref = payableRef(supplierOrderId);
	const payload: OrderPayableInput = {
		ref,
		recipientName: input.recipientName,
		description: `Lieferantenrechnung ${String(so.number)} (${String(so.supplier)})`.slice(0, 200),
		amountCents: input.amountCents,
		dueOn: input.dueOn,
		bic: input.bic,
		note: input.note,
		receipt: receipt ?? null
	};
	if (input.iban !== undefined) payload.iban = input.iban;
	const { payableId } = await treasury.upsertOrderPayable(ctx, payload);
	return { payableId, ref };
}

/**
 * Job (stündlich): alle Bestellungen mit ausstehendem Abgleich erneut an die Kasse geben
 * (erstmalige Rechnung wird verschickt).
 */
export async function syncTreasury(ctx: RequestContext): Promise<string> {
	const treasury = await treasuryService();
	if (!treasury) return 'Kasse nicht aktiv – nichts abgeglichen';
	const dirty = await mdb().transaction((tx) =>
		rows(tx, sql`SELECT id FROM orders WHERE treasury_dirty = true ORDER BY created_at LIMIT 500`)
	);
	let ok = 0;
	let failed = 0;
	for (const r of dirty) {
		const res = await pushInvoice(ctx, String(r.id));
		if (res.pending) failed++;
		else ok++;
	}
	if (!dirty.length) return 'Alles abgeglichen';
	return `${ok} Bestellung(en) abgeglichen${failed ? `, ${failed} fehlgeschlagen` : ''}`;
}
