/**
 * Gemeinsame Server-Helfer des Moduls `material`: Transaktion, Zeilen, Codes, Verlauf, Namen und
 * optionale Dienste. Dienste (`actions`, `offices`) und `core.*` nur AUSSERHALB offener
 * Modul-Transaktionen aufrufen (PGlite hat eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	inList as idList,
	moduleDb,
	num,
	rowsOf as rows,
	str as strOrNull,
	toIso as iso,
	toIsoOrNull as isoOrNull,
	type RequestContext,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { todayBerlin } from '$lib/sdk/dates';
import type { ActionsService } from '$lib/modules/actions/contract';
import type { OfficesService } from '$lib/modules/offices/contract';
import { CODE_PREFIX, MODULE_ID, PERMISSIONS, type CodeKind } from './schemas';

export { idList, iso, isoOrNull, num, rows, strOrNull, type Row };

/** Spaltenwert als Text, `null` → `''` */
export const str = (v: unknown): string => strOrNull(v) ?? '';

export const mdb = () => moduleDb(MODULE_ID);

export const today = (): string => todayBerlin();

/** `true`/`'t'` (Treiber-Unterschiede) */
export const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true';

/** Datum `YYYY-MM-DD` aus einer `date`-Spalte (String oder Date) */
export function dateStr(v: unknown): string {
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return String(v ?? '').slice(0, 10);
}

export const canManage = (ctx: RequestContext) => ctx.permissions.has(PERMISSIONS.manage);
export const canHandleAll = (ctx: RequestContext) => ctx.permissions.has(PERMISSIONS.reservations);

/** Code formatieren: `M-000123` */
export function formatCode(kind: CodeKind, value: number): string {
	return `${CODE_PREFIX[kind]}-${String(value).padStart(6, '0')}`;
}

/** Ist der Code irgendwo vergeben (Stück, Set, Ort)? */
export async function codeInUse(tx: Tx, code: string, except?: string): Promise<boolean> {
	const [r] = await rows(
		tx,
		sql`SELECT 1 AS x FROM units WHERE code = ${code} AND id::text <> ${except ?? ''}
			UNION ALL SELECT 1 FROM sets WHERE code = ${code} AND id::text <> ${except ?? ''}
			UNION ALL SELECT 1 FROM locations WHERE code = ${code} AND id::text <> ${except ?? ''}
			UNION ALL SELECT 1 FROM articles WHERE code = ${code} AND id::text <> ${except ?? ''}
			LIMIT 1`
	);
	return !!r;
}

/**
 * Nächste freie Codes einer Art (fortlaufend, unter Advisory-Lock bis Transaktionsende). Übersprungen
 * werden Codes, die schon (z. B. von Hand) vergeben oder vorab reserviert sind.
 */
export async function nextCodes(tx: Tx, kind: CodeKind, count: number): Promise<string[]> {
	const prefix = CODE_PREFIX[kind];
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'material:codes'}))`);
	const [r] = await rows(tx, sql`SELECT value FROM code_counters WHERE prefix = ${prefix}`);
	let value = num(r?.value);
	const out: string[] = [];
	while (out.length < count) {
		value++;
		const code = formatCode(kind, value);
		if (await codeInUse(tx, code)) continue;
		const [reserved] = await rows(tx, sql`SELECT 1 AS x FROM reserved_codes WHERE code = ${code}`);
		if (reserved) continue;
		out.push(code);
	}
	await tx.execute(
		sql`INSERT INTO code_counters (prefix, value) VALUES (${prefix}, ${value})
			ON CONFLICT (prefix) DO UPDATE SET value = EXCLUDED.value`
	);
	return out;
}

/**
 * Eigenen Code übernehmen (vorab gedrucktes Etikett oder Herstellercode): muss frei sein; ein
 * reservierter Code wird dabei verbraucht. Ebenfalls unter der Code-Sperre.
 */
export async function claimCode(tx: Tx, code: string, except?: string): Promise<string> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'material:codes'}))`);
	if (await codeInUse(tx, code, except)) {
		throw errors.validation([{ path: ['code'], message: 'Dieser Code ist schon vergeben' }]);
	}
	await tx.execute(sql`DELETE FROM reserved_codes WHERE code = ${code}`);
	return code;
}

export interface MovementInput {
	kind: string;
	unitId?: string | null;
	articleId?: string | null;
	quantity?: number | null;
	detail?: string;
	note?: string;
	reservationId?: string | null;
}

/** Verlaufseintrag schreiben (gleiche Transaktion wie die Änderung) */
export async function logMovement(tx: Tx, ctx: RequestContext, m: MovementInput): Promise<void> {
	await tx.execute(
		sql`INSERT INTO movements (id, kind, unit_id, article_id, quantity, detail, note, reservation_id, actor_id)
			VALUES (${crypto.randomUUID()}, ${m.kind}, ${m.unitId ?? null}, ${m.articleId ?? null},
				${m.quantity ?? null}, ${m.detail ?? ''}, ${m.note ?? ''}, ${m.reservationId ?? null},
				${ctx.userId ?? null})`
	);
}

/** Namen von Benutzer*innen; Unbekannte fehlen */
export async function userNames(
	ctx: RequestContext,
	ids: (string | null | undefined)[]
): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((v): v is string => !!v))];
	const map = new Map<string, string>();
	if (!unique.length) return map;
	for (const u of (await core.users.byIds(ctx, unique)).values()) map.set(u.id, u.name);
	return map;
}

/** `null`, wenn `actions` nicht aktiv ist */
export function actionsService(): Promise<ActionsService | null> {
	return core.modules.useOptional<ActionsService>('actions', MODULE_ID);
}

/** `null`, wenn `offices` nicht aktiv ist */
export function officesService(): Promise<OfficesService | null> {
	return core.modules.useOptional<OfficesService>('offices', MODULE_ID);
}
