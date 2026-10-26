/**
 * Zusätzliche Postfächer (`extra:<id>`, z. B. herbstlager@…) und Weiterleitungen (weitere Adressen, die intern
 * in ein bestehendes Postfach einsortiert werden). Verwaltung mit `messages.mailbox.manage`.
 *
 * - Freigaben an Benutzer*innen, Mitglieder und Gruppen (Gruppe = alle verknüpften Konten der Mitglieder und
 *   Leitungen), Stufe `read` (lesen) bzw. `edit` (lesen und als Absender verwenden). Zugriff haben nur Konten
 *   mit `messages.message.send` (wie bei allen Postfächern).
 * - Jede Adresse gibt es nur einmal: Konflikt mit einem bestehenden Postfach oder einer Weiterleitung → 409.
 * - Löschen eines Postfachs: Mails wandern nach „Nicht zugeordnet“, Ordner und Weiterleitungen darauf entfallen.
 *
 * Core-Dienste (Principals, Audit, Speicher) nie innerhalb einer Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	describePrincipals,
	errors,
	inList,
	moduleDb,
	principalKeysFor,
	principalMatchSql,
	principalUserIds,
	replaceObjectShares,
	rowsOf,
	searchPrincipals,
	toIso,
	validatePrincipals,
	type Principal,
	type PrincipalInfo,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { UNASSIGNED, extraKey, kindOf } from './mailbox';
import { loadMailboxDirectory, type MailboxEntry } from './mailbox.service';
import {
	EXTRA_SHARE_TYPES,
	MAX_ALIASES,
	MAX_EXTRA_MAILBOXES,
	MODULE_ID,
	PERM_SEND,
	type AliasInput,
	type AliasTarget,
	type AliasesResponse,
	type ExtraMailbox,
	type ExtraMailboxInput,
	type ExtraMailboxUpdateInput,
	type ExtraShareLevel,
	type ExtraShareType,
	type MailboxAlias
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const SHARES = { shareTable: 'extra_mailbox_shares', fk: 'mailbox_id' } as const;
const STAMM_LABEL = 'Stamm';
/** Sperre für die Eindeutigkeit der Adressen (zusätzliche Postfächer + Weiterleitungen) */
const ADDRESS_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('messages:mailbox-addresses'))`;

interface StoredShare {
	type: ExtraShareType;
	id: string;
	level: ExtraShareLevel;
}

interface ExtraRow {
	id: string;
	address: string;
	name: string;
	description: string | null;
	createdAt: string;
	shares: StoredShare[];
}

/** Text einer Zeile (`NULL` → leer) */
const txt = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));
const levelOf = (v: unknown): ExtraShareLevel => (txt(v) === 'edit' ? 'edit' : 'read');

// --- Lesen (Verzeichnis, Zugriff) -----------------------------------------------------------

/** Alle zusätzlichen Postfächer mit Freigaben (eine Transaktion, keine Core-Dienste) */
async function loadExtraRows(): Promise<ExtraRow[]> {
	return mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT id, address, name, description, created_at FROM extra_mailboxes ORDER BY lower(name), address`
		);
		const shares = await rowsOf(
			tx,
			sql`SELECT mailbox_id, principal_type, principal_id, level FROM extra_mailbox_shares
				ORDER BY created_at, principal_type, principal_id`
		);
		return rows.map((r) => ({
			id: txt(r.id),
			address: txt(r.address),
			name: txt(r.name),
			description: strOrNull(r.description),
			createdAt: toIso(r.created_at),
			shares: shares
				.filter((s) => txt(s.mailbox_id) === txt(r.id))
				.map((s) => ({
					type: txt(s.principal_type) as ExtraShareType,
					id: txt(s.principal_id),
					level: levelOf(s.level)
				}))
		}));
	});
}

/**
 * Verzeichnis-Einträge der zusätzlichen Postfächer: berechtigt sind alle Konten hinter den Freigaben
 * (beide Stufen), die `messages.message.send` haben.
 */
