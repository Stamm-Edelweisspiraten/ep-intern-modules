/**
 * Öffentliche Links (für Personen ohne Konto): Anlegen, Auflisten, Widerrufen; öffentliche Auflösung.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.5. Signaturen nicht ändern.
 *
 * Sicherheit:
 *   - Token: 32 Byte `crypto.getRandomValues` → base64url; gespeichert nur `core.crypto.forModule('files').hash(token)`.
 *   - Passwort: scrypt (`node:crypto`, Salt 16 Byte, Format `scrypt$<salt>$<hash>`), Vergleich `timingSafeEqual`.
 *   - Nach `unlock`: Zugriffstoken `<linkId>.<exp>.<sig>` mit `sig = hash('access:' + linkId + '.' + exp)`
 *     (Präfix trennt die Domäne vom Token-Hash), gültig `LINK_ACCESS_TTL_SEC`.
 *   - Passwort-Raten: höchstens `MAX_UNLOCK_FAILURES` Fehlversuche je Link und Stunde, danach 429 (auch bei
 *     richtigem Passwort), Erfolg setzt den Zähler zurück.
 *   - Verwalten (Auflisten, Anlegen, Widerrufen) nur für Bereichsberechtigte (`canManageShares`).
 *   - Ungültig / abgelaufen / widerrufen / Knoten im Papierkorb → überall dieselbe 404-Meldung „Link nicht verfügbar“.
 *   - Knoten-Zugriff nur innerhalb des Link-Teilbaums (Vorfahren-Prüfung), gelöschte Knoten nie.
 *   - Audit `files.link.accessed` höchstens 1× je Link und Stunde (über `last_access_at`), `access_count` zählt jeden Aufruf von Info/Inhalt.
 *
 * Ablaufdatum: gültig bis einschließlich `expires_on`, verglichen mit `CURRENT_DATE` der Datenbank
 * (beim Anlegen und beim Abruf dieselbe Quelle).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext, type Tx } from '$lib/sdk/server';
import { requireNode, resolveAccess } from './access';
import {
	NODE_COLUMNS,
	ancestorsOf,
	mdb,
	nodeRowOf,
	rowsOf,
	toIso,
	userRefs,
	type NodeRow,
	type Row
} from './db';
import { contentResponse, thumbResponse } from './storage';
import {
	LINK_ACCESS_TTL_SEC,
	MAX_LINKS_PER_NODE,
	MAX_UNLOCK_FAILURES,
	MODULE_ID,
	PERMISSIONS,
	type Breadcrumb,
	type LinkCreateInput,
	type PublicLinkInfo,
	type PublicListing,
	type PublicNode,
	type ShareLink,
	type UserRef
} from './schemas';
import { assertCanManageShares, keysFor } from './shares.service';

const scrypt = promisify(scryptCb) as (
	password: string,
	salt: Buffer,
	keylen: number
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const PUBLIC_PATH = '/p/files/link';
const UNAVAILABLE = 'Link nicht verfügbar';
const AUDIT_ACTOR = { type: 'system' as const, id: 'files-link', name: 'Öffentlicher Link' };

const unavailable = () => errors.notFound(UNAVAILABLE);
const lockedOut = () =>
	errors.rateLimited('Zu viele Fehlversuche – bitte in einer Stunde erneut versuchen');

/** SQL-Bedingung (ohne Alias, Tabelle `share_links`): Link wegen Fehlversuchen gesperrt */
const LOCKED_SQL = sql`(failed_count >= ${MAX_UNLOCK_FAILURES}
	AND failed_window_start IS NOT NULL AND failed_window_start > now() - interval '1 hour')`;

// ---------------------------------------------------------------------------
// Hilfen: Token, Passwort, Zugriffstoken
// ---------------------------------------------------------------------------

const hashValue = (value: string) => core.crypto.forModule(MODULE_ID).hash(value);

function newToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
	return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
	const salt = Buffer.from(parts[1]!, 'base64');
	const expected = Buffer.from(parts[2]!, 'base64');
	if (salt.length === 0 || expected.length === 0) return false;
	const actual = await scrypt(password, salt, expected.length);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeEqualHex(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Signatur des Zugriffstokens (eigene Domäne, damit sie nie mit einem Token-Hash übereinstimmt) */
const accessSignature = (linkId: string, exp: string) => hashValue(`access:${linkId}.${exp}`);

function issueAccessToken(linkId: string): string {
	const exp = String(Math.floor(Date.now() / 1000) + LINK_ACCESS_TTL_SEC);
	return `${linkId}.${exp}.${accessSignature(linkId, exp)}`;
}

function accessTokenValid(linkId: string, token: string | undefined): boolean {
	if (!token) return false;
	const parts = token.split('.');
	if (parts.length !== 3) return false;
	const [id, expRaw, sig] = parts as [string, string, string];
	if (id !== linkId || !/^\d{1,12}$/.test(expRaw)) return false;
	const exp = Number(expRaw);
	if (exp < Math.floor(Date.now() / 1000)) return false;
	return safeEqualHex(sig, accessSignature(id, expRaw));
}

/** Echtes Kalenderdatum `YYYY-MM-DD` (z. B. kein 31.02.) */
function isRealDate(v: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === v;
}

// ---------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------

/** Spalten für `share_links l`; `active`/`audit_due` in SQL, Datum als Text */
const LINK_COLUMNS = sql`l.id, l.node_id, to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
	l.password_hash, l.created_by, l.created_at, l.revoked_at, l.last_access_at, l.access_count,
	(l.revoked_at IS NULL AND (l.expires_on IS NULL OR l.expires_on >= CURRENT_DATE)) AS active,
	(l.last_access_at IS NULL OR l.last_access_at < now() - interval '1 hour') AS audit_due`;

interface LinkRow {
	id: string;
	nodeId: string;
	expiresOn: string | null;
	passwordHash: string | null;
	createdBy: string | null;
	createdAt: string;
	revokedAt: string | null;
	lastAccessAt: string | null;
	accessCount: number;
	active: boolean;
	auditDue: boolean;
}

const textOrNull = (v: unknown): string | null =>
	v === null || v === undefined ? null : String(v);
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true' || v === 1;

function linkRowOf(r: Row): LinkRow {
	return {
		id: String(r.id),
		nodeId: String(r.node_id),
		expiresOn: textOrNull(r.expires_on),
		passwordHash: textOrNull(r.password_hash),
		createdBy: textOrNull(r.created_by),
		createdAt: toIso(r.created_at),
		revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : toIso(r.revoked_at),
		lastAccessAt:
			r.last_access_at === null || r.last_access_at === undefined ? null : toIso(r.last_access_at),
		accessCount: Number(r.access_count ?? 0),
		active: bool(r.active),
		auditDue: bool(r.audit_due)
	};
}

function toShareLink(row: LinkRow, users: Map<string, UserRef>, url: string | null): ShareLink {
	return {
		id: row.id,
		nodeId: row.nodeId,
		url,
		expiresOn: row.expiresOn,
		hasPassword: row.passwordHash !== null,
		active: row.active,
		revokedAt: row.revokedAt,
		accessCount: row.accessCount,
		lastAccessAt: row.lastAccessAt,
		createdBy: row.createdBy ? (users.get(row.createdBy) ?? null) : null,
		createdAt: row.createdAt
	};
}

async function loadLinkById(tx: Tx, id: string): Promise<LinkRow | null> {
	const [r] = await rowsOf(tx, sql`SELECT ${LINK_COLUMNS} FROM share_links l WHERE l.id = ${id}`);
	return r ? linkRowOf(r) : null;
}

function toPublicNode(n: NodeRow): PublicNode {
	return {
		id: n.id,
		kind: n.kind,
		name: n.name,
		contentType: n.kind === 'file' ? n.contentType : null,
		sizeBytes: n.kind === 'file' ? n.sizeBytes : null,
		hasThumb: n.kind === 'file' && n.thumbPath !== null,
		updatedAt: n.updatedAt
	};
}

// ---------------------------------------------------------------------------
// Öffentliche Auflösung
// ---------------------------------------------------------------------------

interface ValidLink {
	link: LinkRow;
	node: NodeRow;
}

/** Gültigen Link samt Knoten laden; sonst überall dieselbe 404 */
async function loadValidLink(tx: Tx, token: string): Promise<ValidLink> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT ${LINK_COLUMNS} FROM share_links l WHERE l.token_hash = ${hashValue(token)}`
	);
	if (!r) throw unavailable();
	const link = linkRowOf(r);
	if (!link.active) throw unavailable();
	const chain = await ancestorsOf(tx, link.nodeId);
	const node = chain[chain.length - 1];
	if (!node || node.id !== link.nodeId || chain.some((n) => n.deletedAt !== null)) {
		throw unavailable();
	}
	return { link, node };
}

/** Zugriffstoken prüfen, wenn der Link ein Passwort hat */
function assertUnlocked(link: LinkRow, accessToken: string | undefined): void {
	if (link.passwordHash === null) return;
	if (!accessTokenValid(link.id, accessToken)) throw errors.forbidden('Passwort erforderlich');
}

/**
 * Knoten im Teilbaum des Links (inkl. Link-Knoten) mit Pfad ab dem Link-Knoten.
 * Fremde, gelöschte oder unbekannte Knoten → `null`.
 */
async function nodeInLink(tx: Tx, linkNode: NodeRow, nodeId: string): Promise<NodeRow[] | null> {
	const chain = await ancestorsOf(tx, nodeId);
	const last = chain[chain.length - 1];
	if (!last || last.id !== nodeId) return null;
	const idx = chain.findIndex((n) => n.id === linkNode.id);
	if (idx < 0) return null;
	const path = chain.slice(idx);
	if (path.some((n) => n.deletedAt !== null)) return null;
	return path;
}

async function countAccess(tx: Tx, linkId: string): Promise<void> {
	await tx.execute(
		sql`UPDATE share_links SET access_count = access_count + 1, last_access_at = now()
			WHERE id = ${linkId}`
	);
}

/** Audit höchstens 1× je Link und Stunde (NACH der Transaktion) */
async function auditAccess(ctx: RequestContext, link: LinkRow, counted: boolean): Promise<void> {
	if (!counted || !link.auditDue) return;
	try {
		await core.audit.log({
			action: 'files.link.accessed',
			actor: AUDIT_ACTOR,
			target: link.id,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata: { linkId: link.id, nodeId: link.nodeId, accessCount: link.accessCount + 1 }
		});
	} catch {
		// Audit-Fehler dürfen den Abruf nicht verhindern
	}
}

// ---------------------------------------------------------------------------
// Intern
// ---------------------------------------------------------------------------

/** GET `/nodes/:id/links` (nur Bereichsberechtigte) */
export async function listLinks(ctx: RequestContext, nodeId: string): Promise<ShareLink[]> {
	const keys = await keysFor(ctx);
	const rows = await mdb().transaction(async (tx) => {
		assertCanManageShares(ctx, await requireNode(tx, ctx, nodeId, keys, 'edit'));
		const list = await rowsOf(
			tx,
			sql`SELECT ${LINK_COLUMNS} FROM share_links l WHERE l.node_id = ${nodeId}
				ORDER BY l.created_at DESC, l.id`
		);
		return list.map(linkRowOf);
	});
	const users = await userRefs(
		ctx,
		rows.map((r) => r.createdBy)
	);
	return rows.map((r) => toShareLink(r, users, null));
}

/**
 * POST `/nodes/:id/links` (Bereichsberechtigte + `files.link.create`): Ablaufdatum nicht in der Vergangenheit (422),
 * max `MAX_LINKS_PER_NODE` aktive (409). Antwort enthält einmalig `url` = `<origin>/p/files/link/<token>`
 * (`core` liefert die Origin, siehe andere Module: `app.origin`).
 */
export async function createLink(
	ctx: RequestContext,
	nodeId: string,
	input: LinkCreateInput
): Promise<ShareLink> {
	if (!core.permissions.has(ctx, PERMISSIONS.linkCreate)) {
		throw errors.forbidden('Du darfst keine öffentlichen Links anlegen');
	}
	const expiresOn = input.expiresOn ?? null;
	if (expiresOn !== null && !isRealDate(expiresOn)) {
		throw errors.validation([{ path: ['expiresOn'], message: 'Ungültiges Datum' }]);
	}
	const keys = await keysFor(ctx);
	const passwordHash = input.password ? await hashPassword(input.password) : null;
	const token = newToken();
	const id = crypto.randomUUID();

	const row = await mdb().transaction(async (tx) => {
		assertCanManageShares(ctx, await requireNode(tx, ctx, nodeId, keys, 'edit'));
		if (expiresOn !== null) {
			const [r] = await rowsOf(tx, sql`SELECT (${expiresOn}::date < CURRENT_DATE) AS past`);
			if (r && bool(r.past)) {
				throw errors.validation([
					{ path: ['expiresOn'], message: 'Das Ablaufdatum liegt in der Vergangenheit' }
				]);
			}
		}
		const [c] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM share_links
				WHERE node_id = ${nodeId} AND revoked_at IS NULL
					AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)`
		);
		if (Number(c?.n ?? 0) >= MAX_LINKS_PER_NODE) {
			throw errors.conflict(
				`Höchstens ${MAX_LINKS_PER_NODE} aktive Links je Eintrag – bitte zuerst einen widerrufen`
			);
		}
		await tx.execute(
			sql`INSERT INTO share_links (id, node_id, token_hash, expires_on, password_hash, created_by)
				VALUES (${id}, ${nodeId}, ${hashValue(token)}, ${expiresOn}::date, ${passwordHash}, ${ctx.userId})`
		);
		const created = await loadLinkById(tx, id);
		if (!created) throw errors.notFound();
		return created;
	});

	const users = await userRefs(ctx, [row.createdBy]);
	await core.audit.logFromContext(ctx, 'files.link.created', {
		target: id,
		metadata: { linkId: id, nodeId, hasPassword: passwordHash !== null, expiresOn }
	});
	return toShareLink(row, users, `${core.app.origin()}${PUBLIC_PATH}/${token}`);
}

