/**
 * Posteingang lesen: Postfächer mit Ungelesen-Zähler, Liste, Detail mit Verlauf, gelesen/ungelesen,
 * Papierkorb, Zuordnen aus „Nicht zugeordnet“, Anhänge, Vorbelegung für Antworten/Weiterleitungen.
 * Zugriff je Mail über ihr Postfach (`accessibleMailboxes`); fremd → 404.
 * Core-Aufrufe nie innerhalb einer Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	moduleDb,
	rowsOf,
	secureFileResponse,
	detectContentType,
	toIso,
	userLabel,
	type RequestContext,
	type Row
} from '$lib/sdk/server';
import { inboxDocument, inlineCidImages, quoteForEditor } from './html';
import { UNASSIGNED, isSharedMailbox, prefixedSubject } from './mailbox';
import { notifyNewMail } from './inbox-notify.service';
import {
	accessibleMailboxes,
	loadMailboxDirectory,
	type AccessibleMailbox
} from './mailbox.service';
import { loadInboxConfig } from './inbound.service';
import { folderPathOf, mailboxStats } from './folders.service';
import {
	BASE_PATH,
	INLINE_IMAGE_MAX,
	MODULE_ID,
	PERM_INBOX_MANAGE,
	type ComposeMode,
	type ComposePrefill,
	type InboxAddress,
	type InboxAttachmentInfo,
	type InboxDetail,
	type InboxFilter,
	type InboxListResponse,
	type InboxSummary,
	type MailboxesResponse,
	type MailboxSentItem,
	type MailboxSentResponse,
	type MessageStatus,
	type ThreadEntry
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const system = () => core.auth.systemContext(MODULE_ID);

const str = (v: unknown) => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));

function addresses(v: unknown): InboxAddress[] {
	const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
	if (!Array.isArray(list)) return [];
	return list
		.filter((a): a is { address: string; name?: string | null } => !!a && typeof a === 'object')
		.map((a) => ({ address: String(a.address), name: a.name ? String(a.name) : null }));
}

function snippetOf(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function summaryOf(r: Row): InboxSummary {
	return {
		id: str(r.id),
		mailboxKey: str(r.mailbox_key),
		from: { address: str(r.from_address), name: strOrNull(r.from_name) },
		subject: str(r.subject),
		snippet: snippetOf(str(r.body_text)),
		receivedAt: toIso(r.received_at),
		read: r.is_read === true || r.is_read === 't',
		attachmentCount: Number(r.attachment_count ?? 0),
		spam: r.spam === true,
		answered: r.answered === true || r.answered === 't',
		deleted: r.deleted_at != null,
		folderId: strOrNull(r.folder_id)
	};
}

/** Lese-/Antwortstatus als SQL-Spalten (`i` = inbox_messages) */
const statusColumns = (userId: string) => sql`
	EXISTS (SELECT 1 FROM inbox_reads rd WHERE rd.inbox_message_id = i.id AND rd.user_id = ${userId}) AS is_read,
	EXISTS (SELECT 1 FROM messages m WHERE m.reply_of = i.id) AS answered,
	(SELECT count(*)::int FROM inbox_attachments a WHERE a.inbox_message_id = i.id AND NOT a.inline) AS attachment_count`;

