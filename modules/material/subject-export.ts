/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Reservierungen, die das Konto angelegt hat,
 * sowie die vom Konto ausgelösten Verlaufseinträge (ohne Daten Dritter). Eigene Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import type { DataSubject, ModuleSubjectExport } from '$lib/sdk/server';
import { dateStr, iso, mdb, num, rows, str } from './db';

async function run({ userId }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!userId) return null;
	return mdb().transaction(async (tx) => {
		const reservations = await rows(
			tx,
			sql`SELECT id, title, status, starts_on, ends_on, notes, created_at FROM reservations
				WHERE created_by = ${userId} ORDER BY created_at, id`
		);
		const movements = await rows(
			tx,
			sql`SELECT kind, detail, note, quantity, created_at FROM movements
				WHERE actor_id = ${userId} ORDER BY created_at, id`
		);
		if (!reservations.length && !movements.length) return null;
		return {
			reservations: reservations.map((r) => ({
				id: String(r.id),
				title: String(r.title),
				status: String(r.status),
				startsOn: dateStr(r.starts_on),
				endsOn: dateStr(r.ends_on),
				notes: str(r.notes),
				createdAt: iso(r.created_at)
			})),
			actions: movements.map((m) => ({
				kind: String(m.kind),
				detail: str(m.detail),
				note: str(m.note),
				quantity: m.quantity == null ? null : num(m.quantity),
				at: iso(m.created_at)
			}))
		};
	});
}

export const subjectExport: ModuleSubjectExport = { run };
