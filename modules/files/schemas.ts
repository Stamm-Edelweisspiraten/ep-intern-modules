/**
 * API-Vertrag des Moduls `files` (Dateien / Cloud-Ablage): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';
import { PRINCIPAL_TYPES, type PrincipalInfo } from '$lib/sdk/types/sharing';

export const MODULE_ID = 'files';
export const BASE_PATH = '/modules/files';

export const PERMISSIONS = {
	/** Grundrecht: eigene Ablage („Meine Dateien“) und für mich Freigegebenes */
	view: 'files.file.view',
	/** Stammesordner lesen */
	sharedView: 'files.shared.view',
	/** Stammesordner bearbeiten (hochladen, umbenennen, verschieben, löschen) */
	sharedEdit: 'files.shared.edit',
	/** Öffentliche Links anlegen (nur für Knoten mit Bearbeiten-Zugriff) */
	linkCreate: 'files.link.create',
	/** Alles sehen und verwalten (auch fremde „Meine Dateien“) */
	manageAll: 'files.file.manage-all'
} as const;

export const SETTING_KEYS = {
	/** Kontingent je Person in MB (gilt für „Meine Dateien“), 0 = unbegrenzt */
	quotaMb: 'files.quota.mb',
	/** Tage im Papierkorb bis zum endgültigen Löschen */
	trashDays: 'files.trash.days'
} as const;

export const SPACES = ['personal', 'shared'] as const;
export type Space = (typeof SPACES)[number];
export const SPACE_LABELS: Record<Space, string> = {
	personal: 'Meine Dateien',
	shared: 'Stamm'
};

export const NODE_KINDS = ['folder', 'file'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_LEVEL_LABELS: Record<ShareLevel, string> = { read: 'Sehen', edit: 'Bearbeiten' };

/** Zugriffsstufe des Aufrufers auf einen Knoten */
export type AccessLevel = 'read' | 'edit';

export const MAX_NAME = 200;
/** Maximale Ordnertiefe (Wurzel = 0) */
export const MAX_DEPTH = 20;
export const MAX_BULK = 500;
export const MAX_SHARES = 200;
export const MAX_LINKS_PER_NODE = 20;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_PASSWORD = 200;
export const MIN_PASSWORD = 8;
/** Fehlversuche je Link und Stunde, danach gesperrt (429) */
export const MAX_UNLOCK_FAILURES = 10;
/** Gleichzeitige Uploads im Browser */
export const UPLOAD_CONCURRENCY = 3;
export const DEFAULT_QUOTA_MB = 1024;
export const DEFAULT_TRASH_DAYS = 30;
/** Zugriffstoken nach Passwort-Eingabe (öffentlicher Link) */
export const LINK_ACCESS_TTL_SEC = 15 * 60;
/** Textvorschau nur bis zu dieser Größe */
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

/** Bildtypen mit Thumbnail und Vorschau (Inhalt prüft der Server per `core.images`) */
export const PREVIEW_IMAGE_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/avif'
] as const;
export const PREVIEW_PDF = 'application/pdf';
export const PREVIEW_TEXT_TYPES = [
	'text/plain',
	'text/csv',
	'text/markdown',
	'application/json'
] as const;

/** Aktive Inhalte: nie inline ausliefern (immer `attachment`) */
export const NEVER_INLINE_TYPES = ['text/html', 'image/svg+xml', 'application/xhtml+xml'] as const;

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

/** Ordner-/Dateiname: keine Pfadtrenner, keine Steuerzeichen, nicht „.“/„..“ */
/** Unsichtbare Zeichen und Bidi-Steuerung (z. B. U+202E dreht die Anzeige von Dateinamen um) sind in Namen nicht erlaubt */
export const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export const nodeName = z
	.string()
	.trim()
	.min(1, 'Bitte einen Namen angeben')
	// Zeichen (Codepoints) wie `normalizeName`, nicht UTF-16-Einheiten (Emoji zählen einfach)
	.refine((v) => Array.from(v).length <= MAX_NAME, `Höchstens ${MAX_NAME} Zeichen`)
	.refine(
		// eslint-disable-next-line no-control-regex
		(v) => !/[/\\\u0000-\u001f\u007f]/.test(v),
		'Name darf keine / \\ oder Steuerzeichen enthalten'
	)
	.refine((v) => !INVISIBLE_CHARS.test(v), 'Name darf keine unsichtbaren Steuerzeichen enthalten')
	.refine((v) => v !== '.' && v !== '..', 'Ungültiger Name');

