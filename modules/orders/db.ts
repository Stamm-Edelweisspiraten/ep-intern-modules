/**
 * Gemeinsame Server-Helfer des Moduls `orders`: Transaktion, Zeilen, Datum, Nummernvergabe und Zugriff
 * auf die Dienste anderer Module. Dienste (`members`, `treasury`, `offices`) und `core.*` nur
 * AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite hat eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import { core, type Tx } from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import type { OfficesService } from '$lib/modules/offices/contract';
import type { TreasuryService } from '$lib/modules/treasury/contract';
import { MODULE_ID } from './schemas';
import { formatNumber } from './stock';

export type Row = Record<string, unknown>;

export const mdb = () => core.database.forModule(MODULE_ID);

export async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
	return ((await tx.execute(query)) as unknown as { rows: Row[] }).rows;
}

/** pg liefert Date, PGlite Strings */
export const iso = (v: unknown): string => {
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
export const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
export const num = (v: unknown): number => Number(v ?? 0);
export const str = (v: unknown): string | null => (v == null ? null : String(v));

export const idList = (ids: string[]) =>
	sql.join(
		ids.map((v) => sql`${v}`),
		sql`, `
	);

let todayOverride: string | null = null;
/** Nur für Tests: festes „heute“ (`YYYY-MM-DD`) */
export function setOrdersTodayForTests(d: string | null): void {
	todayOverride = d;
}
/** Heutiges Datum in Deutschland */
export function today(): string {
	return (
		todayOverride ??
		new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
	);
}

/**
 * Nächste Nummer `<prefix>-JJJJ-NNNN` für `orders` (B) bzw. `supplier_orders` (E), serialisiert per
 * Advisory-Lock bis zum Transaktionsende.
 */
export async function nextNumber(
	tx: Tx,
	table: 'orders' | 'supplier_orders',
	date: string = today()
): Promise<{ number: string; year: number; seq: number }> {
	const year = Number(date.slice(0, 4));
	const prefix = table === 'orders' ? 'B' : 'E';
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`orders.number.${table}`}))`);
	const [r] = await rows(
		tx,
		table === 'orders'
			? sql`SELECT coalesce(max(seq), 0) + 1 AS next FROM orders WHERE year = ${year}`
			: sql`SELECT coalesce(max(seq), 0) + 1 AS next FROM supplier_orders WHERE year = ${year}`
	);
	const seq = num(r?.next) || 1;
	return { number: formatNumber(prefix, year, seq), year, seq };
}

/** `members` ist harte Abhängigkeit */
export const membersService = () => core.modules.use<MembersService>('members', MODULE_ID);

/** `null`, wenn die Kasse nicht aktiv ist (oder nicht geladen werden kann) */
export async function treasuryService(): Promise<TreasuryService | null> {
	try {
		return await core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);
	} catch {
		return null;
	}
}

/** `null`, wenn `offices` nicht aktiv ist */
export async function officesService(): Promise<OfficesService | null> {
	try {
		return await core.modules.useOptional<OfficesService>('offices', MODULE_ID);
	} catch {
		return null;
	}
}

/** Namen von Benutzer*innen (für „bestellt von“/„angelegt von“), Unbekannte fehlen */
export async function userNames(
	ctx: Parameters<typeof core.users.directory>[0],
	ids: (string | null | undefined)[]
): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((v): v is string => !!v))];
	const map = new Map<string, string>();
	if (!unique.length) return map;
	// Verzeichnis liefert höchstens 30 je Aufruf
	for (let i = 0; i < unique.length; i += 30) {
		const ids = unique.slice(i, i + 30);
		const list = await core.users.directory(ctx, { ids, limit: ids.length });
		for (const u of list) map.set(u.id, u.name);
	}
	return map;
}
