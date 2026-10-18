/**
 * API-Vertrag des Moduls `events` (Termine): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';
import { PRINCIPAL_TYPES, type PrincipalType } from '$lib/sdk/types/sharing';
import { daysBetween, minGapDays } from './recurrence';

export const MODULE_ID = 'events';

/** Gruppen-ID für „ganzer Stamm“ in der Gruppen-Zuordnung (`event_groups.group_id`) */
export const STAMM_GROUP_ID = 'stamm';
export const DEFAULT_STAMM_NAME = 'Stamm Edelweißpiraten';
export const STAMM_NAME_SETTING = 'events.stamm.name';

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_LEVEL_LABELS: Record<ShareLevel, string> = { read: 'Sehen', edit: 'Bearbeiten' };

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_GROUPS = 50;
export const MAX_SHARES = 200;

export const COLOR_PRESETS = [
	'#2563eb',
	'#16a34a',
	'#dc2626',
	'#d97706',
	'#9333ea',
	'#0891b2',
	'#db2777',
	'#4b5563'
] as const;

/** Echtes Kalenderdatum `JJJJ-MM-TT` */
export function isRealDate(iso: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === iso;
}

/** Tag normalisieren: trimmen, Mehrfach-Leerzeichen zusammenfassen; leer → `''` */
export function normalizeTag(tag: string): string {
	return tag.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Tags normalisieren und (ohne Groß-/Kleinschreibung) deduplizieren, Reihenfolge bleibt */
export function normalizeTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const t = normalizeTag(raw);
		const k = t.toLocaleLowerCase('de-DE');
		if (!t || seen.has(k)) continue;
		seen.add(k);
		out.push(t);
	}
	return out;
}

const text = (max: number) =>
	z.string().trim().min(1, 'Pflichtfeld').max(max, `Höchstens ${max} Zeichen`);

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

export const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Format JJJJ-MM-TT')
	.refine(isRealDate, 'Kein gültiges Datum');
const time = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format HH:MM')
	.nullish()
	.transform((v) => (v ? v : null));
const optionalDate = dateSchema.nullish().transform((v) => (v ? v : null));

const color = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb')
	.nullish()
	.transform((v) => (v ? v.toLowerCase() : null));

const tag = z
	.string()
	.transform(normalizeTag)
	.pipe(z.string().min(1, 'Leerer Tag').max(MAX_TAG_LENGTH, `Höchstens ${MAX_TAG_LENGTH} Zeichen`));

const refId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9*_-]+$/, 'Ungültige ID');

export const shareInput = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: refId,
		level: z.enum(SHARE_LEVELS)
	})
	.strict();
export type ShareInput = z.infer<typeof shareInput>;

export interface EventDates {
	startsOn: string;
	startsTime: string | null;
	endsOn: string | null;
	endsTime: string | null;
}

/** Regeln für Start/Ende (gleich wie bei Aktionen) */
export function checkEventDates(a: EventDates, ctx: z.RefinementCtx): void {
	if (a.endsOn && a.endsOn < a.startsOn) {
		ctx.addIssue({
			code: 'custom',
			path: ['endsOn'],
			message: 'Das Enddatum liegt vor dem Startdatum'
		});
	}
	if (a.endsTime && !a.endsOn) {
		ctx.addIssue({
			code: 'custom',
			path: ['endsTime'],
			message: 'Für eine Uhrzeit wird ein Enddatum benötigt'
		});
	}
	if (
		a.endsOn &&
		a.endsOn === a.startsOn &&
		a.startsTime &&
		a.endsTime &&
		a.endsTime < a.startsTime
	) {
		ctx.addIssue({ code: 'custom', path: ['endsTime'], message: 'Das Ende liegt vor dem Beginn' });
	}
}

// ---------------------------------------------------------------------------------------------
// Wiederholung (Serien)

export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];
export const RECURRENCE_FREQ_LABELS: Record<RecurrenceFreq, string> = {
	daily: 'Täglich',
	weekly: 'Wöchentlich',
	monthly: 'Monatlich',
	yearly: 'Jährlich'
};
/** monatlich/jährlich: gleicher Tag im Monat, n-ter Wochentag oder letzter Wochentag (aus dem Startdatum) */
export const MONTHLY_MODES = ['day', 'nth-weekday', 'last-weekday'] as const;
export type MonthlyMode = (typeof MONTHLY_MODES)[number];
export const MAX_RECURRENCE_COUNT = 500;
/** Höchstzahl expandierter Vorkommen je Abfrage */
export const MAX_OCCURRENCES = 2000;
/** Zeitfenster für offene Abfragen ohne `to` (Tage ab `from` bzw. heute) */
export const OPEN_WINDOW_DAYS = 366;