/**
 * DELETE `/links/:id`: ohne edit auf dem Knoten 404; mit edit nur über eine Freigabe 403
 * (nur Bereichsberechtigte dürfen widerrufen)
 */
export async function revokeLink(ctx: RequestContext, linkId: string): Promise<ShareLink> {
	const keys = await keysFor(ctx);
	const { row, changed } = await mdb().transaction(async (tx) => {
		const link = await loadLinkById(tx, linkId);
		if (!link) throw errors.notFound('Link nicht gefunden');
		const access = await resolveAccess(tx, ctx, link.nodeId, keys);
		if (!access || access.level !== 'edit') throw errors.notFound('Link nicht gefunden');
		assertCanManageShares(ctx, access);
		const wasOpen = link.revokedAt === null;
		if (wasOpen) {
			await tx.execute(sql`UPDATE share_links SET revoked_at = now() WHERE id = ${linkId}`);
		}
		const updated = await loadLinkById(tx, linkId);
		if (!updated) throw errors.notFound('Link nicht gefunden');
		return { row: updated, changed: wasOpen };
	});
	const users = await userRefs(ctx, [row.createdBy]);
	if (changed) {
		await core.audit.logFromContext(ctx, 'files.link.revoked', {
			target: linkId,
			metadata: { linkId, nodeId: row.nodeId }
		});
	}
	return toShareLink(row, users, null);
}