export const nodeId = z.uuid('Ungültige ID');

const refId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9*_-]+$/, 'Ungültige ID');

/** Zielordner: Knoten-ID oder `null` = Wurzel des Bereichs */
const parentRef = nodeId.nullable();

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

export const idParams = z.object({ id: nodeId });
export const parentParams = z.object({ parent: z.union([nodeId, z.literal('root')]) });
export const linkIdParams = z.object({ id: z.uuid() });
export const tokenParams = z.object({
	token: z
		.string()
		.min(20)
		.max(100)
		.regex(/^[A-Za-z0-9_-]+$/)
});
export const tokenNodeParams = tokenParams.extend({ nodeId });

/** GET `/nodes` – Inhalt eines Ordners; ohne `parent` = Wurzel des Bereichs */
export const listQuery = z.object({
	space: z.enum(SPACES).default('personal'),
	parent: nodeId.optional(),
	/** nur mit `manage-all`: „Meine Dateien“ einer anderen Person */
	owner: z.string().min(1).max(64).optional()
});

export const searchQuery = z.object({
	q: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100),
	space: z.enum(SPACES).optional()
});

export const contentQuery = z.object({
	download: z.enum(['0', '1']).optional()
});

export const folderCreateInput = z
	.object({
		space: z.enum(SPACES),
		parentId: parentRef,
		name: nodeName
	})
	.strict();
export type FolderCreateInput = z.input<typeof folderCreateInput>;

export const renameInput = z.object({ name: nodeName }).strict();

export const moveInput = z
	.object({
		ids: z.array(nodeId).min(1).max(MAX_BULK),
		/** Ziel: Ordner-ID oder `null` = Wurzel von `space` */
		targetId: parentRef,
		space: z.enum(SPACES)
	})
	.strict();
export type MoveInput = z.input<typeof moveInput>;

export const bulkInput = z.object({ ids: z.array(nodeId).min(1).max(MAX_BULK) }).strict();

/** Upload (multipart): Textfelder neben `file` */
export const uploadFields = z.object({
	space: z.enum(SPACES),
	/** Relativer Pfad bei Ordner-Upload, z. B. „Fotos/2026/bild.jpg“ – Ordner werden angelegt */
	relativePath: z.string().max(1000).optional(),
	/** `rename` (Standard) = „Name (2)“, `replace` = vorhandene Datei ersetzen */
	conflict: z.enum(['rename', 'replace']).default('rename')
});

export const shareInput = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: refId,
		level: z.enum(SHARE_LEVELS)
	})
	.strict();
export type ShareInput = z.infer<typeof shareInput>;
export const sharesInput = z
	.object({ shares: z.array(shareInput).max(MAX_SHARES) })
	.strict()
	.superRefine((v, c) => {
		const seen = new Set<string>();
		v.shares.forEach((s, i) => {
			const k = `${s.type}:${s.id}`;
			if (seen.has(k))
				c.addIssue({ code: 'custom', message: 'Doppelt', path: ['shares', i, 'id'] });
			seen.add(k);
		});
	});

export const principalSearchQuery = z.object({ q: z.string().trim().min(2).max(100) });

export const linkCreateInput = z
	.object({
		/** Ablaufdatum `YYYY-MM-DD` (gültig bis Tagesende) oder `null` = unbegrenzt */
		expiresOn: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
			.nullable(),
		password: z
			.string()
			.min(MIN_PASSWORD, `Mindestens ${MIN_PASSWORD} Zeichen`)
			.max(MAX_PASSWORD)
			.nullable()
	})
	.strict();
export type LinkCreateInput = z.input<typeof linkCreateInput>;

export const linkUnlockInput = z.object({ password: z.string().min(1).max(MAX_PASSWORD) }).strict();