export async function extraDirectoryEntries(): Promise<MailboxEntry[]> {
	const out: MailboxEntry[] = [];
	for (const m of await loadExtraRows()) {
		const userIds = m.shares.length
			? await principalUserIds(MODULE_ID, m.shares, { permission: PERM_SEND })
			: [];
		out.push({ key: extraKey(m.id), kind: 'extra', address: m.address, name: m.name, userIds });
	}
	return out;
}

/** Weiterleitungen (Adresse → Postfach-Schlüssel) */
export async function loadAliasRows(): Promise<
	{ id: string; address: string; targetKey: string; createdAt: string }[]
> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, address, target_key, created_at FROM mailbox_aliases ORDER BY address`
		)
	);
	return rows.map((r) => ({
		id: txt(r.id),
		address: txt(r.address),
		targetKey: txt(r.target_key),
		createdAt: toIso(r.created_at)
	}));
}

/** Zusätzliches Postfach, das die angemeldete Person lesen darf (höchste Stufe ihrer Freigaben) */
export interface MyExtraMailbox {
	key: string;
	name: string;
	address: string;
	level: ExtraShareLevel;
}

/** Zusätzliche Postfächer der angemeldeten Person (nur mit `messages.message.send`) */
export async function myExtraMailboxes(ctx: RequestContext): Promise<MyExtraMailbox[]> {
	if (!ctx.userId || !core.permissions.has(ctx, PERM_SEND)) return [];
	const keys = await principalKeysFor(ctx, MODULE_ID);
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT m.id, m.name, m.address, bool_or(s.level = 'edit') AS can_send
				FROM extra_mailboxes m JOIN extra_mailbox_shares s ON s.mailbox_id = m.id
				WHERE ${principalMatchSql('s', keys)}
				GROUP BY m.id, m.name, m.address
				ORDER BY lower(m.name), m.address`
		)
	);
	return rows.map((r) => ({
		key: extraKey(txt(r.id)),
		name: txt(r.name),
		address: txt(r.address),
		level: r.can_send === true || r.can_send === 't' ? 'edit' : 'read'
	}));
}

// --- Verwaltung: zusätzliche Postfächer ------------------------------------------------------

/** Anzeigedaten aller Freigaben auf einmal (Schlüssel `typ:id`) */
async function describeAll(
	ctx: RequestContext,
	list: StoredShare[]
): Promise<Map<string, PrincipalInfo>> {
	const unique = new Map<string, Principal>();
	for (const s of list) unique.set(`${s.type}:${s.id}`, { type: s.type, id: s.id });
	const infos = await describePrincipals(ctx, MODULE_ID, [...unique.values()], {
		everyoneLabel: STAMM_LABEL,
		types: EXTRA_SHARE_TYPES
	});
	return new Map(infos.map((p) => [`${p.type}:${p.id}`, p]));
}

