/**
 * API-Vertrag des Moduls "notes" (Notizen): Zod-Schemas für Server und UI, DTOs, Live-Ereignisse und Konstanten.
 *
 * Inhalt einer Notiz = Yjs-Dokument (Fragment `default`, Tiptap/ProseMirror-Schema aus `doc/extensions.ts`).
 * Änderungen laufen als binäre Yjs-Updates (`POST /notes/:id/updates`), verteilt per SSE (`GET /notes/:id/live`).
 * Abgeleitete Felder (`content_json`, `content_text`) erzeugt der Server verzögert für Suche, Vorschau und Export.
 */
import { z } from 'zod';
import { PRINCIPAL_TYPES, type PrincipalType } from '$lib/sdk/types/sharing';

export const MODULE_ID = 'notes';
export const BASE_PATH = '/modules/notes';
export const API_BASE = '/api/v1/modules/notes';
/** Name des Yjs-Fragments (Standard von `@tiptap/extension-collaboration`) */
export const YDOC_FIELD = 'default';

/** Benachrichtigungen (core.notifications) */
export const NOTIFY_NOTE_SHARED = 'note-shared';

export const PERM = {
	view: 'notes.note.view',
	create: 'notes.note.create',
	viewAll: 'notes.note.view-all',
	editAll: 'notes.note.edit-all'
} as const;

// --- Grenzen ----------------------------------------------------------------

export const MAX_TITLE = 200;
/** Tiefe des Seitenbaums (Wurzel = 1) */
export const MAX_DEPTH = 10;
/** Kinder je Notiz (Anzeige/Sortierung) */
export const MAX_CHILDREN = 500;
/** Gespeicherter Yjs-Zustand je Notiz */
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
/** Ein Yjs-Update je Anfrage (rohes `application/octet-stream`) */
export const MAX_UPDATE_BYTES = 5 * 1024 * 1024;
/** Anwesenheit (Awareness-Update, base64) */
export const MAX_AWARENESS_CHARS = 64 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_SHARES = 200;
export const MAX_STREAMS_PER_USER = 30;
export const MAX_VERSIONS_AUTO = 50;
export const MAX_VERSIONS_MANUAL = 100;
export const TRASH_DAYS = 30;
/** Nach so vielen Einzel-Updates wird verdichtet (`notes.ydoc`) */
export const COMPACT_AFTER_UPDATES = 200;
/** Abgeleitete Felder (Text, JSON) nach dieser Ruhezeit neu erzeugen */
export const DERIVE_DELAY_MS = 5_000;
/** Höhe eingebetteter Inhalte (px) */
export const MIN_EMBED_HEIGHT = 160;
export const MAX_EMBED_HEIGHT = 1600;
export const DEFAULT_EMBED_HEIGHT = 480;

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

export const EXPORT_FORMATS = ['md', 'zip', 'html', 'docx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
	md: 'Markdown (.md)',
	zip: 'Markdown mit Bildern (.zip)',
	html: 'HTML-Datei (.html)',
	docx: 'Word (.docx)',
	pdf: 'PDF (.pdf)'
};

/** Schriftgrößen der Werkzeugleiste (px) */
export const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32] as const;

/** Text- und Markierungsfarben (Vorschläge, eigene über `ColorPicker`) */
export const TEXT_COLORS = [
	'#1f2937',
	'#6b7280',
	'#dc2626',
	'#ea580c',
	'#ca8a04',
	'#16a34a',
	'#0891b2',
	'#2563eb',
	'#7c3aed',
	'#db2777'
] as const;
export const HIGHLIGHT_COLORS = [
	'#fef08a',
	'#fed7aa',
	'#fecaca',
	'#e9d5ff',
	'#bfdbfe',
	'#a5f3fc',
	'#bbf7d0',
	'#e5e7eb'
] as const;

export const PRESENCE_COLORS = [
	'#e11d48',
	'#2563eb',
	'#16a34a',
	'#d97706',
	'#7c3aed',
	'#0891b2',
	'#db2777',
	'#4d7c0f'
] as const;