/** Ungelesene Mails (ohne Spam/Papierkorb) je Postfach für die angemeldete Person */
async function unreadCounts(userId: string, keys: string[]): Promise<Map<string, number>> {
	if (!keys.length) return new Map();
	const counts = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT i.mailbox_key, count(*)::int AS n FROM inbox_messages i
				WHERE i.mailbox_key IN (${inList(keys)}) AND i.deleted_at IS NULL AND NOT i.spam
					AND NOT EXISTS (SELECT 1 FROM inbox_reads rd WHERE rd.inbox_message_id = i.id AND rd.user_id = ${userId})
				GROUP BY i.mailbox_key`
		)
	);
	return new Map(counts.map((c) => [str(c.mailbox_key), Number(c.n)]));
}

/**
 * Zähler für die Seitenleiste (`navBadge`): ungelesene Mails in allen eigenen Postfächern – ohne
 * „Nicht zugeordnet“ (Sammelordner der Verwaltung soll nicht dauerhaft zählen).
 */
export async function unreadTotal(ctx: RequestContext): Promise<number> {
	if (!ctx.userId) return 0;
	const keys = (await accessibleMailboxes(ctx))
		.filter((b) => b.kind !== 'unassigned')
		.map((b) => b.key);
	let total = 0;
	for (const n of (await unreadCounts(ctx.userId, keys)).values()) total += n;
	return total;
}

export async function listMailboxes(ctx: RequestContext): Promise<MailboxesResponse> {
	const boxes = await accessibleMailboxes(ctx);
	const keys = boxes.map((b) => b.key);
	const unread = await unreadCounts(ctx.userId ?? '', keys);
	const stats = await mailboxStats(
		ctx.userId ?? '',
		keys.filter((k) => k !== UNASSIGNED)
	);
	const canManage = core.permissions.has(ctx, PERM_INBOX_MANAGE);
	const cfg = await loadInboxConfig();
	let lastPoll: MailboxesResponse['lastPoll'] = null;
	if (canManage) {
		const [state] = await mdb().transaction((tx) =>
			rowsOf(tx, sql`SELECT last_at, status, message FROM inbox_poll_state WHERE id = 1`)
		);
		lastPoll = {
			at: state?.last_at == null ? null : toIso(state.last_at),
			status: strOrNull(state?.status),
			message: strOrNull(state?.message)
		};
	}
	return {
		mailboxes: boxes.map((b) => ({
			...b,
			unread: unread.get(b.key) ?? 0,
			folders: stats.folders.get(b.key) ?? [],
			inboxUnread:
				b.key === UNASSIGNED ? (unread.get(b.key) ?? 0) : (stats.inboxUnread.get(b.key) ?? 0),
			spamCount: stats.spam.get(b.key) ?? 0
		})),
		enabled: cfg.enabled,
		canManage,
		lastPoll
	};
}

const filterSql = (filter: InboxFilter, userId: string) => {
	switch (filter) {
		case 'unread':
			return sql`i.deleted_at IS NULL AND NOT i.spam AND NOT EXISTS (SELECT 1 FROM inbox_reads rd WHERE rd.inbox_message_id = i.id AND rd.user_id = ${userId})`;
		case 'spam':
			return sql`i.deleted_at IS NULL AND i.spam`;
		case 'trash':
			return sql`i.deleted_at IS NOT NULL`;
		default:
			return sql`i.deleted_at IS NULL AND NOT i.spam`;
	}
};

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listInbox(
	ctx: RequestContext,
	q: {
		mailbox: string;
		filter: InboxFilter;
		folder?: string;
		search: string;
		limit: number;
		offset: number;
	}
): Promise<InboxListResponse> {
	const box = await requireBox(ctx, q.mailbox);
	const userId = ctx.userId ?? '';
	const like = `%${escapeLike(q.search.toLowerCase())}%`;
	// Spam und Papierkorb gelten für das ganze Postfach, sonst Posteingang (ohne Ordner) bzw. ein Ordner
	const folder = q.folder ?? 'inbox';
	const postbox = q.filter === 'spam' || q.filter === 'trash';
	if (!postbox && folder !== 'inbox') {
		const [f] = await mdb().transaction((tx) =>
			rowsOf(tx, sql`SELECT 1 FROM inbox_folders WHERE id = ${folder} AND mailbox_key = ${box.key}`)
		);
		if (!f) throw errors.notFound('Ordner nicht gefunden');
	}
	const folderSql = postbox
		? sql``
		: folder === 'inbox'
			? sql`AND i.folder_id IS NULL`
			: sql`AND i.folder_id = ${folder}`;
	const where = sql`i.mailbox_key = ${box.key} AND ${filterSql(q.filter, userId)} ${folderSql}
		${q.search ? sql`AND (lower(i.subject) LIKE ${like} OR lower(i.from_address) LIKE ${like} OR lower(coalesce(i.from_name, '')) LIKE ${like})` : sql``}`;
	return mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT i.id, i.mailbox_key, i.folder_id, i.from_address, i.from_name, i.subject,
					left(i.body_text, 400) AS body_text, i.received_at, i.spam, i.deleted_at, ${statusColumns(userId)}
				FROM inbox_messages i WHERE ${where}
				ORDER BY i.received_at DESC, i.id LIMIT ${q.limit} OFFSET ${q.offset}`
		);
		const [t] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM inbox_messages i WHERE ${where}`
		);
		return { items: rows.map(summaryOf), total: Number(t?.n ?? 0) };
	});
}

/** SQL-Bedingung „Nachricht gehört zu diesem Postfach“ (`m` = messages); Altbestand ohne `mailbox_key` über die Absenderadresse */
function sentFromSql(box: AccessibleMailbox, userId: string) {
	const legacy =
		box.kind === 'personal'
			? sql`(m.mailbox_key IS NULL AND lower(m.sender_address) = ${box.address.toLowerCase()} AND m.created_by = ${userId})`
			: sql`(m.mailbox_key IS NULL AND lower(m.sender_address) = ${box.address.toLowerCase()})`;
	return sql`(m.mailbox_key = ${box.key} OR ${legacy})`;
}

/** Von der Adresse eines Postfachs gesendete Nachrichten (gemeinsame Postfächer: von allen Berechtigten) */
export async function listMailboxSent(
	ctx: RequestContext,
	q: { mailbox: string; search: string; limit: number; offset: number }
): Promise<MailboxSentResponse> {
	const box = await requireBox(ctx, q.mailbox);
	if (box.kind === 'unassigned') throw errors.notFound('Postfach nicht gefunden');
	const like = `%${escapeLike(q.search.toLowerCase())}%`;
	const where = sql`${sentFromSql(box, ctx.userId ?? '')}
		${q.search ? sql`AND (lower(m.subject) LIKE ${like} OR EXISTS (SELECT 1 FROM message_recipients rs WHERE rs.message_id = m.id AND lower(rs.address) LIKE ${like}))` : sql``}`;
	const data = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT m.id, m.subject, m.created_at, m.created_by, m.status, m.total,
					(SELECT r.address FROM message_recipients r WHERE r.message_id = m.id
						ORDER BY r.name NULLS LAST, r.address LIMIT 1) AS first_to,
					(SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS attachment_count
				FROM messages m WHERE ${where}
				ORDER BY m.created_at DESC, m.id LIMIT ${q.limit} OFFSET ${q.offset}`
		);
		const [t] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM messages m WHERE ${where}`);
		return { rows, total: Number(t?.n ?? 0) };
	});
	const names = await core.users.byIds(
		ctx,
		data.rows.map((r) => strOrNull(r.created_by))
	);
	return {
		items: data.rows.map((r): MailboxSentItem => ({
			id: str(r.id),
			subject: str(r.subject),
			to: str(r.first_to),
			recipients: Number(r.total ?? 0),
			createdAt: toIso(r.created_at),
			createdByName: userLabel(names, strOrNull(r.created_by)),
			status: str(r.status) as MessageStatus,
			attachmentCount: Number(r.attachment_count ?? 0)
		})),
		total: data.total
	};
}

/**
 * Darf `ctx` diese gesendete Nachricht über ein Postfach sehen? (zusätzlich zu „eigene“/`view-all`):
 * gehört sie zu einem eigenen Postfach – gemeinsame Postfächer auch, wenn jemand anderes gesendet hat.
 */
export async function sentViaAccessibleMailbox(
	ctx: RequestContext,
	m: { mailbox_key?: unknown; sender_address?: unknown; created_by?: unknown }
): Promise<boolean> {
	if (!ctx.userId) return false;
	const boxes = (await accessibleMailboxes(ctx)).filter((b) => b.kind !== 'unassigned');
	const key = strOrNull(m.mailbox_key);
	if (key) return boxes.some((b) => b.key === key);
	const sender = str(m.sender_address).toLowerCase();
	return boxes.some(
		(b) =>
			b.address.toLowerCase() === sender &&
			(b.kind !== 'personal' || strOrNull(m.created_by) === ctx.userId)
	);
}

async function requireBox(ctx: RequestContext, key: string): Promise<AccessibleMailbox> {
	const box = (await accessibleMailboxes(ctx)).find((b) => b.key === key);
	if (!box) throw errors.notFound('Postfach nicht gefunden');
	return box;
}

/** Mail laden und Zugriff prüfen (404 für Fremde); `tx`-frei, Core-Aufrufe danach erlaubt */
export async function loadInboxRow(
	ctx: RequestContext,
	id: string
): Promise<{ row: Row; box: AccessibleMailbox }> {
	const userId = ctx.userId ?? '';
	const [row] = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT i.*, ${statusColumns(userId)} FROM inbox_messages i WHERE i.id = ${id}`)
	);
	if (!row) throw errors.notFound('Nachricht nicht gefunden');
	const box = (await accessibleMailboxes(ctx)).find((b) => b.key === str(row.mailbox_key));
	if (!box) throw errors.notFound('Nachricht nicht gefunden');
	return { row, box };
}

