/**
 * API-Vertrag des Moduls `material` (Materialverwaltung, v2): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 *
 * Begriffe: **Typ** (z. B. „Kohtenbahn“) fasst gleichartige **Lagerartikel** zusammen; ein Artikel
 * („Kohtenbahn K1.1“ oder „Tampen“ × 21) hat eine Anzahl, einen Lagerort, einen Zustand und einen Code.
 * Artikel ohne Typ stehen für sich. Reserviert wird nach Typ + Anzahl oder nach konkretem Artikel.
 */
import { z } from 'zod';
import { isRealDate } from '$lib/sdk/dates';
import { labelFormatSchema, labelLayoutSchema } from '$lib/sdk/labels';
import type { LabelFormat, LabelLayout } from '$lib/sdk/labels';
import { styleColor, styleIcon } from '$lib/sdk/style-presets';
import { normalizeBarcode, type ExpiryState } from './pantry';

export const MODULE_ID = 'material';
export const BASE_PATH = '/modules/material';
/** Pfad für `apiFetch` */
export const API = `${BASE_PATH}`;

/** Rolle mit allen Rechten (per `defaultRoleGrants`, im Amt „Materialwart*in“ verknüpfen) */
export const MANAGER_ROLE_NAME = 'Materialwart*in';
/** Rolle der Gruppenleitungen (aus `members`, automatisch vergeben) */
export const LEADER_ROLE_NAME = 'Gruppenleitung';
/** Amts-Vorlage (Modul `offices`) und ihre Benachrichtigungen */
export const OFFICE_KEY = 'materialwart';
export const NOTIFY_RESERVATION_CREATED = 'reservation-created';
export const NOTIFY_DAMAGE = 'damage-reported';
export const NOTIFY_FOOD_EXPIRING = 'food-expiring';

export const PERMISSIONS = {
	view: 'material.inventory.view',
	manage: 'material.inventory.manage',
	reserve: 'material.reservation.create',
	reservations: 'material.reservation.manage',
	labels: 'material.labels.manage',
	pantry: 'material.pantry.manage'
} as const;

export const MAX_NAME = 150;
export const MAX_UNIT = 20;
export const MAX_TEXT = 5000;
export const MAX_NOTE = 1000;
export const MAX_CODE = 40;
export const MAX_IMAGES = 10;
export const MAX_BATCH_ITEMS = 200;
export const MAX_RESERVATION_LINES = 200;
export const MAX_QUANTITY = 100_000;
export const MAX_LABELS = 2000;
export const MAX_RESERVE_CODES = 500;

/** Bilder (vom Server mit `core.images` erzeugt), an Typen oder Artikeln */
export const IMAGE_VARIANTS = ['thumb', 'web'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];
export const IMAGE_OWNERS = ['types', 'items'] as const;
export type ImageOwner = (typeof IMAGE_OWNERS)[number];
export const IMAGE_CONTENT_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/gif'
] as const;
export const IMAGE_ACCEPT = IMAGE_CONTENT_TYPES.join(',');
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function imageUrl(
	owner: ImageOwner,
	ownerId: string,
	imageId: string,
	variant: ImageVariant
): string {
	return `/api/v1${BASE_PATH}/${owner}/${ownerId}/images/${imageId}/${variant}`;
}

// --- Codes ---------------------------------------------------------------------

/** Präfixe automatisch vergebener Codes: Lagerartikel, Lagerort */
export const CODE_PREFIX = { item: 'M', location: 'L' } as const;
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

