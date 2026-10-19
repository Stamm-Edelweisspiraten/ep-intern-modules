/**
 * Ordner/Dateien: Auflisten, Anlegen, Umbenennen, Verschieben, Suche, „Mit mir geteilt“, DTO-Aufbau.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.3. Signaturen nicht ändern.
 * Muster: `principalKeysFor` vor der Transaktion → DB in `mdb().transaction` → Namen (`userRefs`) danach → Audit danach.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import {
	accessForMany,
	canManageAll,
	requireFolderTarget,
	requireNode,
	rootAccess,
	sharedWithMeRoots,
	visibleNodesFilter
} from './access';
import {
	ancestorsOf,
	descendantIds,
	filesSettings,
	loadNode,
	mdb,
	NODE_COLUMNS,
	nodeRowOf,
	rowsOf,
	userRefs,
	type NodeRow
} from './db';
import { displayPath, normalizeName, uniqueName } from './names';
import { keysFor } from './shares.service';
import { assertQuota } from './storage';
import {
	MAX_DEPTH,
	MAX_SEARCH_RESULTS,
	SPACE_LABELS,
	type AccessLevel,
	type Breadcrumb,
	type BulkResult,
	type FileNode,
	type FolderCreateInput,
	type FolderListing,
	type MoveInput,
	type SearchResult,
	type Space,
	type UserRef
} from './schemas';

/** Zusatzinfos je Knoten für `FileNode` (in der Transaktion ermittelt) */
export interface NodeExtras {
	access: AccessLevel;
	/** Darf Freigaben/Links verwalten (Bereichsrecht, nicht über eine Freigabe) */
	canShare: boolean;
	shared: boolean;
	linked: boolean;
	childCount: number | null;
}

// ---------------------------------------------------------------------------
// Interne Helfer
// ---------------------------------------------------------------------------

/** Größe der `IN (…)`-Listen je Abfrage */
const CHUNK = 500;
const SHARED_WITH_ME_LABEL = 'Mit mir geteilt';

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

const idList = (ids: readonly string[]): SQL =>
	sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `
	);

const maxLevel = (a: AccessLevel | null | undefined, b: AccessLevel | null | undefined) =>
	a === 'edit' || b === 'edit' ? 'edit' : a === 'read' || b === 'read' ? 'read' : null;

/** Sortierung: Ordner zuerst, dann Name (de, ohne Groß/Klein, Zahlen natürlich) */
function compareNodes(a: NodeRow, b: NodeRow): number {
	if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
	return a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true });
}

/** Bedingung „gleicher Ordner“ (Alias `n`) – passend zum Unique-Index der Migration */
function siblingCondition(input: { space: Space; ownerId: string; parentId: string | null }): SQL {
	if (input.parentId) return sql`n.parent_id = ${input.parentId}`;
	if (input.space === 'shared') return sql`n.parent_id IS NULL AND n.space = 'shared'`;
	return sql`n.parent_id IS NULL AND n.space = 'personal' AND n.owner_id = ${input.ownerId}`;
}

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function conflictError(name: string, existing: readonly string[]) {
	return errors.conflict(
		`Es gibt hier schon „${name}“. Vorschlag: „${uniqueName(existing, name)}“`
	);
}

/** Verletzung des Unique-Index (gleichzeitiges Anlegen) erkennen */
function isUniqueViolation(e: unknown): boolean {
	let cur: unknown = e;
	for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
		if (String((cur as { code?: unknown }).code) === '23505') return true;
		cur = (cur as { cause?: unknown }).cause;
	}
	return false;
}

function depthError(path: string) {
	return errors.validation([
		{ path: [path], message: `Höchstens ${MAX_DEPTH} Ordnerebenen möglich` }
	]);
}

/** Tiefe eines Knotens (Wurzel-Kind = 1) */
async function depthOf(tx: Tx, id: string | null): Promise<number> {
	if (!id) return 0;
	return (await ancestorsOf(tx, id)).length;
}

/** Höhe des Teilbaums unter einem Knoten (Datei/leerer Ordner = 0), inkl. gelöschter Nachfahren */
async function subtreeHeight(tx: Tx, id: string): Promise<number> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE t(id, d) AS (
				SELECT id, 0 FROM nodes WHERE id = ${id}
				UNION ALL
				SELECT c.id, t.d + 1 FROM nodes c JOIN t ON c.parent_id = t.id WHERE t.d < ${MAX_DEPTH + 1}
			)
			SELECT COALESCE(max(d), 0) AS h FROM t`
	);
	return Number(rows[0]?.h ?? 0);
}

