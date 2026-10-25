/**
 * Spam-Bewertung eingehender Mails (rein, ohne Core-Zugriffe; Server, Tests).
 *
 * Jede Regel vergibt Punkte mit einem lesbaren Grund; ab `SPAM_THRESHOLD` Punkten gilt die Mail als Spam.
 * Vorrang vor den Punkten:
 * 1. Absender auf der **Sperrliste** (Adresse oder Domain) → immer Spam.
 * 2. **Eigene Mail** (Message-ID stammt aus unserem Versand) → nie Spam.
 * 3. Absender auf der **Vertrauensliste** oder **bekannt** (Mitglied, Konto, eigene Domain, schon von uns
 *    angeschrieben, Antwort auf eine unserer Mails) → kein Spam, solange die Absenderprüfung
 *    (DMARC/DKIM/SPF) nicht ausdrücklich fehlschlägt (sonst könnte jede*r eine bekannte Adresse fälschen).
 *
 * Gegen Fehlalarme: Formmerkmale (Großbuchstaben, Satzzeichen, fehlende Message-ID, viele Links, Datum)
 * zählen zusammen höchstens `FORM_POINTS_MAX`; eine bestandene Absenderprüfung zieht `AUTH_PASS_BONUS` ab
 * (nicht gegen die Markierung des Mailservers). Ein einzelnes schwaches Merkmal macht so nie Spam.
 */
import type { ParsedInbound } from './inbound-parse';

/** Ab so vielen Punkten ist eine Mail Spam */
export const SPAM_THRESHOLD = 5;
/** So viele Mails desselben Absenders in `FLOOD_WINDOW_MINUTES` gelten als Massenversand */
export const FLOOD_LIMIT = 10;
export const FLOOD_WINDOW_MINUTES = 60;
/** Höchstpunktzahl aller Formmerkmale zusammen */
export const FORM_POINTS_MAX = 2;
/** Abzug für eine bestandene Absenderprüfung (DMARC bzw. DKIM/SPF) */
export const AUTH_PASS_BONUS = 2;

export type SpamSource = 'server' | 'rules' | 'blocklist' | 'user';

export interface SpamReason {
	code: string;
	label: string;
	points: number;
}

export interface SpamVerdict {
	spam: boolean;
	score: number;
	/** Wodurch die Entscheidung fiel (`null` = kein Spam) */
	source: SpamSource | null;
	reasons: SpamReason[];
}

export type SenderRuleKind = 'block' | 'allow';

export interface SenderRuleMatch {
	kind: SenderRuleKind;
	matchType: 'address' | 'domain';
}

export interface SpamContext {
	/** Domains der eigenen Postfächer (persönlich, Ämter, Gruppen, Stamm) */
	ownDomains: Set<string>;
	/** Treffer auf der Sperr-/Vertrauensliste (Adresse vor Domain) oder `null` */
	rule: SenderRuleMatch | null;
	/** Bekannter Absender (Mitglied, Konto, eigene Domain, schon angeschrieben, Antwort auf unsere Mail) */
	known: boolean;
	/** Die Mail stammt aus unserem eigenen Versand (Message-ID wie beim Senden vergeben) */
	ownSent?: boolean;
	/** Die Antwortadresse ist bekannt oder gehört zu einer eigenen Domain */
	knownReplyTo?: boolean;
	/** Mails desselben Absenders im Zeitfenster vor dieser (inklusive bereits importierter) */
	recentFromSender: number;
	/** „Jetzt“ für die Datumsprüfung (Tests) */
	now?: Date;
}

/** Ausführbare bzw. gefährliche Dateiendungen (auch als doppelte Endung „rechnung.pdf.exe“) */
const DANGEROUS_EXT = new Set([
	'exe',
	'scr',
	'bat',
	'cmd',
	'com',
	'pif',
	'cpl',
	'msi',
	'msp',
	'js',
	'jse',
	'vbs',
	'vbe',
	'wsf',
	'wsh',
	'hta',
	'ps1',
	'jar',
	'lnk',
	'reg',
	'iso',
	'img',
	'vhd',
	'vhdx',
	'appx',
	'msix'
]);
/** Office-Dateien mit Makros */
const MACRO_EXT = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm']);

