/**
 * Reine Logik für Postfächer (ohne Server-/Svelte-Imports, in Tests und UI nutzbar):
 * Schlüssel, Zuordnung eingehender Adressen, Betreff-Präfixe für Antworten/Weiterleitungen.
 *
 * Postfach-Schlüssel entsprechen den Absender-Schlüsseln aus `GET /senders`, nur das persönliche
 * Postfach trägt die Konto-ID: `personal:<userId>`, `office:<amtId>:<adresse>`, `group:<gruppenId>`,
 * `stamm`, zusätzliche Postfächer der Verwaltung `extra:<id>`, dazu `unassigned` für Mails, die keinem
 * Postfach zugeordnet werden konnten.
 */

export type MailboxKind = 'personal' | 'office' | 'group' | 'stamm' | 'extra' | 'unassigned';

export const UNASSIGNED = 'unassigned';

/** Gültige Message-ID (wie im Core: `<lokal@domain>`) */
export const MESSAGE_ID_PATTERN = /^<[^\s<>@]{1,200}@[^\s<>@]{1,200}>$/;

/** Postfach-Schlüssel gültig? (Format, keine Prüfung der Berechtigung) */
export const MAILBOX_KEY_PATTERN =
	/^(personal:[A-Za-z0-9_-]{1,100}|office:[A-Za-z0-9-]{1,100}:[^\s:]{3,254}|group:[A-Za-z0-9-]{1,100}|extra:[A-Za-z0-9-]{1,100}|stamm|unassigned)$/;

export function personalKey(userId: string): string {
	return `personal:${userId}`;
}

/** Schlüssel eines zusätzlichen Postfachs der Verwaltung */
export function extraKey(id: string): string {
	return `extra:${id}`;
}

export function kindOf(key: string): MailboxKind {
	const kind = key.split(':')[0];
	return kind === 'personal' ||
		kind === 'office' ||
		kind === 'group' ||
		kind === 'stamm' ||
		kind === 'extra'
		? kind
		: 'unassigned';
}

/** Gemeinsames Postfach (mehrere Personen): Amt, Gruppe, Stamm, zusätzliches Postfach */
export function isSharedMailbox(key: string): boolean {
	const kind = kindOf(key);
	return kind === 'office' || kind === 'group' || kind === 'stamm' || kind === 'extra';
}

/** Absender-Schlüssel (`GET /senders`), mit dem aus diesem Postfach geantwortet wird */
export function senderKeyFor(mailboxKey: string): string | null {
	const kind = kindOf(mailboxKey);
	if (kind === 'unassigned') return null;
	return kind === 'personal' ? 'personal' : mailboxKey;
}

/** Postfach eines Absenders (`personal` → `personal:<userId>`) */
export function mailboxKeyForSender(senderKey: string, userId: string | null): string | null {
	if (senderKey === 'personal') return userId ? personalKey(userId) : null;
	return MAILBOX_KEY_PATTERN.test(senderKey) ? senderKey : null;
}

/** Ein Postfach mit seiner Adresse (systemweit, für die Zuordnung beim Abruf) */
export interface MailboxTarget {
	key: string;
	address: string;
	name: string;
}

export interface RouteResult {
	/** Je Postfach genau ein Eintrag (Adresse, an die die Mail ging) */
	targets: { mailbox: MailboxTarget; address: string }[];
	/** Kein Postfach gefunden: Adresse für den Sammelordner und Grund */
	unassigned: { address: string; reason: 'unknown' | 'ambiguous' } | null;
}

/**
 * Index Adresse → Postfächer. Persönliche Adressen, die mehrere Konten ergeben (gleicher Name),
 * sind mehrdeutig und werden keinem Konto zugeordnet.
 */
export function buildAddressIndex(mailboxes: MailboxTarget[]): {
	byAddress: Map<string, MailboxTarget[]>;
	ambiguous: Set<string>;
} {
	const byAddress = new Map<string, MailboxTarget[]>();
	const ambiguous = new Set<string>();
	for (const m of mailboxes) {
		const address = m.address.trim().toLowerCase();
		const list = byAddress.get(address) ?? [];
		if (list.some((x) => x.key === m.key)) continue;
		if (kindOf(m.key) === 'personal' && list.some((x) => kindOf(x.key) === 'personal')) {
			ambiguous.add(address);
		}
		list.push(m);
		byAddress.set(address, list);
	}
	for (const address of ambiguous) {
		const rest = (byAddress.get(address) ?? []).filter((x) => kindOf(x.key) !== 'personal');
		if (rest.length) byAddress.set(address, rest);
		else byAddress.delete(address);
	}
	return { byAddress, ambiguous };
}

/**
 * Empfänger einer Mail den Postfächern zuordnen. `candidates` = Zustell-Empfänger (`Delivered-To` …)
 * zuerst, dann An/Cc. `ownDomains` bestimmt die Adresse für den Sammelordner (sonst die erste).
 */
export function routeAddresses(
	candidates: string[],
	index: ReturnType<typeof buildAddressIndex>,
	ownDomains: ReadonlySet<string>
): RouteResult {
	const seen = new Set<string>();
	const targets: RouteResult['targets'] = [];
	let ambiguousHit: string | null = null;
	for (const raw of candidates) {
		const address = raw.trim().toLowerCase();
		if (!address || seen.has(address)) continue;
		seen.add(address);
		if (index.ambiguous.has(address) && !ambiguousHit) ambiguousHit = address;
		for (const mailbox of index.byAddress.get(address) ?? []) {
			if (!targets.some((t) => t.mailbox.key === mailbox.key)) targets.push({ mailbox, address });
		}
	}
	if (targets.length) return { targets, unassigned: null };
	if (ambiguousHit) return { targets, unassigned: { address: ambiguousHit, reason: 'ambiguous' } };
	const all = [...seen];
	const own = all.find((a) => ownDomains.has(a.split('@').pop() ?? ''));
	return { targets, unassigned: { address: own ?? all[0] ?? '', reason: 'unknown' } };
}

const REPLY_PREFIX = /^\s*((re|aw|antw|wg|fw|fwd|wtr)\s*(\[\d+\])?\s*:\s*)+/i;

/** Betreff ohne Antwort-/Weiterleitungs-Präfixe („Re: AW: Wg: …“) */
export function baseSubject(subject: string): string {
	return subject.replace(REPLY_PREFIX, '').trim();
}

/** Betreff für Antwort („Re: …“) bzw. Weiterleitung („Wg: …“), höchstens `max` Zeichen */
export function prefixedSubject(subject: string, mode: 'reply' | 'forward', max = 200): string {
	const base = baseSubject(subject) || '(kein Betreff)';
	return `${mode === 'reply' ? 'Re' : 'Wg'}: ${base}`.slice(0, max);
}
