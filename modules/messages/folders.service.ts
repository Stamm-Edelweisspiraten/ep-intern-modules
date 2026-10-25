/**
 * Ordner im Posteingang: je Postfach, gemeinsam für alle mit Zugriff auf das Postfach (Amt, Gruppe,
 * Stamm), im persönlichen Postfach nur für die Person selbst. „Nicht zugeordnet“ hat keine Ordner.
 * Anlegen/Umbenennen/Verschieben/Löschen von Ordnern, Mails einsortieren, Sammelaktionen.
 * Zugriff über `accessibleMailboxes` (je Request, fremd → 404); Core-Aufrufe nie in der Transaktion.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	isUniqueViolation,
	moduleDb,
	rowsOf,
	toIso,
	userLabel,
	type RequestContext,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { UNASSIGNED, isSharedMailbox } from './mailbox';
import {
	accessibleMailboxes,
	loadMailboxDirectory,
	type AccessibleMailbox
} from './mailbox.service';
import {
	descendantIds,
	folderDepth,
	folderPath,
	nameTaken,
	subtreeHeight,
	wouldCycle
} from './folders';
import {
	MAX_FOLDERS_PER_MAILBOX,
	MAX_FOLDER_DEPTH,
	MODULE_ID,
	type BulkAction,
	type DeleteFolderResult,
	type FolderDetails,
	type FolderCreateInput,
	type FolderUpdateInput,
	type InboxFolder,
	type MoveMailsInput,
	type MoveMailsResult
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const str = (v: unknown) => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));

const FOLDER_NOT_FOUND = 'Ordner nicht gefunden';
const NAME_TAKEN = 'Hier gibt es schon einen Ordner mit diesem Namen';
const DEPTH_TEXT = `Höchstens ${MAX_FOLDER_DEPTH} Ebenen`;

type FolderRow = { id: string; parentId: string | null; name: string; mailboxKey: string };

const folderOf = (r: Row): FolderRow => ({
	id: str(r.id),
	parentId: strOrNull(r.parent_id),
	name: str(r.name),
	mailboxKey: str(r.mailbox_key)
});

/** Paralleles Anlegen/Verschieben im selben Postfach hintereinander (Limit, Namensprüfung) */
const lockMailbox = (tx: Tx, key: string) =>
	tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`messages:folders:${key}`}))`);

async function foldersOfMailbox(tx: Tx, key: string): Promise<FolderRow[]> {
	return (
		await rowsOf(
			tx,
			sql`SELECT id, parent_id, name, mailbox_key FROM inbox_folders WHERE mailbox_key = ${key}`
		)
	).map(folderOf);
}

/** Zähler für die Seitenleiste je Postfach: Ordner (ungelesen/gesamt), Posteingang ungelesen, Spam */
export async function mailboxStats(
	userId: string,
	keys: string[]
): Promise<{
	folders: Map<string, InboxFolder[]>;
	inboxUnread: Map<string, number>;
	spam: Map<string, number>;
}> {
	const folders = new Map<string, InboxFolder[]>();
	const inboxUnread = new Map<string, number>();
	const spam = new Map<string, number>();
	if (!keys.length) return { folders, inboxUnread, spam };
	const data = await mdb().transaction(async (tx) => {
		const list = await rowsOf(
			tx,
			sql`SELECT id, parent_id, name, mailbox_key FROM inbox_folders WHERE mailbox_key IN (${inList(keys)})`
		);
		const counts = await rowsOf(
			tx,
			sql`SELECT i.mailbox_key, i.folder_id, count(*)::int AS total,
					count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM inbox_reads rd
						WHERE rd.inbox_message_id = i.id AND rd.user_id = ${userId}))::int AS unread
				FROM inbox_messages i
				WHERE i.mailbox_key IN (${inList(keys)}) AND i.deleted_at IS NULL AND NOT i.spam
				GROUP BY i.mailbox_key, i.folder_id`
		);
		const spamRows = await rowsOf(
			tx,
			sql`SELECT mailbox_key, count(*)::int AS n FROM inbox_messages
				WHERE mailbox_key IN (${inList(keys)}) AND deleted_at IS NULL AND spam
				GROUP BY mailbox_key`
		);
		return { list, counts, spamRows };
	});
	const byFolder = new Map<string, { unread: number; total: number }>();
	for (const c of data.counts) {
		const folderId = strOrNull(c.folder_id);
		const entry = { unread: Number(c.unread ?? 0), total: Number(c.total ?? 0) };
		if (folderId) byFolder.set(folderId, entry);
		else inboxUnread.set(str(c.mailbox_key), entry.unread);
	}
	for (const r of data.list) {
		const f = folderOf(r);
		const list = folders.get(f.mailboxKey) ?? [];
		list.push({
			id: f.id,
			parentId: f.parentId,
			name: f.name,
			unread: byFolder.get(f.id)?.unread ?? 0,
			total: byFolder.get(f.id)?.total ?? 0
		});
		folders.set(f.mailboxKey, list);
	}
	for (const list of folders.values()) {
		list.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
	}
	for (const s of data.spamRows) spam.set(str(s.mailbox_key), Number(s.n ?? 0));
	return { folders, inboxUnread, spam };
}

/** Ordner laden und Zugriff über sein Postfach prüfen (fremd → 404) */
async function requireFolder(
	ctx: RequestContext,
	id: string
): Promise<{ folder: FolderRow; box: AccessibleMailbox }> {
	const [row] = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT id, parent_id, name, mailbox_key FROM inbox_folders WHERE id = ${id}`)
	);
	if (!row) throw errors.notFound(FOLDER_NOT_FOUND);
	const folder = folderOf(row);
	const box = (await accessibleMailboxes(ctx)).find((b) => b.key === folder.mailboxKey);
	if (!box) throw errors.notFound(FOLDER_NOT_FOUND);
	return { folder, box };
}