// ---------------------------------------------------------------------------
// Öffentlich
// ---------------------------------------------------------------------------

/** GET `/public/links/:token` */
export async function publicInfo(
	ctx: RequestContext,
	token: string,
	accessToken?: string
): Promise<PublicLinkInfo> {
	const { link, node } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		await countAccess(tx, valid.link.id);
		return valid;
	});
	await auditAccess(ctx, link, true);
	// Nach dem Freischalten (gültiges `t`) gibt es den Datei-Knoten auch bei Passwort-Links
	const needsPassword = link.passwordHash !== null && !accessTokenValid(link.id, accessToken);
	return {
		name: node.name,
		kind: node.kind,
		needsPassword,
		expiresOn: link.expiresOn,
		node: !needsPassword && node.kind === 'file' ? toPublicNode(node) : null
	};
}

/**
 * POST `/public/links/:token/unlock`: falsches Passwort → 403 „Passwort falsch“.
 * Ab `MAX_UNLOCK_FAILURES` Fehlversuchen innerhalb einer Stunde (Fenster je Link) → 429, auch bei
 * richtigem Passwort. scrypt läuft außerhalb der Transaktion; der Zähler wird danach atomar geändert.
 */
export async function unlockLink(
	_ctx: RequestContext,
	token: string,
	password: string
): Promise<{ accessToken: string; expiresInSec: number }> {
	const { link, locked } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		const [r] = await rowsOf(
			tx,
			sql`SELECT ${LOCKED_SQL} AS locked FROM share_links WHERE id = ${valid.link.id}`
		);
		return { link: valid.link, locked: bool(r?.locked) };
	});
	if (link.passwordHash === null) {
		return { accessToken: issueAccessToken(link.id), expiresInSec: LINK_ACCESS_TTL_SEC };
	}
	if (locked) throw lockedOut();

	const ok = await verifyPassword(password, link.passwordHash);
	if (!ok) {
		// Fehlversuch zählen; Fenster neu starten, wenn es älter als eine Stunde ist
		await mdb().transaction((tx) =>
			tx.execute(
				sql`UPDATE share_links SET
					failed_count = CASE
						WHEN failed_window_start IS NULL OR failed_window_start <= now() - interval '1 hour'
						THEN 1 ELSE failed_count + 1 END,
					failed_window_start = CASE
						WHEN failed_window_start IS NULL OR failed_window_start <= now() - interval '1 hour'
						THEN now() ELSE failed_window_start END
					WHERE id = ${link.id}`
			)
		);
		throw errors.forbidden('Passwort falsch');
	}
	// Erfolg setzt zurück – aber nur, wenn inzwischen (parallele Versuche) keine Sperre greift
	const unlocked = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`UPDATE share_links SET failed_count = 0, failed_window_start = NULL
				WHERE id = ${link.id} AND NOT ${LOCKED_SQL}
				RETURNING id`
		);
		return rows.length > 0;
	});
	if (!unlocked) throw lockedOut();
	return { accessToken: issueAccessToken(link.id), expiresInSec: LINK_ACCESS_TTL_SEC };
}

