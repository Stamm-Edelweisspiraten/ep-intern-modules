/**
 * Eingehende Mail (Rohtext) → `ParsedInbound` über `mailparser`: Kopfzeilen, Adressen, Text/HTML,
 * Anhänge sowie Kennzeichen für Spam, automatische Mails, eigene Benachrichtigungen und das Ergebnis
 * der Absenderprüfung (`Authentication-Results`). Ohne Core-Zugriffe (in Unit-Tests nutzbar).
 */
import { simpleParser, type AddressObject, type HeaderValue } from 'mailparser';
import { MESSAGE_ID_PATTERN } from './mailbox';

export interface InboundAddress {
	address: string;
	name: string | null;
}

export interface InboundAttachment {
	filename: string;
	contentType: string;
	size: number;
	content: Buffer;
	/** Content-ID ohne spitze Klammern (für `cid:`-Bilder im HTML) */
	contentId: string | null;
	/** Im Text eingebettet (z. B. Logo in der Signatur) */
	inline: boolean;
}

export interface ParsedInbound {
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	from: InboundAddress | null;
	replyTo: string | null;
	to: InboundAddress[];
	cc: InboundAddress[];
	/** Zustell-Empfänger aus `Delivered-To`, `X-Original-To`, `Envelope-To` u. Ä. (auch Bcc) */
	envelopeTo: string[];
	subject: string;
	date: Date | null;
	html: string | null;
	text: string;
	attachments: InboundAttachment[];
	/** Vom Mailserver als Spam markiert (`X-Spam-Flag`/`X-Spam-Status`) */
	spam: boolean;
	/** Spam-Wert des Mailservers (`X-Spam-Score`, `score=` in `X-Spam-Status`/`X-Rspamd-Score`) oder `null` */
	serverSpamScore: number | null;
	/** Automatische Mail (`Auto-Submitted`, Abwesenheitsnotiz) – löst keine Benachrichtigung aus */
	autoSubmitted: boolean;
	/** Eigene Benachrichtigung dieser App (`X-EP-Intern`) – wird nicht importiert (Schleifenschutz) */
	ownNotification: boolean;
	/** Ergebnis der Absenderprüfung des Mailservers (DMARC, sonst DKIM/SPF) */
	authResult: 'pass' | 'fail' | 'none';
}

const ENVELOPE_HEADERS = [
	'delivered-to',
	'x-original-to',
	'envelope-to',
	'x-envelope-to',
	'x-rcpt-to',
	'x-forwarded-to'
];

const SIMPLE_ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Kleingeschrieben und getrimmt; ungültige Adressen → `null` */
export function cleanAddress(value: unknown): string | null {
	const v = String(value ?? '')
		.trim()
		.replace(/^<|>$/g, '')
		.toLowerCase();
	return v.length <= 254 && SIMPLE_ADDRESS.test(v) ? v : null;
}

function addressList(value: AddressObject | AddressObject[] | undefined): InboundAddress[] {
	const out: InboundAddress[] = [];
	for (const obj of Array.isArray(value) ? value : value ? [value] : []) {
		for (const entry of obj.value) {
			// Gruppen („Undisclosed recipients:;“) enthalten weitere Adressen
			for (const a of entry.group ?? [entry]) {
				const address = cleanAddress(a.address);
				if (address) out.push({ address, name: oneLine(a.name) || null });
			}
		}
	}
	return out;
}

/** Eine Zeile ohne Steuerzeichen, höchstens `max` Zeichen */
function oneLine(value: unknown, max = 300): string {
	return (
		String(value ?? '')
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, max)
	);
}

function headerText(value: HeaderValue | undefined): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map((v) => String(v)).join(' ');
	if (typeof value === 'object' && 'value' in value) return String(value.value ?? '');
	return String(value);
}

/** Message-IDs aus einem Kopfzeilen-Wert (`<a@b> <c@d>`), nur gültige */
export function messageIds(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.join(' ') : String(value ?? '');
	const found = raw.match(/<[^<>\s]+>/g) ?? [];
	// Manche Programme lassen die Klammern weg
	const ids = found.length ? found : raw.split(/\s+/).map((v) => (v ? `<${v}>` : ''));
	return [...new Set(ids.filter((id) => MESSAGE_ID_PATTERN.test(id)))];
}

/** Kennung des prüfenden Servers (`authserv-id`, erstes Element vor dem ersten „;“) */
const authservId = (line: string) => line.split(';')[0]!.trim().split(/\s+/)[0]!.toLowerCase();