async function messageCounts(keys: string[]): Promise<Map<string, number>> {
	if (!keys.length) return new Map();
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT mailbox_key, count(*)::int AS n FROM inbox_messages
				WHERE mailbox_key IN (${inList(keys)}) AND deleted_at IS NULL GROUP BY mailbox_key`
		)
	);
	return new Map(rows.map((r) => [txt(r.mailbox_key), Number(r.n)]));
}

async function toDtos(ctx: RequestContext, rows: ExtraRow[]): Promise<ExtraMailbox[]> {
	const infos = await describeAll(
		ctx,
		rows.flatMap((r) => r.shares)
	);
	const counts = await messageCounts(rows.map((r) => extraKey(r.id)));
	return rows.map((r) => ({
		id: r.id,
		key: extraKey(r.id),
		name: r.name,
		address: r.address,
		description: r.description,
		createdAt: r.createdAt,
		messages: counts.get(extraKey(r.id)) ?? 0,
		shares: r.shares.map((s) => {
			const info = infos.get(`${s.type}:${s.id}`);
			return {
				type: s.type,
				id: s.id,
				level: s.level,
				name: info?.name ?? 'Unbekannt',
				detail: info?.detail ?? null,
				color: info?.color ?? null,
				image: info?.image ?? null
			};
		})
	}));
}

export async function listExtraMailboxes(ctx: RequestContext): Promise<ExtraMailbox[]> {
	return toDtos(ctx, await loadExtraRows());
}

async function getExtraMailbox(ctx: RequestContext, id: string): Promise<ExtraMailbox> {
	const row = (await loadExtraRows()).find((r) => r.id === id);
	if (!row) throw errors.notFound('Postfach nicht gefunden');
	const [dto] = await toDtos(ctx, [row]);
	return dto!;
}

/**
 * Adresse frei? Prüft gegen alle Postfächer und Weiterleitungen des Verzeichnisses (ohne das eigene
 * Postfach bzw. die eigene Weiterleitung). Ruft Core-Dienste auf – vor der Transaktion.
 */
async function assertAddressFree(
	address: string,
	except: { extraId?: string; aliasAddress?: string } = {}
): Promise<void> {
	const own = except.extraId ? extraKey(except.extraId) : null;
	const taken = (await loadMailboxDirectory()).some(
		(e) => e.address === address && !(own && e.key === own && !e.alias)
	);
	if (taken) throw addressConflict();
}

const addressConflict = () =>
	errors.conflict('Diese Adresse gehört schon zu einem Postfach oder einer Weiterleitung');

/** Gleiche Prüfung in der Transaktion (unter Sperre) gegen die eigenen Tabellen */
async function assertAddressFreeInTx(
	tx: Tx,
	address: string,
	exceptExtraId: string | null
): Promise<void> {
	await tx.execute(ADDRESS_LOCK);
	const hit = await rowsOf(
		tx,
		sql`SELECT 1 FROM extra_mailboxes WHERE address = ${address} AND id <> ${exceptExtraId ?? ''}
			UNION ALL SELECT 1 FROM mailbox_aliases WHERE address = ${address}`
	);
	if (hit.length) throw addressConflict();
}

export async function createExtraMailbox(
	ctx: RequestContext,
	input: ExtraMailboxInput
): Promise<ExtraMailbox> {
	await validatePrincipals(ctx, MODULE_ID, input.shares, { types: EXTRA_SHARE_TYPES });
	await assertAddressFree(input.address);
	const id = crypto.randomUUID();
	await mdb().transaction(async (tx) => {
		await assertAddressFreeInTx(tx, input.address, null);
		const [c] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM extra_mailboxes`);
		if (Number(c?.n ?? 0) >= MAX_EXTRA_MAILBOXES) {
			throw errors.conflict(`Höchstens ${MAX_EXTRA_MAILBOXES} zusätzliche Postfächer`);
		}
		await tx.execute(
			sql`INSERT INTO extra_mailboxes (id, address, name, description, created_by)
				VALUES (${id}, ${input.address}, ${input.name}, ${input.description}, ${ctx.userId ?? null})`
		);
		await replaceObjectShares(tx, ctx, SHARES, id, input.shares);
	});
	await core.audit.logFromContext(ctx, 'messages.mailbox.created', {
		target: id,
		metadata: { shares: input.shares.length }
	});
	return getExtraMailbox(ctx, id);
}