export const recurrenceEnd = z.discriminatedUnion('type', [
	z.object({ type: z.literal('never') }).strict(),
	z.object({ type: z.literal('until'), date: dateSchema }).strict(),
	z
		.object({
			type: z.literal('count'),
			count: z.number().int().min(1).max(MAX_RECURRENCE_COUNT)
		})
		.strict()
]);

export const recurrenceRule = z
	.object({
		freq: z.enum(RECURRENCE_FREQS),
		interval: z.number().int().min(1).max(99).default(1),
		/** Nur `weekly`: ISO-Wochentage 1 = Mo … 7 = So; leer/fehlend = Wochentag des Starts */
		byWeekday: z
			.array(z.number().int().min(1).max(7))
			.max(7)
			.optional()
			.transform((v) => (v && v.length ? [...new Set(v)].sort((a, b) => a - b) : undefined)),
		/** Nur `monthly`/`yearly` (Standard `day`) */
		monthlyMode: z.enum(MONTHLY_MODES).optional(),
		end: recurrenceEnd.default({ type: 'never' })
	})
	.strict();
export type RecurrenceRule = z.infer<typeof recurrenceRule>;
export type RecurrenceRuleInput = z.input<typeof recurrenceRule>;

/** Serienregeln gegen Start/Ende prüfen (Pfadpräfix `recurrence`) */
export function checkRecurrence(
	v: EventDates & { recurrence: RecurrenceRule | null },
	ctx: z.RefinementCtx
): void {
	const r = v.recurrence;
	if (!r) return;
	if (r.end.type === 'until' && r.end.date < v.startsOn) {
		ctx.addIssue({
			code: 'custom',
			path: ['recurrence', 'end', 'date'],
			message: 'Das Serienende liegt vor dem Start'
		});
	}
	if (r.byWeekday && r.freq !== 'weekly') {
		ctx.addIssue({
			code: 'custom',
			path: ['recurrence', 'byWeekday'],
			message: 'Wochentage nur bei wöchentlicher Wiederholung'
		});
	}
	if (r.monthlyMode && r.freq !== 'monthly' && r.freq !== 'yearly') {
		ctx.addIssue({
			code: 'custom',
			path: ['recurrence', 'monthlyMode'],
			message: 'Nur bei monatlicher oder jährlicher Wiederholung'
		});
	}
	// Ein Vorkommen muss vor dem nächsten enden
	const duration = v.endsOn ? daysBetween(v.startsOn, v.endsOn) : 0;
	if (duration > 0 && duration >= minGapDays(r, v.startsOn)) {
		ctx.addIssue({
			code: 'custom',
			path: ['endsOn'],
			message: 'Der Termin dauert länger als der Abstand der Wiederholungen'
		});
	}
}

export const eventInput = z
	.object({
		title: text(200),
		description: optionalText(10000),
		location: optionalText(300),
		color,
		startsOn: dateSchema,
		startsTime: time,
		endsOn: optionalDate,
		endsTime: time,
		tags: z
			.array(tag)
			.max(MAX_TAGS, `Höchstens ${MAX_TAGS} Tags`)
			.default([])
			.transform(normalizeTags),
		/** `stamm` oder Gruppen-IDs aus `members` */
		groupIds: z
			.array(refId)
			.max(MAX_GROUPS)
			.default([])
			.transform((v) => [...new Set(v)]),
		/** Sichtbarkeit/Bearbeitung (Eigentümer*in hat immer vollen Zugriff) */
		shares: z.array(shareInput).max(MAX_SHARES).default([]),
		onWebsite: z.boolean().default(false),
		/** Wiederholung; `null` = einmaliger Termin */
		recurrence: recurrenceRule.nullable().default(null)
	})
	.strict()
	.superRefine((v, ctx) => {
		checkEventDates(v, ctx);
		checkRecurrence(v, ctx);
		const keys = new Set<string>();
		v.shares.forEach((s, i) => {
			const k = `${s.type}:${s.id}`;
			if (keys.has(k)) {
				ctx.addIssue({ code: 'custom', path: ['shares', i], message: 'Doppelte Freigabe' });
			}
			keys.add(k);
			if (s.type === 'everyone' && s.id !== '*') {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Ungültige ID' });
			}
		});
	});
export type EventInput = z.infer<typeof eventInput>;

export const idParams = z.object({ id: z.uuid('Ungültige ID') });

/** Ein Vorkommen einer Serie (ursprüngliches Datum) */
export const occurrenceParams = z.object({ id: z.uuid('Ungültige ID'), date: dateSchema });
export const detailQuery = z.object({ occurrence: dateSchema.optional() });

