/**
 * Spam-Bewertung des Posteingangs (`messages/spam-rules.ts`) und Hilfen aus `inbound-parse.ts`/`html.ts`:
 * Punkte je Regel, Schwelle, Vorrang von Sperr-/Vertrauensliste und bekannten Absendern (nicht bei
 * fehlgeschlagener Absenderprüfung), Linkanalyse, Listen-Einträge, Spam-Wert des Servers, Link-Entschärfung.
 */
import { describe, expect, it } from 'vitest';
import {
	FORM_POINTS_MAX,
	SPAM_THRESHOLD,
	baseDomain,
	extractLinks,
	matchSenderRule,
	parseSenderPattern,
	scoreSpam,
	type SpamContext,
	type SpamInput
} from '$modules/messages/spam-rules';
import { serverSpamScoreOf } from '$modules/messages/inbound-parse';
import { neutralizeLinks } from '$modules/messages/html';

const NOW = new Date('2026-06-01T12:00:00Z');

function mail(over: Partial<SpamInput> = {}): SpamInput {
	return {
		from: { address: 'petra@extern.example', name: 'Petra Extern' },
		replyTo: null,
		subject: 'Frage zur Fahrt',
		date: new Date('2026-06-01T11:00:00Z'),
		messageId: '<a@extern.example>',
		html: null,
		text: 'Hallo, wann geht es los?',
		attachments: [],
		spam: false,
		serverSpamScore: null,
		authResult: 'none',
		...over
	};
}
function ctx(over: Partial<SpamContext> = {}): SpamContext {
	return {
		ownDomains: new Set(['pfadfinder.test']),
		rule: null,
		known: false,
		recentFromSender: 0,
		now: NOW,
		...over
	};
}
const att = (filename: string) => ({
	filename,
	contentType: 'application/octet-stream',
	size: 10,
	content: Buffer.from('x'),
	contentId: null,
	inline: false
});
const codes = (v: ReturnType<typeof scoreSpam>) => v.reasons.map((r) => r.code);

