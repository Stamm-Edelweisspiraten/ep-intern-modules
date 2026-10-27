/**
 * API-Vertrag des Moduls `material` (Materialverwaltung): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';
import { isRealDate } from '$lib/sdk/dates';
import { labelFormatSchema, labelLayoutSchema } from '$lib/sdk/labels';
import type { LabelFormat, LabelLayout } from '$lib/sdk/labels';

export const MODULE_ID = 'material';
export const BASE_PATH = '/modules/material';

/** Rolle mit allen Rechten (per `defaultRoleGrants`, im Amt „Materialwart*in“ verknüpfen) */
export const MANAGER_ROLE_NAME = 'Materialwart*in';
/** Rolle der Gruppenleitungen (aus `members`, automatisch vergeben) */
export const LEADER_ROLE_NAME = 'Gruppenleitung';
/** Amts-Vorlage (Modul `offices`) und ihre Benachrichtigungen */
export const OFFICE_KEY = 'materialwart';
export const NOTIFY_RESERVATION_CREATED = 'reservation-created';
export const NOTIFY_DAMAGE = 'damage-reported';
export const NOTIFY_OVERDUE = 'overdue';
/** Benachrichtigung an die reservierende Person: Rückgabe überfällig */
export const NOTIFY_MY_OVERDUE = 'my-overdue';

export const PERMISSIONS = {
	view: 'material.inventory.view',
	manage: 'material.inventory.manage',
	reserve: 'material.reservation.create',
	reservations: 'material.reservation.manage',
	labels: 'material.labels.manage'
} as const;

export const MAX_NAME = 150;
export const MAX_TEXT = 5000;
export const MAX_NOTE = 1000;
export const MAX_CODE = 40;
export const MAX_IMAGES_PER_ARTICLE = 10;
export const MAX_BATCH_UNITS = 200;
export const MAX_RESERVATION_LINES = 200;
export const MAX_QUANTITY = 100_000;
export const MAX_VALUE_CENTS = 100_000_000;
export const MAX_LABELS = 2000;
export const MAX_RESERVE_CODES = 500;

/** Bilder (vom Server mit `core.images` erzeugt) */
export const IMAGE_VARIANTS = ['thumb', 'web'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];
export const IMAGE_CONTENT_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/gif'
] as const;
export const IMAGE_ACCEPT = IMAGE_CONTENT_TYPES.join(',');
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function imageUrl(articleId: string, imageId: string, variant: ImageVariant): string {
	return `/api/v1${BASE_PATH}/articles/${articleId}/images/${imageId}/${variant}`;
}

// --- Codes ---------------------------------------------------------------------

/** Präfixe automatisch vergebener Codes: Stück/Kiste, Set, Lagerort */
export const CODE_PREFIX = { unit: 'M', set: 'S', location: 'L', article: 'A' } as const;
export type CodeKind = keyof typeof CODE_PREFIX;

/** Code normalisieren: Leerraum weg, Großbuchstaben */
export function normalizeCode(raw: string): string {
	return raw.trim().replace(/\s+/g, '').toUpperCase();
}

/** Pfad der Scan-Seite für einen Code (Inhalt des QR-Codes ist die volle URL) */
export function scanPath(code: string): string {
	return `${BASE_PATH}/scan/${encodeURIComponent(code)}`;
}

/**
 * Gescannten Inhalt in einen Code übersetzen: volle URL der Scan-Seite (QR) oder der Code selbst
 * (Strichcode, USB-Scanner, Eingabe). Fremde URLs → `null`.
 */
