/**
 * Benachrichtigungen an das Amt „Kämmerer*in“ (Vorlage in `module.ts`, Modul `offices` optional):
 * neue Bestellung (sofort) und tägliche Fehlmengen-Meldung. Immer NACH der Transaktion aufrufen;
 * Fehler werden nur geloggt – Bestellungen und Jobs scheitern nie daran.
 */
import { sql } from 'drizzle-orm';
import { formatEuro } from '$lib/components/layout/money';
import { core, type RequestContext } from '$lib/sdk/server';
import type { OfficeNotification } from '$lib/modules/offices/contract';
import { MODULE_ID, NOTIFY_ORDER_CREATED, NOTIFY_STOCK_DEFICIT, OFFICE_KEY } from './schemas';
import { mdb, officesService, rows } from './db';
import { loadStock } from './orders.service';
import { lineDescription } from './stock';

export const ORDERS_LINK = '/modules/orders?tab=bestellungen';
export const STOCK_LINK = '/modules/orders?tab=lager';
const DIGEST_KEY = 'stock-deficit';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

async function send(ctx: RequestContext | null, items: OfficeNotification[]): Promise<boolean> {
	if (!items.length) return false;
	try {
		const offices = await officesService();
		if (!offices) return false;
		await offices.notify(ctx ?? core.auth.systemContext('orders-notify'), items);
		return true;
	} catch (e) {
		console.error('[orders] Benachrichtigung an das Amt „Kämmerer*in“ fehlgeschlagen:', e);
		return false;
	}
}

export interface OrderCreatedInfo {
	number: string;
	memberName: string;
	items: { articleTitle: string; variantLabel: string; quantity: number; totalCents: number }[];
	totalCents: number;
}

export function orderCreatedNotification(info: OrderCreatedInfo): OfficeNotification {
	const lines = [
		`Bestellung: ${info.number}`,
		`Für: ${info.memberName}`,
		'',
		...info.items.map(
			(i) =>
				`• ${lineDescription(i.articleTitle, i.variantLabel, i.quantity)}: ${formatEuro(i.totalCents)}`
		),
		'',
		`Summe: ${formatEuro(info.totalCents)}`
	];
	return {
		module: MODULE_ID,
		office: OFFICE_KEY,
		event: NOTIFY_ORDER_CREATED,
		subject: clip(`Neue Bestellung ${info.number}: ${info.memberName}`, 150),
		text: clip(lines.join('\n'), 4000),
		link: ORDERS_LINK
	};
}

/** Meldet eine neue Bestellung an die Kämmerer*innen. Wirft nie. */
export async function notifyOrderCreated(
	ctx: RequestContext,
	info: OrderCreatedInfo
): Promise<void> {
	await send(ctx, [orderCreatedNotification(info)]);
}

/**
 * Job (täglich): Fehlmengen (offene Bestellungen + Mindestbestand − Bestand − unterwegs) an das Amt
 * melden – nur wenn es welche gibt und sich der Stand seit der letzten Meldung geändert hat.
 */
export async function runDeficitDigest(ctx: RequestContext): Promise<string> {
	try {
		const { stock, last } = await mdb().transaction(async (tx) => ({
			stock: await loadStock(tx),
			last: (await rows(tx, sql`SELECT fingerprint FROM digest_state WHERE key = ${DIGEST_KEY}`))[0]
				?.fingerprint as string | undefined
		}));
		const missing = stock.filter((r) => r.deficit > 0);
		const fingerprint = missing
			.map((r) => `${r.variantId}:${r.deficit}`)
			.sort()
			.join(',');
		if (!missing.length) {
			await saveFingerprint('');
			return 'Keine Fehlmengen';
		}
		if (last === fingerprint) return 'Fehlmengen unverändert – keine Meldung';
		const total = missing.reduce((s, r) => s + r.deficit, 0);
		const lines = missing.map((r) => {
			const size = r.variantLabel ? ` (Gr. ${r.variantLabel})` : '';
			const parts = [`Bestand ${r.stock}`, `offen bestellt ${r.demand}`];
			if (r.minStock) parts.push(`Mindestbestand ${r.minStock}`);
			if (r.inTransit) parts.push(`unterwegs ${r.inTransit}`);
			return `• ${r.articleTitle}${size}: ${r.deficit} fehlen (${parts.join(', ')})`;
		});
		const sent = await send(ctx, [
			{
				module: MODULE_ID,
				office: OFFICE_KEY,
				event: NOTIFY_STOCK_DEFICIT,
				subject: clip(
					`Nachbestellung nötig: ${missing.length} Artikel, ${total} Stück fehlen`,
					150
				),
				text: clip(['Diese Artikel fehlen im Lager:', '', ...lines].join('\n'), 4000),
				link: STOCK_LINK
			}
		]);
		if (!sent) return 'Ämter nicht aktiv – keine Meldung';
		await saveFingerprint(fingerprint);
		return `Fehlmengen gemeldet: ${missing.length} Artikel`;
	} catch (e) {
		console.error('[orders] Fehlmengen-Meldung fehlgeschlagen:', e);
		return 'Fehlmengen-Meldung fehlgeschlagen';
	}
}

async function saveFingerprint(fingerprint: string): Promise<void> {
	await mdb().transaction((tx) =>
		tx.execute(
			sql`INSERT INTO digest_state (key, fingerprint) VALUES (${DIGEST_KEY}, ${fingerprint})
				ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = now()`
		)
	);
}