/** Abweichende Felder eines einzelnen Vorkommens (alles optional; fehlend = wie Serie) */
export const occurrenceOverride = z
	.object({
		title: text(200).optional(),
		description: optionalText(10000).optional(),
		location: optionalText(300).optional(),
		startsOn: dateSchema.optional(),
		startsTime: time.optional(),
		endsOn: optionalDate.optional(),
		endsTime: time.optional()
	})
	.strict();
export type OccurrenceOverride = z.infer<typeof occurrenceOverride>;

/** `PUT /events/:id/occurrences/:date` – absagen und/oder einzeln ändern */
export const occurrenceInput = z
	.object({
		cancelled: z.boolean().default(false),
		override: occurrenceOverride.nullable().default(null)
	})
	.strict();
export type OccurrenceInput = z.infer<typeof occurrenceInput>;

export const listQuery = z.object({
	/** Zeitraum (Überlappung): Termine, die zwischen `from` und `to` stattfinden */
	from: dateSchema.optional(),
	to: dateSchema.optional(),
	search: z.string().trim().max(100).optional(),
	tag: z.string().trim().max(MAX_TAG_LENGTH).optional(),
	groupId: refId.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200),
	offset: z.coerce.number().int().min(0).default(0)
});
export type ListQuery = z.infer<typeof listQuery>;

export const principalSearchQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});

export const tagsQuery = z.object({
	search: z.string().trim().max(MAX_TAG_LENGTH).optional()
});

export const websiteQuery = z.object({
	/** Standard: heute */
	from: dateSchema.optional(),
	to: dateSchema.optional(),
	tag: z.string().trim().max(MAX_TAG_LENGTH).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});

// ---------------------------------------------------------------------------------------------
// DTOs

export interface UserRef {
	id: string;
	name: string;
	/** Profilbild oder `null` */
	image?: string | null;
}

export interface EventGroupRef {
	id: string;
	name: string;
	color: string | null;
	/** Gruppenstunde aus `members` (1 = Mo … 7 = So), für Vorschläge; beim Stamm `null` */
	meetingWeekday?: number | null;
	meetingTime?: string | null;
	meetingPlace?: string | null;
}

export interface EventShare {
	type: PrincipalType;
	id: string;
	name: string;
	detail: string | null;
	color: string | null;
	/** Profil- bzw. Gruppenbild oder `null` */
	image?: string | null;
	level: ShareLevel;
}

export interface EventAccess {
	level: ShareLevel;
	isOwner: boolean;
}

export interface EventItem extends EventDates {
	id: string;
	title: string;
	description: string | null;
	location: string | null;
	color: string | null;
	tags: string[];
	groups: EventGroupRef[];
	onWebsite: boolean;
	owner: UserRef | null;
	access: EventAccess;
	createdAt: string;
	updatedAt: string;
	/** Eindeutiger Schlüssel in Listen: `id` bzw. `id:occurrenceDate` */
	key: string;
	/** Serie: ursprüngliches Datum dieses Vorkommens (Start-/Endfelder sind die des Vorkommens) */
	occurrenceDate: string | null;
	recurrence: RecurrenceRule | null;
	/** Vorkommen weicht von der Serie ab */
	isException: boolean;
}

/** Einzelner Termin; `shares` nur bei Bearbeiten-Zugriff, sonst leer */
export interface EventDetail extends EventItem {
	shares: EventShare[];
	/** Serie: Werte der Serie selbst (unabhängig vom angefragten Vorkommen und seinem Override) */
	series:
		(EventDates & { title: string; description: string | null; location: string | null }) | null;
	/** Serie: gespeicherter Override dieses Vorkommens (nur bei Bearbeiten-Zugriff, sonst `null`) */
	override: OccurrenceOverride | null;
	/** Serie, nur bei Bearbeiten-Zugriff: abgesagte Vorkommen (ursprüngliche Daten) */
	cancelledDates: string[];
	/** Serie, nur bei Bearbeiten-Zugriff: einzeln geänderte Vorkommen (ursprüngliche Daten) */
	exceptionDates: string[];
}

export interface EventList {
	items: EventItem[];
	total: number;
}

/** Öffentliche Felder für die Stammeswebsite (API-Key mit `events.website.read`) */
export interface WebsiteEvent extends EventDates {
	id: string;
	title: string;
	description: string | null;
	location: string | null;
	color: string | null;
	tags: string[];
	/** Gruppennamen (inkl. Stammesname) */
	groups: string[];
	/** Teil einer Serie (jedes Vorkommen ist ein eigener Eintrag mit gleicher `id`) */
	recurring: boolean;
	/** Serie: ursprüngliches Datum (stabiler Schlüssel `id` + `occurrenceDate`) */
	occurrenceDate: string | null;
}