/**
 * Ergebnis aus `Authentication-Results` (DMARC hat Vorrang, sonst DKIM/SPF).
 *
 * Gewertet werden nur die Kopfzeilen des **obersten** (= unseres) Mailservers: ältere Zeilen stammen von
 * Zwischenstationen (Weiterleitung, Catch-all beim Provider) und schlagen dort oft fehl, ohne dass die Mail
 * gefälscht ist. Nur ein eindeutiges Ergebnis zählt als „fail“: `dmarc=fail` (nicht bei `arc=pass`, also
 * sauber weitergeleitet) oder hartes `spf=fail` ohne bestandenes DKIM/SPF. `softfail`, `neutral`,
 * `temperror`/`permerror` und ein DKIM-Fehler allein (Mailinglisten ändern oft den Text) sind „none“.
 */
export function authResultOf(lines: string[]): ParsedInbound['authResult'] {
	const relevant = lines.filter((l) => /\b(?:dmarc|dkim|spf)=/i.test(l));
	if (!relevant.length) return 'none';
	const top = authservId(relevant[0]!);
	const text = relevant
		.filter((l) => authservId(l) === top)
		.join(';')
		.toLowerCase();
	const arcPass = /\barc=pass\b/.test(text);
	const dmarc = /\bdmarc=(\w+)/.exec(text)?.[1];
	if (dmarc === 'pass') return 'pass';
	if (dmarc === 'fail') return arcPass ? 'none' : 'fail';
	const dkim = [...text.matchAll(/\bdkim=(\w+)/g)].map((m) => m[1]);
	const spf = [...text.matchAll(/\bspf=(\w+)/g)].map((m) => m[1]);
	if (dkim.includes('pass') || spf.includes('pass')) return 'pass';
	if (spf.includes('fail') && !arcPass) return 'fail';
	return 'none';
}

/** Spam-Wert aus den üblichen Kopfzeilen (SpamAssassin, rspamd), sonst `null` */
export function serverSpamScoreOf(headers: {
	score?: string;
	status?: string;
	rspamd?: string;
}): number | null {
	const candidates = [
		headers.score,
		headers.rspamd,
		/\bscore=(-?\d+(?:\.\d+)?)/i.exec(headers.status ?? '')?.[1]
	];
	for (const c of candidates) {
		const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(c ?? '');
		if (m) {
			const n = Number(m[1]!.replace(',', '.'));
			if (Number.isFinite(n)) return n;
		}
	}
	return null;
}

const MAX_TEXT = 500_000;
const MAX_HTML = 2_000_000;

export async function parseInbound(source: Buffer): Promise<ParsedInbound> {
	const mail = await simpleParser(source, {
		skipImageLinks: true,
		skipTextToHtml: true,
		skipTextLinks: true
	});
	const lines = mail.headerLines ?? [];
	const linesOf = (key: string) =>
		lines.filter((l) => l.key === key).map((l) => l.line.slice(l.line.indexOf(':') + 1).trim());
	const envelopeTo = [
		...new Set(
			ENVELOPE_HEADERS.flatMap(linesOf)
				.flatMap((v) => v.split(/[,\s]+/))
				.map(cleanAddress)
				.filter((a): a is string => !!a)
		)
	];
	const header = (key: string) => headerText(mail.headers.get(key)).trim().toLowerCase();
	const spam = header('x-spam-flag') === 'yes' || /^yes\b/.test(header('x-spam-status')) || false;
	const auto = header('auto-submitted');
	const precedence = header('precedence');
	const fromList = addressList(mail.from);
	const replyTo = addressList(mail.replyTo)[0]?.address ?? null;
	return {
		messageId: messageIds(mail.messageId)[0] ?? null,
		inReplyTo: messageIds(mail.inReplyTo)[0] ?? null,
		references: messageIds(mail.references).slice(-50),
		from: fromList[0] ?? null,
		replyTo,
		to: addressList(mail.to),
		cc: addressList(mail.cc),
		envelopeTo,
		subject: oneLine(mail.subject, 500),
		date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
		html: typeof mail.html === 'string' && mail.html.trim() ? mail.html.slice(0, MAX_HTML) : null,
		text: (mail.text ?? '').slice(0, MAX_TEXT),
		attachments: (mail.attachments ?? []).map((a) => ({
			filename: oneLine(a.filename, 200) || 'anhang',
			contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.contentType ?? '')
				? a.contentType.toLowerCase()
				: 'application/octet-stream',
			size: a.size ?? a.content?.length ?? 0,
			content: a.content,
			contentId: a.cid ? String(a.cid).replace(/^<|>$/g, '') : null,
			inline: a.contentDisposition === 'inline' || (!!a.cid && !!a.related)
		})),
		spam,
		serverSpamScore: serverSpamScoreOf({
			score: header('x-spam-score'),
			status: header('x-spam-status'),
			rspamd: header('x-rspamd-score')
		}),
		autoSubmitted:
			(!!auto && auto !== 'no') || precedence === 'auto_reply' || precedence === 'junk',
		ownNotification: header('x-ep-intern') !== '',
		authResult: authResultOf(linesOf('authentication-results'))
	};
}