/** Summe der Dateigrößen eines Teilbaums (inkl. Papierkorb-Einträge) */
async function subtreeBytes(tx: Tx, id: string): Promise<number> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE t(id) AS (
				SELECT id FROM nodes WHERE id = ${id}
				UNION ALL
				SELECT c.id FROM nodes c JOIN t ON c.parent_id = t.id
			)
			SELECT COALESCE(sum(n.size_bytes), 0) AS b FROM nodes n JOIN t ON t.id = n.id
			WHERE n.kind = 'file'`
	);
	return Number(rows[0]?.b ?? 0);
}

/** Wurzel-Eigentümer*in für die Wurzel-Prüfung (`null` bei shared) */
const rootOwner = (node: Pick<NodeRow, 'space' | 'ownerId'>) =>
	node.space === 'personal' ? node.ownerId : null;

/** Daten für DTOs aus der Transaktion: Zeilen + Extras */
interface NodeBundle {
	rows: NodeRow[];
	extras: Map<string, NodeExtras>;
}

async function bundle(
	tx: Tx,
	ctx: RequestContext,
	rows: NodeRow[],
	keys: readonly string[],
	minLevel: AccessLevel | null = null
): Promise<NodeBundle> {
	const levels = rows.length ? await accessForMany(tx, ctx, rows, keys) : new Map();
	const access = new Map<string, AccessLevel>();
	for (const r of rows) access.set(r.id, maxLevel(levels.get(r.id), minLevel) ?? 'read');
	return { rows, extras: await extrasForMany(tx, rows, access, ctx) };
}

async function usersFor(ctx: RequestContext, rows: readonly NodeRow[]) {
	return userRefs(
		ctx,
		rows.map((r) => r.createdBy)
	);
}

function toDtos(b: NodeBundle, users: Map<string, UserRef>): FileNode[] {
	return b.rows.map((r) => toFileNode(r, b.extras.get(r.id)!, users));
}

async function loadWithKeys(ctx: RequestContext, id: string, keys: readonly string[]) {
	const b = await mdb().transaction(async (tx) => {
		const row = await loadNode(tx, id);
		if (!row) throw errors.notFound('Datei oder Ordner nicht gefunden');
		return bundle(tx, ctx, [row], keys);
	});
	return toDtos(b, await usersFor(ctx, b.rows))[0]!;
}

// ---------------------------------------------------------------------------
// Öffentliche Funktionen
// ---------------------------------------------------------------------------

/** Bereichsberechtigt (Eigentümer*in, Stammesordner mit `files.shared.edit`, `manage-all`) – Freigaben zählen nicht */
function hasRootEdit(ctx: RequestContext, row: Pick<NodeRow, 'space' | 'ownerId'>): boolean {
	return canManageAll(ctx) || rootAccess(ctx, row.space, rootOwner(row)) === 'edit';
}

/** Extras (Freigaben/Links/Kinderzahl) für viele Knoten in der Transaktion; ohne `ctx` ist `canShare` immer `false` */
export async function extrasForMany(
	tx: Tx,
	rows: readonly NodeRow[],
	access: Map<string, AccessLevel>,
	ctx?: RequestContext
): Promise<Map<string, NodeExtras>> {
	const out = new Map<string, NodeExtras>();
	const byId = new Map(rows.map((r) => [r.id, r]));
	const canShareOf = (id: string) => {
		const row = byId.get(id);
		return !!ctx && !!row && hasRootEdit(ctx, row);
	};
	const ids = [...new Set(rows.map((r) => r.id))];
	for (const part of chunks(ids)) {
		const res = await rowsOf(
			tx,
			sql`SELECT n.id,
					EXISTS (SELECT 1 FROM node_shares s WHERE s.node_id = n.id) AS shared,
					EXISTS (SELECT 1 FROM share_links l WHERE l.node_id = n.id AND l.revoked_at IS NULL
						AND (l.expires_on IS NULL OR l.expires_on >= CURRENT_DATE)) AS linked,
					CASE WHEN n.kind = 'folder' THEN
						(SELECT count(*) FROM nodes c WHERE c.parent_id = n.id AND c.deleted_at IS NULL)
					END AS child_count
				FROM nodes n WHERE n.id IN (${idList(part)})`
		);
		for (const r of res) {
			const id = String(r.id);
			out.set(id, {
				access: access.get(id) ?? 'read',
				canShare: canShareOf(id),
				shared: r.shared === true || r.shared === 't',
				linked: r.linked === true || r.linked === 't',
				childCount: r.child_count == null ? null : Number(r.child_count)
			});
		}
	}
	// Fallback für Knoten ohne Treffer (sollte nicht vorkommen)
	for (const r of rows) {
		if (!out.has(r.id)) {
			out.set(r.id, {
				access: access.get(r.id) ?? 'read',
				canShare: canShareOf(r.id),
				shared: false,
				linked: false,
				childCount: r.kind === 'folder' ? 0 : null
			});
		}
	}
	return out;
}

/** DTO aus Zeile + Extras + Namen (rein) */
export function toFileNode(
	row: NodeRow,
	extras: NodeExtras,
	users: Map<string, UserRef>
): FileNode {
	const isFile = row.kind === 'file';
	return {
		id: row.id,
		parentId: row.parentId,
		kind: row.kind,
		space: row.space,
		name: row.name,
		ownerId: row.ownerId,
		contentType: isFile ? row.contentType : null,
		sizeBytes: isFile ? (row.sizeBytes ?? 0) : null,
		hasThumb: isFile && !!row.thumbPath,
		access: extras.access,
		canShare: extras.canShare,
		shared: extras.shared,
		linked: extras.linked,
		childCount: isFile ? null : (extras.childCount ?? 0),
		createdBy: row.createdBy
			? (users.get(row.createdBy) ?? { id: row.createdBy, name: 'Unbekannt' })
			: null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** Ein Knoten als DTO (Zugriff prüft der Aufrufer nicht erneut) – eigene Transaktion, Namen danach */
export async function loadFileNode(ctx: RequestContext, id: string): Promise<FileNode> {
	const keys = await keysFor(ctx);
	return loadWithKeys(ctx, id, keys);
}

/** GET `/nodes`: Ordnerinhalt (Ordner zuerst, dann Name, `localeCompare('de')`) + Breadcrumbs */
export async function listFolder(
	ctx: RequestContext,
	input: { space: Space; parentId: string | null; ownerId?: string }
): Promise<FolderListing> {
	const keys = await keysFor(ctx);
	const data = await mdb().transaction(async (tx) => {
		let space: Space = input.space;
		let folder: NodeRow | null = null;
		let level: AccessLevel;
		let ownerId: string;
		const breadcrumbs: Breadcrumb[] = [];

		if (input.parentId === null) {
			if (space === 'personal') {
				const owner = input.ownerId ?? ctx.userId;
				if (!owner) throw errors.notFound('Ordner nicht gefunden');
				ownerId = owner;
			} else {
				ownerId = '';
			}
			const root = rootAccess(ctx, space, space === 'personal' ? ownerId : null);
			if (!root) throw errors.notFound('Ordner nicht gefunden');
			level = root;
			breadcrumbs.push({ id: null, name: SPACE_LABELS[space] });
		} else {
			const acc = await requireNode(tx, ctx, input.parentId, keys, 'read');
			if (acc.node.kind !== 'folder') {
				throw errors.validation([{ path: ['parent'], message: 'Das ist kein Ordner' }]);
			}
			folder = acc.node;
			level = acc.level;
			space = folder.space;
			ownerId = folder.ownerId;

			const chain = await ancestorsOf(tx, folder.id);
			const root = rootAccess(ctx, space, rootOwner(folder));
			if (root) {
				breadcrumbs.push({ id: null, name: SPACE_LABELS[space] });
				for (const a of chain) breadcrumbs.push({ id: a.id, name: a.name });
			} else {
				breadcrumbs.push({ id: null, name: SHARED_WITH_ME_LABEL });
				const levels = await accessForMany(tx, ctx, chain, keys);
				const first = chain.findIndex((a) => levels.has(a.id));
				const visible = first < 0 ? chain.slice(-1) : chain.slice(first);
				for (const a of visible) breadcrumbs.push({ id: a.id, name: a.name });
			}
		}

		const cond =
			folder === null
				? siblingCondition({ space, ownerId, parentId: null })
				: sql`n.parent_id = ${folder.id}`;
		const rows = (
			await rowsOf(
				tx,
				sql`SELECT ${NODE_COLUMNS} FROM nodes n WHERE ${cond} AND n.deleted_at IS NULL`
			)
		).map(nodeRowOf);
		rows.sort(compareNodes);
		const items = await bundle(tx, ctx, rows, keys, level);
		const self = folder ? await bundle(tx, ctx, [folder], keys, level) : null;
		return { space, level, breadcrumbs, items, self };
	});

	const users = await usersFor(ctx, [...data.items.rows, ...(data.self?.rows ?? [])]);
	return {
		space: data.space,
		folder: data.self ? toDtos(data.self, users)[0]! : null,
		breadcrumbs: data.breadcrumbs,
		access: data.level,
		items: toDtos(data.items, users)
	};
}

/** POST `/folders` → 201; Namenskonflikt → 409 `conflict` mit Vorschlag in der Meldung */
export async function createFolder(
	ctx: RequestContext,
	input: FolderCreateInput
): Promise<FileNode> {
	const keys = await keysFor(ctx);
	const name = normalizeName(input.name);
	if (!name) throw errors.validation([{ path: ['name'], message: 'Bitte einen Namen angeben' }]);
	const id = crypto.randomUUID();
	await mdb().transaction(async (tx) => {
		const target = await requireFolderTarget(tx, ctx, input.space, input.parentId, keys, 'edit');
		const space = target.folder?.space ?? input.space;
		const parentId = target.folder?.id ?? null;
		if ((await depthOf(tx, parentId)) + 1 > MAX_DEPTH) throw depthError('parentId');
		const siblings = await siblingNames(tx, { space, ownerId: target.ownerId, parentId });
		if (siblings.some((s) => sameKey(s, name))) throw conflictError(name, siblings);
		try {
			await tx.execute(
				sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, created_by)
					VALUES (${id}, ${parentId}, 'folder', ${space}, ${target.ownerId}, ${name}, ${ctx.userId})`
			);
		} catch (e) {
			if (isUniqueViolation(e)) throw conflictError(name, siblings);
			throw e;
		}
	});
	const node = await loadWithKeys(ctx, id, keys);
	await core.audit.logFromContext(ctx, 'files.node.created', {
		target: id,
		metadata: { kind: 'folder', space: node.space }
	});
	return node;
}

