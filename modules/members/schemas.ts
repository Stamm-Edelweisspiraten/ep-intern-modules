/** API-Vertrag des Moduls "members": Zod-Schemas für Server und UI sowie die DTO-Typen. */
import { z } from 'zod';
import { LIST_MAX_COLUMNS } from '$lib/pdf-lists/types';

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

/** Beitragsebenen des Jahresbeitrags (Stamm → Bund); Zweitmitglieder zahlen nur die angehakten */
export const FEE_LEVELS = ['stamm', 'gau', 'landesmark', 'bund'] as const;
export type FeeLevel = (typeof FEE_LEVELS)[number];
export const FEE_LEVEL_LABELS: Record<FeeLevel, string> = {
	stamm: 'Stamm',
	gau: 'Gau',
	landesmark: 'Landesmark',
	bund: 'Bund'
};

/** Maximale Dokumentgröße (Bytes) und erlaubte Typen beim Upload */
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

/** Alter in vollen Jahren zum Stichtag `today` (Standard: heute); `null` bei ungültigem Datum. */
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

/** Optionales Datum JJJJ-MM-TT; leer → null */
const optionalDate = z
	.string()
	.trim()
	.nullish()
	.transform((v) => (v ? v : null))
	.refine(
		(v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v)),
		'Kein gültiges Datum'
	);

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

const postalCode = z
	.string()
	.trim()
	.min(1, 'Pflichtfeld')
	.max(10, 'Höchstens 10 Zeichen')
	.regex(/^[A-Za-z0-9]([A-Za-z0-9 -]*[A-Za-z0-9])?$/, 'Ungültige Postleitzahl');

/** ISO-3166-Alpha-2, Standard Deutschland */
const countryCode = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z]{2}$/, 'Ungültiges Land')
	.default('DE');

export const memberInput = z
	.object({
		firstName: text(100),
		lastName: text(100),
		scoutName: optionalText(100),
		birthDate,
		street: text(200),
		postalCode,
		city: text(100),
		country: countryCode,
		phones: z.array(phoneEntry).max(10, 'Höchstens 10 Telefonnummern').default([]),
		emails: z.array(emailEntry).max(10, 'Höchstens 10 E-Mail-Adressen').default([]),
		stage: z.enum(STAGES, 'Bitte einen Stand wählen'),
		/**
		 * Optional (früher Pflicht, sobald eine Gruppe existierte). Nur beim
		 * allerersten Mitglied darf die Liste leer sein, da Gruppen einen Leiter aus den Mitgliedern brauchen.
		 */
		groupIds: z.array(id).max(20).default([]),
		consentSocialMedia: z.boolean().default(false),
		consentWebsite: z.boolean().default(false),
		consentPrint: z.boolean().default(false),
		/** Werte der Zusatzfelder (nur aktive Schlüssel; fehlende bleiben unverändert) */
		custom: z.record(z.string().max(40), z.unknown()).default({}),
		/** Eintritt/Austritt (JJJJ-MM-TT); leer = unbekannt bzw. noch Mitglied */
		entryDate: optionalDate,
		exitDate: optionalDate,
		/** Zweitmitglied: zahlt nur die Ebenen in `feeLevels` */
		secondaryMember: z.boolean().default(false),
		feeLevels: z
			.array(z.enum(FEE_LEVELS))
			.max(FEE_LEVELS.length)
			.default([...FEE_LEVELS])
			.transform((l) => FEE_LEVELS.filter((f) => l.includes(f)))
	})
	.superRefine((m, ctx) => {
		if (m.entryDate && m.exitDate && m.exitDate < m.entryDate) {
			ctx.addIssue({
				code: 'custom',
				path: ['exitDate'],
				message: 'Austritt darf nicht vor dem Eintritt liegen'
			});
		}
		if (m.secondaryMember && m.feeLevels.length === 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['feeLevels'],
				message: 'Mindestens eine Ebene wählen'
			});
		}
		if (m.country === 'DE' && !/^\d{5}$/.test(m.postalCode)) {
			ctx.addIssue({
				code: 'custom',
				path: ['postalCode'],
				message: 'Deutsche Postleitzahlen haben 5 Ziffern'
			});
		}
		noDuplicates(m.phones, ctx, 'phones');
		noDuplicates(m.emails, ctx, 'emails');
	});
