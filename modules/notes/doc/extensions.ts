/**
 * Gemeinsames Dokumentschema der Notizen (Server UND Browser, ohne DOM-Zugriff): Tiptap-Erweiterungen, aus
 * denen `getSchema()` das ProseMirror-Schema baut. Der Browser ergänzt nur Verhalten (Collaboration, Cursor,
 * Platzhalter, Markdown-Einfügen, Node-Views) – nie neue Knoten/Marks, sonst passen Server-Ableitung und Export
 * nicht mehr.
 *
 * Eigene Knoten:
 *   - `image` speichert nur `assetId` (+ `alt`, `width`); die Adresse wird beim Darstellen aus der ID gebaut, eine
 *     freie `src` aus dem Dokument wird nie ausgegeben (kein Nachladen fremder Server). Markdown: `![alt](asset:<id>)`.
 *   - `embed` = eingebetteter Inhalt eines anderen Moduls (z. B. Whiteboard), `{ module, kind, refId, height }`.
 *     Markdown: `:::embed {module="whiteboard" kind="board" refId="…" height="480"} :::`.
 */
import {
	createAtomBlockMarkdownSpec,
	getSchema,
	mergeAttributes,
	Node,
	type AnyExtension
} from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import StarterKit from '@tiptap/starter-kit';
import type { Schema } from '@tiptap/pm/model';
import { API_BASE, DEFAULT_EMBED_HEIGHT, MAX_EMBED_HEIGHT, MIN_EMBED_HEIGHT } from '../schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9-]{0,40}$/;

export const ASSET_SCHEME = 'asset:';

export function isUuid(v: unknown): v is string {
	return typeof v === 'string' && UUID_RE.test(v);
}

/** Standard-Adresse eines Bildes (relativ, mit Session-Cookie) */
export function assetUrl(assetId: string, variant: 'thumb' | 'web' | 'file' = 'web'): string {
	return `${API_BASE}/assets/${assetId}/${variant}`;
}

export interface NoteExtensionOptions {
	/** Bild-Adresse beim Rendern (Export ersetzt sie durch Dateinamen bzw. data-URLs) */
	assetSrc?: (assetId: string) => string;
	/** Browser: Bildgröße per Ziehgriff */
	resizableImages?: boolean;
}

const clampHeight = (v: unknown): number => {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_EMBED_HEIGHT;
	return Math.min(MAX_EMBED_HEIGHT, Math.max(MIN_EMBED_HEIGHT, n));
};

/** Bild mit Asset-ID statt freier Adresse */
export function noteImage(options: NoteExtensionOptions = {}) {
	const src = options.assetSrc ?? ((id: string) => assetUrl(id));
	return Image.extend({
		addAttributes() {
			return {
				assetId: {
					default: null,
					parseHTML: (el) => {
						const v = el.getAttribute('data-asset-id');
						return isUuid(v) ? v : null;
					},
					renderHTML: (attrs) => (isUuid(attrs.assetId) ? { 'data-asset-id': attrs.assetId } : {})
				},
				// `src` wird nie aus dem Dokument übernommen, sondern aus der ID gebaut
				src: {
					default: null,
					parseHTML: () => null,
					renderHTML: () => ({})
				},
				alt: { default: null },
				title: { default: null },
				width: {
					default: null,
					parseHTML: (el) => {
						const n = Number(el.getAttribute('width'));
						return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
					}
				},
				height: { default: null, parseHTML: () => null, renderHTML: () => ({}) }
			};
		},
		parseHTML() {
			return [{ tag: 'img[data-asset-id]' }];
		},
		renderHTML({ node, HTMLAttributes }) {
			const id = node.attrs.assetId;
			return [
				'img',
				mergeAttributes(HTMLAttributes, isUuid(id) ? { src: src(id), loading: 'lazy' } : {})
			];
		},
		parseMarkdown: (token, helpers) => {
			const href = String(token.href ?? '');
			const id = href.startsWith(ASSET_SCHEME) ? href.slice(ASSET_SCHEME.length) : '';
			return helpers.createNode('image', {
				assetId: isUuid(id) ? id : null,
				alt: token.text || null,
				title: token.title || null
			});
		},
		renderMarkdown: (node) => {
			const id = node.attrs?.assetId;
			const alt = String(node.attrs?.alt ?? '').replace(/[[\]]/g, '');
			return isUuid(id) ? `![${alt}](${ASSET_SCHEME}${id})` : alt ? `[Bild: ${alt}]` : '';
		}
	}).configure({
		inline: false,
		allowBase64: false,
		resize: options.resizableImages
			? { enabled: true, minWidth: 80, minHeight: 40, alwaysPreserveAspectRatio: true }
			: false
	});
}

/** Eingebetteter Inhalt eines anderen Moduls (Darstellung im Browser per Node-View als iframe) */
export const Embed = Node.create({
	name: 'embed',
	group: 'block',
	atom: true,
	draggable: true,
	selectable: true,
	addAttributes() {
		return {
			module: {
				default: null,
				parseHTML: (el) => {
					const v = el.getAttribute('data-module');
					return v && KEY_RE.test(v) ? v : null;
				},
				renderHTML: (a) => ({ 'data-module': a.module })
			},
			kind: {
				default: null,
				parseHTML: (el) => {
					const v = el.getAttribute('data-kind');
					return v && KEY_RE.test(v) ? v : null;
				},
				renderHTML: (a) => ({ 'data-kind': a.kind })
			},
			refId: {
				default: null,
				parseHTML: (el) => {
					const v = el.getAttribute('data-ref-id');
					return isUuid(v) ? v : null;
				},
				renderHTML: (a) => ({ 'data-ref-id': a.refId })
			},
			height: {
				default: DEFAULT_EMBED_HEIGHT,
				parseHTML: (el) => clampHeight(el.getAttribute('data-height')),
				renderHTML: (a) => ({ 'data-height': clampHeight(a.height) })
			}
		};
	},
	parseHTML() {
		return [{ tag: 'div[data-embed]' }];
	},
	renderHTML({ HTMLAttributes }) {
		return ['div', mergeAttributes({ 'data-embed': '' }, HTMLAttributes)];
	},
	...createAtomBlockMarkdownSpec({
		nodeName: 'embed',
		requiredAttributes: ['module', 'kind', 'refId'],
		defaultAttributes: { height: DEFAULT_EMBED_HEIGHT },
		allowedAttributes: ['module', 'kind', 'refId', 'height']
	})
});

/** Alle Erweiterungen, die das Schema bestimmen */
export function noteExtensions(options: NoteExtensionOptions = {}): AnyExtension[] {
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3] },
			// Rückgängig übernimmt Yjs (nur eigene Änderungen)
			undoRedo: false,
			link: {
				openOnClick: false,
				autolink: true,
				protocols: ['http', 'https', 'mailto'],
				HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
			}
		}),
		TextStyleKit.configure({ fontFamily: false, lineHeight: false }),
		Highlight.configure({ multicolor: true }),
		TextAlign.configure({ types: ['heading', 'paragraph'] }),
		TaskList,
		TaskItem.configure({ nested: true }),
		TableKit.configure({ table: { resizable: !!options.resizableImages } }),
		noteImage(options),
		Embed
	];
}

let cachedSchema: Schema | null = null;

/** ProseMirror-Schema (Server: Ableitung, Import, Versionen) */
export function noteSchema(): Schema {
	cachedSchema ??= getSchema(noteExtensions());
	return cachedSchema;
}