/**
 * Ordnerkette unter `parentId` sicherstellen (vorhandene gleichnamige Ordner wiederverwenden, sonst anlegen),
 * in der laufenden Transaktion. Liefert die ID des letzten Ordners (`parentId`, wenn `folders` leer).
 * Tiefe > `MAX_DEPTH` → 422.
 */
export async function ensureFolderPath(
	tx: Tx,
	input: {
		space: Space;
		ownerId: string;
		parentId: string | null;
		folders: readonly string[];
		createdBy: string | null;
	}
): Promise<string | null> {
	let parentId = input.parentId;
	if (input.folders.length === 0) return parentId;
	let depth = await depthOf(tx, parentId);
	for (const raw of input.folders) {
		const wanted = normalizeName(raw);
		if (!wanted || wanted === '.' || wanted === '..') continue;
		if (++depth > MAX_DEPTH) throw depthError('relativePath');

		const cond = siblingCondition({ space: input.space, ownerId: input.ownerId, parentId });
		// gleichnamige Datei blockiert → „Name (2)“ usw.; ein vorhandener Ordner mit dem Namen wird genutzt
		const blocked: string[] = [];
		let candidate = wanted;
		let found: string | null = null;
		for (let i = 0; i < 1000; i++) {
			const rows = await rowsOf(
				tx,
				sql`SELECT n.id, n.kind FROM nodes n
					WHERE ${cond} AND n.deleted_at IS NULL AND lower(n.name) = lower(${candidate}) LIMIT 1`
			);
			const hit = rows[0];
			if (!hit) break;
			if (String(hit.kind) === 'folder') {
				found = String(hit.id);
				break;
			}
			blocked.push(candidate);
			candidate = uniqueName(blocked, candidate);
		}
		if (found) {
			parentId = found;
			continue;
		}
		const id = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, created_by)
				VALUES (${id}, ${parentId}, 'folder', ${input.space}, ${input.ownerId}, ${candidate},
					${input.createdBy})`
		);
		parentId = id;
	}
	return parentId;
}

/** Namen der nicht gelöschten Geschwister in einem Ordner (für `uniqueName`) */
export async function siblingNames(
	tx: Tx,
	input: { space: Space; ownerId: string; parentId: string | null }
): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT n.name FROM nodes n WHERE ${siblingCondition(input)} AND n.deleted_at IS NULL`
	);
	return rows.map((r) => String(r.name));
}