describe('scoreSpam', () => {
	it('normale Mail: kein Spam, keine Gründe', () => {
		const v = scoreSpam(mail(), ctx());
		expect(v).toMatchObject({ spam: false, score: 0, source: null, reasons: [] });
	});

	it('Server-Markierung allein reicht (Quelle server)', () => {
		const v = scoreSpam(mail({ spam: true }), ctx());
		expect(v.spam).toBe(true);
		expect(v.source).toBe('server');
		expect(v.score).toBeGreaterThanOrEqual(SPAM_THRESHOLD);
	});

	it('gefälschte eigene Domain mit fehlgeschlagener Prüfung → Spam (rules)', () => {
		const v = scoreSpam(
			mail({ from: { address: 'kasse@pfadfinder.test', name: null }, authResult: 'fail' }),
			ctx()
		);
		expect(v.spam).toBe(true);
		expect(v.source).toBe('rules');
		expect(codes(v)).toEqual(expect.arrayContaining(['auth-fail', 'spoofed-own']));
	});

	it('gefährlicher Anhang, auch als doppelte Endung', () => {
		expect(codes(scoreSpam(mail({ attachments: [att('Rechnung.pdf.exe')] }), ctx()))).toContain(
			'dangerous-attachment'
		);
		expect(scoreSpam(mail({ attachments: [att('setup.EXE')] }), ctx()).spam).toBe(true);
		expect(codes(scoreSpam(mail({ attachments: [att('liste.xlsm')] }), ctx()))).toEqual([
			'macro-attachment'
		]);
		expect(scoreSpam(mail({ attachments: [att('liste.xlsx')] }), ctx()).reasons).toEqual([]);
	});

	it('Links: andere Anzeige als Ziel, IP, Linkverkürzer; gleiche Domain ist in Ordnung', () => {
		const phishing = mail({
			html: '<p>Bitte bestätigen: <a href="https://login.evil.example/x">www.sparkasse.de</a></p>'
		});
		expect(codes(scoreSpam(phishing, ctx()))).toContain('link-mismatch');
		const same = mail({ html: '<a href="https://www.sparkasse.de/login">sparkasse.de</a>' });
		expect(codes(scoreSpam(same, ctx()))).not.toContain('link-mismatch');
		expect(
			codes(scoreSpam(mail({ html: '<a href="http://192.168.4.1/a">hier</a>' }), ctx()))
		).toContain('ip-link');
		expect(
			codes(scoreSpam(mail({ html: '<a href="https://bit.ly/abc">Fotos</a>' }), ctx()))
		).toContain('shortener');
	});

	it('Anzeigename mit fremder Adresse und Reply-To auf fremde Domain', () => {
		const v = scoreSpam(
			mail({
				from: { address: 'x@evil.example', name: 'service@paypal.de' },
				replyTo: 'collect@other.example'
			}),
			ctx()
		);
		expect(codes(v)).toEqual(expect.arrayContaining(['display-name', 'reply-to']));
		expect(v.spam).toBe(true);
	});

	it('Betreff: Muster, Großbuchstaben, Satzzeichen (je wenige Punkte)', () => {
		const v = scoreSpam(mail({ subject: 'SIE HABEN IM LOTTO GEWONNEN!!!' }), ctx());
		expect(codes(v)).toEqual(
			expect.arrayContaining(['subject-pattern', 'subject-caps', 'subject-marks'])
		);
		// Muster 2 + Form (Großbuchstaben 1 + Satzzeichen 1, gedeckelt auf 2)
		expect(v.score).toBe(4);
		expect(v.spam).toBe(false);
		// „Gewinn“ mit Umlaut-Faltung, Konto gesperrt
		expect(codes(scoreSpam(mail({ subject: 'Ihr Konto wurde eingeschränkt' }), ctx()))).toContain(
			'subject-pattern'
		);
	});

	it('Massenversand zählt erst ab der Grenze; zusammen mit weiterem Signal Spam', () => {
		expect(codes(scoreSpam(mail(), ctx({ recentFromSender: 9 })))).toEqual([]);
		const v = scoreSpam(mail({ subject: 'Bitcoin Rendite' }), ctx({ recentFromSender: 10 }));
		expect(codes(v)).toEqual(['flood', 'subject-pattern']);
		expect(v.spam).toBe(true);
	});

	it('Datum in der Zukunft, fehlende Message-ID, fehlender Absender', () => {
		const v = scoreSpam(
			mail({ date: new Date('2026-06-05T00:00:00Z'), messageId: null, from: null }),
			ctx()
		);
		expect(codes(v)).toEqual(['no-sender', 'future-date', 'no-message-id']);
	});

	it('Gründe nach Punkten sortiert, Punkte summiert', () => {
		const v = scoreSpam(mail({ spam: true, attachments: [att('a.js')] }), ctx());
		expect(v.reasons.map((r) => r.points)).toEqual([6, 5]);
		expect(v.score).toBe(11);
		expect(v.source).toBe('rules');
	});

	it('Sperrliste: immer Spam, auch ohne Punkte', () => {
		const v = scoreSpam(mail(), ctx({ rule: { kind: 'block', matchType: 'domain' } }));
		expect(v).toMatchObject({ spam: true, source: 'blocklist' });
		expect(v.reasons[0]).toMatchObject({
			code: 'blocked',
			label: 'Domain des Absenders ist gesperrt'
		});
	});

	it('Vertrauensliste und bekannte Absender: kein Spam – außer die Absenderprüfung schlägt fehl', () => {
		const spammy = mail({ spam: true, attachments: [att('a.exe')] });
		expect(scoreSpam(spammy, ctx({ known: true })).spam).toBe(false);
		expect(scoreSpam(spammy, ctx({ rule: { kind: 'allow', matchType: 'address' } })).spam).toBe(
			false
		);
		const forged = mail({ spam: true, authResult: 'fail' });
		expect(scoreSpam(forged, ctx({ known: true })).spam).toBe(true);
		expect(scoreSpam(forged, ctx({ rule: { kind: 'allow', matchType: 'address' } })).spam).toBe(
			true
		);
	});
});

describe('scoreSpam – keine Fehlalarme', () => {
	it('eigene Mail (Message-ID aus unserem Versand): nie Spam, auch bei fehlgeschlagener Prüfung', () => {
		const own = mail({
			from: { address: 'anna.mueller@pfadfinder.test', name: 'Anna' },
			replyTo: 'anna@gmail.example',
			authResult: 'fail'
		});
		expect(scoreSpam(own, ctx()).spam).toBe(true);
		expect(scoreSpam(own, ctx({ ownSent: true }))).toMatchObject({ spam: false, source: null });
	});

	it('Formmerkmale zusammen höchstens FORM_POINTS_MAX – nie allein Spam', () => {
		const links = Array.from({ length: 25 }, (_, i) => `<a href="https://x.example/${i}">L</a>`);
		const v = scoreSpam(
			mail({
				subject: 'WICHTIGE INFO ZUM SOMMERLAGER???',
				messageId: null,
				date: new Date('2026-06-05T00:00:00Z'),
				html: links.join(' '),
				text: 'kurz'
			}),
			ctx()
		);
		expect(codes(v)).toEqual(
			expect.arrayContaining(['subject-caps', 'subject-marks', 'no-message-id', 'many-links'])
		);
		expect(v.score).toBe(FORM_POINTS_MAX);
		expect(v.spam).toBe(false);
	});

	it('Reply-To auf eine bekannte/eigene Adresse zählt nicht', () => {
		const m = mail({ replyTo: 'eltern@gmail.example' });
		expect(codes(scoreSpam(m, ctx()))).toContain('reply-to');
		expect(codes(scoreSpam(m, ctx({ knownReplyTo: true })))).not.toContain('reply-to');
	});

	it('bestätigter Newsletter mit Klickzähler: kein Link-Fehlalarm, Prüfung zieht Punkte ab', () => {
		const news = mail({
			from: { address: 'news@verband.example', name: 'Verband' },
			authResult: 'pass',
			subject: 'Newsletter Juni',
			html: '<a href="https://click.mailer.example/abc">www.verband.example</a> <a href="https://bit.ly/x">Fotos</a>'
		});
		const v = scoreSpam(news, ctx());
		expect(codes(v)).not.toContain('link-mismatch');
		expect(codes(v)).toContain('auth-pass');
		expect(v.score).toBe(0);
		// Gleiche Mail ohne Bestätigung, angezeigte fremde Bank-Domain → weiterhin auffällig
		const phish = mail({
			html: '<a href="https://click.mailer.example/abc">www.sparkasse.de</a>',
			authResult: 'pass'
		});
		expect(codes(scoreSpam(phish, ctx()))).toContain('link-mismatch');
	});

	it('Bestätigung hebt die Server-Markierung nicht auf', () => {
		const v = scoreSpam(mail({ spam: true, authResult: 'pass' }), ctx());
		expect(v.spam).toBe(true);
		expect(codes(v)).not.toContain('auth-pass');
	});
});

