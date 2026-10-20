/**
 * API-Vertrag des Moduls `orders` (Bestellungen / Kämmerer*in): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';

export const MODULE_ID = 'orders';
export const BASE_PATH = '/modules/orders';

/** Rolle mit allen Verwaltungsrechten (per `defaultRoleGrants`, im Amt „Kämmerer*in“ verknüpfen) */
export const MANAGER_ROLE_NAME = 'Kämmerer*in';
/** Amts-Vorlage (Modul `offices`) und ihre Benachrichtigungen */
export const OFFICE_KEY = 'kaemmerer';
export const NOTIFY_ORDER_CREATED = 'order-created';
export const NOTIFY_STOCK_DEFICIT = 'stock-deficit';

export const PERMISSIONS = {
	view: 'orders.order.view',
	create: 'orders.order.create',
	manage: 'orders.order.manage',
	articles: 'orders.article.manage',
	stock: 'orders.stock.manage'
} as const;

export const MAX_TITLE = 150;
export const MAX_DESCRIPTION = 5000;
export const MAX_NOTES = 5000;
export const MAX_URL = 1000;
export const MAX_LABEL = 50;
export const MAX_NOTE = 1000;
export const MAX_SUPPLIER = 150;
export const MAX_VARIANTS = 30;
export const MAX_IMAGES_PER_ARTICLE = 20;
export const MAX_ORDER_ITEMS = 50;
export const MAX_QUANTITY = 999;
export const MAX_PRICE_CENTS = 1_000_000_00;
export const MAX_ARTICLES = 500;

/** Bilder: Varianten (vom Server mit `core.images` erzeugt) */
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

/** Lieferantenrechnung (Beleg) */
export const RECEIPT_CONTENT_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp'
] as const;
export const RECEIPT_ACCEPT = RECEIPT_CONTENT_TYPES.join(',');
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** Schlüssel in der Kasse */
export const invoiceSourceKey = (orderId: string) => `order:${orderId}`;
export const invoiceLineRef = (orderId: string, itemId: string) => `order:${orderId}:${itemId}`;
export const payableRef = (supplierOrderId: string) => `order-supplier:${supplierOrderId}`;

/** API-Pfad eines Artikelbilds (für `<img src>`) */
export function imageUrl(articleId: string, imageId: string, variant: ImageVariant): string {
	return `/api/v1${BASE_PATH}/articles/${articleId}/images/${imageId}/${variant}`;
}