export function codeFromScan(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;
	if (/^https?:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			const m = url.pathname.match(/\/modules\/material\/scan\/([^/?#]+)/);
			return m ? normalizeCode(decodeURIComponent(m[1]!)) : null;
		} catch {
			return null;
		}
	}
	const code = normalizeCode(text);
	return code.length > 0 && code.length <= MAX_CODE ? code : null;
}

// --- Labels/Konstanten ---------------------------------------------------------

export const ARTICLE_KINDS = ['unit', 'bulk'] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export const ARTICLE_KIND_LABELS: Record<ArticleKind, string> = {
	unit: 'Einzelstücke',
	bulk: 'Menge'
};

export const CONDITIONS = ['ok', 'worn', 'damaged', 'defect', 'lost'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABELS: Record<Condition, string> = {
	ok: 'In Ordnung',
	worn: 'Gebraucht',
	damaged: 'Beschädigt',
	defect: 'Defekt',
	lost: 'Verloren'
};
/** Zustände, in denen ein Stück nicht reserviert/ausgegeben werden kann */
export const UNUSABLE_CONDITIONS: readonly Condition[] = ['defect', 'lost'];

export const RESERVATION_STATUSES = ['reserved', 'issued', 'returned', 'cancelled'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
	reserved: 'Reserviert',
	issued: 'Ausgegeben',
	returned: 'Zurückgegeben',
	cancelled: 'Storniert'
};

export const LINE_KINDS = ['unit', 'set', 'article'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const LABEL_TARGETS = ['unit', 'article', 'set', 'location', 'blank'] as const;
export type LabelTarget = (typeof LABEL_TARGETS)[number];
export const LABEL_TARGET_LABELS: Record<LabelTarget, string> = {
	unit: 'Stücke und Kisten',
	article: 'Artikel (auch Mengen wie Tassen)',
	set: 'Sets',
	location: 'Lagerorte',
	blank: 'Leere Codes (vorab drucken)'
};

/** Felder (Platzhalter) je Etikett-Ziel mit Beispielwerten für den Designer */
export const LABEL_FIELDS: Record<LabelTarget, { key: string; label: string; sample: string }[]> = {
	unit: [
		{ key: 'name', label: 'Bezeichnung', sample: 'Kohtenbahn 07' },
		{ key: 'article', label: 'Artikel', sample: 'Kohtenbahn' },
		{ key: 'code', label: 'Code', sample: 'M-000123' },
		{
			key: 'url',
			label: 'Scan-Link (für QR)',
			sample: 'https://intern.example.org/modules/material/scan/M-000123'
		},
		{ key: 'category', label: 'Kategorie', sample: 'Zelte' },
		{ key: 'location', label: 'Lagerort', sample: 'Materialraum › Regal A' },
		{ key: 'set', label: 'Set', sample: 'Kohte 3' },
		{ key: 'contents', label: 'Inhalt (Kisten)', sample: '10 × Tasse, 2 × Topf, Kelle' },
		{ key: 'org', label: 'Stammesname', sample: 'Stamm Edelweißpiraten' }
	],
	set: [
		{ key: 'name', label: 'Name', sample: 'Kohte 3' },
		{ key: 'template', label: 'Set-Typ', sample: 'Kohte' },
		{ key: 'code', label: 'Code', sample: 'S-000004' },
		{
			key: 'url',
			label: 'Scan-Link (für QR)',
			sample: 'https://intern.example.org/modules/material/scan/S-000004'
		},
		{ key: 'parts', label: 'Teile', sample: '4 × Kohtenbahn, 1 × Kohtenkreuz' },
		{ key: 'org', label: 'Stammesname', sample: 'Stamm Edelweißpiraten' }
	],
	location: [
		{ key: 'name', label: 'Name', sample: 'Regal A' },
		{ key: 'path', label: 'Pfad', sample: 'Materialraum › Regal A' },
		{ key: 'code', label: 'Code', sample: 'L-000002' },
		{
			key: 'url',
			label: 'Scan-Link (für QR)',
			sample: 'https://intern.example.org/modules/material/scan/L-000002'
		},
		{ key: 'org', label: 'Stammesname', sample: 'Stamm Edelweißpiraten' }
	],
	article: [
		{ key: 'name', label: 'Artikel', sample: 'Emaille-Tasse' },
		{ key: 'category', label: 'Kategorie', sample: 'Küche' },
		{ key: 'unit', label: 'Einheit', sample: 'Stück' },
		{ key: 'total', label: 'Bestand gesamt', sample: '42' },
		{ key: 'locations', label: 'Lagerorte', sample: 'Regal B – Küche, Kochkiste 1' },
		{ key: 'code', label: 'Code', sample: 'A-000008' },
		{
			key: 'url',
			label: 'Scan-Link (für QR)',
			sample: 'https://intern.example.org/modules/material/scan/A-000008'
		},
		{ key: 'org', label: 'Stammesname', sample: 'Stamm Edelweißpiraten' }
	],
	blank: [
		{ key: 'code', label: 'Code', sample: 'M-000200' },
		{
			key: 'url',
			label: 'Scan-Link (für QR)',
			sample: 'https://intern.example.org/modules/material/scan/M-000200'
		},
		{ key: 'org', label: 'Stammesname', sample: 'Stamm Edelweißpiraten' }
	]
};

export { isRealDate };

// --- Bausteine -----------------------------------------------------------------

const name = z.string().trim().min(1, 'Pflichtfeld').max(MAX_NAME, `Höchstens ${MAX_NAME} Zeichen`);
const text = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => v ?? '');
const quantity = z
	.number()
	.int('Nur ganze Zahlen')
	.min(1, 'Mindestens 1')
	.max(MAX_QUANTITY, 'Zu groß');
const count = z
	.number()
	.int('Nur ganze Zahlen')
	.min(0, 'Nicht negativ')
	.max(MAX_QUANTITY, 'Zu groß');
const dateString = z.string().refine(isRealDate, 'Ungültiges Datum');
const code = z
	.string()
	.trim()
	.min(1, 'Pflichtfeld')
	.max(MAX_CODE, `Höchstens ${MAX_CODE} Zeichen`)
	.transform(normalizeCode)
	.refine((v) => /^[A-Z0-9][A-Z0-9._/-]*$/.test(v), 'Nur Buchstaben, Ziffern und - . _ /');
const color = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, 'Ungültige Farbe')
	.nullish()
	.transform((v) => v ?? null);

export const idParams = z.object({ id: z.uuid() });
export const codeParams = z.object({ code: z.string().min(1).max(200) });
export const actionParams = z.object({ actionId: z.uuid() });
export const imageParams = z.object({ id: z.uuid(), imageId: z.uuid() });
export const imageVariantParams = imageParams.extend({ variant: z.enum(IMAGE_VARIANTS) });
export const imageOrderInput = z.object({ ids: z.array(z.uuid()).max(MAX_IMAGES_PER_ARTICLE) });

// --- Lagerorte -----------------------------------------------------------------

export const locationInput = z.object({
	name,
	parentId: z
		.uuid()
		.nullish()
		.transform((v) => v ?? null),
	description: text(MAX_TEXT)
});
export const locationUpdateInput = locationInput.partial();

export interface Location {
	id: string;
	parentId: string | null;
	name: string;
	description: string;
	code: string;
	/** Voller Pfad „Materialraum › Regal A“ */
	path: string;
	position: number;
	/** Stücke direkt an diesem Ort inkl. Inhalt der Kisten dort (ohne Kisten selbst, ohne Unterorte) */
	unitCount: number;
}

// --- Kategorien ----------------------------------------------------------------

export const categoryInput = z.object({
	name,
	color,
	icon: z
		.string()
		.trim()
		.max(60)
		.nullish()
		.transform((v) => v || null)
});
export const categoryUpdateInput = categoryInput.partial();

export interface Category {
	id: string;
	name: string;
	color: string | null;
	icon: string | null;
	articleCount: number;
}

// --- Artikel -------------------------------------------------------------------

export const articleInput = z.object({
	name,
	categoryId: z
		.uuid()
		.nullish()
		.transform((v) => v ?? null),
	kind: z.enum(ARTICLE_KINDS),
	unitLabel: z
		.string()
		.trim()
		.max(30)
		.nullish()
		.transform((v) => v || 'Stück'),
	description: text(MAX_TEXT),
	notes: text(MAX_TEXT),
	/** Mindestbestand (nur Menge) – darunter erscheint ein Hinweis */
	minQuantity: count.default(0)
});
export const articleUpdateInput = articleInput.omit({ kind: true }).partial();

export const articleListQuery = z.object({
	search: z.string().trim().max(100).optional(),
	categoryId: z.uuid().optional(),
	kind: z.enum(ARTICLE_KINDS).optional(),
	archived: z.enum(['0', '1']).optional()
});

export interface ArticleImage {
	id: string;
	thumbUrl: string;
	webUrl: string;
	width: number;
	height: number;
}

export interface Article {
	id: string;
	name: string;
	/** Eigener Code (Etikett am Regalfach, Scannen) */
	code: string;
	categoryId: string | null;
	categoryName: string | null;
	categoryColor: string | null;
	categoryIcon: string | null;
	kind: ArticleKind;
	unitLabel: string;
	description: string;
	notes: string;
	minQuantity: number;
	archived: boolean;
	images: ArticleImage[];
	/** Einzelstücke: alle aktiven Stücke / davon nutzbar (nicht defekt/verloren) */
	unitCount: number;
	usableCount: number;
	/** Menge: Summe des Bestands über alle Orte und Kisten */
	stockTotal: number;
	/** Gerade ausgegeben (Stücke bzw. Menge) */
	issuedCount: number;
}

// --- Stücke und Kisten ---------------------------------------------------------

/** Ort eines Stücks: genau eins von beidem oder keins („ohne Ort“) */
const placement = {
	locationId: z
		.uuid()
		.nullish()
		.transform((v) => v ?? null),
	containerId: z
		.uuid()
		.nullish()
		.transform((v) => v ?? null)
};

export const unitInput = z
	.object({
		articleId: z.uuid(),
		label: text(MAX_NAME),
		/** Eigener Code (z. B. vorab gedrucktes Etikett); leer = automatisch */
		code: code.nullish().transform((v) => v ?? null),
		isContainer: z.boolean().default(false),
		...placement,
		condition: z.enum(CONDITIONS).default('ok'),
		conditionNote: text(MAX_NOTE),
		purchasedOn: dateString.nullish().transform((v) => v ?? null),
		valueCents: z
			.number()
			.int()
			.min(0)
			.max(MAX_VALUE_CENTS)
			.nullish()
			.transform((v) => v ?? null),
		notes: text(MAX_TEXT),
		/** Mehrere gleichartige Stücke auf einmal: Bezeichnung + fortlaufende Nummer */
		count: z.number().int().min(1).max(MAX_BATCH_UNITS).default(1),
		/** Startnummer der Nummerierung (nur bei `count` > 1 oder `numbered`) */
		numberFrom: z.number().int().min(0).max(99_999).default(1),
		numbered: z.boolean().default(false)
	})
	.refine((v) => !(v.locationId && v.containerId), {
		path: ['containerId'],
		message: 'Entweder Lagerort oder Kiste'
	})
	.refine((v) => !(v.code && v.count > 1), {
		path: ['code'],
		message: 'Eigener Code nur für ein einzelnes Stück'
	});

export const unitUpdateInput = z.object({
	label: text(MAX_NAME).optional(),
	code: code.optional(),
	isContainer: z.boolean().optional(),
	conditionNote: text(MAX_NOTE).optional(),
	purchasedOn: dateString
		.nullish()
		.transform((v) => v ?? null)
		.optional(),
	valueCents: z
		.number()
		.int()
		.min(0)
		.max(MAX_VALUE_CENTS)
		.nullish()
		.transform((v) => v ?? null)
		.optional(),
	notes: text(MAX_TEXT).optional(),
	articleId: z.uuid().optional()
});

export const moveInput = z
	.object({ ...placement, note: text(MAX_NOTE) })
	.refine((v) => !(v.locationId && v.containerId), {
		path: ['containerId'],
		message: 'Entweder Lagerort oder Kiste'
	});

/** Mehrere Stücke auf einmal umlagern (Inventur, Kiste packen) */
export const moveManyInput = z
	.object({ unitIds: z.array(z.uuid()).min(1).max(MAX_BATCH_UNITS), ...placement })
	.refine((v) => !(v.locationId && v.containerId), {
		path: ['containerId'],
		message: 'Entweder Lagerort oder Kiste'
	});

export const conditionInput = z.object({
	condition: z.enum(CONDITIONS),
	note: text(MAX_NOTE)
});

export const unitListQuery = z.object({
	search: z.string().trim().max(100).optional(),
	articleId: z.uuid().optional(),
	categoryId: z.uuid().optional(),
	locationId: z.uuid().optional(),
	/** Mit allen Unterorten und dem Inhalt der Kisten dort */
	deep: z.enum(['0', '1']).optional(),
	containerId: z.uuid().optional(),
	containers: z.enum(['0', '1']).optional(),
	condition: z.enum(CONDITIONS).optional(),
	retired: z.enum(['0', '1']).optional(),
	/** Nur Stücke ohne Lagerort und ohne Kiste */
	unplaced: z.enum(['0', '1']).optional(),
	issued: z.enum(['0', '1']).optional(),
	/** Nur im Zeitraum verfügbare Stücke */
	from: dateString.optional(),
	to: dateString.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
	offset: z.coerce.number().int().min(0).default(0)
});

export interface UnitSummary {
	id: string;
	code: string;
	/** Anzeigename: eigene Bezeichnung oder Artikelname */
	name: string;
	label: string;
	articleId: string;
	articleName: string;
	categoryName: string | null;
	categoryColor: string | null;
	isContainer: boolean;
	containerId: string | null;
	containerName: string | null;
	locationId: string | null;
	/** Effektiver Ort (über Kisten aufgelöst) als Pfad */
	locationPath: string;
	condition: Condition;
	retired: boolean;
	setId: string | null;
	setName: string | null;
	/** Gerade ausgegeben für diese Reservierung */
	issued: { reservationId: string; title: string } | null;
}

export interface Movement {
	id: string;
	kind: string;
	label: string;
	quantity: number | null;
	note: string;
	actorName: string;
	createdAt: string;
	reservationId: string | null;
}

export interface StockEntry {
	id: string;
	articleId: string;
	articleName: string;
	unitLabel: string;
	locationId: string | null;
	containerId: string | null;
	/** Ort/Kiste als Text */
	holderName: string;
	quantity: number;
}

export interface ContainerTarget {
	articleId: string;
	articleName: string;
	kind: ArticleKind;
	unitLabel: string;
	target: number;
	actual: number;
}

export interface UnitDetail extends UnitSummary {
	conditionNote: string;
	purchasedOn: string | null;
	valueCents: number | null;
	notes: string;
	createdAt: string;
	/** Nur Kisten: Inhalt */
	contents: { units: UnitSummary[]; stock: StockEntry[]; targets: ContainerTarget[] } | null;
	history: Movement[];
	/** Kommende und laufende Reservierungen dieses Stücks */
	reservations: ReservationRef[];
}

export const targetsInput = z.object({
	targets: z
		.array(z.object({ articleId: z.uuid(), quantity }))
		.max(100)
		.refine((l) => new Set(l.map((t) => t.articleId)).size === l.length, 'Artikel doppelt')
});

// --- Mengenbestand -------------------------------------------------------------

const holder = z
	.object({
		locationId: z
			.uuid()
			.nullish()
			.transform((v) => v ?? null),
		containerId: z
			.uuid()
			.nullish()
			.transform((v) => v ?? null)
	})
	.refine((v) => !!v.locationId !== !!v.containerId, 'Genau ein Lagerort oder eine Kiste');

export const stockSetInput = z.object({
	articleId: z.uuid(),
	holder,
	/** Neuer Bestand an diesem Ort */
	quantity: count,
	note: text(MAX_NOTE)
});

export const stockMoveInput = z.object({
	articleId: z.uuid(),
	from: holder,
	to: holder,
	quantity,
	note: text(MAX_NOTE)
});

export const stockListQuery = z.object({
	articleId: z.uuid().optional(),
	locationId: z.uuid().optional(),
	containerId: z.uuid().optional()
});

// --- Sets ----------------------------------------------------------------------

export const setTemplateInput = z.object({
	name,
	description: text(MAX_TEXT),
	parts: z
		.array(z.object({ articleId: z.uuid(), quantity }))
		.min(1, 'Mindestens ein Teil')
		.max(50)
		.refine((l) => new Set(l.map((p) => p.articleId)).size === l.length, 'Artikel doppelt')
});
export const setTemplateUpdateInput = setTemplateInput.partial();

export interface SetTemplate {
	id: string;
	name: string;
	description: string;
	/** Teile: Einzelstücke (bilden das konkrete Set) und Mengen (kommen beim Reservieren aus dem Lager dazu) */
	parts: {
		articleId: string;
		articleName: string;
		kind: ArticleKind;
		unitLabel: string;
		quantity: number;
	}[];
	setCount: number;
}

export const setInput = z.object({
	templateId: z.uuid(),
	name,
	code: code.nullish().transform((v) => v ?? null),
	notes: text(MAX_TEXT),
	unitIds: z.array(z.uuid()).max(100).default([])
});
export const setUpdateInput = setInput.omit({ templateId: true }).partial().extend({
	code: code.optional()
});

export interface SetCompleteness {
	complete: boolean;
	/** Fehlende Teile (Vorlage − vorhandene nutzbare Stücke) */
	missing: { articleId: string; articleName: string; count: number }[];
	/** Teile, die nicht zur Vorlage passen bzw. zu viel sind */
	extra: { articleId: string; articleName: string; count: number }[];
	/** Stücke, die defekt oder verloren sind */
	unusable: number;
}

export interface MaterialSet {
	id: string;
	code: string;
	name: string;
	templateId: string;
	templateName: string;
	notes: string;
	units: UnitSummary[];
	completeness: SetCompleteness;
	/** Mengen laut Set-Typ, die beim Reservieren aus dem Lager dazukommen */
	bulkParts: { articleId: string; articleName: string; unitLabel: string; quantity: number }[];
	/** Gerade ganz oder teilweise ausgegeben */
	issuedUnits: number;
}

// --- Reservierungen ------------------------------------------------------------

export const reservationLineInput = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unit'), unitId: z.uuid() }),
	z.object({ kind: z.literal('set'), setId: z.uuid() }),
	z.object({ kind: z.literal('article'), articleId: z.uuid(), quantity })
]);
export type ReservationLineInput = z.infer<typeof reservationLineInput>;