async function attachmentsOf(
	id: string
): Promise<(InboxAttachmentInfo & { path: string; contentId: string | null })[]> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, filename, content_type, size, content_id, inline, storage_path
				FROM inbox_attachments WHERE inbox_message_id = ${id} ORDER BY inline, filename, id`
		)
	);
	return rows.map((a) => ({
		id: str(a.id),
		filename: str(a.filename),
		contentType: str(a.content_type),
		size: Number(a.size),
		inline: a.inline === true,
		path: str(a.storage_path),
		contentId: strOrNull(a.content_id)
	}));
}

export async function getInboxMessage(ctx: RequestContext, id: string): Promise<InboxDetail> {
	const { row, box } = await loadInboxRow(ctx, id);
	const userId = ctx.userId ?? '';
	const threadId = str(row.thread_id);
	const data = await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO inbox_reads (inbox_message_id, user_id) VALUES (${id}, ${userId})
				ON CONFLICT DO NOTHING`
		);
		const replies = await rowsOf(
			tx,
			sql`SELECT id, created_by, created_at, reply_of FROM messages
				WHERE reply_of = ${id} OR forward_of = ${id} ORDER BY created_at`
		);
		const inbound = await rowsOf(
			tx,
			sql`SELECT id, from_address, from_name, subject, left(body_text, 400) AS body_text, received_at
				FROM inbox_messages WHERE thread_id = ${threadId} AND mailbox_key = ${box.key} AND deleted_at IS NULL`
		);
		const outbound = await rowsOf(
			tx,
			sql`SELECT id, sender_address, sender_name, subject, left(body_text, 400) AS body_text, created_at
				FROM messages WHERE (thread_id = ${threadId} OR id = ${threadId}) AND mailbox_key = ${box.key}`
		);
		return { replies, inbound, outbound };
	});
	const attachments = await attachmentsOf(id);
	const folderPath = await folderPathOf(box.key, strOrNull(row.folder_id));
	// Eingebettete Bilder (cid) als data:-URLs
	const images = new Map<string, { contentType: string; data: Uint8Array }>();
	for (const a of attachments) {
		if (!a.contentId || a.size > INLINE_IMAGE_MAX || !a.contentType.startsWith('image/')) continue;
		try {
			const file = await core.storage.download(system(), { module: MODULE_ID, path: a.path });
			if (detectContentType(file.buffer) === a.contentType) {
				images.set(a.contentId.toLowerCase(), { contentType: a.contentType, data: file.buffer });
			}
		} catch {
			// Bild fehlt im Speicher – Platzhalter bleibt leer
		}
	}
	const names = await core.users.byIds(
		ctx,
		data.replies.map((r) => strOrNull(r.created_by))
	);
	const thread: ThreadEntry[] = [
		...data.inbound.map((t) => ({
			id: str(t.id),
			direction: 'in' as const,
			from: t.from_name ? `${str(t.from_name)} <${str(t.from_address)}>` : str(t.from_address),
			subject: str(t.subject),
			snippet: snippetOf(str(t.body_text)),
			at: toIso(t.received_at),
			href: `${BASE_PATH}/inbox/${str(t.id)}`,
			current: str(t.id) === id
		})),
		...data.outbound.map((t) => ({
			id: str(t.id),
			direction: 'out' as const,
			from: t.sender_name
				? `${str(t.sender_name)} <${str(t.sender_address)}>`
				: str(t.sender_address),
			subject: str(t.subject),
			snippet: snippetOf(str(t.body_text)),
			at: toIso(t.created_at),
			href: `${BASE_PATH}/${str(t.id)}`,
			current: false
		}))
	].sort((a, b) => a.at.localeCompare(b.at));
	const skipped = (() => {
		const v = row.skipped_attachments;
		const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
		return Array.isArray(list)
			? list.map((s: { filename?: unknown; contentType?: unknown; size?: unknown }) => ({
					filename: str(s.filename),
					contentType: str(s.contentType),
					size: Number(s.size ?? 0)
				}))
			: [];
	})();
	return {
		...summaryOf({ ...row, is_read: true }),
		mailboxAddress: str(row.mailbox_address),
		mailboxName: box.name,
		folderPath,
		to: addresses(row.to_list),
		cc: addresses(row.cc_list),
		replyTo: strOrNull(row.reply_to),
		document: inboxDocument(inlineCidImages(str(row.body_html), images)),
		authResult: (['pass', 'fail'].includes(str(row.auth_result))
			? str(row.auth_result)
			: 'none') as InboxDetail['authResult'],
		truncated: row.truncated === true,
		unassignedReason: (strOrNull(row.unassigned_reason) as InboxDetail['unassignedReason']) ?? null,
		attachments: attachments
			.filter((a) => !a.inline || !a.contentId || !images.has(a.contentId.toLowerCase()))
			.map(({ path: _p, contentId: _c, ...a }) => a),
		skippedAttachments: skipped,
		blockedImages: Number(row.blocked_images ?? 0),
		replies: data.replies.map((r) => ({
			messageId: str(r.id),
			byName: userLabel(names, strOrNull(r.created_by)),
			at: toIso(r.created_at),
			kind: r.reply_of ? ('reply' as const) : ('forward' as const)
		})),
		thread: thread.length > 1 ? thread : [],
		canReply: box.senderKey !== null
	};
}

