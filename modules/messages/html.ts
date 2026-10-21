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