const reservationBase = z.object({
	title: name,
	actionId: z
		.uuid()
		.nullish()
		.transform((v) => v ?? null),
	startsOn: dateString,
	endsOn: dateString,
	notes: text(MAX_TEXT),
	lines: z.array(reservationLineInput).max(MAX_RESERVATION_LINES)
});

export const reservationInput = reservationBase.refine((v) => v.endsOn >= v.startsOn, {
	path: ['endsOn'],
	message: 'Ende liegt vor dem Beginn'
});
export const reservationUpdateInput = reservationBase
	.partial()
	.refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, {
		path: ['endsOn'],
		message: 'Ende liegt vor dem Beginn'
	});

export const reservationListQuery = z.object({
	status: z.enum([...RESERVATION_STATUSES, 'open', 'all']).optional(),
	mine: z.enum(['0', '1']).optional(),
	from: dateString.optional(),
	to: dateString.optional(),
	search: z.string().trim().max(100).optional()
});

export const availabilityInput = z.object({
	startsOn: dateString,
	endsOn: dateString,
	excludeReservationId: z.uuid().nullish(),
	lines: z.array(reservationLineInput).max(MAX_RESERVATION_LINES)
});

export const availabilityQuery = z.object({
	from: dateString,
	to: dateString,
	excludeReservationId: z.uuid().optional()
});