/** PATCH `/nodes/:id` (edit nötig); Konflikt 409 */
export async function renameNode(ctx: RequestContext, id: string, name: string): Promise<FileNode> {
	const keys = await keysFor(ctx);
	const wanted = normalizeName(name);
	if (!wanted) throw errors.validation([{ path: ['name'], message: 'Bitte einen Namen angeben' }]);
	let kind: NodeRow['kind'] = 'file';
	const changed = await mdb().transaction(async (tx) => {
		const { node } = await requireNode(tx, ctx, id, keys, 'edit');
		kind = node.kind;
		if (node.name === wanted) return false;
		const siblings = await siblingNames(tx, {
			space: node.space,
			ownerId: node.ownerId,
			parentId: node.parentId
		});
		// den Knoten selbst einmal herausnehmen (Umbenennen nur in Groß/Klein ist erlaubt)
		const own = siblings.indexOf(node.name);
		if (own >= 0) siblings.splice(own, 1);
		if (siblings.some((s) => sameKey(s, wanted))) throw conflictError(wanted, siblings);
		try {
			await tx.execute(sql`UPDATE nodes SET name = ${wanted}, updated_at = now() WHERE id = ${id}`);
		} catch (e) {
			if (isUniqueViolation(e)) throw conflictError(wanted, siblings);
			throw e;
		}
		return true;
	});
	const result = await loadWithKeys(ctx, id, keys);
	if (changed) {
		await core.audit.logFromContext(ctx, 'files.node.renamed', {
			target: id,
			metadata: { kind }
		});
	}
	return result;
}