/** Ordner im Postfach `key` als Ziel prüfen (in der Transaktion); unbekannt/anderes Postfach → 422 */
async function requireTargetFolder(
	tx: Tx,
	key: string,
	folderId: string,
	path: string
): Promise<FolderRow> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT id, parent_id, name, mailbox_key FROM inbox_folders
			WHERE id = ${folderId} AND mailbox_key = ${key}`
	);
	if (!row) throw errors.validation([{ path: [path], message: 'Unbekannter Ordner' }]);
	return folderOf(row);
}

const toDto = (f: FolderRow): InboxFolder => ({
	id: f.id,
	parentId: f.parentId,
	name: f.name,
	unread: 0,
	total: 0
});

export async function createFolder(
	ctx: RequestContext,
	input: FolderCreateInput
): Promise<InboxFolder> {
	const box = (await accessibleMailboxes(ctx)).find((b) => b.key === input.mailbox);
	if (!box) throw errors.notFound('Postfach nicht gefunden');
	if (box.key === UNASSIGNED) {
		throw errors.validation([
			{ path: ['mailbox'], message: 'In „Nicht zugeordnet“ gibt es keine Ordner' }
		]);
	}
	const name = input.name.trim();
	const id = crypto.randomUUID();
	let depth = 1;
	try {
		await mdb().transaction(async (tx) => {
			await lockMailbox(tx, box.key);
			const all = await foldersOfMailbox(tx, box.key);
			if (all.length >= MAX_FOLDERS_PER_MAILBOX) {
				throw errors.validation([
					{ path: ['name'], message: `Höchstens ${MAX_FOLDERS_PER_MAILBOX} Ordner je Postfach` }
				]);
			}
			if (input.parentId) {
				await requireTargetFolder(tx, box.key, input.parentId, 'parentId');
				depth = folderDepth(all, input.parentId) + 1;
				if (depth > MAX_FOLDER_DEPTH) {
					throw errors.validation([{ path: ['parentId'], message: DEPTH_TEXT }]);
				}
			}
			if (nameTaken(all, input.parentId, name)) throw errors.conflict(NAME_TAKEN);
			await tx.execute(
				sql`INSERT INTO inbox_folders (id, mailbox_key, parent_id, name, created_by)
					VALUES (${id}, ${box.key}, ${input.parentId}, ${name}, ${ctx.userId ?? null})`
			);
		});
	} catch (e) {
		if (isUniqueViolation(e)) throw errors.conflict(NAME_TAKEN);
		throw e;
	}
	await core.audit.logFromContext(ctx, 'messages.inbox.folder-created', {
		target: id,
		metadata: { shared: isSharedMailbox(box.key), depth }
	});
	return toDto({ id, parentId: input.parentId, name, mailboxKey: box.key });
}

/** Umbenennen und/oder verschieben (`parentId`: neuer Elternordner, `null` = oberste Ebene) */
export async function updateFolder(
	ctx: RequestContext,
	id: string,
	input: FolderUpdateInput
): Promise<InboxFolder> {
	const { folder, box } = await requireFolder(ctx, id);
	const name = input.name?.trim() ?? folder.name;
	const parentId = input.parentId === undefined ? folder.parentId : input.parentId;
	const moved = parentId !== folder.parentId;
	try {
		await mdb().transaction(async (tx) => {
			await lockMailbox(tx, box.key);
			const all = await foldersOfMailbox(tx, box.key);
			if (!all.some((f) => f.id === id)) throw errors.notFound(FOLDER_NOT_FOUND);
			if (moved && parentId) {
				await requireTargetFolder(tx, box.key, parentId, 'parentId');
				if (wouldCycle(all, id, parentId)) {
					throw errors.validation([
						{
							path: ['parentId'],
							message:
								'Ein Ordner kann nicht in sich selbst oder einen Unterordner verschoben werden'
						}
					]);
				}
			}
			if (moved && folderDepth(all, parentId) + subtreeHeight(all, id) > MAX_FOLDER_DEPTH) {
				throw errors.validation([{ path: ['parentId'], message: DEPTH_TEXT }]);
			}
			if (nameTaken(all, parentId, name, id)) throw errors.conflict(NAME_TAKEN);
			await tx.execute(
				sql`UPDATE inbox_folders SET name = ${name}, parent_id = ${parentId}, updated_at = now()
					WHERE id = ${id}`
			);
		});
	} catch (e) {
		if (isUniqueViolation(e)) throw errors.conflict(NAME_TAKEN);
		throw e;
	}
	await core.audit.logFromContext(ctx, 'messages.inbox.folder-updated', {
		target: id,
		metadata: { shared: isSharedMailbox(box.key), renamed: name !== folder.name, moved }
	});
	return toDto({ id, parentId, name, mailboxKey: box.key });
}

/** Ordner samt Unterordnern löschen; enthaltene Mails gehen zurück in den Posteingang */
export async function deleteFolder(ctx: RequestContext, id: string): Promise<DeleteFolderResult> {
	const { box } = await requireFolder(ctx, id);
	const result = await mdb().transaction(async (tx) => {
		await lockMailbox(tx, box.key);
		const all = await foldersOfMailbox(tx, box.key);
		const ids = [id, ...descendantIds(all, id)];
		const [c] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM inbox_messages WHERE folder_id IN (${inList(ids)})`
		);
		await tx.execute(
			sql`UPDATE inbox_messages SET folder_id = NULL WHERE folder_id IN (${inList(ids)})`
		);
		await tx.execute(sql`DELETE FROM inbox_folders WHERE id = ${id}`);
		return { folders: ids.length, movedMessages: Number(c?.n ?? 0) };
	});
	await core.audit.logFromContext(ctx, 'messages.inbox.folder-deleted', {
		target: id,
		metadata: { shared: isSharedMailbox(box.key), ...result }
	});
	return { deleted: true, movedMessages: result.movedMessages };
}