export interface ReservationRef {
	id: string;
	title: string;
	startsOn: string;
	endsOn: string;
	status: ReservationStatus;
}

export interface ReservationLine {
	id: string;
	kind: LineKind;
	unitId: string | null;
	setId: string | null;
	articleId: string | null;
	/** Anzeigename (Stück, Set oder Artikel) */
	name: string;
	code: string | null;
	articleKind: ArticleKind | null;
	unitLabel: string;
	/** Menge (Artikel) bzw. 1 (Stück) bzw. Anzahl der Stücke im Set */
	quantity: number;
	/** Menge: ausgegeben / zurück */
	issuedQty: number;
	returnedQty: number;
	/** Stücke, die zu dieser Zeile ausgegeben wurden */
	assignedCount: number;
	/** Automatisch angelegte Mengen-Zeile zu einem reservierten Set (Name des Sets) */
	fromSet: string | null;
}

export interface AssignedUnit {
	unit: UnitSummary;
	lineId: string | null;
	issuedAt: string;
	returnedAt: string | null;
	returnCondition: Condition | null;
	returnNote: string;
}

export interface Reservation extends ReservationRef {
	actionId: string | null;
	actionName: string | null;
	notes: string;
	createdBy: string | null;
	createdByName: string;
	createdAt: string;
	issuedAt: string | null;
	returnedAt: string | null;
	lines: ReservationLine[];
	assigned: AssignedUnit[];
	canEdit: boolean;
	canHandle: boolean;
	/** Rückgabe überfällig (ausgegeben, Ende < heute) */
	overdue: boolean;
}