export async function setRead(
	ctx: RequestContext,
	id: string,
	read: boolean
): Promise<{ read: boolean }> {
	await loadInboxRow(ctx, id);
	const userId = ctx.userId ?? '';
	await mdb().transaction((tx) =>
		tx.execute(
			read
				? sql`INSERT INTO inbox_reads (inbox_message_id, user_id) VALUES (${id}, ${userId}) ON CONFLICT DO NOTHING`
				: sql`DELETE FROM inbox_reads WHERE inbox_message_id = ${id} AND user_id = ${userId}`
		)
	);
	return { read };
}

/** In den Papierkorb (gemeinsame Postfächer: für alle) bzw. wiederherstellen */
export async function setDeleted(
	ctx: RequestContext,
	id: string,
	deleted: boolean
): Promise<{ deleted: boolean }> {
	const { box } = await loadInboxRow(ctx, id);
	await mdb().transaction((tx) =>
		tx.execute(
			deleted
				? sql`UPDATE inbox_messages SET deleted_at = now(), deleted_by = ${ctx.userId ?? null} WHERE id = ${id}`
				: sql`UPDATE inbox_messages SET deleted_at = NULL, deleted_by = NULL WHERE id = ${id}`
		)
	);
	await core.audit.logFromContext(
		ctx,
		deleted ? 'messages.inbox.deleted' : 'messages.inbox.restored',
		{
			target: id,
			metadata: { shared: isSharedMailbox(box.key) }
		}
	);
	return { deleted };
}

