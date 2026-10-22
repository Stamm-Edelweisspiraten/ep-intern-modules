/**
 * Bereinigung des Nachrichtentexts (Ausgabe des Editors) und Klartext-Fassung. Nur Server – der Browser
 * schickt HTML, der Server vertraut ihm nie: Es bleiben nur einfache Formatierungen und http(s)/mailto-Links.
 */
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
	'p',
	'br',
	'strong',
	'b',
	'em',
	'i',
	'u',
	's',
	'ul',
	'ol',
	'li',
	'blockquote',
	'h2',
	'h3',
	'a',
	'hr'
];

/** Bereinigtes HTML-Fragment (Skripte, Event-Handler, fremde Tags und `javascript:`-Links entfallen) */
export function sanitizeBody(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: ALLOWED_TAGS,
		allowedAttributes: { a: ['href', 'target', 'rel'] },
		allowedSchemes: ['http', 'https', 'mailto'],
		allowedSchemesAppliedToAttributes: ['href'],
		allowProtocolRelative: false,
		transformTags: {
			a: (_tag, attribs) => ({
				tagName: 'a',
				attribs: { href: attribs.href ?? '', target: '_blank', rel: 'noopener noreferrer' }
			})
		}
	}).trim();
}

/** Schlankes HTML-Dokument für „Einfach“: kein Layout, keine Farben/Bilder, Schrift des Mailprogramms */
export function plainDocument(fragment: string): string {
	return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"></head><body>${fragment}</body></html>`;
}

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&nbsp;': ' '
};

/** Klartext-Fassung eines bereits bereinigten Fragments (Absätze, Listen, Links als „Text (URL)“) */
export function htmlToText(html: string): string {
	const withLinks = html.replace(
		/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
		(_m, href: string, label: string) => {
			const text = label.replace(/<[^>]*>/g, '').trim();
			const url = href.replace(/&amp;/g, '&');
			return !text || text === url ? url : `${text} (${url})`;
		}
	);
	const blocks = withLinks
		.replace(/<li[^>]*>/g, '\n• ')
		// Tabellen/Blöcke eingehender Mails: Zellen mit Abstand, Zeilen und Blöcke auf neue Zeilen
		.replace(/<\/(td|th)>/g, ' ')
		.replace(/<\/(tr|div|table|h1|h4|h5|h6|pre)>/g, '\n')
		.replace(/<\/(p|h2|h3|blockquote|ul|ol)>/g, '\n\n')
		.replace(/<(br|hr)\s*\/?>/g, '\n');
	const stripped = sanitizeHtml(blocks, {
		allowedTags: [],
		allowedAttributes: {},
		textFilter: (text) => text
	});
	return stripped
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// --- Eingehende Mails ------------------------------------------------------------------------

const INBOUND_TAGS = [
	...ALLOWED_TAGS,
	'div',
	'span',
	'h1',
	'h4',
	'h5',
	'h6',
	'pre',
	'code',
	'sub',
	'sup',
	'small',
	'big',
	'center',
	'font',
	'strike',
	'del',
	'ins',
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'td',
	'th',
	'caption',
	'colgroup',
	'col',
	'img'
];

const TABLE_ATTRS = ['width', 'height', 'align', 'valign', 'bgcolor', 'border'];

/** CSS-Werte ohne `url(…)`, `expression(…)`, `@import` oder spitze Klammern (keine Nachladeversuche) */
const SAFE_CSS_VALUE =
	/^(?!.*(url\s*\(|expression|javascript:|@import|behavior|-moz-binding))[^<>]*$/i;

const STYLE_PROPS = [
	'color',
	'background-color',
	'font',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'line-height',
	'text-align',
	'text-decoration',
	'text-transform',
	'vertical-align',
	'white-space',
	'margin',
	'margin-top',
	'margin-right',
	'margin-bottom',
	'margin-left',
	'padding',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'border',
	'border-top',
	'border-right',
	'border-bottom',
	'border-left',
	'border-collapse',
	'border-color',
	'border-radius',
	'border-spacing',
	'border-style',
	'border-width',
	'width',
	'max-width',
	'min-width',
	'height',
	'display',
	'list-style-type'
];

const INLINE_IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;

/**
 * Bereinigt das HTML einer eingehenden Mail für die Anzeige im abgeschotteten iframe: keine Skripte,
 * Formulare, Event-Handler oder `<style>`-Blöcke; Links nur http(s)/mailto (öffnen im neuen Tab);
 * Bilder nur als `cid:` (eingebettete Anhänge, werden bei der Anzeige zu `data:`) – **externe Bilder
 * entfallen** (keine Lesebestätigung über Tracking-Pixel). CSS nur aus einer Liste sicherer Eigenschaften.
 */
export function sanitizeInbound(html: string): { html: string; blockedImages: number } {
	let blockedImages = 0;
	const out = sanitizeHtml(html, {
		allowedTags: INBOUND_TAGS,
		allowedAttributes: {
			a: ['href', 'title', 'target', 'rel'],
			img: ['src', 'alt', 'width', 'height'],
			font: ['color', 'size', 'face'],
			table: [...TABLE_ATTRS, 'cellpadding', 'cellspacing'],
			td: [...TABLE_ATTRS, 'colspan', 'rowspan'],
			th: [...TABLE_ATTRS, 'colspan', 'rowspan'],
			tr: TABLE_ATTRS,
			col: ['width', 'span'],
			'*': ['style', 'align', 'dir']
		},
		allowedStyles: {
			'*': Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_CSS_VALUE]]))
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		allowedSchemesByTag: { img: ['cid'] },
		allowedSchemesAppliedToAttributes: ['href', 'src'],
		allowProtocolRelative: false,
		// Inhalte von script/style/title & Co. ganz verwerfen
		nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
		transformTags: {
			a: (_tag, attribs) => ({
				tagName: 'a',
				attribs: {
					...(attribs.href ? { href: attribs.href } : {}),
					...(attribs.title ? { title: attribs.title } : {}),
					target: '_blank',
					rel: 'noopener noreferrer'
				}
			}),
			img: (_tag, attribs) => {
				const src = (attribs.src ?? '').trim();
				if (/^cid:/i.test(src)) return { tagName: 'img', attribs };
				// Externes Bild → entfällt (gezählt für den Hinweis in der Ansicht)
				if (src) blockedImages++;
				return { tagName: 'img', attribs: {} };
			}
		},
		exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src
	}).trim();
	return { html: out, blockedImages };
}