export interface ReservationListItem extends ReservationRef {
	actionId: string | null;
	actionName: string | null;
	createdByName: string;
	lineCount: number;
	itemSummary: string;
	overdue: boolean;
	mine: boolean;
}

/** Ergebnis der Verfügbarkeitsprüfung je Zeile */
export interface LineAvailability {
	index: number;
	ok: boolean;
	/** Höchstens so viele wären im Zeitraum frei (Artikel/Menge) */
	available: number | null;
	message: string | null;
	/** Hinweise ohne Fehler, z. B. „Set Kohte 3 wird aufgeteilt“ */
	notes: string[];
}

export interface ArticleAvailability {
	articleId: string;
	total: number;
	free: number;
}

// --- Ausgabe und Rückgabe ------------------------------------------------------

export const issueInput = z.object({
	/** Stücke (inkl. Kisten; deren Inhalt wird mitgenommen) */
	unitIds: z.array(z.uuid()).max(500).default([]),
	/** Mengen je Zeile */
	bulk: z
		.array(z.object({ lineId: z.uuid(), quantity: count }))
		.max(200)
		.default([]),
	/** Stücke ohne Reservierungszeile zusätzlich aufnehmen */
	allowExtra: z.boolean().default(false)
});

export const returnInput = z.object({
	units: z
		.array(
			z.object({
				unitId: z.uuid(),
				condition: z.enum(CONDITIONS).default('ok'),
				note: text(MAX_NOTE)
			})
		)
		.max(500)
		.default([]),
	bulk: z
		.array(z.object({ lineId: z.uuid(), quantity: count }))
		.max(200)
		.default([]),
	/** Nicht zurückgebrachte Stücke als verloren markieren und abschließen */
	closeMissingAsLost: z.boolean().default(false)
});