export function presenceColor(userId: string): string {
	let h = 0;
	for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

// --- Bausteine --------------------------------------------------------------

const uuid = z.uuid('Ungültige ID');

const title = z.string().trim().max(MAX_TITLE, `Höchstens ${MAX_TITLE} Zeichen`);

const icon = z
	.string()
	.regex(/^[a-z0-9-]{1,64}$/, 'Ungültiges Icon')
	.nullish()
	.transform((v) => v ?? null);

const color = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb')
	.transform((v) => v.toLowerCase())
	.nullish()
	.transform((v) => v ?? null);

/** Kennung einer Verbindung (je Browser-Tab) */
export const clientId = z
	.string()
	.trim()
	.min(8)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Ungültige Kennung');

export const idParams = z.object({ id: uuid });
export const actionParams = z.object({ actionId: uuid });
export const versionParams = z.object({ id: uuid, versionId: uuid });
export const assetParams = z.object({
	assetId: uuid,
	variant: z.enum(['thumb', 'web', 'file'])
});

// --- Notizen ------------------------------------------------------------------

/** POST `/notes` – ohne `parentId` = neue Wurzel (Recht `create`), mit `parentId` = Unterseite (edit am Elternteil) */
export const noteCreateInput = z
	.object({
		title: title.default(''),
		parentId: uuid.nullish().transform((v) => v ?? null),
		/** nur für Wurzeln: Notiz einer Aktion (Bearbeiten-Zugriff auf die Aktion nötig) */
		actionId: uuid.nullish().transform((v) => v ?? null),
		icon,
		color,
		/** Startinhalt als Markdown (z. B. Vorlage); ohne = leer */
		markdown: z
			.string()
			.max(2_000_000)
			.nullish()
			.transform((v) => v ?? null)
	})
	.strict();
export type NoteCreateInput = z.input<typeof noteCreateInput>;

/** PATCH `/notes/:id` */
export const noteUpdateInput = z
	.object({
		title: title.optional(),
		icon: icon.optional(),
		color: color.optional(),
		/** nur Wurzeln, nur Eigentümer*in/`edit-all` */
		actionId: uuid.nullable().optional()
	})
	.strict();
export type NoteUpdateInput = z.input<typeof noteUpdateInput>;

/** POST `/notes/:id/move` – neues Elternteil (`null` = eigene Wurzel) und Position unter den Geschwistern */
export const moveInput = z
	.object({
		parentId: uuid.nullable(),
		position: z.number().int().min(0).max(MAX_CHILDREN)
	})
	.strict();
export type MoveInput = z.input<typeof moveInput>;

export const recentQuery = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const searchQuery = z.object({
	q: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});

/** GET `/notes/:id/state?sv=` – `sv` = eigener State-Vector (base64url), dann nur die fehlenden Änderungen */
export const stateQuery = z.object({
	sv: z
		.string()
		.max(100_000)
		.regex(/^[A-Za-z0-9_\-+/=]*$/, 'Ungültiger State-Vector')
		.optional()
});

/** GET `/notes/:id/live` */
export const liveQuery = z.object({
	client: clientId,
	/** Yjs-Client-ID der Awareness (zum Entfernen des Cursors beim Verlassen) */
	awarenessId: z.coerce
		.number()
		.int()
		.min(0)
		.max(2 ** 53)
		.optional()
});

/** POST `/notes/:id/updates?client=` – Body = ein (zusammengeführtes) Yjs-Update, `application/octet-stream` */
export const updatesQuery = z.object({ client: clientId });

/** POST `/notes/:id/awareness` */
export const awarenessInput = z
	.object({
		client: clientId,
		update: z
			.string()
			.max(MAX_AWARENESS_CHARS)
			.regex(/^[A-Za-z0-9+/=]*$/, 'Ungültige Daten')
	})
	.strict();
export type AwarenessInput = z.input<typeof awarenessInput>;

const principalShare = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: z.string().trim().min(1).max(64),
		level: z.enum(SHARE_LEVELS)
	})
	.strict();

export const sharesInput = z
	.object({ shares: z.array(principalShare).max(MAX_SHARES, `Höchstens ${MAX_SHARES} Freigaben`) })
	.strict()
	.superRefine((v, ctx) => {
		const seen = new Set<string>();
		v.shares.forEach((s, i) => {
			const key = `${s.type}:${s.id}`;
			if (seen.has(key)) {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Doppelte Freigabe' });
			}
			seen.add(key);
			if (s.type === 'everyone' && s.id !== '*') {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Ungültige ID' });
			}
		});
	});
export type SharesInput = z.infer<typeof sharesInput>;

export const principalQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});

export const versionInput = z
	.object({ label: z.string().trim().min(1, 'Pflichtfeld').max(100, 'Höchstens 100 Zeichen') })
	.strict();

export const trashIdsInput = z.object({ ids: z.array(uuid).min(1).max(200) }).strict();

