/**
 * Spam-Schutz im Posteingang: Bewertung beim Abruf, „Spam“ / „Kein Spam“ an Mails und die gemeinsame
 * Sperr- und Vertrauensliste (`sender_rules`, eine für alle Postfächer).
 *
 * - Abruf: `loadSpamEnvironment` einmal je Lauf (Listen, bekannte Absender, Einstellung), dann
 *   `evaluateSpam` je Mail (zählt Mails desselben Absenders der letzten Stunde).
 * - Knöpfe: jede*r mit Zugriff auf das Postfach; mit `remember` landet der Absender auf der Liste und
 *   weitere Mails desselben Absenders in den eigenen Postfächern werden gleich mit verschoben.
 * - Liste verwalten: nur mit `messages.inbox.manage` (Endpunkte).
 * Core-Aufrufe nie innerhalb einer Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	moduleDb,
	rowsOf,
	toIso,
	userLabel,
	type RequestContext
} from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import type { ParsedInbound } from './inbound-parse';
import { loadMailboxDirectory, accessibleMailboxes } from './mailbox.service';
import { isValidDomain } from './sender';
import { loadSettings } from './sender.service';
import {
	FLOOD_WINDOW_MINUTES,
	domainOf,
	matchSenderRule,
	parseSenderPattern,
	scoreSpam,
	type SenderRuleKind,
	type SpamVerdict
} from './spam-rules';
import {
	INBOX_SETTING_KEYS,
	MAX_SENDER_RULES,
	MODULE_ID,
	PERM_SEND,
	type SenderRule,
	type SenderRuleInput,
	type SpamMarkInput,
	type SpamMarkResult
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const str = (v: unknown) => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));
const system = () => core.auth.systemContext(MODULE_ID);

interface RuleRow {
	kind: SenderRuleKind;
	matchType: 'address' | 'domain';
	pattern: string;
}

async function loadRules(): Promise<RuleRow[]> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT kind, match_type, pattern FROM sender_rules`)
	);
	return rows.map((r) => ({
		kind: str(r.kind) as SenderRuleKind,
		matchType: str(r.match_type) as 'address' | 'domain',
		pattern: str(r.pattern)
	}));
}

/** Domains der eigenen Postfächer und der Domain persönlicher Adressen */
export async function loadOwnDomains(): Promise<Set<string>> {
	const entries = await loadMailboxDirectory();
	const settings = await loadSettings();
	const own = new Set(entries.map((e) => domainOf(e.address)));
	if (isValidDomain(settings.domain)) own.add(settings.domain.toLowerCase());
	return own;
}

/**
 * Bekannte Absender: Adressen der Mitglieder, der Konten mit Senderecht und alle Adressen, an die schon
 * aus der App geschrieben wurde.
 */
async function loadKnownSenders(): Promise<Set<string>> {
	const known = new Set<string>();
	const members = await core.modules.use<MembersService>('members', MODULE_ID);
	for (const c of await members.listMemberContacts({ limit: 1000 })) {
		for (const e of c.emails) known.add(e.trim().toLowerCase());
	}
	const accounts = await core.users.byIds(system(), await core.permissions.usersWith(PERM_SEND), {
		includeEmail: true
	});
	for (const a of accounts.values()) if (a.email) known.add(a.email.toLowerCase());
	const sent = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT DISTINCT lower(address) AS address FROM message_recipients`)
	);
	for (const r of sent) known.add(str(r.address));
	known.delete('');
	return known;
}

export interface SpamEnvironment {
	enabled: boolean;
	rules: RuleRow[];
	known: Set<string>;
	ownDomains: Set<string>;
}

/** Einmal je Abruf: Einstellung, Listen und bekannte Absender */
export async function loadSpamEnvironment(ownDomains: Set<string>): Promise<SpamEnvironment> {
	const enabled = (await core.settings.get(INBOX_SETTING_KEYS.spamFilter)) !== false;
	return { enabled, rules: await loadRules(), known: await loadKnownSenders(), ownDomains };
}

/** Bewertung einer eingehenden Mail (Datenbank: Mails desselben Absenders der letzten Stunde) */
export async function evaluateSpam(
	env: SpamEnvironment,
	parsed: ParsedInbound
): Promise<SpamVerdict> {
	const address = parsed.from?.address ?? '';
	const [row] = address
		? await mdb().transaction((tx) =>
				rowsOf(
					tx,
					sql`SELECT count(DISTINCT dedupe_key) AS n FROM inbox_messages
						WHERE from_address = ${address}
							AND imported_at > now() - make_interval(mins => ${FLOOD_WINDOW_MINUTES})`
				)
			)
		: [];
	const known = !!address && (env.known.has(address) || env.ownDomains.has(domainOf(address)));
	const rule = address ? matchSenderRule(address, env.rules) : null;
	const verdict = scoreSpam(parsed, {
		ownDomains: env.ownDomains,
		rule,
		known,
		recentFromSender: Number(row?.n ?? 0)
	});
	if (env.enabled || verdict.source === 'blocklist') return verdict;
	// Eigene Erkennung aus: nur Listen, bekannte Absender und das Urteil des Mailservers
	const trusted = (rule?.kind === 'allow' || known) && parsed.authResult !== 'fail';
	const spam = parsed.spam && !trusted;
	return { ...verdict, spam, source: spam ? 'server' : null };
}

/** Mails mit Zugriff laden (sonst 404 wie bei den übrigen Aktionen) */
async function loadMails(
	ctx: RequestContext,
	ids: string[]
): Promise<{ id: string; mailboxKey: string; from: string }[]> {
	const unique = [...new Set(ids)];
	const boxes = new Set((await accessibleMailboxes(ctx)).map((b) => b.key));
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, mailbox_key, from_address FROM inbox_messages WHERE id IN (${inList(unique)})`
		)
	);
	const mails = rows.map((r) => ({
		id: str(r.id),
		mailboxKey: str(r.mailbox_key),
		from: str(r.from_address).toLowerCase()
	}));
	if (mails.length !== unique.length || mails.some((m) => !boxes.has(m.mailboxKey))) {
		throw errors.notFound('Nachricht nicht gefunden');
	}
	return mails;
}