/** Öffentliche Abfragen: `t` = Zugriffstoken nach Passwort-Eingabe */
export const publicInfoQuery = z.object({ t: z.string().max(500).optional() });
export const publicNodesQuery = z.object({
	parent: nodeId.optional(),
	t: z.string().max(500).optional()
});
export const publicContentQuery = z.object({
	t: z.string().max(500).optional(),
	download: z.enum(['0', '1']).optional(),
	thumb: z.enum(['0', '1']).optional()
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface UserRef {
	id: string;
	name: string;
}

export interface FileNode {
	id: string;
	parentId: string | null;
	kind: NodeKind;
	space: Space;
	name: string;
	ownerId: string;
	/** nur Dateien */
	contentType: string | null;
	sizeBytes: number | null;
	hasThumb: boolean;
	/** Zugriff des Aufrufers */
	access: AccessLevel;
	/** Darf Freigaben und öffentliche Links verwalten (Eigentümer*in bzw. Stammesordner mit `files.shared.edit`, `manage-all`) – Bearbeiten über eine Freigabe reicht NICHT */
	canShare: boolean;
	/** Hat eigene Freigaben (Principals) */
	shared: boolean;
	/** Hat aktive öffentliche Links */
	linked: boolean;
	/** Ordner: Anzahl direkter Einträge */
	childCount: number | null;
	createdBy: UserRef | null;
	createdAt: string;
	updatedAt: string;
}

export interface Breadcrumb {
	/** `null` = Wurzel des Bereichs */
	id: string | null;
	name: string;
}

export interface FolderListing {
	space: Space;
	/** `null` = Wurzel */
	folder: FileNode | null;
	breadcrumbs: Breadcrumb[];
	/** Zugriff im aktuellen Ordner (bestimmt Upload/Neuer Ordner) */
	access: AccessLevel;
	/** Ordner zuerst, dann Dateien, je nach Name (de, ohne Groß/Klein) */
	items: FileNode[];
}

export interface SearchResult {
	items: (FileNode & { path: string })[];
	truncated: boolean;
}

export interface TrashItem {
	id: string;
	kind: NodeKind;
	space: Space;
	name: string;
	/** Ursprünglicher Ort, z. B. „Meine Dateien / Fotos“ */
	originalPath: string;
	sizeBytes: number;
	deletedAt: string;
	deletedBy: UserRef | null;
	/** Endgültiges Löschen am */
	purgeOn: string;
}

export interface NodeShare extends PrincipalInfo {
	level: ShareLevel;
}

export interface NodeShares {
	shares: NodeShare[];
	/** Von übergeordneten Ordnern geerbt (nur Anzeige) */
	inherited: (NodeShare & { fromId: string; fromName: string })[];
}

export interface ShareLink {
	id: string;
	nodeId: string;
	/** Nur direkt nach dem Anlegen gesetzt (Klartext-Token), sonst `null` */
	url: string | null;
	expiresOn: string | null;
	hasPassword: boolean;
	active: boolean;
	revokedAt: string | null;
	accessCount: number;
	lastAccessAt: string | null;
	createdBy: UserRef | null;
	createdAt: string;
}

export interface PublicNode {
	id: string;
	kind: NodeKind;
	name: string;
	contentType: string | null;
	sizeBytes: number | null;
	hasThumb: boolean;
	updatedAt: string;
}

export interface PublicLinkInfo {
	name: string;
	kind: NodeKind;
	needsPassword: boolean;
	expiresOn: string | null;
	/** nur bei Datei-Links bzw. nach Freischalten */
	node: PublicNode | null;
}

export interface PublicListing {
	breadcrumbs: Breadcrumb[];
	items: PublicNode[];
}

export interface Quota {
	usedBytes: number;
	/** `null` = unbegrenzt */
	limitBytes: number | null;
}

export interface FilesMeta {
	quota: Quota;
	maxFileBytes: number;
	allowedContentTypes: string[];
	trashDays: number;
	can: {
		sharedView: boolean;
		sharedEdit: boolean;
		linkCreate: boolean;
		manageAll: boolean;
	};
}

export interface BulkResult {
	affected: number;
}
