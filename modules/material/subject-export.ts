/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Reservierungen, die das Konto angelegt hat,
 * sowie vom Konto gemeldete Zustände (ohne Daten Dritter). Eigene Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import type { DataSubject, ModuleSubjectExport } from '$lib/sdk/server';
import { dateStr, iso, mdb, rows, str } from './db';

async function run({ userId }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!userId) return null;
	return mdb().transaction(async (tx) => {
		const reservations = await rows(
			tx,
			sql`SELECT id, title, purpose, status, starts_on, ends_on, notes, created_at FROM reservations
				WHERE created_by = ${userId} ORDER BY created_at, id`
		);
		const reports = await rows(
			tx,
			sql`SELECT name, code, condition, condition_note, condition_reported_at FROM items
				WHERE condition_reported_by = ${userId} ORDER BY condition_reported_at, id`
		);
		if (!reservations.length && !reports.length) return null;
		return {
			reservations: reservations.map((r) => ({
				id: String(r.id),
				title: String(r.title),
				purpose: String(r.purpose),
				status: String(r.status),
				startsOn: dateStr(r.starts_on),
				endsOn: dateStr(r.ends_on),
				notes: str(r.notes),
				createdAt: iso(r.created_at)
			})),
			conditionReports: reports.map((r) => ({
				item: String(r.name),
				code: String(r.code),
				condition: String(r.condition),
				note: str(r.condition_note),
				at: r.condition_reported_at ? iso(r.condition_reported_at) : null
			}))
		};
	});
}

export const subjectExport: ModuleSubjectExport = { run };