export type MemberInput = z.infer<typeof memberInput>;
/** Eingabeform vor dem Parsen (z. B. für Formulare) */
export type MemberFormInput = z.input<typeof memberInput>;

export const memberListQuery = z.object({
	search: z.string().trim().max(100).optional(),
	stage: z.enum(STAGES).optional(),
	groupId: id.optional(),
	/** Mitgliedschaft heute: aktiv (Standard), ausgetreten oder alle */
	status: z.enum(['active', 'left', 'all']).default('active'),
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

/** Sammelaktionen auf markierten Mitgliedern (`POST /members/bulk`). */
export const BULK_MAX_IDS = 200;
const bulkIds = z
	.array(id)
	.min(1, 'Mindestens ein Mitglied auswählen')
	.max(BULK_MAX_IDS, `Höchstens ${BULK_MAX_IDS} Mitglieder auf einmal`)
	.transform((ids) => [...new Set(ids)]);
const bulkGroupIds = z.array(id).min(1, 'Mindestens eine Gruppe wählen').max(20);

export const bulkInput = z.discriminatedUnion('action', [
	z.object({ action: z.literal('add-groups'), ids: bulkIds, groupIds: bulkGroupIds }),
	z.object({ action: z.literal('remove-groups'), ids: bulkIds, groupIds: bulkGroupIds }),
	z.object({
		action: z.literal('set-stage'),
		ids: bulkIds,
		stage: z.enum(STAGES, 'Bitte einen Stand wählen')
	}),
	z.object({
		action: z.literal('set-consent'),
		ids: bulkIds,
		consent: z
			.object({
				consentSocialMedia: z.boolean().optional(),
				consentWebsite: z.boolean().optional(),
				consentPrint: z.boolean().optional()
			})
			.strict()
			.refine((c) => Object.values(c).some((v) => v !== undefined), 'Mindestens eine Einwilligung')
	}),
	z.object({ action: z.literal('delete'), ids: bulkIds })
]);
export type BulkInput = z.infer<typeof bulkInput>;
export type BulkAction = BulkInput['action'];

export interface BulkResult {
	/** Anzahl tatsächlich geänderter bzw. gelöschter Mitglieder */
	affected: number;
	/** Übersprungene Mitglieder mit Grund (z. B. einziger Leiter, letzte Gruppe) */
	skipped: { id: string; name: string; reason: string }[];
}

export interface AddressSuggestion {
	/** Anzeigetext, z. B. „Rockwinkler Heerstr. 140, 28357 Bremen“ */
	label: string;
	street: string;
	postalCode: string;
	city: string;
	country: string;
}
export interface AddressSuggestions {
	items: AddressSuggestion[];
	/** Dienst nicht erreichbar oder abgeschaltet – Formular bleibt normal nutzbar */
	unavailable: boolean;
}
export const addressSuggestQuery = z.object({
	q: z.string().trim().min(3, 'Mindestens 3 Zeichen').max(120)
});
export const addressPlacesQuery = z.object({
	postalCode: z
		.string()
		.trim()
		.regex(/^\d{5}$/, 'Fünf Ziffern')
});

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
	street: string;
	postalCode: string;
	city: string;
	/** ISO-3166-Alpha-2 */
	country: string;
	phones: ContactEntry[];
	emails: ContactEntry[];
	stage: Stage;
	groups: GroupRef[];
	consentSocialMedia: boolean;
	consentWebsite: boolean;
	consentPrint: boolean;
	privacyConsent: MemberDocument | null;
	registration: MemberDocument | null;
	/** Eintritt/Austritt (JJJJ-MM-TT) oder null */
	entryDate: string | null;
	exitDate: string | null;
	secondaryMember: boolean;
	/** Ebenen, die bei uns gezahlt werden (bei Nicht-Zweitmitgliedern immer alle) */
	feeLevels: FeeLevel[];
	/** Anzahl verknüpfter Benutzerkonten */
	linkCount: number;
	/** Werte der Zusatzfelder (inkl. deaktivierter Felder) */
	custom: Record<string, import('$lib/forms').FormValue>;
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
	/** Bild vorhanden? Abruf über GET /groups/:id/image */
	hasImage: boolean;
	/** Cache-Busting-Wert für die Bild-URL (ISO-Zeitstempel der letzten Änderung) */
	imageVersion: string | null;
	leaders: MemberRef[];
	memberCount: number;
	createdAt: string;
	updatedAt: string;
}

// --- Verknüpfung Benutzer ↔ Mitglied -----------------------------------------

export const LINK_CODE_TTL_DAYS = 90;
export const LINK_MAX_FAILED_ATTEMPTS = 10;
export const LINK_LOCK_MINUTES = 60;
export const LINK_LETTERS_MAX_IDS = 100;
/** Rolle, die per Verknüpfungscode angelegte Konten erhalten (wird ohne Rechte angelegt) */
export const LINK_DEFAULT_ROLE = 'Mitglied';
export const LINK_PUBLIC_PREFIX = '/p/members/verknuepfen';

const linkCode = z
	.string()
	.trim()
	.transform((v) => v.replace(/[\s-]/g, ''))
	.pipe(z.string().regex(/^\d{6}$/, 'Der Code besteht aus 6 Ziffern'));
const linkRelation = z
	.string()
	.trim()
	.max(50, 'Höchstens 50 Zeichen')
	.refine((v) => !CONTROL_CHARS.test(v), 'Enthält ungültige Zeichen')
	.nullish()
	.transform((v) => (v ? v : null));

export const linkTokenParams = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) });
export const linkUserParams = z.object({ id, userId: z.string().min(1).max(100) });
export const linkClaimInput = z.object({ code: linkCode, relation: linkRelation }).strict();
export const linkRegisterInput = z
	.object({
		code: linkCode,
		name: text(120),
		email: emailValue,
		password: z
			.string()
			.min(12, 'Das Passwort braucht mindestens 12 Zeichen')
			.max(128, 'Höchstens 128 Zeichen'),
		relation: linkRelation
	})
	.strict();