/** Bekannte Linkverkürzer (verstecken das eigentliche Ziel) */
const SHORTENERS = new Set([
	'bit.ly',
	'tinyurl.com',
	't.co',
	'goo.gl',
	'is.gd',
	'ow.ly',
	'cutt.ly',
	'rebrand.ly',
	'shorturl.at',
	'tiny.cc',
	'buff.ly',
	'rb.gy',
	't.ly',
	'v.gd',
	's.id'
]);

/** Typische Betreffs von Betrugs- und Werbemails (klein geschrieben, Umlaute gefaltet) */
const SUBJECT_PATTERNS: RegExp[] = [
	/\b(gewinn|gewonnen|lotterie|lotto|jackpot|preisgeld)\b/,
	/\b(bitcoin|krypto|crypto|investment|rendite)\b/,
	/\b(viagra|cialis|casino|dating|singles)\b/,
	/\b(konto|account).{0,20}(gesperrt|eingeschrankt|suspended|locked)\b/,
	/\b(passwort|password).{0,20}(ablauf|abgelaufen|expire)/,
	/\bverify your (account|identity)\b/,
	/\b(dringend|urgent).{0,30}(zahlung|uberweisung|payment|transfer)\b/,
	/\b(erbschaft|inheritance|beneficiary)\b/
];

const fold = (s: string) =>
	s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss');

export const domainOf = (address: string): string =>
	address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** Letzte zwei Labels einer Domain („mail.paypal.com“ → „paypal.com“), für Vergleiche */