/** Alle Postfächer (Ziel beim Zuordnen, nur für die Verwaltung) – ohne Personen */
export async function listAssignTargets(): Promise<
	{ key: string; kind: string; name: string; address: string }[]
> {
	return (await loadMailboxDirectory()).map((e) => ({
		key: e.key,
		kind: e.kind,
		name: e.kind === 'personal' ? `Persönlich: ${e.name}` : e.name,
		address: e.address
	}));
}

/** Aus „Nicht zugeordnet“ einem Postfach zuordnen (nur mit `messages.inbox.manage`) */
export async function assignMail(
	ctx: RequestContext,
	id: string,
	mailbox: string
): Promise<{ mailbox: string; visible: boolean }> {
	const { row } = await loadInboxRow(ctx, id);
	if (str(row.mailbox_key) !== UNASSIGNED) {
		throw errors.conflict('Nur nicht zugeordnete Nachrichten können zugeordnet werden');
	}
	if (mailbox === UNASSIGNED) {
		throw errors.validation([{ path: ['mailbox'], message: 'Bitte ein Postfach wählen' }]);
	}
	const target = (await loadMailboxDirectory()).find((e) => e.key === mailbox);
	if (!target) throw errors.validation([{ path: ['mailbox'], message: 'Unbekanntes Postfach' }]);
	await mdb().transaction(async (tx) => {
		const dup = await rowsOf(
			tx,
			sql`SELECT 1 FROM inbox_messages WHERE mailbox_key = ${mailbox} AND dedupe_key = ${str(row.dedupe_key)}`
		);
		if (dup.length) throw errors.conflict('Die Nachricht liegt bereits in diesem Postfach');
		await tx.execute(
			sql`UPDATE inbox_messages SET mailbox_key = ${mailbox}, mailbox_address = ${target.address},
					unassigned_reason = NULL, folder_id = NULL WHERE id = ${id}`
		);
		// Gelesen-Status der Verwaltung gilt nicht für die Empfänger*innen
		await tx.execute(sql`DELETE FROM inbox_reads WHERE inbox_message_id = ${id}`);
	});
	await core.audit.logFromContext(ctx, 'messages.inbox.assigned', {
		target: id,
		metadata: { kind: target.kind }
	});
	await notifyNewMail([
		{
			id,
			mailboxKey: target.key,
			mailboxName: target.name,
			mailboxAddress: target.address,
			from: { address: str(row.from_address), name: strOrNull(row.from_name) },
			subject: str(row.subject),
			text: str(row.body_text),
			notify: row.spam !== true && row.auto_submitted !== true
		}
	]);
	// Nach dem Zuordnen liegt die Nachricht oft in einem Postfach, das die Verwaltung nicht sieht
	const visible = (await accessibleMailboxes(ctx)).some((b) => b.key === mailbox);
	return { mailbox, visible };
}