/** Zuteilungsvorschlag für Artikel-Zeilen (Bahnen-Anfrage) */
export interface AllocationSuggestion {
	lineId: string;
	articleId: string;
	needed: number;
	units: UnitSummary[];
	/** Sets, die dafür aufgeteilt würden */
	splitSets: string[];
	missing: number;
}

// --- Codes ---------------------------------------------------------------------

export type CodeTarget =
	| { type: 'unit'; id: string; code: string; name: string }
	| { type: 'set'; id: string; code: string; name: string }
	| { type: 'location'; id: string; code: string; name: string }
	| { type: 'article'; id: string; code: string; name: string }
	| { type: 'reserved'; code: string };

export const reserveCodesInput = z.object({
	count: z.number().int().min(1).max(MAX_RESERVE_CODES)
});

// --- Etiketten -----------------------------------------------------------------

export const labelFormatInput = z.object({ name, format: labelFormatSchema });
export const labelFormatUpdateInput = labelFormatInput.partial();

export interface LabelFormatEntry {
	/** Vorgabe-Schlüssel oder `custom:<id>` */
	key: string;
	id: string | null;
	name: string;
	format: LabelFormat;
	preset: boolean;
}

export const labelTemplateInput = z.object({
	name,
	target: z.enum(LABEL_TARGETS),
	layout: labelLayoutSchema,
	formatKey: z.string().min(1).max(80)
});
export const labelTemplateUpdateInput = labelTemplateInput.partial();

