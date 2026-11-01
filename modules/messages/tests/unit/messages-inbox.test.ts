/**
 * Posteingang – reine Logik: Postfach-Schlüssel und Zuordnung (`mailbox.ts`), Mail-Parser
 * (`inbound-parse.ts`), HTML-Bereinigung eingehender Mails und Zitat für Antworten (`html.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
	baseSubject,
	buildAddressIndex,
	extraKey,
	isSharedMailbox,
	kindOf,
	mailboxKeyForSender,
	prefixedSubject,
	routeAddresses,
	senderKeyFor,
	MAILBOX_KEY_PATTERN
} from '$modules/messages/mailbox';
import {
	authResultOf,
	cleanAddress,
	messageIds,
	parseInbound
} from '$modules/messages/inbound-parse';
import {
	inboxDocument,
	inlineCidImages,
	quoteForEditor,
	sanitizeInbound,
	textToHtml
} from '$modules/messages/html';

const mailboxes = [
	{ key: 'personal:u1', address: 'anna.mueller@stamm.de', name: 'Anna Müller' },
	{ key: 'personal:u2', address: 'tim.meier@stamm.de', name: 'Tim Meier' },
	{ key: 'personal:u3', address: 'tim.meier@stamm.de', name: 'Tim Meier' },
	{ key: 'office:o1:kasse@stamm.de', address: 'kasse@stamm.de', name: 'Kasse' },
	{ key: 'group:g1', address: 'kasse@stamm.de', name: 'Gruppe mit gleicher Adresse' },
	{ key: 'stamm', address: 'info@stamm.de', name: 'Stamm' }
];
const index = buildAddressIndex(mailboxes);
const own = new Set(['stamm.de']);

describe('Postfach-Schlüssel', () => {
	it('Art, gemeinsam, Absender-Schlüssel', () => {
		expect(kindOf('personal:u1')).toBe('personal');
		expect(kindOf('office:o1:kasse@stamm.de')).toBe('office');
		expect(kindOf('irgendwas')).toBe('unassigned');
		expect(isSharedMailbox('group:g1')).toBe(true);
		expect(isSharedMailbox('personal:u1')).toBe(false);
		expect(senderKeyFor('personal:u1')).toBe('personal');
		expect(senderKeyFor('stamm')).toBe('stamm');
		expect(senderKeyFor('unassigned')).toBeNull();
		expect(mailboxKeyForSender('personal', 'u1')).toBe('personal:u1');
		expect(mailboxKeyForSender('personal', null)).toBeNull();
		expect(mailboxKeyForSender('group:g1', 'u1')).toBe('group:g1');
	});

	it('zusätzliche Postfächer (`extra:<id>`) sind gemeinsam und ihr eigener Absender', () => {
		const key = extraKey('3f2b8c1e-0000-4000-8000-000000000001');
		expect(key).toBe('extra:3f2b8c1e-0000-4000-8000-000000000001');
		expect(kindOf(key)).toBe('extra');
		expect(isSharedMailbox(key)).toBe(true);
		expect(senderKeyFor(key)).toBe(key);
		expect(mailboxKeyForSender(key, 'u1')).toBe(key);
		expect(MAILBOX_KEY_PATTERN.test(key)).toBe(true);
		for (const bad of ['extra:', 'extra:a b', "extra:x' OR 1=1", 'extra:a:b']) {
			expect(MAILBOX_KEY_PATTERN.test(bad), bad).toBe(false);
		}
	});

	it('Weiterleitung = weitere Adresse desselben Postfachs, ein Eintrag je Postfach', () => {
		const idx = buildAddressIndex([
			{ key: 'extra:e1', address: 'herbstlager@stamm.de', name: 'Herbstlager' },
			{ key: 'extra:e1', address: 'lager@stamm.de', name: 'Herbstlager' },
			{ key: 'stamm', address: 'info@stamm.de', name: 'Stamm' }
		]);
		const r = routeAddresses(['lager@stamm.de', 'herbstlager@stamm.de'], idx, own);
		expect(r.targets.map((t) => [t.mailbox.key, t.address])).toEqual([
			['extra:e1', 'lager@stamm.de']
		]);
		expect(r.unassigned).toBeNull();
	});

	it('Muster lässt nur gültige Schlüssel zu', () => {
		for (const ok of [
			'personal:abc-1',
			'office:1-2:kasse@stamm.de',
			'group:x',
			'stamm',
			'unassigned'
		]) {
			expect(MAILBOX_KEY_PATTERN.test(ok), ok).toBe(true);
		}
		for (const bad of ['personal:', 'office:1', 'stamm2', "group:a' OR 1=1", 'personal:a b']) {
			expect(MAILBOX_KEY_PATTERN.test(bad), bad).toBe(false);
		}
	});
});

describe('Zuordnung', () => {
	it('Zustell-Empfänger zuerst, Groß-/Kleinschreibung egal, je Postfach ein Eintrag', () => {
		const r = routeAddresses(['ANNA.Mueller@stamm.de', 'anna.mueller@stamm.de'], index, own);
		expect(r.targets.map((t) => t.mailbox.key)).toEqual(['personal:u1']);
		expect(r.unassigned).toBeNull();
	});

	it('eine Adresse für Amt und Gruppe → beide Postfächer', () => {
		const r = routeAddresses(['kasse@stamm.de'], index, own);
		expect(r.targets.map((t) => t.mailbox.key).sort()).toEqual([
			'group:g1',
			'office:o1:kasse@stamm.de'
		]);
	});

	it('gleicher Name → mehrdeutig, kein persönliches Postfach', () => {
		const r = routeAddresses(['tim.meier@stamm.de'], index, own);
		expect(r.targets).toEqual([]);
		expect(r.unassigned).toEqual({ address: 'tim.meier@stamm.de', reason: 'ambiguous' });
	});

	it('unbekannt → Sammelordner mit der Adresse der eigenen Domain', () => {
		const r = routeAddresses(['jemand@extern.de', 'tippfehler@stamm.de'], index, own);
		expect(r.unassigned).toEqual({ address: 'tippfehler@stamm.de', reason: 'unknown' });
	});
});

describe('Betreff', () => {
	it('Präfixe werden nicht gestapelt', () => {
		expect(baseSubject('AW: Re: WG: Fahrt')).toBe('Fahrt');
		expect(baseSubject('Rechnung: März')).toBe('Rechnung: März');
		expect(prefixedSubject('Re: AW: Fahrt', 'reply')).toBe('Re: Fahrt');
		expect(prefixedSubject('Fahrt', 'forward')).toBe('Wg: Fahrt');
		expect(prefixedSubject('', 'reply')).toBe('Re: (kein Betreff)');
		expect(prefixedSubject('x'.repeat(300), 'reply')).toHaveLength(200);
	});
});

describe('Parser', () => {
	it('Adressen, Message-IDs, Zustell-Empfänger, Spam, Automatik, eigene Benachrichtigung', async () => {
		const raw = [
			'From: "Müller, Petra" <Petra@Extern.example>',
			'To: Kasse <kasse@stamm.de>, undisclosed-recipients:;',
			'Cc: info@stamm.de',
			'Delivered-To: anna.mueller@stamm.de',
			'X-Original-To: Kasse@Stamm.de',
			'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=',
			'Message-ID: <abc@extern.example>',
			'In-Reply-To: <out-1@stamm.de>',
			'References: <first@extern.example> <out-1@stamm.de> kaputt',
			'X-Spam-Flag: YES',
			'Auto-Submitted: auto-replied',
			'X-EP-Intern: notification',
			'Authentication-Results: mx.stamm.de; spf=pass smtp.mailfrom=extern.example; dmarc=fail',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Hallo Welt'
		].join('\r\n');
		const p = await parseInbound(Buffer.from(raw));
		expect(p.from).toEqual({ address: 'petra@extern.example', name: 'Müller, Petra' });
		expect(p.to.map((a) => a.address)).toEqual(['kasse@stamm.de']);
		expect(p.cc.map((a) => a.address)).toEqual(['info@stamm.de']);
		expect(p.envelopeTo).toEqual(['anna.mueller@stamm.de', 'kasse@stamm.de']);
		expect(p.subject).toBe('Grüße');
		expect(p.messageId).toBe('<abc@extern.example>');
		expect(p.inReplyTo).toBe('<out-1@stamm.de>');
		expect(p.references).toEqual(['<first@extern.example>', '<out-1@stamm.de>']);
		expect(p.spam).toBe(true);
		expect(p.autoSubmitted).toBe(true);
		expect(p.ownNotification).toBe(true);
		expect(p.authResult).toBe('fail');
		expect(p.text.trim()).toBe('Hallo Welt');
	});

	it('ohne Message-ID und ohne Absender bleibt alles robust', async () => {
		const p = await parseInbound(Buffer.from('Subject: nur Text\r\n\r\nInhalt'));
		expect(p.messageId).toBeNull();
		expect(p.from).toBeNull();
		expect(p.to).toEqual([]);
		expect(p.authResult).toBe('none');
	});

	it('Hilfen', () => {
		expect(cleanAddress(' <A@B.de> ')).toBe('a@b.de');
		expect(cleanAddress('kein@')).toBeNull();
		expect(messageIds('<a@b> <a@b> x@y')).toEqual(['<a@b>']);
		expect(messageIds('ohne-klammern@host')).toEqual(['<ohne-klammern@host>']);
		expect(authResultOf(['dkim=pass; spf=fail'])).toBe('pass');
		expect(authResultOf(['dmarc=pass'])).toBe('pass');
		expect(authResultOf([])).toBe('none');
	});

	it('authResultOf: nur eindeutige Fehler, nur der oberste Server', () => {
		// Weiche bzw. unklare Ergebnisse und DKIM-Fehler allein sind keine Fälschung
		expect(authResultOf(['mx.a; spf=softfail'])).toBe('none');
		expect(authResultOf(['mx.a; dkim=fail; spf=neutral'])).toBe('none');
		expect(authResultOf(['mx.a; dmarc=temperror'])).toBe('none');
		expect(authResultOf(['mx.a; spf=fail smtp.mailfrom=x.example'])).toBe('fail');
		expect(authResultOf(['mx.a; dmarc=fail header.from=x.example'])).toBe('fail');
		// Sauber weitergeleitet (ARC bestätigt)
		expect(authResultOf(['mx.a; arc=pass; dmarc=fail header.from=x.example'])).toBe('none');
		// Fehler einer Zwischenstation (weiter unten) zählt nicht
		expect(authResultOf(['mx.a; dkim=pass', 'relay.b; dmarc=fail'])).toBe('pass');
		expect(authResultOf(['mx.a; spf=none', 'relay.b; spf=fail'])).toBe('none');
		// Mehrere Zeilen desselben Servers werden zusammen gelesen
		expect(authResultOf(['mx.a; spf=fail', 'mx.a; dkim=pass'])).toBe('pass');
	});
});

describe('HTML eingehender Mails', () => {
	it('entfernt Skripte, Handler, Formulare, Styles und externe Bilder', () => {
		const { html, blockedImages } = sanitizeInbound(
			'<div onmouseover="x()" style="color:red;background:url(https://t.example/p.gif);font-size:14px">A</div>' +
				'<script>alert(1)</script><style>p{}</style><form action="https://x"><input></form>' +
				'<img src="https://t.example/p.gif"><img src="http://t.example/q.gif"><img src="cid:bild@x">' +
				'<a href="javascript:alert(1)">x</a><a href="//evil.example">y</a><iframe src="https://x"></iframe>' +
				'<table bgcolor="#fff"><tr><td colspan="2">Zelle</td></tr></table>'
		);
		expect(blockedImages).toBe(2);
		expect(html).not.toMatch(
			/script|onmouseover|<style|<form|<input|t\.example|javascript:|evil|iframe|url\(/i
		);
		expect(html).toContain('color:red');
		expect(html).toContain('font-size:14px');
		expect(html).toContain('src="cid:bild@x"');
		expect(html).toContain('<td colspan="2">Zelle</td>');
	});

	it('Links öffnen im neuen Tab ohne Referrer', () => {
		const { html } = sanitizeInbound('<a href="https://gut.example" onclick="x">gut</a>');
		expect(html).toBe(
			'<a href="https://gut.example" target="_blank" rel="noopener noreferrer">gut</a>'
		);
	});

	it('cid-Bilder werden data:-URLs, nur Rasterbilder', () => {
		const images = new Map([
			['bild@x', { contentType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
			['svg@x', { contentType: 'image/svg+xml', data: new Uint8Array([1]) }]
		]);
		const out = inlineCidImages(
			'<img src="cid:Bild@x" alt=""><img src="cid:svg@x"><img src="cid:fehlt">',
			images
		);
		expect(out).toBe('<img src="data:image/png;base64,AQID" alt="">');
	});

	it('Dokument mit eigener CSP, Text escaped', () => {
		expect(inboxDocument('<p>x</p>')).toContain(
			`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`
		);
		expect(textToHtml('<b>&"')).toBe(
			'<div style="white-space: pre-wrap">&lt;b&gt;&amp;&quot;</div>'
		);
	});

	it('Zitat für Antworten nutzt nur Editor-Tags und escaped den Inhalt', () => {
		const q = quoteForEditor(
			'Am 1.6. schrieb Petra <p@x.de>:',
			'Zeile 1\nZeile 2\n\n<script>x</script>'
		);
		expect(q).toBe(
			'<p></p><p>Am 1.6. schrieb Petra &lt;p@x.de&gt;:</p><blockquote><p>Zeile 1<br>Zeile 2</p><p>&lt;script&gt;x&lt;/script&gt;</p></blockquote>'
		);
	});
});