export async function downloadAttachment(
	ctx: RequestContext,
	id: string,
	attachmentId: string,
	inline: boolean
): Promise<Response> {
	await loadInboxRow(ctx, id);
	const att = (await attachmentsOf(id)).find((a) => a.id === attachmentId);
	if (!att) throw errors.notFound('Anhang nicht gefunden');
	const { stream, file } = await core.storage.downloadStream(system(), {
		module: MODULE_ID,
		path: att.path
	});
	return secureFileResponse(stream, {
		contentType: att.contentType,
		size: file.size,
		name: att.filename,
		download: !inline,
		cache: 'private, no-store'
	});
}

/** Anhänge (Bytes) einer Mail für die Weiterleitung, nur die gewählten (Zugriff prüft der Aufrufer) */
export async function forwardAttachments(
	id: string,
	ids: string[]
): Promise<{ filename: string; contentType: string; bytes: Uint8Array }[]> {
	if (!ids.length) return [];
	const all = await attachmentsOf(id);
	const out: { filename: string; contentType: string; bytes: Uint8Array }[] = [];
	for (const wanted of ids) {
		const att = all.find((a) => a.id === wanted);
		if (!att)
			throw errors.validation([{ path: ['forwardAttachmentIds'], message: 'Unbekannter Anhang' }]);
		const file = await core.storage.download(system(), { module: MODULE_ID, path: att.path });
		out.push({ filename: att.filename, contentType: att.contentType, bytes: file.buffer });
	}
	return out;
}

const formatDate = (iso: string) =>
	new Date(iso).toLocaleString('de-DE', {
		timeZone: 'Europe/Berlin',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});

/** Vorbelegung für Antworten („Re:“, Absender des Postfachs, Zitat) und Weiterleiten („Wg:“, Anhänge) */
export async function composePrefill(
	ctx: RequestContext,
	id: string,
	mode: ComposeMode
): Promise<ComposePrefill> {
	const { row, box } = await loadInboxRow(ctx, id);
	if (!box.senderKey) {
		throw errors.conflict(
			'Aus „Nicht zugeordnet“ kann nicht geantwortet werden – bitte erst zuordnen'
		);
	}
	const from = { address: str(row.from_address), name: strOrNull(row.from_name) };
	const fromLabel = from.name ? `${from.name} <${from.address}>` : from.address;
	const when = formatDate(toIso(row.received_at));
	const own = new Set([box.address.toLowerCase()]);
	let addressesOut: string[] = [];
	if (mode !== 'forward') {
		addressesOut.push((strOrNull(row.reply_to) ?? from.address).toLowerCase());
		if (mode === 'reply-all') {
			for (const a of [...addresses(row.to_list), ...addresses(row.cc_list)]) {
				addressesOut.push(a.address.toLowerCase());
			}
		}
		addressesOut = [...new Set(addressesOut)].filter((a) => !own.has(a));
	}
	const header =
		mode === 'forward'
			? `---------- Weitergeleitete Nachricht ----------\nVon: ${fromLabel}\nDatum: ${when}\nBetreff: ${str(row.subject)}\nAn: ${addresses(
					row.to_list
				)
					.map((a) => a.address)
					.join(', ')}`
			: `Am ${when} schrieb ${fromLabel}:`;
	const attachments =
		mode === 'forward'
			? (await attachmentsOf(id))
					.filter((a) => !a.inline)
					.map(({ path: _p, contentId: _c, ...a }) => a)
			: [];
	return {
		mode,
		senderKey: box.senderKey,
		addresses: addressesOut,
		subject: prefixedSubject(str(row.subject), mode === 'forward' ? 'forward' : 'reply'),
		bodyHtml: quoteForEditor(header, str(row.body_text)),
		replyOf: mode === 'forward' ? null : id,
		forwardOf: mode === 'forward' ? id : null,
		attachments
	};
}