/**
 * POST `/nodes/move`: edit auf jedem Knoten und auf dem Ziel; nicht in sich selbst/Nachfahren (422),
 * Tiefe ≤ `MAX_DEPTH`; Namenskonflikt im Ziel → automatisch `uniqueName`. Wechsel des Bereichs bzw. der
 * Eigentümer*in setzt `space`/`owner_id` für den ganzen Teilbaum; Ziel „Meine Dateien“ prüft das Kontingent.
 */
export async function moveNodes(ctx: RequestContext, input: MoveInput): Promise<BulkResult> {
	const keys = await keysFor(ctx);
	const settings = await filesSettings();
	const ids = [...new Set(input.ids)];
	const moved = await mdb().transaction(async (tx) => {
		// Verschiebungen serialisieren: zwei gleichzeitige Moves könnten sonst einen Zyklus bilden
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('files:move'))`);
		const target = await requireFolderTarget(tx, ctx, input.space, input.targetId, keys, 'edit');
		const targetId = target.folder?.id ?? null;
		const targetSpace = target.folder?.space ?? input.space;
		const targetOwner = target.ownerId;
		const targetChain = targetId ? await ancestorsOf(tx, targetId) : [];
		const targetChainIds = new Set(targetChain.map((a) => a.id));
		const targetDepth = targetChain.length;

		// Zugriff auf alle Knoten prüfen, dann nur die obersten bewegen
		const idSet = new Set(ids);
		const nodes: NodeRow[] = [];
		for (const id of ids) {
			const { node } = await requireNode(tx, ctx, id, keys, 'edit');
			const chain = await ancestorsOf(tx, id);
			if (chain.some((a) => a.id !== id && idSet.has(a.id))) continue;
			nodes.push(node);
		}

		interface Plan {
			node: NodeRow;
			space: Space;
			ownerId: string;
			rewriteSubtree: boolean;
		}
		const plans: Plan[] = [];
		let addBytes = 0;
		for (const node of nodes) {
			if (targetChainIds.has(node.id)) {
				throw errors.validation([
					{
						path: ['targetId'],
						message: 'Ein Ordner kann nicht in sich selbst oder einen Unterordner verschoben werden'
					}
				]);
			}
			const newOwner = targetSpace === 'personal' ? targetOwner : node.ownerId;
			const spaceChange = node.space !== targetSpace;
			const ownerChange = newOwner !== node.ownerId;
			const sameParent =
				node.parentId === targetId && !spaceChange && (targetSpace === 'shared' || !ownerChange);
			if (sameParent) continue;
			// Aus der Ablage heraus (anderer Bereich / andere Eigentümer*in) nur mit Bereichsrecht am Quellknoten –
			// eine edit-Freigabe reicht nicht (sonst ließen sich fremde private Ordner übernehmen)
			if ((spaceChange || ownerChange) && !hasRootEdit(ctx, node)) {
				throw errors.forbidden(
					'Nur die Eigentümer*in kann Einträge aus dieser Ablage herausverschieben'
				);
			}

			const height = node.kind === 'folder' ? await subtreeHeight(tx, node.id) : 0;
			if (targetDepth + 1 + height > MAX_DEPTH) throw depthError('targetId');

			if (targetSpace === 'personal' && (spaceChange || ownerChange)) {
				addBytes += node.kind === 'file' ? (node.sizeBytes ?? 0) : await subtreeBytes(tx, node.id);
			}
			plans.push({
				node,
				space: targetSpace,
				ownerId: newOwner,
				rewriteSubtree: node.kind === 'folder' && (spaceChange || ownerChange)
			});
		}

		if (addBytes > 0) await assertQuota(tx, targetOwner, addBytes, settings.quotaBytes);

		const siblings = await siblingNames(tx, {
			space: targetSpace,
			ownerId: targetOwner,
			parentId: targetId
		});
		for (const p of plans) {
			const name = uniqueName(siblings, p.node.name);
			siblings.push(name);
			await tx.execute(
				sql`UPDATE nodes SET parent_id = ${targetId}, name = ${name}, space = ${p.space},
					owner_id = ${p.ownerId}, updated_at = now() WHERE id = ${p.node.id}`
			);
			if (p.rewriteSubtree) {
				const sub = await descendantIds(tx, p.node.id);
				for (const part of chunks(sub)) {
					await tx.execute(
						sql`UPDATE nodes SET space = ${p.space}, owner_id = ${p.ownerId}
							WHERE id IN (${idList(part)})`
					);
				}
			}
		}
		return plans.length;
	});
	if (moved > 0) {
		await core.audit.logFromContext(ctx, 'files.node.moved', {
			target: input.targetId ?? undefined,
			metadata: { count: moved, space: input.space }
		});
	}
	return { affected: moved };
}

/** GET `/search`: Name enthält `q` (ohne Groß/Klein), nur sichtbare, nicht gelöschte; max `MAX_SEARCH_RESULTS` */
export async function searchNodes(
	ctx: RequestContext,
	input: { q: string; space?: Space }
): Promise<SearchResult> {
	const keys = await keysFor(ctx);
	const q = input.q.trim().toLowerCase();
	const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const data = await mdb().transaction(async (tx) => {
		const spaceCond = input.space ? sql`AND n.space = ${input.space}` : sql``;
		const rows = (
			await rowsOf(
				tx,
				sql`SELECT ${NODE_COLUMNS} FROM nodes n
					WHERE ${visibleNodesFilter(ctx, keys)} AND n.deleted_at IS NULL
						AND lower(n.name) LIKE ${pattern} ESCAPE '\\' ${spaceCond}
					ORDER BY CASE WHEN n.kind = 'folder' THEN 0 ELSE 1 END, lower(n.name), n.id
					LIMIT ${MAX_SEARCH_RESULTS + 1}`
			)
		).map(nodeRowOf);
		const truncated = rows.length > MAX_SEARCH_RESULTS;
		const hits = rows.slice(0, MAX_SEARCH_RESULTS);
		hits.sort(compareNodes);

		// Vorfahren je Treffer; ohne Zugang über die Wurzel nur ab dem ersten zugänglichen Vorfahren
		const chains = new Map<string, NodeRow[]>();
		const hidden: NodeRow[] = [];
		for (const h of hits) {
			const chain = (await ancestorsOf(tx, h.id)).filter((a) => a.id !== h.id);
			chains.set(h.id, chain);
			if (!rootAccess(ctx, h.space, rootOwner(h))) hidden.push(...chain);
		}
		const hiddenLevels = hidden.length ? await accessForMany(tx, ctx, hidden, keys) : new Map();
		const paths = new Map<string, string>();
		for (const h of hits) {
			const chain = chains.get(h.id)!;
			if (rootAccess(ctx, h.space, rootOwner(h))) {
				paths.set(h.id, displayPath([SPACE_LABELS[h.space], ...chain.map((a) => a.name)]));
			} else {
				const first = chain.findIndex((a) => hiddenLevels.has(a.id));
				const visible = first < 0 ? [] : chain.slice(first);
				paths.set(h.id, displayPath([SHARED_WITH_ME_LABEL, ...visible.map((a) => a.name)]));
			}
		}
		return { b: await bundle(tx, ctx, hits, keys), truncated, paths };
	});
	const users = await usersFor(ctx, data.b.rows);
	return {
		items: toDtos(data.b, users).map((n) => ({ ...n, path: data.paths.get(n.id) ?? '' })),
		truncated: data.truncated
	};
}

/** GET `/shared-with-me` */
export async function sharedWithMe(ctx: RequestContext): Promise<FileNode[]> {
	const keys = await keysFor(ctx);
	const b = await mdb().transaction(async (tx) => {
		const roots = await sharedWithMeRoots(tx, ctx, keys);
		roots.sort(compareNodes);
		return bundle(tx, ctx, roots, keys);
	});
	return toDtos(b, await usersFor(ctx, b.rows));
}