export async function updateExtraMailbox(
	ctx: RequestContext,
	id: string,
	input: ExtraMailboxUpdateInput
): Promise<ExtraMailbox> {
	const current = (await loadExtraRows()).find((r) => r.id === id);
	if (!current) throw errors.notFound('Postfach nicht gefunden');
	if (input.shares) {
		const keep = new Set(current.shares.map((s) => `${s.type}:${s.id}`));
		await validatePrincipals(ctx, MODULE_ID, input.shares, { types: EXTRA_SHARE_TYPES, keep });
	}
	const addressChanged = input.address !== undefined && input.address !== current.address;
	if (addressChanged) await assertAddressFree(input.address!, { extraId: id });
	await mdb().transaction(async (tx) => {
		if (addressChanged) await assertAddressFreeInTx(tx, input.address!, id);
		const res = await rowsOf(
			tx,
			sql`UPDATE extra_mailboxes SET
					name = ${input.name ?? current.name},
					address = ${input.address ?? current.address},
					description = ${input.description === undefined ? current.description : input.description},
					updated_at = now()
				WHERE id = ${id} RETURNING id`
		);
		if (!res.length) throw errors.notFound('Postfach nicht gefunden');
		if (input.shares) await replaceObjectShares(tx, ctx, SHARES, id, input.shares);
	});
	await core.audit.logFromContext(ctx, 'messages.mailbox.updated', {
		target: id,
		metadata: {
			addressChanged,
			...(input.shares ? { shares: input.shares.length } : {})
		}
	});
	return getExtraMailbox(ctx, id);
}

/**
 * Postfach löschen: Mails nach „Nicht zugeordnet“ (ohne Ordner), Ordner und Weiterleitungen darauf löschen.
 * Liegt dieselbe Mail schon in „Nicht zugeordnet“, entfällt die Kopie samt Anhängen.
 */
export async function deleteExtraMailbox(
	ctx: RequestContext,
	id: string
): Promise<{ deleted: true; movedMessages: number; deletedAliases: number }> {
	const key = extraKey(id);
	const result = await mdb().transaction(async (tx) => {
		const found = await rowsOf(tx, sql`SELECT id FROM extra_mailboxes WHERE id = ${id} FOR UPDATE`);
		if (!found.length) throw errors.notFound('Postfach nicht gefunden');
		const dupWhere = sql`i.mailbox_key = ${key} AND EXISTS (SELECT 1 FROM inbox_messages u
			WHERE u.mailbox_key = ${UNASSIGNED} AND u.dedupe_key = i.dedupe_key)`;
		const files = await rowsOf(
			tx,
			sql`SELECT a.storage_path FROM inbox_attachments a JOIN inbox_messages i ON i.id = a.inbox_message_id
				WHERE ${dupWhere}`
		);
		await tx.execute(sql`DELETE FROM inbox_messages i WHERE ${dupWhere}`);
		const moved = await rowsOf(
			tx,
			sql`UPDATE inbox_messages SET mailbox_key = ${UNASSIGNED}, folder_id = NULL,
					unassigned_reason = 'unknown'
				WHERE mailbox_key = ${key} RETURNING id`
		);
		if (moved.length) {
			// Gelesen-Status der bisherigen Berechtigten gilt nicht für die Verwaltung
			await tx.execute(
				sql`DELETE FROM inbox_reads WHERE inbox_message_id IN (${inList(moved.map((m) => txt(m.id)))})`
			);
		}
		await tx.execute(sql`DELETE FROM inbox_folders WHERE mailbox_key = ${key}`);
		const aliases = await rowsOf(
			tx,
			sql`DELETE FROM mailbox_aliases WHERE target_key = ${key} RETURNING id`
		);
		await tx.execute(sql`DELETE FROM extra_mailboxes WHERE id = ${id}`);
		return {
			moved: moved.length,
			aliases: aliases.length,
			paths: files.map((f) => txt(f.storage_path))
		};
	});
	if (result.paths.length) {
		await bestEffort('messages.mailbox.delete-files', () =>
			core.storage.removeMany(core.auth.systemContext(MODULE_ID), {
				module: MODULE_ID,
				paths: result.paths
			})
		);
	}
	await core.audit.logFromContext(ctx, 'messages.mailbox.deleted', {
		target: id,
		metadata: { movedMessages: result.moved, deletedAliases: result.aliases }
	});
	return { deleted: true, movedMessages: result.moved, deletedAliases: result.aliases };
}

