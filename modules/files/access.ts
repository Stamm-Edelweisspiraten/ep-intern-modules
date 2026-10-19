/**
 * Objektbezogene Zugriffsprüfung für Ordner/Dateien. Alle internen Endpunkte gehen hier durch.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.1. Signaturen nicht ändern.
 *
 * Regeln (Basisrecht `files.file.view` prüft der Router):
 *   - System-Kontext, `files.file.manage-all`                        -> edit (alles)
 *   - space `personal`: owner_id = ctx.userId                        -> edit
 *   - space `shared`: `files.shared.edit` -> edit, `files.shared.view` -> read
 *   - Principal-Freigabe auf dem Knoten ODER einem Vorfahren (vererbt) -> höchste Stufe gewinnt
 *   - gelöschte Knoten (Papierkorb) und ohne Zugriff                  -> 404 (Existenz nicht verraten)
 * `keys` = `principalKeysFor(ctx, 'files')`, immer VOR der Transaktion ermitteln.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, errors, principalMatchSql, type RequestContext, type Tx } from '$lib/sdk/server';
import { ancestorsOf, nodeRowOf, NODE_COLUMNS, rowsOf, type NodeRow } from './db';
import { PERMISSIONS, type AccessLevel, type Space } from './schemas';

export interface NodeAccess {
	node: NodeRow;
	level: AccessLevel;
}

/** Schutz gegen Zyklen beim Hochlaufen im Baum (MAX_DEPTH ist deutlich kleiner) */
const MAX_WALK = 64;

export function canManageAll(ctx: RequestContext): boolean {
	return ctx.actor.type === 'system' || core.permissions.has(ctx, PERMISSIONS.manageAll);
}

export function canSharedEdit(ctx: RequestContext): boolean {
	return canManageAll(ctx) || core.permissions.has(ctx, PERMISSIONS.sharedEdit);
}

export function canSharedView(ctx: RequestContext): boolean {
	return canSharedEdit(ctx) || core.permissions.has(ctx, PERMISSIONS.sharedView);
}

/** Höhere der beiden Stufen (`null` = kein Zugriff) */
function maxLevel(a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null {
	if (a === 'edit' || b === 'edit') return 'edit';
	return a ?? b;
}

/** Zugriff auf die (virtuelle) Wurzel eines Bereichs; `ownerId` nur für `personal` */
export function rootAccess(
	ctx: RequestContext,
	space: Space,
	ownerId: string | null
): AccessLevel | null {
	if (canManageAll(ctx)) return 'edit';
	if (space === 'personal') {
		return ctx.userId && ownerId === ctx.userId ? 'edit' : null;
	}
	if (core.permissions.has(ctx, PERMISSIONS.sharedEdit)) return 'edit';
	if (core.permissions.has(ctx, PERMISSIONS.sharedView)) return 'read';
	return null;
}

const idList = (ids: readonly string[]): SQL =>
	sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `
	);

/** Höchste Freigabestufe für den Aufrufer auf einer Liste von Knoten (z. B. Knoten + Vorfahren) */
async function shareLevelOn(
	tx: Tx,
	nodeIds: readonly string[],
	keys: readonly string[]
): Promise<AccessLevel | null> {
	if (nodeIds.length === 0 || keys.length === 0) return null;
	const rows = await rowsOf(
		tx,
		sql`SELECT DISTINCT s.level FROM node_shares s
			WHERE s.node_id IN (${idList(nodeIds)}) AND ${principalMatchSql('s', keys)}`
	);
	if (rows.some((r) => r.level === 'edit')) return 'edit';
	return rows.length > 0 ? 'read' : null;
}

/** Zugriff auf einen Knoten oder `null` (nicht vorhanden, im Papierkorb oder kein Zugriff) */
export async function resolveAccess(
	tx: Tx,
	ctx: RequestContext,
	nodeId: string,
	keys: readonly string[]
): Promise<NodeAccess | null> {
	const chain = await ancestorsOf(tx, nodeId);
	const node = chain[chain.length - 1];
	if (!node || node.id !== nodeId) return null;
	if (chain.some((n) => n.deletedAt !== null)) return null;

	let level = rootAccess(ctx, node.space, node.ownerId);
	if (level !== 'edit') {
		const shared = await shareLevelOn(
			tx,
			chain.map((n) => n.id),
			keys
		);
		level = maxLevel(level, shared);
	}
	return level ? { node, level } : null;
}

/** Wie `resolveAccess`; wirft `notFound` ohne Zugriff und `forbidden`, wenn `edit` verlangt, aber nur `read` da ist */
export async function requireNode(
	tx: Tx,
	ctx: RequestContext,
	nodeId: string,
	keys: readonly string[],
	need: AccessLevel = 'read'
): Promise<NodeAccess> {
	const access = await resolveAccess(tx, ctx, nodeId, keys);
	if (!access) throw errors.notFound('Datei oder Ordner nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten');
	}
	return access;
}

/**
 * Zielordner für Anlegen/Hochladen/Verschieben prüfen. `parentId = null` = Wurzel von `space`
 * (personal: Ablage von `ctx.userId`). Ziel muss ein Ordner sein (sonst 422). Liefert den Ordner
 * (`null` bei Wurzel), die Stufe und den `ownerId`, den neue Kinder bekommen (personal: Eigentümer*in des Ordners).
 */
export async function requireFolderTarget(
	tx: Tx,
	ctx: RequestContext,
	space: Space,
	parentId: string | null,
	keys: readonly string[],
	need: AccessLevel = 'edit'
): Promise<{ folder: NodeRow | null; level: AccessLevel; ownerId: string }> {
	if (parentId === null) {
		let ownerId: string;
		if (space === 'personal') {
			if (!ctx.userId)
				throw errors.forbidden('„Meine Dateien“ gibt es nur für angemeldete Personen');
			ownerId = ctx.userId;
		} else {
			ownerId = ctx.userId ?? ctx.actor.id ?? 'system';
		}
		const level = rootAccess(ctx, space, space === 'personal' ? ownerId : null);
		if (!level) throw errors.forbidden('Kein Zugriff auf diesen Bereich');
		if (need === 'edit' && level !== 'edit') {
			throw errors.forbidden('Keine Berechtigung zum Bearbeiten');
		}
		return { folder: null, level, ownerId };
	}

	const { node, level } = await requireNode(tx, ctx, parentId, keys, need);
	if (node.kind !== 'folder') {
		throw errors.validation(
			[{ path: ['parentId'], message: 'Ziel ist kein Ordner' }],
			'Ziel ist kein Ordner'
		);
	}
	if (node.space !== space) {
		throw errors.validation(
			[{ path: ['parentId'], message: 'Ordner gehört zu einem anderen Bereich' }],
			'Ordner gehört zu einem anderen Bereich'
		);
	}
	return { folder: node, level, ownerId: node.ownerId };
}

/** Zugriffsstufe je Knoten für Listen (ein Abfrageschritt, Vererbung berücksichtigt) */
export async function accessForMany(
	tx: Tx,
	ctx: RequestContext,
	nodes: readonly NodeRow[],
	keys: readonly string[]
): Promise<Map<string, AccessLevel>> {
	const map = new Map<string, AccessLevel>();
	const open: NodeRow[] = [];
	for (const n of nodes) {
		if (n.deletedAt !== null) continue;
		const base = rootAccess(ctx, n.space, n.ownerId);
		if (base) map.set(n.id, base);
		if (base !== 'edit') open.push(n);
	}
	if (open.length === 0 || keys.length === 0) return map;

	// Vorfahrenkette je Startknoten und höchste passende Freigabe darauf (2 = edit, 1 = read)
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE chain AS (
			SELECT n.id AS start_id, n.id, n.parent_id, 0 AS depth
			FROM nodes n WHERE n.id IN (${idList([...new Set(open.map((n) => n.id))])})
			UNION ALL
			SELECT c.start_id, p.id, p.parent_id, c.depth + 1
			FROM chain c JOIN nodes p ON p.id = c.parent_id
			WHERE c.depth < ${MAX_WALK}
		)
		SELECT c.start_id, MAX(CASE WHEN s.level = 'edit' THEN 2 ELSE 1 END) AS lvl
		FROM chain c JOIN node_shares s ON s.node_id = c.id
		WHERE ${principalMatchSql('s', keys)}
		GROUP BY c.start_id`
	);
	for (const r of rows) {
		const id = String(r.start_id);
		const shared: AccessLevel = Number(r.lvl) >= 2 ? 'edit' : 'read';
		map.set(id, maxLevel(map.get(id) ?? null, shared)!);
	}
	return map;
}

