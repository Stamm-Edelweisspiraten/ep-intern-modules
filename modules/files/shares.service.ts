/**
 * Freigaben an Principals (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in) je Knoten.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.5. Signaturen nicht ändern.
 * Muster: `galleries` (`principalKeysFor`, `validatePrincipals`, `describePrincipals`, `searchPrincipals`
 * aus `$lib/sdk/server`, alle VOR bzw. NACH der Transaktion).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	describePrincipals,
	errors,
	principalKeysFor,
	searchPrincipals,
	validatePrincipals,
	type PrincipalInfo,
	type PrincipalType,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { accessForMany, canManageAll, requireNode, type NodeAccess } from './access';
import { ancestorsOf, mdb, rowsOf, type NodeRow } from './db';
import {
	MODULE_ID,
	type NodeShare,
	type NodeShares,
	type ShareInput,
	type ShareLevel
} from './schemas';

/** Anzeigename des Principals `everyone` in diesem Modul */
const EVERYONE_LABEL = 'Stamm';

interface ShareRow {
	nodeId: string;
	type: PrincipalType;
	id: string;
	level: ShareLevel;
}

/** Rohdaten für die Anzeige: eigene Freigaben und geerbte (mit Herkunft) */
interface RawShares {
	own: ShareRow[];
	inherited: (ShareRow & { fromId: string; fromName: string })[];
}

/** Schlüssel des Aufrufers (Kurzform für `principalKeysFor(ctx, MODULE_ID)`) */
export async function keysFor(ctx: RequestContext): Promise<string[]> {
	return principalKeysFor(ctx, MODULE_ID);
}

/** Freigaben mehrerer Knoten (in der Transaktion), stabil sortiert */
async function sharesOf(tx: Tx, nodeIds: readonly string[]): Promise<ShareRow[]> {
	if (nodeIds.length === 0) return [];
	const rows = await rowsOf(
		tx,
		sql`SELECT node_id, principal_type, principal_id, level FROM node_shares
			WHERE node_id IN (${sql.join(
				nodeIds.map((id) => sql`${id}`),
				sql`, `
			)})
			ORDER BY created_at, principal_type, principal_id`
	);
	return rows.map((r) => ({
		nodeId: String(r.node_id),
		type: String(r.principal_type) as PrincipalType,
		id: String(r.principal_id),
		level: String(r.level) === 'edit' ? 'edit' : 'read'
	}));
}

/**
 * Freigaben und öffentliche Links verwalten dürfen nur die Eigentümer*in und `files.file.manage-all`
 * bzw. System. Wer nur über eine Principal-Freigabe `edit` hat (auch an den ganzen Stamm), darf das nicht
 * (sonst könnte er fremde Inhalte weiterverteilen).
 */
export function canManageShares(ctx: RequestContext, node: NodeRow): boolean {
	if (canManageAll(ctx)) return true;
	return !!ctx.userId && node.ownerId === ctx.userId;
}

/** Wie `canManageShares`, wirft sonst 403 */
export function assertCanManageShares(ctx: RequestContext, access: NodeAccess): void {
	if (!canManageShares(ctx, access.node)) {
		throw errors.forbidden('Nur die Eigentümer*in kann Freigaben und Links verwalten');
	}
}

/**
 * Eigene und geerbte Freigaben eines Knotens laden (Zugriff auf den Knoten prüft der Aufrufer).
 * Geerbte Freigaben nur von Vorfahren, auf die der Aufrufer selbst Zugriff hat – sonst würden Namen
 * fremder Ordner über die Freigabe-Grenze sichtbar. Eigentümer*in und `manage-all` sehen alles.
 */
async function loadRawShares(
	tx: Tx,
	ctx: RequestContext,
	nodeId: string,
	keys: readonly string[]
): Promise<RawShares> {
	const chain = await ancestorsOf(tx, nodeId);
	const self = chain[chain.length - 1];
	const allAncestors = chain.filter((n) => n.id !== nodeId);
	let ancestors = allAncestors;
	if (allAncestors.length > 0 && !(self && canManageShares(ctx, self))) {
		const access = await accessForMany(tx, ctx, allAncestors, keys);
		ancestors = allAncestors.filter((n) => access.has(n.id));
	}
	const rows = await sharesOf(tx, [nodeId, ...ancestors.map((n) => n.id)]);
	const nameOf = new Map(ancestors.map((n) => [n.id, n.name]));
	// Nächster Vorfahre zuerst (Wurzel zuletzt), damit die Herkunft nachvollziehbar bleibt
	const depth = new Map(ancestors.map((n, i) => [n.id, i]));
	const inherited = rows
		.filter((r) => r.nodeId !== nodeId)
		.sort((a, b) => (depth.get(b.nodeId) ?? 0) - (depth.get(a.nodeId) ?? 0))
		.map((r) => ({ ...r, fromId: r.nodeId, fromName: nameOf.get(r.nodeId) ?? '' }));
	return { own: rows.filter((r) => r.nodeId === nodeId), inherited };
}