/**
 * „Spam“ / „Kein Spam“: markiert die Mails und merkt sich (mit `remember`) die Absender auf der Sperr-
 * bzw. Vertrauensliste. Dann gehen auch weitere Mails desselben Absenders in den Postfächern der
 * Person mit. Eigene Adressen (eigene Domains) kommen nie auf die Liste.
 */
export async function markSpam(ctx: RequestContext, input: SpamMarkInput): Promise<SpamMarkResult> {
	const mails = await loadMails(ctx, input.ids);
	const boxes = [...new Set((await accessibleMailboxes(ctx)).map((b) => b.key))];
	const own = input.remember ? await loadOwnDomains() : new Set<string>();
	const senders = input.remember
		? [...new Set(mails.map((m) => m.from))].filter(
				(a) => parseSenderPattern(a)?.matchType === 'address' && !own.has(domainOf(a))
			)
		: [];
	const kind: SenderRuleKind = input.spam ? 'block' : 'allow';
	const ids = mails.map((m) => m.id);
	const userId = ctx.userId ?? null;
	const result = await mdb().transaction(async (tx) => {
		const [count] = await rowsOf(tx, sql`SELECT count(*) AS n FROM sender_rules`);
		if (Number(count?.n ?? 0) + senders.length > MAX_SENDER_RULES) {
			throw errors.conflict(
				`Die Liste ist voll (höchstens ${MAX_SENDER_RULES} Einträge). Bitte alte Einträge löschen.`
			);
		}
		for (const address of senders) {
			await tx.execute(
				sql`INSERT INTO sender_rules (id, kind, match_type, pattern, origin, created_by)
					VALUES (${crypto.randomUUID()}, ${kind}, 'address', ${address}, 'button', ${userId})
					ON CONFLICT (match_type, pattern) DO UPDATE
						SET kind = excluded.kind, origin = 'button', created_by = excluded.created_by, created_at = now()`
			);
		}
		const marked = await rowsOf(
			tx,
			input.spam
				? sql`UPDATE inbox_messages
						SET spam = true, spam_source = 'user', spam_marked_by = ${userId}, spam_marked_at = now()
						WHERE id IN (${inList(ids)}) RETURNING id`
				: sql`UPDATE inbox_messages
						SET spam = false, spam_source = NULL, spam_marked_by = ${userId}, spam_marked_at = now()
						WHERE id IN (${inList(ids)}) RETURNING id`
		);
		let more: unknown[] = [];
		if (senders.length) {
			more = await rowsOf(
				tx,
				input.spam
					? sql`UPDATE inbox_messages
							SET spam = true, spam_source = 'blocklist', spam_marked_by = ${userId}, spam_marked_at = now()
							WHERE lower(from_address) IN (${inList(senders)}) AND mailbox_key IN (${inList(boxes)})
								AND id NOT IN (${inList(ids)}) AND deleted_at IS NULL AND NOT spam
							RETURNING id`
					: sql`UPDATE inbox_messages
							SET spam = false, spam_source = NULL, spam_marked_by = ${userId}, spam_marked_at = now()
							WHERE lower(from_address) IN (${inList(senders)}) AND mailbox_key IN (${inList(boxes)})
								AND id NOT IN (${inList(ids)}) AND deleted_at IS NULL AND spam
							RETURNING id`
			);
		}
		return { changed: marked.length + more.length };
	});
	await core.audit.logFromContext(ctx, 'messages.inbox.spam-marked', {
		metadata: { count: result.changed, spam: input.spam, remembered: senders.length }
	});
	return { changed: result.changed, remembered: senders.length };
}