export const CONDITIONS = ['ok', 'worn', 'damaged', 'defect', 'lost'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABELS: Record<Condition, string> = {
	ok: 'In Ordnung',
	worn: 'Gebraucht',
	damaged: 'Beschädigt',
	defect: 'Defekt',
	lost: 'Verloren'
};
/** Zustände, in denen ein Artikel nicht reserviert werden kann */
export const UNUSABLE_CONDITIONS: readonly Condition[] = ['defect', 'lost'];
export const isUsableCondition = (c: Condition) => !UNUSABLE_CONDITIONS.includes(c);

export const RESERVATION_STATUSES = ['reserved', 'cancelled'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Anzeige-Zustand: „vergangen“ ergibt sich aus dem Ende */
export type ReservationState = 'upcoming' | 'running' | 'past' | 'cancelled';
export const RESERVATION_STATE_LABELS: Record<ReservationState, string> = {
	upcoming: 'Reserviert',
	running: 'Läuft',
	past: 'Vergangen',
	cancelled: 'Storniert'
};

export function reservationState(
	r: { status: ReservationStatus; startsOn: string; endsOn: string },
	today: string
): ReservationState {
	if (r.status === 'cancelled') return 'cancelled';
	if (r.endsOn < today) return 'past';
	if (r.startsOn <= today) return 'running';
	return 'upcoming';
}

export const PURPOSES = ['action', 'group', 'other'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_LABELS: Record<Purpose, string> = {
	action: 'Aktion',
	group: 'Gruppe',
	other: 'Sonstiges'
};

export const LABEL_TARGETS = ['item', 'location', 'blank'] as const;
export type LabelTarget = (typeof LABEL_TARGETS)[number];
export const LABEL_TARGET_LABELS: Record<LabelTarget, string> = {
	item: 'Lagerartikel',
	location: 'Lagerorte',
	blank: 'Leere Codes (vorab drucken)'
};

const URL_SAMPLE = 'https://intern.example.org/modules/material/scan/';
const ORG_FIELD = { key: 'org', label: 'Stammesname', sample: 'Stamm Edelweißpiraten' };

/** Felder (Platzhalter) je Etikett-Ziel mit Beispielwerten für den Designer */
export const LABEL_FIELDS: Record<LabelTarget, { key: string; label: string; sample: string }[]> = {
	item: [
		{ key: 'name', label: 'Bezeichnung', sample: 'Kohtenbahn K1.1' },
		{ key: 'type', label: 'Typ', sample: 'Kohtenbahn' },
		{ key: 'code', label: 'Code', sample: 'M-000123' },
		{ key: 'url', label: 'Scan-Link (für QR)', sample: `${URL_SAMPLE}M-000123` },
		{ key: 'category', label: 'Kategorie', sample: 'Zelte' },
		{ key: 'location', label: 'Lagerort', sample: 'Kiste 1' },
		{ key: 'set', label: 'Set', sample: 'KJ1' },
		{ key: 'quantity', label: 'Anzahl', sample: '21' },
		ORG_FIELD
	],
	location: [
		{ key: 'name', label: 'Name', sample: 'Kiste 1' },
		{ key: 'description', label: 'Beschreibung', sample: 'Küchenmaterial' },
		{ key: 'code', label: 'Code', sample: 'L-000002' },
		{ key: 'url', label: 'Scan-Link (für QR)', sample: `${URL_SAMPLE}L-000002` },
		{ key: 'count', label: 'Anzahl Artikel', sample: '12' },
		ORG_FIELD
	],
	blank: [
		{ key: 'code', label: 'Code', sample: 'M-000200' },
		{ key: 'url', label: 'Scan-Link (für QR)', sample: `${URL_SAMPLE}M-000200` },
		ORG_FIELD
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
/** Bestand eines Artikels: 0 nur bei Verbrauchsmaterial (prüft der Server) */
const stockQuantity = z
	.number()
	.int('Nur ganze Zahlen')
	.min(0, 'Nicht negativ')
	.max(MAX_QUANTITY, 'Zu groß');
const unit = z
	.string()
	.trim()
	.max(MAX_UNIT, `Höchstens ${MAX_UNIT} Zeichen`)
	.nullish()
	.transform((v) => v ?? '');

/** „20 l“, „12“ (ohne Einheit = Stück) */
export function formatAmount(n: number, unitName: string): string {
	return unitName ? `${n} ${unitName}` : String(n);
}
const dateString = z.string().refine(isRealDate, 'Ungültiges Datum');
const optionalId = z
	.uuid()
	.nullish()
	.transform((v) => v ?? null);
const code = z
	.string()
	.trim()
	.min(1, 'Pflichtfeld')
	.max(MAX_CODE, `Höchstens ${MAX_CODE} Zeichen`)
	.transform(normalizeCode)
	.refine((v) => /^[A-Z0-9][A-Z0-9._/-]*$/.test(v), 'Nur Buchstaben, Ziffern und - . _ /');

export const idParams = z.object({ id: z.uuid() });
export const codeParams = z.object({ code: z.string().min(1).max(200) });
export const actionParams = z.object({ actionId: z.uuid() });
export const imageParams = z.object({
	owner: z.enum(IMAGE_OWNERS),
	id: z.uuid(),
	imageId: z.uuid()
});
export const imageOwnerParams = z.object({ owner: z.enum(IMAGE_OWNERS), id: z.uuid() });
export const imageVariantParams = imageParams.extend({ variant: z.enum(IMAGE_VARIANTS) });
export const imageOrderInput = z.object({ ids: z.array(z.uuid()).max(MAX_IMAGES) });

export interface ImageRef {
	id: string;
	thumbUrl: string;
	webUrl: string;
	width: number;
	height: number;
}

// --- Lagerorte (flach) ---------------------------------------------------------

export const locationInput = z.object({ name, description: text(MAX_TEXT) });
export const locationUpdateInput = locationInput.partial();
export const orderInput = z.object({ ids: z.array(z.uuid()).max(1000) });

export interface Location {
	id: string;
	name: string;
	description: string;
	code: string;
	position: number;
	/** Artikel an diesem Ort (ohne archivierte) */
	itemCount: number;
}

// --- Kategorien ----------------------------------------------------------------

export const categoryInput = z.object({
	name,
	icon: styleIcon.nullish().transform((v) => v ?? null),
	color: styleColor.nullish().transform((v) => v ?? null)
});
export const categoryUpdateInput = categoryInput.partial();

export interface CategoryRef {
	id: string;
	name: string;
	icon: string | null;
	color: string | null;
}

export interface Category extends CategoryRef {
	position: number;
	/** Typen + Artikel ohne Typ in dieser Kategorie */
	count: number;
}

// --- Typen ---------------------------------------------------------------------

export const typeInput = z.object({
	name,
	description: text(MAX_TEXT),
	notes: text(MAX_TEXT),
	categoryId: optionalId,
	/** Verbrauchsmaterial (Fackeln, Petroleum): bei der Rücknahme wird der Verbrauch abgezogen */
	consumable: z.boolean().default(false),
	unit
});
export const typeUpdateInput = typeInput.partial().extend({
	// ohne Standardwert: fehlt das Feld, bleibt es unverändert
	consumable: z.boolean().optional(),
	archived: z.boolean().optional()
});

export interface MaterialType {
	id: string;
	name: string;
	description: string;
	notes: string;
	consumable: boolean;
	/** Leer = Stück */
	unit: string;
	categoryId: string | null;
	category: CategoryRef | null;
	images: ImageRef[];
	archived: boolean;
	/** Artikel des Typs (ohne archivierte) */
	itemCount: number;
	/** Summe der Anzahlen / davon nutzbar (nicht defekt/verloren) */
	totalQuantity: number;
	usableQuantity: number;
}

// --- Lagerartikel --------------------------------------------------------------

export const itemInput = z
	.object({
		typeId: optionalId,
		name,
		/** Nur ohne Typ; mit Typ gilt dessen Kategorie */
		categoryId: optionalId,
		quantity: stockQuantity.default(1),
		/** Nur ohne Typ; mit Typ gelten dessen Angaben */
		consumable: z.boolean().default(false),
		unit,
		locationId: optionalId,
		/** Set, zu dem der Artikel gehört (z. B. „KJ1“) */
		setId: optionalId,
		/** Eigener Code (z. B. vorab gedrucktes Etikett); leer = automatisch */
		code: code.nullish().transform((v) => v ?? null),
		condition: z.enum(CONDITIONS).default('ok'),
		conditionNote: text(MAX_NOTE),
		notes: text(MAX_TEXT),
		/** Mehrere Artikel auf einmal: Name + fortlaufende Nummer („K1.“ → „K1.1“, „K1.2“ …) */
		count: z.number().int().min(1).max(MAX_BATCH_ITEMS).default(1),
		numberFrom: z.number().int().min(0).max(99_999).default(1)
	})
	.refine((v) => !(v.code && v.count > 1), {
		path: ['code'],
		message: 'Eigener Code nur für einen einzelnen Artikel'
	});

/** Namen beim Mehrfach-Anlegen */
export function batchNames(base: string, count: number, from: number): string[] {
	if (count <= 1) return [base];
	return Array.from({ length: count }, (_, i) => `${base}${from + i}`);
}

export const itemUpdateInput = z.object({
	typeId: optionalId.optional(),
	name: name.optional(),
	categoryId: optionalId.optional(),
	quantity: stockQuantity.optional(),
	consumable: z.boolean().optional(),
	unit: unit.optional(),
	locationId: optionalId.optional(),
	setId: optionalId.optional(),
	code: code.optional(),
	condition: z.enum(CONDITIONS).optional(),
	conditionNote: text(MAX_NOTE).optional(),
	notes: text(MAX_TEXT).optional(),
	archived: z.boolean().optional()
});

/** Mehrere Artikel umlagern (`locationId: null` = ohne Ort) */
export const moveItemsInput = z.object({
	itemIds: z.array(z.uuid()).min(1).max(MAX_BATCH_ITEMS),
	locationId: optionalId
});

/** Zustand/Schaden melden (auch mit Reservierungsrecht) */
export const conditionInput = z.object({
	condition: z.enum(CONDITIONS),
	note: text(MAX_NOTE)
});

export interface Item {
	id: string;
	name: string;
	code: string;
	typeId: string | null;
	typeName: string | null;
	/** Wirksame Kategorie (vom Typ bzw. eigene) */
	categoryId: string | null;
	category: CategoryRef | null;
	quantity: number;
	/** Wirksam (vom Typ bzw. eigene) */
	consumable: boolean;
	unit: string;
	locationId: string | null;
	locationName: string | null;
	setId: string | null;
	setName: string | null;
	condition: Condition;
	conditionNote: string;
	conditionReportedAt: string | null;
	notes: string;
	archived: boolean;
	/** Eigene Bilder; ohne eigene das Titelbild des Typs als `thumbUrl` */
	images: ImageRef[];
	thumbUrl: string | null;
	createdAt: string;
}

/** Verbrauch bei einer Rücknahme */
export interface ConsumptionEntry {
	reservationId: string | null;
	reservationTitle: string;
	quantity: number;
	recordedAt: string;
}

export interface ItemDetail extends Item {
	conditionReportedByName: string | null;
	/** Laufende und kommende Reservierungen, die diesen Artikel (oder seinen Typ) betreffen */
	reservations: (ReservationRef & { quantity: number; viaType: boolean })[];
	/** Nur Verbrauchsmaterial: letzte Verbräuche */
	consumptions: ConsumptionEntry[];
}

export interface TypeDetail extends MaterialType {
	items: Item[];
}

export const inventoryQuery = z.object({
	search: z.string().trim().max(100).optional(),
	categoryId: z.uuid().optional(),
	/** UUID oder `none` (ohne Ort) */
	locationId: z.union([z.uuid(), z.literal('none')]).optional(),
	condition: z.enum(CONDITIONS).optional(),
	/** UUID oder `none` (ohne Set) */
	setId: z.union([z.uuid(), z.literal('none')]).optional(),
	archived: z.enum(['0', '1']).optional()
});

// --- Sets ----------------------------------------------------------------------

/** Ein Set fasst zusammengehörige Artikel zusammen (z. B. „KJ1“ = Kohtenbahnen KJ1.1–KJ1.6) */
export const setInput = z.object({ name, notes: text(MAX_TEXT) });
export const setUpdateInput = setInput.partial();
export const setItemsInput = z.object({ itemIds: z.array(z.uuid()).max(MAX_BATCH_ITEMS) });

export interface SetMember {
	id: string;
	name: string;
	code: string;
	typeId: string | null;
	typeName: string | null;
	quantity: number;
	condition: Condition;
	usable: boolean;
	locationName: string | null;
}

export interface MaterialSet {
	id: string;
	name: string;
	notes: string;
	position: number;
	items: SetMember[];
	/** Einheiten gesamt / davon nutzbar */
	total: number;
	usable: number;
	complete: boolean;
	/** Nächste laufende oder kommende Reservierung, der Artikel des Sets zugeteilt sind */
	nextUse: ReservationRef | null;
}

// --- Zelte (Bauplan) -----------------------------------------------------------

export const MAX_TENT_PARTS = 30;
export const MAX_PART_LABEL = 60;

const partLabel = z
	.string()
	.trim()
	.max(MAX_PART_LABEL, `Höchstens ${MAX_PART_LABEL} Zeichen`)
	.nullish()
	.transform((v) => v ?? '');

export const tentPartInput = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('type'),
		typeId: z.uuid(),
		label: partLabel,
		quantity,
		/** Je Zelt möglichst alle Einheiten aus einem Set (z. B. Dach aus KJ1) */
		fromOneSet: z.boolean().default(false)
	}),
	z.object({ kind: z.literal('item'), itemId: z.uuid(), label: partLabel, quantity })
]);
export type TentPartInput = z.input<typeof tentPartInput>;

export const tentInput = z.object({
	name,
	description: text(MAX_TEXT),
	categoryId: optionalId,
	parts: z.array(tentPartInput).min(1, 'Mindestens ein Teil').max(MAX_TENT_PARTS)
});
export const tentUpdateInput = tentInput.partial().extend({ archived: z.boolean().optional() });

export interface TentPart {
	id: string;
	kind: 'type' | 'item';
	typeId: string | null;
	itemId: string | null;
	/** Typ- bzw. Artikelname */
	name: string;
	label: string;
	quantity: number;
	fromOneSet: boolean;
}

export interface Tent {
	id: string;
	name: string;
	description: string;
	categoryId: string | null;
	category: CategoryRef | null;
	archived: boolean;
	parts: TentPart[];
	/** Bild des ersten Teils mit Bild */
	thumbUrl: string | null;
	/** In Reservierungen verwendet (dann nur archivieren) */
	used: boolean;
}

/** Große Lagertabelle: Typen mit ihren Artikeln, dazu Artikel ohne Typ */
export interface Inventory {
	types: (MaterialType & { items: Item[] })[];
	items: Item[];
}

// --- Katalog (Reservieren) -----------------------------------------------------

export const catalogQuery = z
	.object({
		from: dateString,
		to: dateString,
		/** Beim Bearbeiten: eigene Reservierung nicht mitzählen */
		excludeReservationId: z.uuid().optional()
	})
	.refine((v) => v.to >= v.from, { path: ['to'], message: 'Ende liegt vor dem Beginn' });

export interface CatalogItem {
	id: string;
	name: string;
	code: string;
	quantity: number;
	/** Im Zeitraum frei (0 bei defekt/verloren) */
	free: number;
	locationName: string | null;
	condition: Condition;
	/** Eigenes Bild bzw. Titelbild des Typs */
	thumbUrl: string | null;
	setId: string | null;
	setName: string | null;
}

/** Set innerhalb eines Typs im Katalog („ganzes Set KJ1 wählen“) */
export interface CatalogSet {
	id: string;
	name: string;
	/** Nutzbare Artikel dieses Typs im Set */
	itemIds: string[];
	/** Einheiten des Typs im Set */
	size: number;
	/** Alle Einheiten im Zeitraum frei */
	wholeFree: boolean;
}

export interface CatalogEntry {
	/** `type` = Typ mit Artikeln, `item` = Artikel ohne Typ, `tent` = Zelt (Bauplan) */
	kind: 'type' | 'item' | 'tent';
	id: string;
	name: string;
	description: string;
	category: CategoryRef | null;
	images: ImageRef[];
	thumbUrl: string | null;
	/** Nutzbare Gesamtanzahl / im Zeitraum frei */
	total: number;
	free: number;
	/** Verbrauchsmaterial (Typ oder Artikel) und Einheit */
	consumable: boolean;
	unit: string;
	/** Nur `type`: die Artikel zum gezielten Auswählen */
	items: CatalogItem[];
	/** Nur `item`: Code und Ort */
	code: string | null;
	locationName: string | null;
	/** Nur `type`: Sets mit Artikeln dieses Typs */
	sets: CatalogSet[];
	/** Nur `tent`: Bestandteile je Zelt */
	parts: { label: string; name: string; quantity: number; fromOneSet: boolean }[];
}

export interface Catalog {
	from: string;
	to: string;
	entries: CatalogEntry[];
}

// --- Reservierungen ------------------------------------------------------------

export const reservationLineInput = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('type'), typeId: z.uuid(), quantity }),
	z.object({ kind: z.literal('item'), itemId: z.uuid(), quantity }),
	z.object({ kind: z.literal('tent'), tentId: z.uuid(), quantity })
]);
export type ReservationLineInput = z.infer<typeof reservationLineInput>;