/** Klartext als HTML (escaped, Zeilenumbrüche bleiben) */
export function textToHtml(text: string): string {
	const escaped = text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
	return `<div style="white-space: pre-wrap">${escaped}</div>`;
}

/**
 * `cid:`-Bilder durch `data:`-URLs ersetzen (nur PNG/JPEG/GIF/WebP); unbekannte entfallen.
 * `images`: Content-ID (klein) → `{ contentType, data }`.
 */
export function inlineCidImages(
	html: string,
	images: ReadonlyMap<string, { contentType: string; data: Uint8Array }>
): string {
	return html.replace(/<img\b[^>]*>/gi, (tag) => {
		const m = /src="cid:([^"]+)"/i.exec(tag);
		if (!m) return tag;
		const img = images.get(decodeEntities(m[1]!).toLowerCase());
		if (!img || !INLINE_IMAGE_TYPES.test(img.contentType)) return '';
		const data = `data:${img.contentType};base64,${Buffer.from(img.data).toString('base64')}`;
		return tag.replace(m[0], `src="${data}"`);
	});
}

function decodeEntities(v: string): string {
	return v.replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);
}

/**
 * Vollständiges Dokument für `<iframe srcdoc sandbox>`: eigene CSP (nur `data:`-Bilder, Inline-Styles),
 * Links öffnen im neuen Tab, Grundschrift wie in einem Mailprogramm.
 */
export function inboxDocument(fragment: string): string {
	return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<base target="_blank">
<style>body{margin:12px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:3px solid #d0d7de;color:#57606a}pre{white-space:pre-wrap}</style>
</head><body>${fragment}</body></html>`;
}

/**
 * Zitat für Antwort/Weiterleitung im Editor-Format (nur Tags aus `sanitizeBody`): Kopfzeile + Klartext
 * des Originals als `<blockquote>` mit Absätzen.
 */
export function quoteForEditor(header: string, text: string): string {
	const esc = (v: string) =>
		v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const paragraphs = text
		.replace(/\r\n/g, '\n')
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.slice(0, 200)
		.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
		.join('');
	return `<p></p><p>${esc(header)}</p><blockquote>${paragraphs || '<p></p>'}</blockquote>`;
}