/** GET `/public/links/:token/nodes?parent=&t=`: Ordnerinhalt im Link-Teilbaum (Passwort → `t` Pflicht, sonst 403) */
export async function publicList(
	_ctx: RequestContext,
	token: string,
	input: { parentId: string | null; accessToken?: string }
): Promise<PublicListing> {
	return mdb().transaction(async (tx) => {
		const { link, node: linkNode } = await loadValidLink(tx, token);
		assertUnlocked(link, input.accessToken);

		let path: NodeRow[];
		if (input.parentId === null) {
			path = [linkNode];
		} else {
			const found = await nodeInLink(tx, linkNode, input.parentId);
			if (!found) throw errors.notFound('Ordner nicht gefunden');
			path = found;
		}
		const folder = path[path.length - 1]!;
		if (folder.kind !== 'folder') {
			throw errors.validation([{ path: ['parent'], message: 'Kein Ordner' }]);
		}

		const breadcrumbs: Breadcrumb[] = [
			{ id: null, name: linkNode.name },
			...path.slice(1).map((n) => ({ id: n.id, name: n.name }))
		];
		const rows = await rowsOf(
			tx,
			sql`SELECT ${NODE_COLUMNS} FROM nodes n
				WHERE n.parent_id = ${folder.id} AND n.deleted_at IS NULL`
		);
		const items = rows
			.map(nodeRowOf)
			.sort(
				(a, b) =>
					(a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
					a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
			)
			.map(toPublicNode);
		return { breadcrumbs, items };
	});
}

/** GET `/public/links/:token/content/:nodeId?t=&download=&thumb=`: Datei/Thumbnail als Response (`storage.ts`) */
export async function publicContent(
	ctx: RequestContext,
	token: string,
	nodeId: string,
	input: { accessToken?: string; download: boolean; thumb: boolean }
): Promise<Response> {
	// Vorschaubilder einer Ordneransicht zählen nicht als Abruf
	const counted = !input.thumb;
	const { link, file } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		assertUnlocked(valid.link, input.accessToken);
		const path = await nodeInLink(tx, valid.node, nodeId);
		const target = path?.[path.length - 1];
		if (!target || target.kind !== 'file' || !target.storagePath) {
			throw errors.notFound('Datei nicht gefunden');
		}
		if (input.thumb && !target.thumbPath) throw errors.notFound('Keine Vorschau vorhanden');
		if (counted) await countAccess(tx, valid.link.id);
		return { link: valid.link, file: target };
	});
	await auditAccess(ctx, link, counted);
	if (input.thumb) return thumbResponse(file.thumbPath!);
	return contentResponse({
		path: file.storagePath!,
		name: file.name,
		contentType: file.contentType ?? 'application/octet-stream',
		download: input.download
	});
}