export const reservationInput = z
	.object({
		title: name,
		purpose: z.enum(PURPOSES).default('other'),
		actionId: optionalId,
		groupId: optionalId,
		startsOn: dateString,
		endsOn: dateString,
		notes: text(MAX_TEXT),
		lines: z.array(reservationLineInput).min(1, 'Mindestens ein Artikel').max(MAX_RESERVATION_LINES)
	})
	.refine((v) => v.endsOn >= v.startsOn, { path: ['endsOn'], message: 'Ende liegt vor dem Beginn' })
	.refine((v) => v.purpose !== 'action' || !!v.actionId, {
		path: ['actionId'],
		message: 'Bitte eine Aktion wählen'
	})
	.refine((v) => v.purpose !== 'group' || !!v.groupId, {
		path: ['groupId'],
		message: 'Bitte eine Gruppe wählen'
	})
	.transform((v) => ({
		...v,
		actionId: v.purpose === 'action' ? v.actionId : null,
		groupId: v.purpose === 'group' ? v.groupId : null
	}));
export type ReservationInput = z.input<typeof reservationInput>;

export const reservationListQuery = z.object({
	/** `all` nur mit `material.reservation.manage` */
	scope: z.enum(['mine', 'all']).default('mine'),
	state: z.enum(['open', 'past', 'cancelled', 'all']).default('open'),
	purpose: z.enum(PURPOSES).optional(),
	from: dateString.optional(),
	to: dateString.optional(),
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export const availabilityInput = z.object({
	startsOn: dateString,
	endsOn: dateString,
	excludeReservationId: z.uuid().nullish(),
	lines: z.array(reservationLineInput).max(MAX_RESERVATION_LINES)
});

export interface ReservationRef {
	id: string;
	title: string;
	startsOn: string;
	endsOn: string;
	status: ReservationStatus;
}

export const lineParams = z.object({ id: z.uuid(), lineId: z.uuid() });

/** Zuteilung einer Typ-Zeile von Hand festlegen (angeheftet; den Rest teilt das System zu) */
export const assignmentInput = z.object({
	items: z.array(z.object({ itemId: z.uuid(), quantity })).max(MAX_RESERVATION_LINES)
});

/** Konkreter Artikel einer Typ-Zeile */
export interface LineAssignment {
	itemId: string;
	name: string;
	code: string;
	setId: string | null;
	setName: string | null;
	locationName: string | null;
	quantity: number;
	/** Von Hand festgelegt (wird nicht umgeplant) */
	pinned: boolean;
	/** Nummer des Zelts (bei Zelt-Teilen) */
	slot: number;
}

export interface ReservationLine {
	id: string;
	kind: 'type' | 'item' | 'tent';
	typeId: string | null;
	itemId: string | null;
	tentId: string | null;
	/** Typ-, Artikel- bzw. Zeltname */
	name: string;
	/** Bezeichnung des Zelt-Teils („Dach“) */
	label: string;
	/** Nur Artikel */
	code: string | null;
	locationName: string | null;
	quantity: number;
	/** Typ- bzw. Artikel-Zeilen: Verbrauchsmaterial und Einheit */
	consumable: boolean;
	unit: string;
	thumbUrl: string | null;
	/** Nur Typ-Zeilen: zugeteilte Artikel */
	assignments: LineAssignment[];
	/** Nur Typ-Zeilen: noch nicht zugeteilt */
	missing: number;
	/** Nur Zelt-Teile mit „aus einem Set“: Einheiten je Zelt und Zelte ohne einheitliches Set */
	slotSize: number | null;
	mixedSlots: number;
	/** Nur Zelt-Zeilen: die Teile */
	parts: ReservationLine[];
}

export interface Reservation extends ReservationRef {
	state: ReservationState;
	purpose: Purpose;
	actionId: string | null;
	actionName: string | null;
	groupId: string | null;
	groupName: string | null;
	notes: string;
	createdBy: string | null;
	createdByName: string;
	createdAt: string;
	lines: ReservationLine[];
	canEdit: boolean;
	handedOutAt: string | null;
	handedOutByName: string | null;
	/** Rücknahme (mit eingetragenem Verbrauch) */
	returnedAt: string | null;
	returnedByName: string | null;
	/** Ausgabe markieren/zurücknehmen und Zuteilung ändern (Verwaltung) */
	canHandOut: boolean;
	/** Hinweise zur Zuteilung („Jurte: 1 von 2 aus Bahnen verschiedener Sets“, „2 nicht zugeteilt“) */
	notices: string[];
	/** Ausgegebenes Verbrauchsmaterial je Artikel (zugeteilt oder gezielt) mit Verbrauch nach der Rücknahme */
	consumables: ConsumableUse[];
}

export interface ConsumableUse {
	itemId: string;
	name: string;
	code: string;
	unit: string;
	/** Ausgegeben bzw. reserviert */
	issued: number;
	/** Verbraucht (erst nach der Rücknahme, sonst `null`) */
	consumed: number | null;
}

/** Rücknahme: Verbrauch je Verbrauchsartikel (fehlende = nichts verbraucht) */
export const returnInput = z.object({
	consumed: z
		.array(
			z.object({
				itemId: z.uuid(),
				quantity: z.number().int('Nur ganze Zahlen').min(0).max(MAX_QUANTITY)
			})
		)
		.max(MAX_RESERVATION_LINES)
		.default([])
});

export interface ReservationListItem extends ReservationRef {
	state: ReservationState;
	purpose: Purpose;
	actionId: string | null;
	actionName: string | null;
	groupId: string | null;
	groupName: string | null;
	createdByName: string;
	lineCount: number;
	/** „2 × Kohtenbahn, Kochkiste 1 …“ */
	itemSummary: string;
	mine: boolean;
	canEdit: boolean;
	handedOut: boolean;
	returned: boolean;
}

export interface ReservationPage {
	items: ReservationListItem[];
	total: number;
}

/** Ergebnis der Verfügbarkeitsprüfung je Zeile */
export interface LineAvailability {
	index: number;
	ok: boolean;
	/** Höchstens so viele wären im Zeitraum frei */
	available: number;
	message: string | null;
	/** Voraussichtliche Zuteilung („aus Set KJ1“, „gemischt aus KJ1 + KJ3“) */
	note: string | null;
}

/** Auswahl für den Zweck */
export interface PurposeOptions {
	actions: { id: string; name: string; startsOn: string; endsOn: string | null }[];
	groups: { id: string; name: string; color: string | null }[];
	actionsActive: boolean;
	groupsActive: boolean;
}

// --- Codes ---------------------------------------------------------------------

export type CodeTarget =
	| { type: 'item'; id: string; code: string; name: string }
	| { type: 'location'; id: string; code: string; name: string }
	| { type: 'food'; id: string; code: string; name: string }
	| { type: 'reserved'; code: string };

export const reserveCodesInput = z.object({
	count: z.number().int().min(1).max(MAX_RESERVE_CODES)
});

// --- Vorrat (Lebensmittel) -----------------------------------------------------

const barcodeField = z
	.string()
	.trim()
	.nullish()
	.transform((v, ctx) => {
		if (!v) return null;
		const code = normalizeBarcode(v);
		if (!code) {
			ctx.addIssue({ code: 'custom', message: 'Kein gültiger Strichcode (EAN/GTIN)' });
			return z.NEVER;
		}
		return code;
	});
const optionalDate = dateString.nullish().transform((v) => v ?? null);

export const productInput = z.object({
	name,
	brand: text(MAX_NAME),
	barcode: barcodeField,
	/** „Packung“, „Dose“, „kg“ – leer = Stück */
	unit,
	/** Füllmenge laut Packung („500 g“) */
	packageSize: text(MAX_NAME),
	locationId: optionalId,
	notes: text(MAX_TEXT)
});
export const productUpdateInput = productInput
	.partial()
	.extend({ archived: z.boolean().optional() });

export const checkInInput = z.object({
	quantity,
	bestBefore: optionalDate,
	/** Leer = Lagerort des Produkts */
	locationId: optionalId,
	note: text(MAX_NOTE)
});

export const CHECK_OUT_KINDS = ['out', 'discard'] as const;
export const checkOutInput = z.object({
	quantity,
	/** Nur aus dieser Charge; sonst zuerst ablaufende zuerst */
	batchId: optionalId,
	kind: z.enum(CHECK_OUT_KINDS).default('out'),
	note: text(MAX_NOTE)
});

/** Charge berichtigen (Zählfehler, falsches MHD) */
export const batchUpdateInput = z.object({
	quantity: stockQuantity.optional(),
	bestBefore: optionalDate.optional(),
	note: text(MAX_NOTE)
});

export const pantryQuery = z.object({
	search: z.string().trim().max(100).optional(),
	/** `stock` = mit Bestand, `soon` = läuft bald ab (inkl. abgelaufen), `expired` = abgelaufen */
	filter: z.enum(['all', 'stock', 'soon', 'expired']).default('all'),
	archived: z.enum(['0', '1']).optional()
});

export const barcodeParams = z.object({ code: z.string().min(1).max(40) });
export const batchParams = z.object({ id: z.uuid(), batchId: z.uuid() });

export const MOVEMENT_KINDS = ['in', 'out', 'discard', 'correct'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_LABELS: Record<MovementKind, string> = {
	in: 'Eingelagert',
	out: 'Entnommen',
	discard: 'Entsorgt',
	correct: 'Berichtigt'
};

export interface FoodBatch {
	id: string;
	quantity: number;
	bestBefore: string | null;
	state: ExpiryState;
	locationId: string | null;
	locationName: string | null;
	createdAt: string;
}

export interface FoodProduct {
	id: string;
	name: string;
	brand: string;
	barcode: string | null;
	unit: string;
	packageSize: string;
	locationId: string | null;
	locationName: string | null;
	notes: string;
	archived: boolean;
	/** Bestand über alle Chargen */
	quantity: number;
	/** Frühestes MHD mit Bestand und dessen Zustand */
	nextBestBefore: string | null;
	state: ExpiryState;
	/** Chargen mit Bestand (zuerst ablaufende zuerst) */
	batches: FoodBatch[];
}

export interface FoodMovement {
	id: string;
	kind: MovementKind;
	quantity: number;
	bestBefore: string | null;
	note: string;
	createdByName: string | null;
	createdAt: string;
}

export interface ProductDetail extends FoodProduct {
	movements: FoodMovement[];
}

/** Vorschlag aus Open Food Facts für einen unbekannten Barcode */
export interface BarcodeSuggestion {
	found: boolean;
	name: string;
	brand: string;
	packageSize: string;
}

/** Ergebnis eines Scans im Vorrat */
export interface BarcodeResult {
	barcode: string;
	product: FoodProduct | null;
	/** Nur ohne bekanntes Produkt */
	suggestion: BarcodeSuggestion | null;
}

export interface PantrySummary {
	products: number;
	soon: number;
	expired: number;
}

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
	types: number;
	items: number;
	locations: number;
	/** Artikel mit Zustand beschädigt/defekt/verloren */
	damaged: { id: string; name: string; code: string; condition: Condition }[];
	damagedCount: number;
	/** Reservierungen, die in den nächsten 14 Tagen beginnen oder gerade laufen */
	upcoming: ReservationListItem[];
	upcomingCount: number;
}

// --- Exporte -------------------------------------------------------------------

export const EXPORT_FORMATS = ['pdf', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const INVENTORY_COLUMNS = [
	{ key: 'code', label: 'Code', default: true },
	{ key: 'name', label: 'Bezeichnung', default: true },
	{ key: 'type', label: 'Typ', default: true },
	{ key: 'category', label: 'Kategorie', default: false },
	{ key: 'location', label: 'Lagerort', default: false },
	{ key: 'set', label: 'Set', default: false },
	{ key: 'quantity', label: 'Anzahl', default: true },
	{ key: 'condition', label: 'Zustand', default: true },
	{ key: 'notes', label: 'Notizen', default: false },
	{ key: 'check', label: 'Geprüft', default: false }
] as const;
export type InventoryColumn = (typeof INVENTORY_COLUMNS)[number]['key'];

export const inventoryExportInput = z.object({
	format: z.enum(EXPORT_FORMATS).default('pdf'),
	groupBy: z.enum(['category', 'location']).default('category'),
	categoryId: z.uuid().nullish(),
	locationId: z.union([z.uuid(), z.literal('none')]).nullish(),
	condition: z.enum(CONDITIONS).nullish(),
	columns: z
		.array(z.enum(INVENTORY_COLUMNS.map((c) => c.key) as [InventoryColumn, ...InventoryColumn[]]))
		.min(1)
		.max(INVENTORY_COLUMNS.length)
		.optional(),
	includeArchived: z.boolean().default(false)
});

export const formatQuery = z.object({ format: z.enum(EXPORT_FORMATS).default('pdf') });

export const reservationsExportInput = z
	.object({
		format: z.enum(EXPORT_FORMATS).default('pdf'),
		from: dateString,
		to: dateString,
		purpose: z.enum(PURPOSES).nullish(),
		includeCancelled: z.boolean().default(false),
		/** Je Reservierung die Positionen mit ausgeben */
		withLines: z.boolean().default(true)
	})
	.refine((v) => v.to >= v.from, { path: ['to'], message: 'Ende liegt vor dem Beginn' });