/** GET `/notes/:id/export?format=&subpages=1` */
export const exportQuery = z.object({
	format: z.enum(EXPORT_FORMATS),
	subpages: z.enum(['0', '1']).default('0'),
	/** PDF: mit Stammes-Briefkopf */
	letterhead: z.enum(['0', '1']).default('0')
});

// --- DTOs -------------------------------------------------------------------

export interface UserRef {
	id: string;
	name: string;
	image: string | null;
}

/** Eintrag im Seitenbaum / in Listen */
export interface NoteNode {
	id: string;
	parentId: string | null;
	title: string;
	icon: string | null;
	color: string | null;
	position: number;
	hasChildren: boolean;
	ownerId: string | null;
	actionId: string | null;
	level: ShareLevel;
	isOwner: boolean;
	/** Freigaben ändern, löschen, Aktion wechseln */
	canShare: boolean;
	/** an den ganzen Stamm freigegeben (auch geerbt) */
	stamm: boolean;
	/** irgendeine eigene Freigabe vorhanden */
	shared: boolean;
	updatedAt: string;
	updatedBy: UserRef | null;
	/** Textanfang (nur Listen: Übersicht, Suche) */
	excerpt?: string;
}

export interface Breadcrumb {
	id: string;
	title: string;
	icon: string | null;
}

export interface NoteDetail extends NoteNode {
	owner: UserRef | null;
	/** Pfad ab der ersten zugänglichen Seite (ohne die Notiz selbst) */
	breadcrumbs: Breadcrumb[];
	actionName: string | null;
	sizeBytes: number;
	createdAt: string;
	canCreateChild: boolean;
}

export interface NoteRoots {
	/** eigene Wurzeln */
	own: NoteNode[];
	/** freigegebene Seiten anderer (oberste zugängliche) */
	shared: NoteNode[];
	/** Notizen sichtbarer Aktionen (Wurzeln) */
	actions: (NoteNode & { actionName: string })[];
	canCreate: boolean;
}

export interface NoteSearchHit {
	id: string;
	title: string;
	icon: string | null;
	snippet: string;
	path: string;
}

export interface NoteShareEntry {
	type: PrincipalType;
	userId: string;
	name: string;
	detail: string | null;
	color: string | null;
	image: string | null;
	level: ShareLevel;
}

export interface NoteShares {
	owner: UserRef | null;
	shares: NoteShareEntry[];
	/** von Oberseiten geerbt (nur Seiten, die der Aufrufer selbst sehen darf) */
	inherited: (NoteShareEntry & { fromId: string; fromTitle: string })[];
	canManage: boolean;
	everyoneLabel: string;
}

export interface NoteVersion {
	id: string;
	label: string | null;
	auto: boolean;
	sizeBytes: number;
	createdAt: string;
	createdBy: UserRef | null;
}

export interface NoteVersionDetail extends NoteVersion {
	/** Inhalt als ProseMirror-JSON (Vorschau) */
	content: unknown;
}

export interface TrashItem {
	id: string;
	title: string;
	icon: string | null;
	/** Anzahl Unterseiten im gelöschten Teilbaum */
	descendants: number;
	parentTitle: string | null;
	deletedAt: string;
	deletedBy: UserRef | null;
	purgeOn: string;
}

export interface NoteAsset {
	id: string;
	kind: 'image' | 'file';
	name: string;
	contentType: string;
	sizeBytes: number;
	width: number | null;
	height: number | null;
}

export interface ActionNotes {
	notes: NoteNode[];
	canCreate: boolean;
}

export interface Peer {
	client: string;
	userId: string;
	name: string;
	image: string | null;
	color: string;
	canEdit: boolean;
	awarenessId: number | null;
}

/** Ereignisse im SSE-Stream (`data: <json>`) */
export type LiveEvent =
	| { type: 'hello'; client: string; level: ShareLevel; peers: Peer[] }
	| { type: 'update'; client: string; update: string }
	| { type: 'awareness'; client: string; update: string }
	| { type: 'join'; peer: Peer }
	| { type: 'leave'; client: string; awarenessId: number | null }
	| { type: 'peer'; peer: Peer }
	| { type: 'meta'; note: Pick<NoteNode, 'id' | 'title' | 'icon' | 'color'> }
	| { type: 'access'; level: ShareLevel }
	| { type: 'reset' }
	| { type: 'revoked' }
	| { type: 'deleted' };

/** Antwort von `POST /notes/:id/updates` */
export interface UpdateResult {
	ok: true;
	sizeBytes: number;
}