export const linkLettersInput = z
	.object({
		ids: z
			.array(id)
			.min(1, 'Mindestens ein Mitglied auswählen')
			.max(LINK_LETTERS_MAX_IDS, `Höchstens ${LINK_LETTERS_MAX_IDS} Mitglieder auf einmal`)
			.transform((ids) => [...new Set(ids)])
	})
	.strict();

/** Mitgliedsdaten-PDF (`POST /members/sheets.pdf`, `POST /groups/sheets.pdf`) */
export const SHEETS_MAX_IDS = 200;
/** Auswahl der Listenspalten (Schlüssel prüft der Server gegen den Katalog; ohne Auswahl gilt „Fahrt“) */
export const listSelectionInput = z
	.object({
		preset: z.string().max(40).optional(),
		columns: z
			.array(z.string().min(1).max(60))
			.min(1, 'Mindestens eine Spalte wählen')
			.max(LIST_MAX_COLUMNS, `Höchstens ${LIST_MAX_COLUMNS} Spalten`),
		hideEmpty: z.boolean().default(true)
	})
	.strict();
export const memberSheetsInput = z
	.object({
		ids: z
			.array(id)
			.min(1, 'Mindestens ein Mitglied auswählen')
			.max(SHEETS_MAX_IDS, `Höchstens ${SHEETS_MAX_IDS} Mitglieder auf einmal`)
			.transform((ids) => [...new Set(ids)]),
		selection: listSelectionInput.optional()
	})
	.strict();
export const groupSheetsInput = z
	.object({
		groupIds: z
			.array(id)
			.min(1, 'Mindestens eine Gruppe wählen')
			.max(20, 'Höchstens 20 Gruppen auf einmal')
			.transform((ids) => [...new Set(ids)]),
		selection: listSelectionInput.optional()
	})
	.strict();

