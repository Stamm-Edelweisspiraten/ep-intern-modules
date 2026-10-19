/**
 * Datenbank-Grundlagen des Moduls `files`: Transaktion, Zeilen-Mapping, Einstellungen, Namen.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.1. Signaturen nicht ändern.
 * `core.*` (außer `core.database`) nie in einer offenen Transaktion aufrufen (PGlite).
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, type RequestContext, type Tx } from '$lib/sdk/server';
import {
	DEFAULT_QUOTA_MB,
	DEFAULT_TRASH_DAYS,
	MODULE_ID,
	SETTING_KEYS,
	type NodeKind,
	type Space,
	type UserRef
} from './schemas';

export type Row = Record<string, unknown>;

export const mdb = () => core.database.forModule(MODULE_ID);

/** Systemkontext für Storage-Zugriffe NACH der Objektprüfung (Benutzer brauchen keine Storage-Rechte) */
export const filesCtx = (): RequestContext => core.auth.systemContext('files-storage');

/** Rohe Zeile eines Knotens (camelCase, Zeitstempel als ISO-String) */
export interface NodeRow {
	id: string;
	parentId: string | null;
	kind: NodeKind;
	space: Space;
	ownerId: string;
	name: string;
	storagePath: string | null;
	contentType: string | null;
	sizeBytes: number | null;
	thumbPath: string | null;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	deletedBy: string | null;
	trashRoot: boolean;
}

/** Spaltenliste für `SELECT … FROM nodes n` (Alias `n`), passend zu `nodeRowOf` */
export const NODE_COLUMNS: SQL = sql`n.id, n.parent_id, n.kind, n.space, n.owner_id, n.name, n.storage_path,
	n.content_type, n.size_bytes, n.thumb_path, n.created_by, n.created_at, n.updated_at, n.deleted_at,
	n.deleted_by, n.trash_root`;

/** Schutz gegen Zyklen im Baum (MAX_DEPTH ist deutlich kleiner) */
const MAX_WALK = 64;
/** `core.users.directory` liefert höchstens 30 Einträge je Aufruf */
const DIRECTORY_CHUNK = 30;

export async function rowsOf(tx: Tx, query: SQL): Promise<Row[]> {
	const res = (await tx.execute(query)) as unknown as { rows: Row[] };
	return res.rows;
}

/** pg liefert `Date`, PGlite Strings → immer ISO-String */
export function toIso(v: unknown): string {
	if (v instanceof Date) return v.toISOString();
	return new Date(String(v)).toISOString();
}

const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : toIso(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true' || v === 1;

export function nodeRowOf(r: Row): NodeRow {
	const size = r.size_bytes;
	return {
		id: String(r.id),
		parentId: strOrNull(r.parent_id),
		kind: String(r.kind) as NodeKind,
		space: String(r.space) as Space,
		ownerId: String(r.owner_id),
		name: String(r.name),
		storagePath: strOrNull(r.storage_path),
		contentType: strOrNull(r.content_type),
		sizeBytes: size === null || size === undefined ? null : Number(size),
		thumbPath: strOrNull(r.thumb_path),
		createdBy: strOrNull(r.created_by),
		createdAt: toIso(r.created_at),
		updatedAt: toIso(r.updated_at),
		deletedAt: isoOrNull(r.deleted_at),
		deletedBy: strOrNull(r.deleted_by),
		trashRoot: bool(r.trash_root)
	};
}

/** Knoten laden; gelöschte (Papierkorb) nur mit `includeDeleted` */
export async function loadNode(
	tx: Tx,
	id: string,
	opts: { includeDeleted?: boolean } = {}
): Promise<NodeRow | null> {
	const deleted = opts.includeDeleted ? sql`` : sql` AND n.deleted_at IS NULL`;
	const [row] = await rowsOf(
		tx,
		sql`SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id = ${id}${deleted}`
	);
	return row ? nodeRowOf(row) : null;
}

/** Mehrere Knoten laden (Reihenfolge beliebig), gelöschte nur mit `includeDeleted` */
export async function loadNodes(
	tx: Tx,
	ids: readonly string[],
	opts: { includeDeleted?: boolean } = {}
): Promise<NodeRow[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	const deleted = opts.includeDeleted ? sql`` : sql` AND n.deleted_at IS NULL`;
	const list = sql.join(
		unique.map((id) => sql`${id}`),
		sql`, `
	);
	const rows = await rowsOf(
		tx,
		sql`SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id IN (${list})${deleted}`
	);
	return rows.map(nodeRowOf);
}

/**
 * Vorfahren eines Knotens inkl. ihm selbst, von der Wurzel abwärts (rekursives CTE über `parent_id`).
 * Gelöschte Vorfahren sind enthalten (Aufrufer prüft `deletedAt`).
 */
export async function ancestorsOf(tx: Tx, id: string): Promise<NodeRow[]> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE up AS (
			SELECT n.*, 0 AS depth FROM nodes n WHERE n.id = ${id}
			UNION ALL
			SELECT p.*, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT ${NODE_COLUMNS} FROM up n ORDER BY n.depth DESC`
	);
	return rows.map(nodeRowOf);
}

/** IDs aller Nachfahren (ohne den Knoten selbst), auch gelöschte */
export async function descendantIds(tx: Tx, id: string): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE down AS (
			SELECT c.id, 1 AS depth FROM nodes c WHERE c.parent_id = ${id}
			UNION ALL
			SELECT c.id, down.depth + 1 FROM nodes c JOIN down ON c.parent_id = down.id
			WHERE down.depth < ${MAX_WALK}
		)
		SELECT DISTINCT id FROM down`
	);
	return rows.map((r) => String(r.id));
}

/** Namen zu Benutzer-IDs (NACH der Transaktion; unbekannt → „Unbekannt“) */
export async function userRefs(
	ctx: RequestContext,
	ids: readonly (string | null | undefined)[]
): Promise<Map<string, UserRef>> {
	const unique = [...new Set(ids.filter((v): v is string => !!v))];
	const map = new Map<string, UserRef>();
	if (unique.length === 0) return map;
	// `directory` braucht nur eine Anmeldung; Kontexte ohne Benutzer (z. B. Jobs) laufen als System
	const dirCtx =
		ctx.userId || ctx.actor.type === 'system' ? ctx : core.auth.systemContext('files-names');
	for (let i = 0; i < unique.length; i += DIRECTORY_CHUNK) {
		const chunk = unique.slice(i, i + DIRECTORY_CHUNK);
		const users = await core.users.directory(dirCtx, { ids: chunk, limit: chunk.length });
		for (const u of users) map.set(u.id, { id: u.id, name: u.name });
	}
	for (const id of unique) if (!map.has(id)) map.set(id, { id, name: 'Unbekannt' });
	return map;
}

async function numberSetting(key: string, fallback: number): Promise<number> {
	try {
		const v = Number(await core.settings.get(key));
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
	} catch {
		return fallback;
	}
}

/** Modul-Einstellungen (NICHT in einer Transaktion) */
export async function filesSettings(): Promise<{ quotaBytes: number | null; trashDays: number }> {
	const quotaMb = await numberSetting(SETTING_KEYS.quotaMb, DEFAULT_QUOTA_MB);
	const trashDays = await numberSetting(SETTING_KEYS.trashDays, DEFAULT_TRASH_DAYS);
	return {
		quotaBytes: quotaMb === 0 ? null : quotaMb * 1024 * 1024,
		trashDays: trashDays >= 1 ? trashDays : DEFAULT_TRASH_DAYS
	};
}