/** Sperr- und Vertrauensliste (Verwaltung) */
export async function listSenderRules(ctx: RequestContext): Promise<SenderRule[]> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, kind, match_type, pattern, note, origin, created_by, created_at
				FROM sender_rules ORDER BY kind, match_type DESC, pattern`
		)
	);
	const names = await core.users.byIds(
		ctx,
		rows.map((r) => strOrNull(r.created_by))
	);
	return rows.map((r) => ({
		id: str(r.id),
		kind: str(r.kind) as SenderRule['kind'],
		matchType: str(r.match_type) as SenderRule['matchType'],
		pattern: str(r.pattern),
		note: strOrNull(r.note),
		origin: str(r.origin) as SenderRule['origin'],
		createdByName: r.created_by ? userLabel(names, str(r.created_by)) : null,
		createdAt: toIso(r.created_at)
	}));
}

export async function createSenderRule(
	ctx: RequestContext,
	input: SenderRuleInput
): Promise<SenderRule> {
	const parsed = parseSenderPattern(input.value);
	if (!parsed) {
		throw errors.validation(
			[{ path: ['value'], message: 'Bitte eine gültige Mailadresse oder Domain eingeben' }],
			'Ungültige Adresse oder Domain'
		);
	}
	const own = await loadOwnDomains();
	const domain = parsed.matchType === 'domain' ? parsed.pattern : domainOf(parsed.pattern);
	if (input.kind === 'block' && [...own].some((d) => d === domain || d.endsWith(`.${domain}`))) {
		throw errors.validation(
			[{ path: ['value'], message: 'Eigene Adressen und Domains lassen sich nicht sperren' }],
			'Eigene Adressen lassen sich nicht sperren'
		);
	}
	const id = crypto.randomUUID();
	await mdb().transaction(async (tx) => {
		const [count] = await rowsOf(tx, sql`SELECT count(*) AS n FROM sender_rules`);
		if (Number(count?.n ?? 0) >= MAX_SENDER_RULES) {
			throw errors.conflict(`Die Liste ist voll (höchstens ${MAX_SENDER_RULES} Einträge)`);
		}
		const [dup] = await rowsOf(
			tx,
			sql`SELECT kind FROM sender_rules WHERE match_type = ${parsed.matchType} AND pattern = ${parsed.pattern}`
		);
		if (dup) {
			throw errors.conflict(
				str(dup.kind) === input.kind
					? 'Dieser Eintrag steht schon auf der Liste'
					: 'Dieser Eintrag steht schon auf der anderen Liste – bitte dort erst löschen'
			);
		}
		await tx.execute(
			sql`INSERT INTO sender_rules (id, kind, match_type, pattern, note, origin, created_by)
				VALUES (${id}, ${input.kind}, ${parsed.matchType}, ${parsed.pattern}, ${input.note}, 'manual', ${ctx.userId ?? null})`
		);
	});
	await core.audit.logFromContext(ctx, 'messages.spam.rule-created', {
		target: id,
		metadata: { kind: input.kind, matchType: parsed.matchType }
	});
	const rule = (await listSenderRules(ctx)).find((r) => r.id === id);
	if (!rule) throw errors.notFound('Eintrag nicht gefunden');
	return rule;
}

export async function deleteSenderRule(
	ctx: RequestContext,
	id: string
): Promise<{ deleted: true }> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(tx, sql`DELETE FROM sender_rules WHERE id = ${id} RETURNING kind, match_type`)
	);
	if (!rows.length) throw errors.notFound('Eintrag nicht gefunden');
	await core.audit.logFromContext(ctx, 'messages.spam.rule-deleted', {
		target: id,
		metadata: { kind: str(rows[0]!.kind), matchType: str(rows[0]!.match_type) }
	});
	return { deleted: true };
}