/** Mails laden und Zugriff prüfen: alle müssen existieren und in zugänglichen Postfächern liegen (sonst 404) */
async function loadAccessibleMails(
	ctx: RequestContext,
	ids: string[]
): Promise<{ id: string; mailboxKey: string; folderId: string | null }[]> {
	const unique = [...new Set(ids)];
	const boxes = new Set((await accessibleMailboxes(ctx)).map((b) => b.key));
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, mailbox_key, folder_id FROM inbox_messages WHERE id IN (${inList(unique)})`
		)
	);
	const mails = rows.map((r) => ({
		id: str(r.id),
		mailboxKey: str(r.mailbox_key),
		folderId: strOrNull(r.folder_id)
	}));
	if (mails.length !== unique.length || mails.some((m) => !boxes.has(m.mailboxKey))) {
		throw errors.notFound('Nachricht nicht gefunden');
	}
	return mails;
}

/** Mails in einen Ordner (oder `null` = Posteingang) desselben Postfachs verschieben */
export async function moveMails(
	ctx: RequestContext,
	input: MoveMailsInput
): Promise<MoveMailsResult> {
	const mails = await loadAccessibleMails(ctx, input.ids);
	const keys = [...new Set(mails.map((m) => m.mailboxKey))];
	if (keys.length !== 1) {
		throw errors.validation([
			{ path: ['ids'], message: 'Die Nachrichten liegen in verschiedenen Postfächern' }
		]);
	}
	const key = keys[0]!;
	if (key === UNASSIGNED) {
		throw errors.validation([
			{ path: ['folderId'], message: 'In „Nicht zugeordnet“ gibt es keine Ordner' }
		]);
	}
	const ids = mails.map((m) => m.id);
	await mdb().transaction(async (tx) => {
		if (input.folderId) await requireTargetFolder(tx, key, input.folderId, 'folderId');
		await tx.execute(
			sql`UPDATE inbox_messages SET folder_id = ${input.folderId}
				WHERE id IN (${inList(ids)}) AND mailbox_key = ${key}`
		);
	});
	await core.audit.logFromContext(ctx, 'messages.inbox.moved', {
		target: input.folderId ?? undefined,
		metadata: { count: ids.length, shared: isSharedMailbox(key), toInbox: !input.folderId }
	});
	return {
		moved: ids.length,
		previous: mails.map((m) => ({ id: m.id, folderId: m.folderId }))
	};
}

/** Sammelaktion für markierte Mails: gelesen/ungelesen (je Person), Papierkorb/wiederherstellen (für alle) */
export async function bulkAction(
	ctx: RequestContext,
	input: { ids: string[]; action: BulkAction }
): Promise<{ changed: number }> {
	const mails = await loadAccessibleMails(ctx, input.ids);
	const ids = mails.map((m) => m.id);
	const userId = ctx.userId ?? '';
	await mdb().transaction(async (tx) => {
		switch (input.action) {
			case 'read':
				for (const id of ids) {
					await tx.execute(
						sql`INSERT INTO inbox_reads (inbox_message_id, user_id) VALUES (${id}, ${userId})
							ON CONFLICT DO NOTHING`
					);
				}
				break;
			case 'unread':
				await tx.execute(
					sql`DELETE FROM inbox_reads WHERE user_id = ${userId} AND inbox_message_id IN (${inList(ids)})`
				);
				break;
			case 'delete':
				await tx.execute(
					sql`UPDATE inbox_messages SET deleted_at = now(), deleted_by = ${ctx.userId ?? null}
						WHERE id IN (${inList(ids)}) AND deleted_at IS NULL`
				);
				break;
			case 'restore':
				await tx.execute(
					sql`UPDATE inbox_messages SET deleted_at = NULL, deleted_by = NULL WHERE id IN (${inList(ids)})`
				);
				break;
		}
	});
	if (input.action === 'delete' || input.action === 'restore') {
		await core.audit.logFromContext(
			ctx,
			input.action === 'delete' ? 'messages.inbox.deleted' : 'messages.inbox.restored',
			{
				metadata: {
					count: ids.length,
					shared: mails.some((m) => isSharedMailbox(m.mailboxKey))
				}
			}
		);
	}
	return { changed: ids.length };
}

/** Ordnerpfad einer Mail (für die Detailansicht) */
export async function folderPathOf(
	mailboxKey: string,
	folderId: string | null
): Promise<{ id: string; name: string }[]> {
	if (!folderId) return [];
	const all = await mdb().transaction((tx) => foldersOfMailbox(tx, mailboxKey));
	return folderPath(all, folderId).map((f) => ({ id: f.id, name: f.name }));
}

/** Details zu einem Postfach bzw. Ordner: Anzahl, Ungelesene, Größe, Anhänge, Zeitraum, Zugriff */
export async function folderDetails(
	ctx: RequestContext,
	q: { mailbox: string; folder?: string }
): Promise<FolderDetails> {
	const box = (await accessibleMailboxes(ctx)).find((b) => b.key === q.mailbox);
	if (!box) throw errors.notFound('Postfach nicht gefunden');
	const userId = ctx.userId ?? '';
	const data = await mdb().transaction(async (tx) => {
		const all = await foldersOfMailbox(tx, box.key);
		const folder = q.folder ? all.find((f) => f.id === q.folder) : undefined;
		if (q.folder && !folder) throw errors.notFound(FOLDER_NOT_FOUND);
		const ids = folder ? [folder.id, ...descendantIds(all, folder.id)] : [];
		const scope = folder ? sql`AND i.folder_id IN (${inList(ids)})` : sql``;
		const [stats] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n,
					count(*) FILTER (WHERE ${folder ? sql`i.folder_id = ${folder.id}` : sql`i.folder_id IS NULL`})::int AS direct,
					count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM inbox_reads rd
						WHERE rd.inbox_message_id = i.id AND rd.user_id = ${userId}))::int AS unread,
					coalesce(sum(i.size), 0)::bigint AS size,
					min(i.received_at) AS oldest, max(i.received_at) AS newest,
					(SELECT count(*)::int FROM inbox_attachments a JOIN inbox_messages j ON j.id = a.inbox_message_id
						WHERE j.mailbox_key = ${box.key} AND j.deleted_at IS NULL AND NOT j.spam AND NOT a.inline
						${folder ? sql`AND j.folder_id IN (${inList(ids)})` : sql``}) AS attachments
				FROM inbox_messages i
				WHERE i.mailbox_key = ${box.key} AND i.deleted_at IS NULL AND NOT i.spam ${scope}`
		);
		const [other] = folder
			? [undefined]
			: await rowsOf(
					tx,
					sql`SELECT count(*) FILTER (WHERE deleted_at IS NULL AND spam)::int AS spam,
							count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS trash
						FROM inbox_messages WHERE mailbox_key = ${box.key}`
				);
		const [meta] = folder
			? await rowsOf(
					tx,
					sql`SELECT created_at, created_by FROM inbox_folders WHERE id = ${folder.id}`
				)
			: [undefined];
		return { all, folder, ids, stats, other, meta };
	});
	const createdBy = strOrNull(data.meta?.created_by);
	let access: string[] = [];
	if (box.shared && box.kind !== 'unassigned') {
		const entry = (await loadMailboxDirectory()).find((e) => e.key === box.key);
		const names = await core.users.byIds(ctx, entry?.userIds ?? []);
		access = (entry?.userIds ?? [])
			.map((id) => userLabel(names, id))
			.sort((a, b) => a.localeCompare(b, 'de'));
	}
	const names = createdBy ? await core.users.byIds(ctx, [createdBy]) : null;
	const s = data.stats;
	return {
		kind: data.folder ? 'folder' : 'mailbox',
		name: data.folder?.name ?? box.name,
		mailboxName: box.name,
		address: box.address,
		path: data.folder ? folderPath(data.all, data.folder.id).map((f) => f.name) : [],
		shared: box.shared,
		messages: Number(s?.n ?? 0),
		direct: Number(s?.direct ?? 0),
		unread: Number(s?.unread ?? 0),
		size: Number(s?.size ?? 0),
		attachments: Number(s?.attachments ?? 0),
		folders: data.folder ? data.ids.length - 1 : data.all.length,
		spam: data.other ? Number(data.other.spam ?? 0) : null,
		trash: data.other ? Number(data.other.trash ?? 0) : null,
		oldest: s?.oldest == null ? null : toIso(s.oldest),
		newest: s?.newest == null ? null : toIso(s.newest),
		createdAt: data.meta?.created_at == null ? null : toIso(data.meta.created_at),
		createdByName: names && createdBy ? userLabel(names, createdBy) : null,
		access
	};
}