export function baseDomain(host: string): string {
	const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
	// Übliche zweiteilige Endungen (co.uk, com.au …)
	const twoPart = parts.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(parts.at(-2) ?? '');
	return parts.slice(twoPart ? -3 : -2).join('.');
}

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Host einer URL (nur http/https), sonst `null` */
function hostOf(url: string): string | null {
	try {
		const u = new URL(url.trim());
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

const decodeEntities = (s: string) =>
	s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'");

export interface LinkInfo {
	href: string;
	text: string;
}

/** Links aus rohem HTML (einfacher Parser, genügt für die Bewertung; höchstens 500) */
export function extractLinks(html: string | null): LinkInfo[] {
	if (!html) return [];
	const out: LinkInfo[] = [];
	const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
	for (const m of html.matchAll(re)) {
		const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
		const text = decodeEntities((m[4] ?? '').replace(/<[^>]*>/g, ' '))
			.replace(/\s+/g, ' ')
			.trim();
		out.push({ href, text });
		if (out.length >= 500) break;
	}
	return out;
}

/** Sichtbarer Linktext, der wie eine Adresse aussieht („www.bank.de“, „https://…“) → Host */
function hostInText(text: string): string | null {
	const m = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i.exec(text.trim());
	return m ? m[1]!.toLowerCase() : null;
}

/** Anzeigename enthält eine (andere) Mailadresse – typisch für „PayPal <x@fremd.example>“ */
function nameShowsOtherAddress(name: string | null, address: string): boolean {
	if (!name) return false;
	const m = /[^\s<>"'()]+@[^\s<>"'()]+\.[a-z]{2,}/i.exec(name);
	return !!m && m[0].toLowerCase() !== address.toLowerCase();
}

function subjectShouts(subject: string): boolean {
	const letters = subject.replace(/[^A-Za-zÄÖÜäöüß]/g, '');
	if (letters.length < 10) return false;
	const upper = letters.replace(/[^A-ZÄÖÜ]/g, '').length;
	return upper / letters.length >= 0.8;
}

/** Eingaben der Bewertung aus der geparsten Mail */
export type SpamInput = Pick<
	ParsedInbound,
	| 'from'
	| 'replyTo'
	| 'subject'
	| 'date'
	| 'messageId'
	| 'html'
	| 'text'
	| 'attachments'
	| 'spam'
	| 'serverSpamScore'
	| 'authResult'
>;

/** Bewertet eine eingehende Mail. Reihenfolge der Gründe = Gewicht (höchste zuerst). */
export function scoreSpam(mail: SpamInput, ctx: SpamContext): SpamVerdict {
	const reasons: SpamReason[] = [];
	const add = (code: string, label: string, points: number) =>
		reasons.push({ code, label, points });
	const address = mail.from?.address ?? '';
	const fromDomain = address ? domainOf(address) : '';
	const authFailed = mail.authResult === 'fail';

	// --- Absender
	if (!address) add('no-sender', 'Kein Absender angegeben', 2);
	if (authFailed) {
		add('auth-fail', 'Absenderprüfung (DMARC/DKIM/SPF) fehlgeschlagen', 4);
	}
	if (fromDomain && ctx.ownDomains.has(fromDomain) && authFailed) {
		add('spoofed-own', 'Gibt sich als eigene Adresse aus, ist aber nicht bestätigt', 4);
	}
	if (nameShowsOtherAddress(mail.from?.name ?? null, address)) {
		add('display-name', 'Der Anzeigename enthält eine andere Mailadresse', 3);
	}
	if (
		mail.replyTo &&
		fromDomain &&
		!ctx.knownReplyTo &&
		baseDomain(domainOf(mail.replyTo)) !== baseDomain(fromDomain) &&
		mail.authResult !== 'pass'
	) {
		add('reply-to', 'Antworten gehen an eine fremde Domain', 2);
	}

	// --- Server
	if (mail.spam) add('server-flag', 'Vom Mailserver als Spam markiert', 6);
	else if (mail.serverSpamScore !== null && mail.serverSpamScore >= 3) {
		add('server-score', `Spam-Wert des Mailservers: ${mail.serverSpamScore}`, 2);
	}

	// --- Anhänge
	const exts = mail.attachments.map((a) => a.filename.toLowerCase().split('.').slice(1));
	if (exts.some((e) => e.some((x) => DANGEROUS_EXT.has(x)))) {
		add('dangerous-attachment', 'Anhang mit ausführbarem oder gefährlichem Dateityp', 5);
	} else if (exts.some((e) => MACRO_EXT.has(e.at(-1) ?? ''))) {
		add('macro-attachment', 'Office-Anhang mit Makros', 3);
	}

	// --- Links
	const links = extractLinks(mail.html);
	const hosts = links.map((l) => hostOf(l.href)).filter((h): h is string => !!h);
	// Bestätigte Newsletter zeigen oft ihre eigene Adresse an und verlinken über einen Klickzähler –
	// das ist kein Täuschungsversuch, solange die angezeigte Domain die des (bestätigten) Absenders ist.
	const senderBase = fromDomain ? baseDomain(fromDomain) : '';
	const mismatch = links.some((l) => {
		const shown = hostInText(l.text);
		const target = hostOf(l.href);
		if (!shown || !target || baseDomain(shown) === baseDomain(target)) return false;
		return !(mail.authResult === 'pass' && baseDomain(shown) === senderBase);
	});
	if (mismatch) add('link-mismatch', 'Ein Link zeigt eine andere Adresse an, als er öffnet', 3);
	if (hosts.some((h) => IPV4_HOST.test(h))) {
		add('ip-link', 'Link auf eine nackte IP-Adresse', 3);
	}
	if (hosts.some((h) => SHORTENERS.has(h))) {
		add('shortener', 'Link über einen Linkverkürzer (Ziel verborgen)', 2);
	}
	const textLength = (mail.text ?? '').replace(/\s+/g, '').length;
	const form: SpamReason[] = [];
	const addForm = (code: string, label: string, points: number) =>
		form.push({ code, label, points });
	if (links.length > 20 && textLength < links.length * 40) {
		addForm('many-links', 'Sehr viele Links bei wenig Text', 1);
	}

	// --- Betreff und Form
	const subject = fold(mail.subject ?? '');
	if (SUBJECT_PATTERNS.some((re) => re.test(subject))) {
		add('subject-pattern', 'Betreff typisch für Betrugs- oder Werbemails', 2);
	}
	if (subjectShouts(mail.subject ?? '')) addForm('subject-caps', 'Betreff in Großbuchstaben', 1);
	if (/[!?$€]{3,}/.test(mail.subject ?? ''))
		addForm('subject-marks', 'Viele Satzzeichen im Betreff', 1);
	if (!mail.messageId)
		addForm('no-message-id', 'Keine Message-ID (ungewöhnlich für echte Mailprogramme)', 1);
	const now = (ctx.now ?? new Date()).getTime();
	if (mail.date && mail.date.getTime() > now + 24 * 3600_000) {
		addForm('future-date', 'Datum liegt in der Zukunft', 2);
	}
	// Formmerkmale zusammen höchstens FORM_POINTS_MAX (die Gründe bleiben sichtbar, die Punkte gekappt)
	let formLeft = FORM_POINTS_MAX;
	for (const r of form.sort((a, b) => b.points - a.points)) {
		const points = Math.min(r.points, formLeft);
		formLeft -= points;
		reasons.push({ ...r, points });
	}
	if (ctx.recentFromSender >= FLOOD_LIMIT) {
		add('flood', `Mehr als ${FLOOD_LIMIT} Mails dieses Absenders in einer Stunde`, 3);
	}

	// Bekannte oder vertrauenswürdige Adresse, aber die Absenderprüfung schlägt fehl: vermutlich gefälscht
	if (authFailed && (ctx.known || ctx.rule?.kind === 'allow')) {
		add('forged-known', 'Gibt sich als bekannter Absender aus, ist aber nicht bestätigt', 2);
	}

	if (mail.authResult === 'pass' && !mail.spam && reasons.some((r) => r.points > 0)) {
		add('auth-pass', 'Absender bestätigt (DMARC/DKIM/SPF)', -AUTH_PASS_BONUS);
	}

	reasons.sort((a, b) => b.points - a.points);
	const score = Math.max(
		0,
		reasons.reduce((s, r) => s + r.points, 0)
	);

	// --- Listen und bekannte Absender haben Vorrang
	if (ctx.rule?.kind === 'block') {
		const label =
			ctx.rule.matchType === 'domain'
				? 'Domain des Absenders ist gesperrt'
				: 'Absender ist gesperrt';
		return {
			spam: true,
			score,
			source: 'blocklist',
			reasons: [{ code: 'blocked', label, points: 0 }, ...reasons]
		};
	}
	if (ctx.ownSent) return { spam: false, score, source: null, reasons };
	if ((ctx.rule?.kind === 'allow' || ctx.known) && !authFailed) {
		return { spam: false, score, source: null, reasons };
	}
	if (score >= SPAM_THRESHOLD) {
		const serverOnly = mail.spam && score - 6 < SPAM_THRESHOLD;
		return { spam: true, score, source: serverOnly ? 'server' : 'rules', reasons };
	}
	return { spam: false, score, source: null, reasons };
}

/** Eintrag der Sperr-/Vertrauensliste aus einer Eingabe: „name@domain“ → Adresse, „@domain“/„domain“ → Domain */
export function parseSenderPattern(
	input: string
): { matchType: 'address' | 'domain'; pattern: string } | null {
	const v = input.trim().toLowerCase().replace(/^<|>$/g, '');
	if (/^[^\s@<>(),;:"]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v))
		return { matchType: 'address', pattern: v };
	const d = v.replace(/^\*?@/, '').replace(/^\*\./, '');
	if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d) && d.length <= 253) {
		return { matchType: 'domain', pattern: d };
	}
	return null;
}

/**
 * Passender Listeneintrag für eine Adresse: exakte Adresse vor Domain; Domain trifft auch Subdomains
 * („example.org“ trifft „mail.example.org“). Bei Adresse und Domain gewinnt die Adresse.
 */
export function matchSenderRule(
	address: string,
	rules: { kind: SenderRuleKind; matchType: 'address' | 'domain'; pattern: string }[]
): SenderRuleMatch | null {
	const a = address.toLowerCase();
	const exact = rules.find((r) => r.matchType === 'address' && r.pattern === a);
	if (exact) return { kind: exact.kind, matchType: 'address' };
	const domain = domainOf(a);
	const hits = rules.filter(
		(r) => r.matchType === 'domain' && (domain === r.pattern || domain.endsWith(`.${r.pattern}`))
	);
	if (!hits.length) return null;
	// Längste (genaueste) Domain gewinnt; bei Gleichstand sperren
	hits.sort((x, y) => y.pattern.length - x.pattern.length || (x.kind === 'block' ? -1 : 1));
	return { kind: hits[0]!.kind, matchType: 'domain' };
}
