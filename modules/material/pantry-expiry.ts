/**
 * Job `pantry-expiry` (täglich): Chargen mit Bestand, deren MHD in höchstens `EXPIRY_WARN_DAYS` Tagen erreicht
 * oder schon überschritten ist, gehen einmal gesammelt an das Amt „Materialwart*in“.
 */
import { sql } from 'drizzle-orm';
import type { RequestContext } from '$lib/sdk/server';
import { addDays, formatDateDe } from '$lib/sdk/dates';
import { dateStr, idList, mdb, num, rows, str, today } from './db';
import { notifyFoodExpiring } from './notify';
import { EXPIRY_WARN_DAYS } from './pantry';
import { formatAmount } from './schemas';

export async function runPantryExpiry(ctx: RequestContext): Promise<string> {
	const t = today();
	const due = await mdb().transaction((tx) =>
		rows(
			tx,
			sql`SELECT b.id, b.product_id, b.quantity, to_char(b.best_before, 'YYYY-MM-DD') AS best_before,
					p.name, p.brand, p.unit
				FROM food_batches b JOIN food_products p ON p.id = b.product_id
				WHERE b.quantity > 0 AND b.expiry_notified_at IS NULL AND p.archived_at IS NULL
					AND b.best_before <= ${addDays(t, EXPIRY_WARN_DAYS)}::date
				ORDER BY b.best_before, lower(p.name), b.id`
		)
	);
	if (!due.length) return 'Nichts läuft ab';
	const lines = due.map((b) => {
		const date = dateStr(b.best_before);
		const brand = str(b.brand);
		return {
			productId: String(b.product_id),
			text:
				`${String(b.name)}${brand ? ` (${brand})` : ''}: ${formatAmount(num(b.quantity), str(b.unit))}, ` +
				`MHD ${formatDateDe(date)}${date < t ? ' – abgelaufen' : ''}`
		};
	});
	if (!(await notifyFoodExpiring(ctx, lines)))
		return `${due.length} Chargen offen (Ämter nicht aktiv)`;
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE food_batches SET expiry_notified_at = now()
				WHERE id IN (${idList(due.map((b) => String(b.id)))})`
		)
	);
	return `${due.length} Chargen gemeldet`;
}