export interface LabelTemplate {
	id: string;
	name: string;
	target: LabelTarget;
	layout: LabelLayout;
	formatKey: string;
	updatedAt: string;
}

export const labelPrintInput = z.object({
	templateId: z.uuid(),
	formatKey: z.string().min(1).max(80).optional(),
	target: z.enum(LABEL_TARGETS),
	ids: z.array(z.uuid()).max(MAX_LABELS).default([]),
	/** Nur `blank`: Codes (vorher über `/codes/reserve` geholt) */
	codes: z.array(z.string().min(1).max(MAX_CODE)).max(MAX_LABELS).default([]),
	/** Je Objekt so viele Etiketten */
	copies: z.number().int().min(1).max(20).default(1),
	startIndex: z.number().int().min(0).max(399).default(0),
	outlines: z.boolean().default(false)
});

// --- Übersicht -----------------------------------------------------------------

export interface Overview {
	articles: number;
	units: number;
	containers: number;
	sets: number;
	locations: number;
	issuedUnits: number;
	overdueReservations: number;
	damagedUnits: number;
	upcomingReservations: number;
	/** Stücke ohne Lagerort und ohne Kiste */
	unplacedUnits: number;
	lowStock: { articleId: string; name: string; total: number; min: number }[];
}

// --- Ausleihen (Katalog) ---------------------------------------------------------

