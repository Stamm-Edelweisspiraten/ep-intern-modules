/**
 * Hilfen für die Darstellung (rein): Kontrastfarbe, Datei-Adressen, Dateigröße, Symbol je Dateityp/Karte.
 * Das Whiteboard ist „Papier“: die Fläche bleibt auch im Dunkelmodus hell, damit Nutzerfarben gleich wirken
 * (wie PDF-Vorschauen) – deshalb feste Farben hier statt Design-Tokens.
 */
import type { RefType } from '../../schemas';
import { API_BASE } from '../../schemas';

export const PAPER = '#ffffff';
export const PAPER_PATTERN = '#cbd5e1';
export const INK = '#1f2937';
export const MUTED_INK = '#64748b';
export const SELECTION = '#2563eb';
export const CARD_BORDER = '#cbd5e1';

/** Gut lesbare Schriftfarbe auf `fill` (dunkel auf hell, hell auf dunkel) */
export function textOn(fill: string | null | undefined): string {
	if (!fill || fill === 'transparent' || !/^#[0-9a-f]{6}$/i.test(fill)) return INK;
	const n = parseInt(fill.slice(1), 16);
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
	return l > 0.35 ? INK : '#ffffff';
}

export function assetUrl(
	boardId: string,
	assetId: string,
	variant: 'thumb' | 'web' | 'file'
): string {
	return `${API_BASE}/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}/${variant}`;
}

export function formatBytes(bytes: number | null | undefined): string {
	const n = bytes && bytes > 0 ? bytes : 0;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Art einer Datei für Symbol und Farbe */
export type FileKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'image' | 'archive' | 'text' | 'other';

export function fileKind(contentType: string, name = ''): FileKind {
	const t = contentType.toLowerCase();
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
	if (t.startsWith('image/')) return 'image';
	if (/word|opendocument\.text|rtf/.test(t) || ['doc', 'docx', 'odt', 'rtf'].includes(ext))
		return 'doc';
	if (/sheet|excel|csv/.test(t) || ['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet';
	if (/presentation|powerpoint/.test(t) || ['ppt', 'pptx', 'odp'].includes(ext)) return 'slides';
	if (/zip|compressed|tar/.test(t) || ['zip', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
	if (t.startsWith('text/') || ['txt', 'md', 'json'].includes(ext)) return 'text';
	return 'other';
}

/** Farbe je Dateiart (feste Werte, Papier ist immer hell) */
export const FILE_COLORS: Record<FileKind, string> = {
	pdf: '#dc2626',
	doc: '#2563eb',
	sheet: '#16a34a',
	slides: '#ea580c',
	image: '#7c3aed',
	archive: '#b45309',
	text: '#475569',
	other: '#64748b'
};

export const REF_COLORS: Record<RefType, string> = {
	action: '#0d9488',
	task: '#2563eb',
	taskboard: '#2563eb',
	event: '#d97706',
	gallery: '#7c3aed',
	file: '#475569',
	whiteboard: '#db2777'
};

/** Endung für das Kürzel auf Datei-Karten („PDF“, „DOCX“) */
export function extensionLabel(name: string): string {
	const ext = name.includes('.') ? name.split('.').pop() : '';
	return (ext ?? '').slice(0, 5).toUpperCase();
}

export function hostOf(url: string): string {
	if (url.startsWith('/')) return 'Intern';
	if (url.startsWith('mailto:')) return url.slice(7);
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}
