/**
 * Gemeinsame Server-Helfer des Moduls `orders`: Transaktion, Zeilen, Datum, Nummernvergabe und Zugriff
 * auf die Dienste anderer Module. Dienste (`members`, `treasury`, `offices`) und `core.*` nur
 * AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite hat eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	inList as idList,
	moduleDb,
	num,
	rowsOf as rows,
	str,
	toIso as iso,
	toIsoOrNull as isoOrNull,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { todayBerlin } from '$lib/sdk/dates';
import type { MembersService } from '$lib/modules/members/contract';
import type { OfficesService } from '$lib/modules/offices/contract';
import type { TreasuryService } from '$lib/modules/treasury/contract';
import { MODULE_ID } from './schemas';
import { formatNumber } from './stock';

/** Grundhelfer aus dem SDK (`$lib/sdk/server/db.ts`), unter den im Modul üblichen Namen */
export { idList, iso, isoOrNull, num, rows, str, type Row };

export const mdb = () => moduleDb(MODULE_ID);

/** Heutiges Datum in Deutschland (zentral, Test-Override über `setTodayForTests` aus `$lib/sdk/dates`) */
export const today = (): string => todayBerlin();

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

/**
 * `null`, wenn die Kasse nicht registriert oder nicht aktiv ist. Andere Fehler (z. B. fehlende
 * `optionalDependencies`-Angabe) sind Programmierfehler und werden bewusst nicht geschluckt (#46).
 */
export function treasuryService(): Promise<TreasuryService | null> {
	return core.modules.useOptional<TreasuryService>('treasury', MODULE_ID);
}

/** `null`, wenn `offices` nicht registriert oder nicht aktiv ist (Fehler wie bei `treasuryService`) */
export function officesService(): Promise<OfficesService | null> {
	return core.modules.useOptional<OfficesService>('offices', MODULE_ID);
}

/** Namen von Benutzer*innen (für „bestellt von“/„angelegt von“), Unbekannte fehlen */
export async function userNames(
	ctx: Parameters<typeof core.users.directory>[0],
	ids: (string | null | undefined)[]
): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((v): v is string => !!v))];
	const map = new Map<string, string>();
	if (!unique.length) return map;
	for (const u of (await core.users.byIds(ctx, unique)).values()) map.set(u.id, u.name);
	return map;
}