export const catalogQuery = z.object({
	from: dateString,
	to: dateString,
	search: z.string().trim().max(100).optional(),
	categoryId: z.uuid().optional()
});

export interface CatalogArticle {
	id: string;
	code: string;
	name: string;
	kind: ArticleKind;
	unitLabel: string;
	description: string;
	categoryId: string | null;
	categoryName: string | null;
	categoryColor: string | null;
	categoryIcon: string | null;
	thumbUrl: string | null;
	/** Nutzbare Stücke bzw. Gesamtmenge */
	total: number;
	/** Im Zeitraum frei */
	free: number;
	/** Wo es liegt (Pfade, höchstens 3) */
	places: string[];
}

export interface CatalogTemplate {
	id: string;
	name: string;
	description: string;
	parts: {
		articleId: string;
		articleName: string;
		/** Einzelstücke oder Menge (Mengen kommen aus dem Lager dazu) */
		kind?: ArticleKind;
		unitLabel?: string;
		quantity: number;
	}[];
	/** So viele vollständige Exemplare lassen sich im Zeitraum aus freien Teilen zusammenstellen */
	free: number;
	/** Fertige Sets dieses Typs */
	sets: number;
}

export interface Catalog {
	from: string;
	to: string;
	articles: CatalogArticle[];
	templates: CatalogTemplate[];
}

// --- „Wo ist …?“ -----------------------------------------------------------------

export const findQuery = z.object({ q: z.string().trim().min(1).max(100) });

export interface FindHit {
	type: 'unit' | 'container' | 'article' | 'set' | 'location';
	id: string;
	code: string;
	name: string;
	/** Artikel/Set-Typ bzw. Kategorie */
	detail: string;
	/** Lagerort als Pfad (bei Artikeln: die Orte mit Bestand) */
	place: string;
	/** Unterwegs: Titel der Reservierung */
	away: string | null;
	condition: Condition | null;
	/** Menge (Mengenartikel) bzw. Stückzahl */
	quantity: number | null;
}

// --- Bestandsliste (PDF) -----------------------------------------------------------

export const INVENTORY_COLUMNS = [
	{ key: 'code', label: 'Code', default: true },
	{ key: 'name', label: 'Bezeichnung', default: true },
	{ key: 'article', label: 'Artikel', default: true },
	{ key: 'category', label: 'Kategorie', default: false },
	{ key: 'place', label: 'Lagerort', default: true },
	{ key: 'condition', label: 'Zustand', default: true },
	{ key: 'set', label: 'Set', default: false },
	{ key: 'away', label: 'Unterwegs', default: true },
	{ key: 'value', label: 'Wert', default: false },
	{ key: 'check', label: 'Geprüft ☐', default: false }
] as const;
export type InventoryColumn = (typeof INVENTORY_COLUMNS)[number]['key'];

export const inventoryPdfInput = z.object({
	locationId: z.uuid().nullish(),
	categoryId: z.uuid().nullish(),
	articleId: z.uuid().nullish(),
	condition: z.enum(CONDITIONS).nullish(),
	groupBy: z.enum(['place', 'category']).default('place'),
	columns: z
		.array(z.enum(INVENTORY_COLUMNS.map((c) => c.key) as [InventoryColumn, ...InventoryColumn[]]))
		.min(1)
		.max(INVENTORY_COLUMNS.length)
		.optional(),
	/** Mengenartikel als eigener Abschnitt */
	includeBulk: z.boolean().default(true),
	includeRetired: z.boolean().default(false)
});