/** Anzeigedaten auflösen (NACH der Transaktion) */
async function describeRaw(ctx: RequestContext, raw: RawShares): Promise<NodeShares> {
	const all: ShareRow[] = [...raw.own, ...raw.inherited];
	const infos =
		all.length === 0
			? []
			: await describePrincipals(ctx, MODULE_ID, all, { everyoneLabel: EVERYONE_LABEL });
	const toShare = (info: PrincipalInfo, level: ShareLevel): NodeShare => ({
		type: info.type,
		id: info.id,
		name: info.name,
		detail: info.detail ?? null,
		color: info.color ?? null,
		image: info.image ?? null,
		level
	});
	const shares = raw.own.map((r, i) => toShare(infos[i]!, r.level));
	const offset = raw.own.length;
	const inherited = raw.inherited.map((r, i) => ({
		...toShare(infos[offset + i]!, r.level),
		fromId: r.fromId,
		fromName: r.fromName
	}));
	return { shares, inherited };
}

/** GET `/nodes/:id/shares` (read nötig): eigene + von Vorfahren geerbte Freigaben, beschrieben */
export async function getShares(ctx: RequestContext, nodeId: string): Promise<NodeShares> {
	const keys = await keysFor(ctx);
	const raw = await mdb().transaction(async (tx) => {
		await requireNode(tx, ctx, nodeId, keys, 'read');
		return loadRawShares(tx, ctx, nodeId, keys);
	});
	return describeRaw(ctx, raw);
}

/** PUT `/nodes/:id/shares` (nur Eigentümer*in oder `manage-all`, siehe `canManageShares`): Liste ersetzen; Principals validieren (422); Audit `files.share.updated` */
export async function putShares(
	ctx: RequestContext,
	nodeId: string,
	shares: readonly ShareInput[]
): Promise<NodeShares> {
	const keys = await keysFor(ctx);
	// 1. Zugriff prüfen und vorhandene Freigaben lesen (für `keep` bei der Validierung)
	const stored = await mdb().transaction(async (tx) => {
		assertCanManageShares(ctx, await requireNode(tx, ctx, nodeId, keys, 'edit'));
		return sharesOf(tx, [nodeId]);
	});
	// 2. Principals außerhalb der Transaktion prüfen (ruft Core + `members`)
	await validatePrincipals(
		ctx,
		MODULE_ID,
		shares.map((s) => ({ type: s.type, id: s.id })),
		{
			pathPrefix: 'shares',
			keep: new Set(stored.map((s) => `${s.type}:${s.id}`))
		}
	);
	// 3. Liste ersetzen (Zugriff erneut prüfen, falls sich zwischenzeitlich etwas geändert hat)
	const raw = await mdb().transaction(async (tx) => {
		assertCanManageShares(ctx, await requireNode(tx, ctx, nodeId, keys, 'edit'));
		await tx.execute(sql`DELETE FROM node_shares WHERE node_id = ${nodeId}`);
		for (const s of shares) {
			await tx.execute(
				sql`INSERT INTO node_shares (node_id, principal_type, principal_id, level, created_by)
					VALUES (${nodeId}, ${s.type}, ${s.id}, ${s.level}, ${ctx.userId})
					ON CONFLICT (node_id, principal_type, principal_id) DO UPDATE SET level = EXCLUDED.level`
			);
		}
		await tx.execute(sql`UPDATE nodes SET updated_at = now() WHERE id = ${nodeId}`);
		return loadRawShares(tx, ctx, nodeId, keys);
	});
	await core.audit.logFromContext(ctx, 'files.share.updated', {
		target: nodeId,
		metadata: { nodeId, count: shares.length }
	});
	return describeRaw(ctx, raw);
}

/** GET `/principals?q=`: Freigabe-Ziele (everyoneLabel „Stamm“) */
export async function searchShareTargets(ctx: RequestContext, q: string): Promise<PrincipalInfo[]> {
	return searchPrincipals(ctx, MODULE_ID, q, { everyoneLabel: EVERYONE_LABEL });
}