describe('Listen-Einträge', () => {
	it('parseSenderPattern: Adresse, Domain, @Domain, *.Domain; Ungültiges → null', () => {
		expect(parseSenderPattern(' Max@Example.ORG ')).toEqual({
			matchType: 'address',
			pattern: 'max@example.org'
		});
		expect(parseSenderPattern('example.org')).toEqual({
			matchType: 'domain',
			pattern: 'example.org'
		});
		expect(parseSenderPattern('@spam.example')).toEqual({
			matchType: 'domain',
			pattern: 'spam.example'
		});
		expect(parseSenderPattern('*.spam.example')).toEqual({
			matchType: 'domain',
			pattern: 'spam.example'
		});
		for (const bad of ['', 'abc', 'foo@', 'a b.de', 'http://x.de']) {
			expect(parseSenderPattern(bad), bad).toBeNull();
		}
	});

	it('matchSenderRule: Adresse vor Domain, Subdomains, genaueste Domain gewinnt', () => {
		const rules = [
			{ kind: 'block' as const, matchType: 'domain' as const, pattern: 'example.org' },
			{ kind: 'allow' as const, matchType: 'domain' as const, pattern: 'good.example.org' },
			{ kind: 'allow' as const, matchType: 'address' as const, pattern: 'max@example.org' }
		];
		expect(matchSenderRule('Max@example.org', rules)).toEqual({
			kind: 'allow',
			matchType: 'address'
		});
		expect(matchSenderRule('x@mail.example.org', rules)).toEqual({
			kind: 'block',
			matchType: 'domain'
		});
		expect(matchSenderRule('x@a.good.example.org', rules)).toEqual({
			kind: 'allow',
			matchType: 'domain'
		});
		expect(matchSenderRule('x@notexample.org', rules)).toBeNull();
	});

	it('baseDomain und extractLinks', () => {
		expect(baseDomain('mail.paypal.com')).toBe('paypal.com');
		expect(baseDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
		expect(
			extractLinks(`<A HREF='https://a.example/?x=1&amp;y=2'><b>Hier</b>&nbsp;klicken</A>`)
		).toEqual([{ href: 'https://a.example/?x=1&y=2', text: 'Hier klicken' }]);
		expect(extractLinks(null)).toEqual([]);
	});
});

describe('Server-Wert und Anzeige', () => {
	it('serverSpamScoreOf liest SpamAssassin und rspamd', () => {
		expect(serverSpamScoreOf({ score: '7.3' })).toBe(7.3);
		expect(serverSpamScoreOf({ status: 'No, score=-0.1 required=5.0' })).toBe(-0.1);
		expect(serverSpamScoreOf({ rspamd: '4,5 / 15' })).toBe(4.5);
		expect(serverSpamScoreOf({ status: 'No' })).toBeNull();
		expect(serverSpamScoreOf({})).toBeNull();
	});

	it('neutralizeLinks macht Links unklickbar, Ziel im Tooltip', () => {
		const out = neutralizeLinks(
			'<p>Bitte <a href="https://evil.example/x" target="_blank" rel="noopener noreferrer">hier</a> klicken</p>'
		);
		expect(out).not.toContain('<a');
		expect(out).not.toContain('href=');
		expect(out).toContain('hier');
		expect(out).toContain('title="Link deaktiviert: https://evil.example/x"');
	});
});