/** Freigabe-Suche der Verwaltung: Gruppen, Mitglieder, Benutzer*innen */
export function searchMailboxPrincipals(
	ctx: RequestContext,
	search: string
): Promise<PrincipalInfo[]> {
	return searchPrincipals(ctx, MODULE_ID, search, {
		everyoneLabel: STAMM_LABEL,
		types: EXTRA_SHARE_TYPES
	});
}

// --- Verwaltung: Weiterleitungen ---------------------------------------------------------------

const KIND_ORDER = ['personal', 'office', 'group', 'stamm', 'extra'] as const;

/** Wählbare Ziele: alle Postfächer des Verzeichnisses (ohne Weiterleitungen), nach Art sortiert */
function targetsOf(directory: MailboxEntry[]): AliasTarget[] {
	const seen = new Set<string>();
	const out: AliasTarget[] = [];
	for (const e of directory) {
		if (e.alias || seen.has(e.key)) continue;
		seen.add(e.key);
		out.push({ key: e.key, kind: e.kind, name: e.name, address: e.address });
	}
	const rank = (k: string) => KIND_ORDER.indexOf(k as (typeof KIND_ORDER)[number]);
	return out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'de'));
}

export async function listAliases(): Promise<AliasesResponse> {
	const targets = targetsOf(await loadMailboxDirectory());
	const byKey = new Map(targets.map((t) => [t.key, t]));
	const aliases: MailboxAlias[] = (await loadAliasRows()).map((a) => ({
		id: a.id,
		address: a.address,
		targetKey: a.targetKey,
		target: byKey.get(a.targetKey) ?? null,
		createdAt: a.createdAt
	}));
	return { aliases, targets };
}

export async function createAlias(ctx: RequestContext, input: AliasInput): Promise<MailboxAlias> {
	if (input.targetKey === UNASSIGNED) {
		throw errors.validation([{ path: ['targetKey'], message: 'Bitte ein Postfach wählen' }]);
	}
	const directory = await loadMailboxDirectory();
	const target = targetsOf(directory).find((t) => t.key === input.targetKey);
	if (!target) {
		throw errors.validation([{ path: ['targetKey'], message: 'Unbekanntes Postfach' }]);
	}
	if (directory.some((e) => e.address === input.address)) throw addressConflict();
	const id = crypto.randomUUID();
	const createdAt = await mdb().transaction(async (tx) => {
		await assertAddressFreeInTx(tx, input.address, null);
		const [c] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM mailbox_aliases`);
		if (Number(c?.n ?? 0) >= MAX_ALIASES) {
			throw errors.conflict(`Höchstens ${MAX_ALIASES} Weiterleitungen`);
		}
		const [row] = await rowsOf(
			tx,
			sql`INSERT INTO mailbox_aliases (id, address, target_key, created_by)
				VALUES (${id}, ${input.address}, ${input.targetKey}, ${ctx.userId ?? null})
				RETURNING created_at`
		);
		return toIso(row?.created_at);
	});
	await core.audit.logFromContext(ctx, 'messages.alias.created', {
		target: id,
		metadata: { targetKind: kindOf(input.targetKey) }
	});
	return { id, address: input.address, targetKey: input.targetKey, target, createdAt };
}

export async function deleteAlias(ctx: RequestContext, id: string): Promise<{ deleted: true }> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(tx, sql`DELETE FROM mailbox_aliases WHERE id = ${id} RETURNING target_key`)
	);
	if (!rows.length) throw errors.notFound('Weiterleitung nicht gefunden');
	await core.audit.logFromContext(ctx, 'messages.alias.deleted', {
		target: id,
		metadata: { targetKind: kindOf(txt(rows[0]!.target_key)) }
	});
	return { deleted: true };
}