export interface LinkedUser {
	id: string;
	name: string;
	email: string | null;
	relation: string | null;
	linkedAt: string;
}
export interface MemberLinks {
	users: LinkedUser[];
	code: { expiresAt: string; expired: boolean; locked: boolean } | null;
}
export interface PublicLinkInfo {
	memberFirstName: string;
	/** Angemeldete Person (Session-Cookie) oder `null` */
	viewer: { name: string } | null;
}
export interface MyMember {
	id: string;
	firstName: string;
	lastName: string;
	scoutName: string | null;
	relation: string | null;
	/** JJJJ-MM-TT */
	birthDate: string;
	groups: { id: string; name: string }[];
	phones: ContactEntry[];
	emails: ContactEntry[];
	/** Werte der Zusatzfelder (Schlüssel → Wert) */
	custom: Record<string, import('$lib/forms').FormValue>;
	/** Abgewählte, abschaltbare Mail-Kategorien */
	mailOptOut: MailCategory[];
}

/** Zusatzfeld mit Kennzeichen, ob es Gesundheitsdaten enthält */
export interface MyFieldDefinition {
	key: string;
	field: import('$lib/forms').FieldDefinition;
	sensitive: boolean;
}
/** Zusatzfelder mit Gesundheitsbezug (Vorlagen) */
export const SENSITIVE_FIELD_KEYS: readonly string[] = [
	'ernaehrung',
	'allergien',
	'medikamente',
	'gesundheit',
	'zecken',
	'tetanus',
	'krankenkasse'
];

// --- Mail-Einstellungen je Mitglied ---------------------------------------------

/** Abschaltbare Kategorien (Standard: an; nur Abwahlen werden gespeichert) */
export const MAIL_CATEGORIES = ['payment-confirmation', 'action-info'] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];
/** Verbindliche Mails (nicht abschaltbar): Rechnungen, Jahresbeitrag, Erinnerungen, Anmeldebestätigung */
export const MANDATORY_MAIL = ['invoice', 'annual-fee', 'reminder', 'registration'] as const;

export const mailPrefInput = z
	.object({
		category: z.string().refine((c) => (MAIL_CATEGORIES as readonly string[]).includes(c), {
			message: 'Diese Mail-Kategorie ist verbindlich oder unbekannt und nicht abschaltbar'
		}) as unknown as z.ZodType<MailCategory>,
		enabled: z.boolean()
	})
	.strict();

export const myContactsInput = z
	.object({
		phones: z.array(phoneEntry).max(10, 'Höchstens 10 Telefonnummern'),
		emails: z.array(emailEntry).max(10, 'Höchstens 10 E-Mail-Adressen')
	})
	.strict()
	.superRefine((m, ctx) => {
		noDuplicates(m.phones, ctx, 'phones');
		noDuplicates(m.emails, ctx, 'emails');
	});

// --- Zusatzfelder -------------------------------------------------------------

export const MEMBER_FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect', 'boolean'] as const;
export const MEMBER_FIELDS_MAX = 40;
/** Vordefinierte Vorlagen (Schlüssel und Typ fest, nicht löschbar) */
export const MEMBER_FIELD_PRESETS = [
	'ernaehrung',
	'allergien',
	'medikamente',
	'gesundheit',
	'schwimmen',
	'zecken',
	'tetanus',
	'krankenkasse',
	'notfallkontakt',
	'juleica'
] as const;

export const customValue = z.union([
	z.string().max(2000),
	z.number().finite(),
	z.boolean(),
	z.array(z.string().max(200)).max(50),
	z.null()
]);
export const customValues = z.record(z.string().max(40), customValue);
/** `PUT /my/members/:id/fields` */
export const myFieldsInput = z.object({ values: customValues }).strict();

export interface MemberFieldDef {
	key: string;
	active: boolean;
	preset: boolean;
	field: import('$lib/forms').FieldDefinition;
}

/** `PUT /fields`: komplette Liste (Reihenfolge = Anzeige); Felder werden gegen die Formular-Bibliothek geprüft */
export const memberFieldsInput = z
	.object({
		fields: z
			.array(
				z.object({
					active: z.boolean().default(true),
					field: z.looseObject({ key: z.string(), type: z.string() })
				})
			)
			.max(MEMBER_FIELDS_MAX, `Höchstens ${MEMBER_FIELDS_MAX} Felder`)
	})
	.strict();
