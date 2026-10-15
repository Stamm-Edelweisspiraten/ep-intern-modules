/** API-Vertrag des Moduls "members": Zod-Schemas fuer Server und UI sowie die DTO-Typen. */
import { z } from 'zod';

export const MODULE_ID = 'members';

export const STAGES = [
	'neuling-woelfling',
	'woelfling',
	'neuling-jungpfadfinder',
	'knappe',
	'pfadfinder',
	'spaeher',
	'kreuzpfadfinder'
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
	'neuling-woelfling': 'Neuling-Wölfling',
	woelfling: 'Wölfling',
	'neuling-jungpfadfinder': 'Neuling-Jungpfadfinder',
	knappe: 'Knappe',
	pfadfinder: 'Pfadfinder',
	spaeher: 'Späher',
	kreuzpfadfinder: 'Kreuzpfadfinder'
};

export const GROUP_TYPES = ['sippe', 'meute'] as const;
export type GroupType = (typeof GROUP_TYPES)[number];
export const GROUP_TYPE_LABELS: Record<GroupType, string> = { sippe: 'Sippe', meute: 'Meute' };

/** 1 = Montag … 7 = Sonntag (ISO-8601) */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_LABELS: Record<number, string> = {
	1: 'Montag',
	2: 'Dienstag',
	3: 'Mittwoch',
	4: 'Donnerstag',
	5: 'Freitag',
	6: 'Samstag',
	7: 'Sonntag'
};

export const DOCUMENT_KINDS = ['privacy', 'registration'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
	privacy: 'Datenschutzeinwilligung',
	registration: 'Stammesanmeldung'
};

/** Maximale Dokumentgroesse (Bytes) und erlaubte Typen beim Upload */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_CONTENT_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp'
] as const;

/** Gruppenbild: nur Rastergrafiken (kein SVG, da aktiver Inhalt) */
export const MAX_GROUP_IMAGE_BYTES = 2 * 1024 * 1024;
export const GROUP_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// --- Hilfsfunktionen --------------------------------------------------------

/** Alter in vollen Jahren zum Stichtag `today` (Standard: heute); `null` bei ungueltigem Datum. */
export function ageFromBirthDate(iso: string, today: Date = new Date()): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	let age = today.getFullYear() - y;
	const beforeBirthday =
		today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d);
	if (beforeBirthday) age--;
	return age;
}

/** Echtes Kalenderdatum im Format JJJJ-MM-TT? */
export function isRealDate(iso: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === iso;
}