/** Rekursive Vorfahrenkette ab `startExpr` (inkl.) als Unterabfrage mit passender Freigabe */
function sharedOnChainSql(startExpr: SQL, keys: readonly string[]): SQL {
	return sql`EXISTS (
		WITH RECURSIVE up AS (
			SELECT a.id, a.parent_id, 0 AS depth FROM nodes a WHERE a.id = ${startExpr}
			UNION ALL
			SELECT p.id, p.parent_id, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT 1 FROM up JOIN node_shares us ON us.node_id = up.id
		WHERE ${principalMatchSql('us', keys)}
	)`;
}

/**
 * „Mit mir geteilt“: Knoten mit direkter Freigabe an einen meiner Principals, die mir nicht ohnehin
 * gehören/über den Bereich zugänglich sind und deren Vorfahren mir nicht schon freigegeben sind.
 */
export async function sharedWithMeRoots(
	tx: Tx,
	ctx: RequestContext,
	keys: readonly string[]
): Promise<NodeRow[]> {
	if (keys.length === 0 || canManageAll(ctx)) return [];
	const uid = ctx.userId ?? '';
	const notViaSpace = canSharedView(ctx)
		? sql`n.space = 'personal' AND n.owner_id <> ${uid}`
		: sql`NOT (n.space = 'personal' AND n.owner_id = ${uid})`;
	const rows = await rowsOf(
		tx,
		sql`SELECT ${NODE_COLUMNS} FROM nodes n
			WHERE n.deleted_at IS NULL
				AND ${notViaSpace}
				AND EXISTS (
					SELECT 1 FROM node_shares s
					WHERE s.node_id = n.id AND ${principalMatchSql('s', keys)}
				)
				AND NOT (n.parent_id IS NOT NULL AND ${sharedOnChainSql(sql`n.parent_id`, keys)})
			ORDER BY CASE WHEN n.kind = 'folder' THEN 0 ELSE 1 END, lower(n.name), n.id`
	);
	return rows.map(nodeRowOf);
}

/**
 * SQL-Bedingung (Alias `n`) für Suche: Knoten, die der Aufrufer sehen darf (inkl. Vererbung).
 * Prüft **nicht** `deleted_at` – der Aufrufer filtert gelöschte Knoten selbst (`n.deleted_at IS NULL`).
 */
export function visibleNodesFilter(ctx: RequestContext, keys: readonly string[]): SQL {
	if (canManageAll(ctx)) return sql`TRUE`;
	const uid = ctx.userId ?? '';
	const parts: SQL[] = [sql`(n.space = 'personal' AND n.owner_id = ${uid})`];
	if (canSharedView(ctx)) parts.push(sql`n.space = 'shared'`);
	if (keys.length > 0) parts.push(sharedOnChainSql(sql`n.id`, keys));
	return sql`(${sql.join(parts, sql` OR `)})`;
}