export function isRealDate(iso: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
	const d = new Date(`${iso}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// --- Bausteine -----------------------------------------------------------------

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

const optionalUrl = z
	.string()
	.trim()
	.max(MAX_URL, `Höchstens ${MAX_URL} Zeichen`)
	.nullish()
	.transform((v) => (v ? v : null))
	.refine((v) => v === null || /^https?:\/\/\S+$/i.test(v), 'Nur http(s)-Links');

const cents = z
	.number()
	.int('Nur ganze Cent')
	.min(0, 'Nicht negativ')
	.max(MAX_PRICE_CENTS, 'Betrag zu hoch');

const quantity = z
	.number()
	.int('Nur ganze Zahlen')
	.min(1, 'Mindestens 1')
	.max(MAX_QUANTITY, `Höchstens ${MAX_QUANTITY}`);

const count = z.number().int('Nur ganze Zahlen').min(0, 'Nicht negativ').max(100_000, 'Zu groß');

const dateString = z.string().refine(isRealDate, 'Ungültiges Datum');

export const idParams = z.object({ id: z.uuid() });
export const imageParams = z.object({ id: z.uuid(), imageId: z.uuid() });
export const imageVariantParams = imageParams.extend({ variant: z.enum(IMAGE_VARIANTS) });

// --- Artikel -------------------------------------------------------------------

/**
 * Größe/Variante. Ohne Größen hat ein Artikel genau eine Variante mit `label: ''`.
 * `id` fehlt = neu; vorhandene Varianten ohne Eintrag werden archiviert (nie gelöscht, wenn bestellt).
 */
export const variantInput = z.object({
	id: z.uuid().optional(),
	label: z.string().trim().max(MAX_LABEL, `Höchstens ${MAX_LABEL} Zeichen`),
	priceCents: cents,
	reorderUrl: optionalUrl,
	minStock: count.default(0)
});
export type VariantInput = z.input<typeof variantInput>;

const variantList = z
	.array(variantInput)
	.min(1, 'Mindestens ein Preis')
	.max(MAX_VARIANTS, `Höchstens ${MAX_VARIANTS} Größen`)
	.superRefine((list, c) => {
		if (list.length > 1) {
			const seen = new Set<string>();
			list.forEach((v, i) => {
				const key = v.label.toLowerCase();
				if (!key) c.addIssue({ code: 'custom', message: 'Größe angeben', path: [i, 'label'] });
				else if (seen.has(key))
					c.addIssue({ code: 'custom', message: 'Größe doppelt', path: [i, 'label'] });
				seen.add(key);
			});
		}
	});

export const articleInput = z.object({
	title: z.string().trim().min(1, 'Pflichtfeld').max(MAX_TITLE, `Höchstens ${MAX_TITLE} Zeichen`),
	description: optionalText(MAX_DESCRIPTION),
	/** Interne Notizen (nur mit `orders.article.manage`/`orders.stock.manage` sichtbar) */
	notes: optionalText(MAX_NOTES),
	/** Nachbestelllink für den ganzen Artikel (Größen können eigene haben) */
	reorderUrl: optionalUrl,
	/** Im Katalog bestellbar */
	active: z.boolean().default(true),
	variants: variantList
});
export type ArticleInput = z.input<typeof articleInput>;
/** PATCH: nur übergebene Felder; `variants` ersetzt die Liste */
// `active` ohne Standardwert, sonst würde jedes PATCH ohne `active` den Artikel wieder aktivieren
export const articleUpdateInput = articleInput.extend({ active: z.boolean() }).partial();
export type ArticleUpdateInput = z.input<typeof articleUpdateInput>;

export const articleOrderInput = z.object({
	ids: z.array(z.uuid()).max(MAX_ARTICLES)
});
export const imageOrderInput = z.object({
	ids: z.array(z.uuid()).max(MAX_IMAGES_PER_ARTICLE)
});

export const articleListQuery = z.object({
	/** `all` nur mit Artikelrecht (inkl. inaktiver/archivierter) */
	scope: z.enum(['catalog', 'all']).default('catalog')
});

export interface ArticleImage {
	id: string;
	width: number;
	height: number;
	position: number;
	thumbUrl: string;
	webUrl: string;
}

export interface ArticleVariant {
	id: string;
	/** '' = ohne Größe */
	label: string;
	priceCents: number;
	/** Nur für Verwaltung (sonst `null`) */
	reorderUrl: string | null;
	stock: number | null;
	minStock: number | null;
	position: number;
	archived: boolean;
}

export interface Article {
	id: string;
	title: string;
	description: string | null;
	/** Nur für Verwaltung, sonst `null` */
	notes: string | null;
	reorderUrl: string | null;
	active: boolean;
	archived: boolean;
	position: number;
	/** Aktive Varianten nach `position` (Verwaltung: auch archivierte, `archived: true`) */
	variants: ArticleVariant[];
	hasSizes: boolean;
	/** min/max der aktiven Varianten (gleich = Einzelpreis) */
	priceMinCents: number;
	priceMaxCents: number;
	images: ArticleImage[];
	/** Titelbild = erstes Bild */
	cover: ArticleImage | null;
	createdAt: string;
	updatedAt: string;
}

// --- Bestellungen von Mitgliedern ------------------------------------------------

export const orderItemInput = z.object({
	variantId: z.uuid(),
	quantity
});

export const orderCreateInput = z.object({
	memberId: z.string().min(1).max(64),
	items: z
		.array(orderItemInput)
		.min(1, 'Mindestens ein Artikel')
		.max(MAX_ORDER_ITEMS, `Höchstens ${MAX_ORDER_ITEMS} Positionen`)
		.superRefine((list, c) => {
			const seen = new Set<string>();
			list.forEach((it, i) => {
				if (seen.has(it.variantId))
					c.addIssue({ code: 'custom', message: 'Artikel doppelt', path: [i, 'variantId'] });
				seen.add(it.variantId);
			});
		}),
	note: optionalText(MAX_NOTE)
});
export type OrderCreateInput = z.input<typeof orderCreateInput>;

/** Mengen je Position (Storno bzw. Ausgabe); 0 = nichts */
const itemQuantities = z
	.array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(0).max(MAX_QUANTITY) }))
	.min(1, 'Mindestens eine Position')
	.max(MAX_ORDER_ITEMS);

/** POST `/orders/:id/cancel` – ohne `items` = alles Offene stornieren */
export const orderCancelInput = z.object({
	items: itemQuantities.optional(),
	reason: optionalText(MAX_NOTE)
});
export type OrderCancelInput = z.input<typeof orderCancelInput>;

/** POST `/orders/:id/handout` – Ausgabe aus dem Lager (Teilmengen erlaubt) */
export const orderHandoutInput = z.object({ items: itemQuantities });
export type OrderHandoutInput = z.input<typeof orderHandoutInput>;

export const ORDER_STATUSES = ['open', 'partial', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
	open: 'Offen',
	partial: 'Teilweise ausgegeben',
	delivered: 'Ausgegeben',
	cancelled: 'Storniert'
};

export const orderListQuery = z.object({
	/** `all` nur mit `orders.order.manage` */
	scope: z.enum(['mine', 'all']).default('mine'),
	status: z.enum(['active', 'all', ...ORDER_STATUSES]).default('all'),
	search: z.string().trim().max(100).default(''),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export const memberSearchQuery = z.object({ search: z.string().trim().max(100).default('') });

/** Zahlstand aus der Kasse (`null` = Kasse nicht aktiv bzw. noch keine Rechnung) */
export const PAYMENT_STATUSES = ['paid', 'partial', 'open', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
	paid: 'Bezahlt',
	partial: 'Teilweise bezahlt',
	open: 'Offen',
	cancelled: 'Storniert'
};

export interface OrderPayment {
	invoiceId: string;
	invoiceNumber: string;
	status: PaymentStatus;
	dueCents: number;
	paidCents: number;
	openCents: number;
	dueOn: string | null;
	overdue: boolean;
}

export interface OrderItem {
	id: string;
	variantId: string;
	articleId: string | null;
	articleTitle: string;
	variantLabel: string;
	unitPriceCents: number;
	quantity: number;
	deliveredQty: number;
	cancelledQty: number;
	/** quantity − delivered − cancelled */
	openQty: number;
	totalCents: number;
	/** Nur für Verwaltung: aktueller Lagerbestand der Variante */
	stock: number | null;
}

export interface Order {
	id: string;
	number: string;
	member: { id: string; name: string };
	orderedBy: { id: string; name: string } | null;
	note: string | null;
	status: OrderStatus;
	items: OrderItem[];
	/** Summe der nicht stornierten Mengen */
	totalCents: number;
	invoiceNumber: string | null;
	payment: OrderPayment | null;
	/** Darf die*der Aufrufende stornieren (eigene: solange nichts ausgegeben; manage: offene Mengen) */
	canCancel: boolean;
	createdAt: string;
	cancelledAt: string | null;
}

export interface OrderList {
	items: Order[];
	total: number;
}

export interface OrderCreated {
	order: Order;
	/** Rechnung per Mail verschickt */
	mailed: boolean;
	/** Kasse nicht aktiv → Rechnung folgt (Job) */
	invoicePending: boolean;
}

/** Auswahl beim Bestellen */
export interface MemberOption {
	id: string;
	name: string;
}

// --- Lager -----------------------------------------------------------------------

export const stockCorrectionInput = z.object({
	variantId: z.uuid(),
	/** Neuer Bestand (absolut) */
	stock: count,
	note: optionalText(MAX_NOTE)
});
export type StockCorrectionInput = z.input<typeof stockCorrectionInput>;

export const MOVEMENT_KINDS = ['receipt', 'handout', 'correction', 'return'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_KIND_LABELS: Record<MovementKind, string> = {
	receipt: 'Wareneingang',
	handout: 'Ausgabe',
	correction: 'Korrektur',
	return: 'Rücknahme'
};

export const movementListQuery = z.object({
	variantId: z.uuid().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export interface StockRow {
	articleId: string;
	articleTitle: string;
	variantId: string;
	variantLabel: string;
	priceCents: number;
	stock: number;
	minStock: number;
	/** Offene Mengen aus Mitgliedsbestellungen */
	demand: number;
	/** Bestellt beim Lieferanten, noch nicht eingegangen */
	inTransit: number;
	/** max(0, demand + minStock − stock − inTransit) */
	deficit: number;
	/** Variante, sonst Artikel */
	reorderUrl: string | null;
	articleActive: boolean;
}

export interface StockMovement {
	id: string;
	variantId: string;
	articleTitle: string;
	variantLabel: string;
	delta: number;
	kind: MovementKind;
	orderNumber: string | null;
	supplierOrderNumber: string | null;
	note: string | null;
	createdBy: { id: string; name: string } | null;
	createdAt: string;
}

// --- Einkauf (Lieferantenbestellungen) ------------------------------------------

export const supplierItemInput = z.object({
	variantId: z.uuid(),
	quantity,
	unitCostCents: cents.nullish().transform((v) => v ?? null)
});

export const supplierOrderInput = z.object({
	supplier: z
		.string()
		.trim()
		.min(1, 'Pflichtfeld')
		.max(MAX_SUPPLIER, `Höchstens ${MAX_SUPPLIER} Zeichen`),
	orderedOn: dateString,
	note: optionalText(MAX_NOTE),
	items: z
		.array(supplierItemInput)
		.min(1, 'Mindestens ein Artikel')
		.max(MAX_ORDER_ITEMS * 4)
		.superRefine((list, c) => {
			const seen = new Set<string>();
			list.forEach((it, i) => {
				if (seen.has(it.variantId))
					c.addIssue({ code: 'custom', message: 'Artikel doppelt', path: [i, 'variantId'] });
				seen.add(it.variantId);
			});
		})
});
export type SupplierOrderInput = z.input<typeof supplierOrderInput>;
/** PATCH: Kopf jederzeit; `items` nur solange nichts eingegangen ist (sonst 409) */
export const supplierOrderUpdateInput = supplierOrderInput.partial();
export type SupplierOrderUpdateInput = z.input<typeof supplierOrderUpdateInput>;

/** POST `/supplier-orders/:id/receive` – eingegangene Mengen (Teillieferung) */
export const supplierReceiveInput = z.object({
	items: z
		.array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(0).max(MAX_QUANTITY) }))
		.min(1)
		.max(MAX_ORDER_ITEMS * 4),
	note: optionalText(MAX_NOTE)
});
export type SupplierReceiveInput = z.input<typeof supplierReceiveInput>;

/**
 * PUT `/supplier-orders/:id/invoice` – multipart: Textfelder wie unten (`amountCents` als Zahl-String),
 * optional Datei `file` (Beleg). Legt die Auszahlung in der Kasse an bzw. aktualisiert sie.
 */
export const supplierInvoiceInput = z.object({
	amountCents: z.coerce
		.number()
		.int()
		.min(1, 'Der Betrag muss größer als 0 sein')
		.max(MAX_PRICE_CENTS),
	recipientName: z.string().trim().min(1, 'Pflichtfeld').max(150),
	/** fehlt = unverändert, '' = entfernen */
	iban: z.string().trim().max(42).optional(),
	bic: optionalText(11),
	dueOn: dateString.nullish().transform((v) => v ?? null),
	note: optionalText(MAX_NOTE)
});
export type SupplierInvoiceInput = z.input<typeof supplierInvoiceInput>;

export const supplierOrderListQuery = z.object({
	status: z.enum(['active', 'all', 'ordered', 'partial', 'received', 'closed']).default('active')
});

export const SUPPLIER_STATUSES = ['ordered', 'partial', 'received', 'closed'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
	ordered: 'Bestellt',
	partial: 'Teilweise geliefert',
	received: 'Geliefert',
	closed: 'Abgeschlossen'
};

export interface SupplierOrderItem {
	id: string;
	variantId: string;
	articleId: string | null;
	articleTitle: string;
	variantLabel: string;
	quantity: number;
	receivedQty: number;
	cancelledQty: number;
	/** quantity − received − cancelled */
	openQty: number;
	unitCostCents: number | null;
}

export interface SupplierPayment {
	status: PaymentStatus;
	amountCents: number;
	paidCents: number;
}

export interface SupplierOrder {
	id: string;
	number: string;
	supplier: string;
	orderedOn: string;
	note: string | null;
	status: SupplierStatus;
	items: SupplierOrderItem[];
	/** Σ quantity × unitCost (nur Positionen mit Preis) */
	estimatedCents: number;
	invoice: {
		amountCents: number;
		recipientName: string;
		/** in der Kasse angelegt */
		inTreasury: boolean;
		payment: SupplierPayment | null;
	} | null;
	createdBy: { id: string; name: string } | null;
	createdAt: string;
	closedAt: string | null;
}

/** GET `/supplier-orders/suggestion` – Fehlmengen als Vorschlag für eine neue Lieferantenbestellung */
export interface SupplierSuggestion {
	items: {
		variantId: string;
		articleTitle: string;
		variantLabel: string;
		quantity: number;
		reorderUrl: string | null;
	}[];
}

/** Übersicht für die Verwaltung (Kopfzahlen der Tabs) */
export interface OrdersOverview {
	openOrders: number;
	openItems: number;
	deficitVariants: number;
	openSupplierOrders: number;
	unpaidSupplierInvoices: number;
	treasuryActive: boolean;
}