/** `#abc` / `#AABBCC` -> `#aabbcc`; sonst `null`. */
export function normalizeHexColor(value: string): string | null {
	const v = value.trim().toLowerCase();
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

// --- Eingaben ---------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_NO_NEWLINE = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

const text = (max: number) =>
	z
		.string()
		.trim()
		.min(1, 'Pflichtfeld')
		.max(max, `Höchstens ${max} Zeichen`)
		.refine((v) => !CONTROL_CHARS.test(v), 'Enthält ungültige Zeichen');

const optionalText = (max: number, multiline = false) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.refine(
			(v) => !(multiline ? CONTROL_CHARS_NO_NEWLINE : CONTROL_CHARS).test(v),
			'Enthält ungültige Zeichen'
		)
		.nullish()
		.transform((v) => (v ? v : null));

const id = z.uuid('Ungültige ID');

const emailValue = z
	.string()
	.trim()
	.toLowerCase()
	.min(1, 'E-Mail-Adresse fehlt')
	.max(200, 'Höchstens 200 Zeichen')
	.pipe(z.email('Ungültige E-Mail-Adresse'));

const phoneValue = z
	.string()
	.trim()
	.min(1, 'Telefonnummer fehlt')
	.max(30, 'Höchstens 30 Zeichen')
	.transform((v) => v.replace(/\s+/g, ' '))
	.refine((v) => /^\+?[0-9][0-9 ()/.-]{4,28}$/.test(v), 'Ungültige Telefonnummer')
	.refine((v) => {
		const digits = v.replace(/\D/g, '').length;
		return digits >= 6 && digits <= 15;
	}, 'Telefonnummer muss 6 bis 15 Ziffern haben');

export const phoneEntry = z.object({
	name: optionalText(100),
	value: phoneValue
});
export const emailEntry = z.object({
	name: optionalText(100),
	value: emailValue
});

const birthDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Format JJJJ-MM-TT')
	.refine(isRealDate, 'Kein gültiges Datum')
	.refine((v) => v <= new Date().toISOString().slice(0, 10), 'Darf nicht in der Zukunft liegen')
	.refine((v) => (ageFromBirthDate(v) ?? 0) <= 120, 'Geburtsdatum unplausibel');

function noDuplicates<T extends { value: string }>(
	list: T[],
	ctx: z.RefinementCtx,
	field: 'phones' | 'emails'
) {
	const seen = new Set<string>();
	list.forEach((entry, i) => {
		const key = field === 'phones' ? entry.value.replace(/[^\d+]/g, '') : entry.value;
		if (seen.has(key)) {
			ctx.addIssue({
				code: 'custom',
				path: [field, i, 'value'],
				message: 'Eintrag ist doppelt vorhanden'
			});
		}
		seen.add(key);
	});
}

export const memberInput = z
	.object({
		firstName: text(100),
		lastName: text(100),
		scoutName: optionalText(100),
		birthDate,
		address: text(300),
		phones: z.array(phoneEntry).max(10, 'Höchstens 10 Telefonnummern').default([]),
		emails: z.array(emailEntry).max(10, 'Höchstens 10 E-Mail-Adressen').default([]),
		stage: z.enum(STAGES, 'Bitte einen Stand wählen'),
		/**
		 * Pflichtangabe, sobald mindestens eine Gruppe existiert (der Server erzwingt das). Nur beim
		 * allerersten Mitglied darf die Liste leer sein, da Gruppen einen Leiter aus den Mitgliedern brauchen.
		 */
		groupIds: z.array(id).max(20).default([]),
		consentSocialMedia: z.boolean().default(false),
		consentWebsite: z.boolean().default(false),
		consentPrint: z.boolean().default(false)
	})
	.superRefine((m, ctx) => {
		noDuplicates(m.phones, ctx, 'phones');
		noDuplicates(m.emails, ctx, 'emails');
	});
export type MemberInput = z.infer<typeof memberInput>;
/** Eingabeform vor dem Parsen (z. B. fuer Formulare) */
export type MemberFormInput = z.input<typeof memberInput>;

export const memberListQuery = z.object({
	search: z.string().trim().max(100).optional(),
	stage: z.enum(STAGES).optional(),
	groupId: id.optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

const hexColor = z
	.string()
	.trim()
	.nullish()
	.transform((v, ctx) => {
		if (!v) return null;
		const n = normalizeHexColor(v);
		if (!n) {
			ctx.addIssue({ code: 'custom', message: 'Farbe als Hex-Code, z. B. #2f855a' });
			return z.NEVER;
		}
		return n;
	});

export const groupInput = z.object({
	name: text(100),
	type: z.enum(GROUP_TYPES, 'Bitte einen Typ wählen'),
	leaderIds: z.array(id).min(1, 'Mindestens ein Gruppenleiter').max(20),
	description: optionalText(2000, true),
	meetingPlace: optionalText(200),
	meetingWeekday: z
		.number('Ungültiger Wochentag')
		.int()
		.min(1, 'Ungültiger Wochentag')
		.max(7, 'Ungültiger Wochentag')
		.nullish()
		.transform((v) => v ?? null),
	meetingTime: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format HH:MM')
		.nullish()
		.transform((v) => (v ? v : null)),
	color: hexColor
});
export type GroupInput = z.infer<typeof groupInput>;
export type GroupFormInput = z.input<typeof groupInput>;

export const idParams = z.object({ id });
export const documentParams = z.object({
	id,
	kind: z.enum(DOCUMENT_KINDS)
});

// --- Antworten (DTOs) -------------------------------------------------------

export interface GroupRef {
	id: string;
	name: string;
	type: GroupType;
	/** `#rrggbb` oder `null` */
	color: string | null;
}

export interface MemberRef {
	id: string;
	firstName: string;
	lastName: string;
	scoutName: string | null;
}

export interface ContactEntry {
	/** Bezeichnung, z. B. "Mutter" */
	name: string | null;
	value: string;
}

export interface MemberDocument {
	name: string;
}

export interface Member extends MemberRef {
	/** JJJJ-MM-TT */
	birthDate: string;
	address: string;
	phones: ContactEntry[];
	emails: ContactEntry[];
	stage: Stage;
	groups: GroupRef[];
	consentSocialMedia: boolean;
	consentWebsite: boolean;
	consentPrint: boolean;
	privacyConsent: MemberDocument | null;
	registration: MemberDocument | null;
	createdAt: string;
	updatedAt: string;
}

export interface MemberList {
	items: Member[];
	total: number;
}

export interface Group {
	id: string;
	name: string;
	type: GroupType;
	description: string | null;
	meetingPlace: string | null;
	/** 1 = Montag … 7 = Sonntag */
	meetingWeekday: number | null;
	meetingTime: string | null;
	color: string | null;
	/** Bild vorhanden? Abruf ueber GET /groups/:id/image */
	hasImage: boolean;
	/** Cache-Busting-Wert fuer die Bild-URL (ISO-Zeitstempel der letzten Aenderung) */
	imageVersion: string | null;
	leaders: MemberRef[];
	memberCount: number;
	createdAt: string;
	updatedAt: string;
}
