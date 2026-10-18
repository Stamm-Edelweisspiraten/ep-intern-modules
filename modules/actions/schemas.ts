/** API-Vertrag des Moduls "actions": Zod-Schemas fuer Server und UI sowie die DTO-Typen. */
import { z } from 'zod';
import { isValidIban, normalizeIban } from './iban';
import { formDefinitionSchema } from '$lib/forms/schema';
import type { FormDefinition } from '$lib/forms/types';

export const MODULE_ID = 'actions';

// --- Konstanten -------------------------------------------------------------

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_LEVEL_LABELS: Record<ShareLevel, string> = {
	read: 'Lesen',
	edit: 'Bearbeiten'
};

export const PARTICIPANT_ROLES = ['participant', 'team'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];
export const PARTICIPANT_ROLE_LABELS: Record<ParticipantRole, string> = {
	participant: 'Teilnehmer*in',
	team: 'Team'
};

export const DIETS = ['vegetarian', 'vegan', 'meat'] as const;
export type Diet = (typeof DIETS)[number];
export const DIET_LABELS: Record<Diet, string> = {
	vegetarian: 'Vegetarisch',
	vegan: 'Vegan',
	meat: 'Mit Fleisch'
};

// --- Hilfsfunktionen --------------------------------------------------------

/** Echtes Kalenderdatum im Format JJJJ-MM-TT? */
export function isRealDate(iso: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === iso;
}

/** Alter in vollen Jahren zum Stichtag; `null` bei ungueltigem Datum. */
export function ageAt(birthIso: string, onIso: string): number | null {
	const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthIso);
	const o = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onIso);
	if (!b || !o) return null;
	let age = Number(o[1]) - Number(b[1]);
	if (
		Number(o[2]) < Number(b[2]) ||
		(Number(o[2]) === Number(b[2]) && Number(o[3]) < Number(b[3]))
	) {
		age--;
	}
	return age;
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
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Format JJJJ-MM-TT')
	.refine(isRealDate, 'Kein gültiges Datum');
const time = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format HH:MM')
	.nullish()
	.transform((v) => (v ? v : null));
const optionalDate = date.nullish().transform((v) => (v ? v : null));

const actionFields = {
	name: text(150),
	description: optionalText(5000, true),
	location: optionalText(200),
	startsOn: date,
	startsTime: time,
	endsOn: optionalDate,
	endsTime: time
};

const checkActionDates = (
	a: {
		startsOn: string;
		endsOn: string | null;
		startsTime: string | null;
		endsTime: string | null;
	},
	ctx: z.RefinementCtx
) => {
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
		ctx.addIssue({
			code: 'custom',
			path: ['endsTime'],
			message: 'Das Ende liegt vor dem Beginn'
		});
	}
};

/** POST: `isPast` (Aktion liegt bereits in der Vergangenheit), Standard `false`. */
export const actionInput = z
	.object({ ...actionFields, isPast: z.boolean().default(false) })
	.superRefine(checkActionDates);
/** PUT: fehlt `isPast`, bleibt der gespeicherte Wert unveraendert. */
export const actionUpdateInput = z
	.object({ ...actionFields, isPast: z.boolean().optional() })
	.superRefine(checkActionDates);
export type ActionInput = z.infer<typeof actionInput>;
export type ActionFormInput = z.input<typeof actionInput>;

export const actionListQuery = z.object({
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export const idParams = z.object({ id });
export const shareParams = z.object({ id, userId: id });
export const participantParams = z.object({ id, participantId: id });

export const shareInput = z.object({ level: z.enum(SHARE_LEVELS) });
export const userSearchQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100),
	limit: z.coerce.number().int().min(1).max(30).default(20)
});

export const participantInput = z.object({
	name: text(150),
	groupLabel: optionalText(150),
	birthDate: date
		.refine((v) => v <= new Date().toISOString().slice(0, 10), 'Darf nicht in der Zukunft liegen')
		.nullish()
		.transform((v) => (v ? v : null)),
	bremenResident: z
		.boolean()
		.nullish()
		.transform((v) => v ?? null),
	role: z.enum(PARTICIPANT_ROLES).default('participant'),
	juleica: z.boolean().default(false),
	/** Ausdrueckliche Zuschussberechtigung; `null` = automatisch, fehlt = unveraendert */
	subsidyEligible: z.boolean().nullable().optional(),
	diet: z
		.enum(DIETS)
		.nullish()
		.transform((v) => v ?? null),
	allergies: optionalText(1000, true),
	notes: optionalText(2000, true)
});
export type ParticipantInput = z.infer<typeof participantInput>;
export type ParticipantFormInput = z.input<typeof participantInput>;

// --- Antworten (DTOs) -------------------------------------------------------

export interface UserRef {
	userId: string;
	name: string;
	email: string | null;
}

export interface ShareEntry extends UserRef {
	level: ShareLevel;
}

export interface ActionSummary {
	id: string;
	name: string;
	description: string | null;
	location: string | null;
	/** JJJJ-MM-TT */
	startsOn: string;
	/** HH:MM oder null */
	startsTime: string | null;
	endsOn: string | null;
	endsTime: string | null;
	owner: UserRef;
	/** Zugriff des aktuellen Benutzers */
	access: {
		level: 'edit' | 'read';
		isOwner: boolean;
		canShare: boolean;
	};
	participantCount: number;
	/** Aktion liegt bereits in der Vergangenheit (nachtraegliche Abrechnung) */
	isPast: boolean;
	/** Uebernommener Beitrag aus der Kalkulation oder `null` */
	fee: AppliedFee | null;
	createdAt: string;
	updatedAt: string;
}

export interface ActionList {
	items: ActionSummary[];
	total: number;
}

export interface ActionShares {
	owner: UserRef;
	shares: ShareEntry[];
	/** Darf der aktuelle Benutzer Freigaben aendern? */
	canManage: boolean;
}

export interface Participant {
	id: string;
	actionId: string;
	/** E-Mail für die Bestätigung (aus dem Anmeldeformular) */
	contactEmail: string | null;
	name: string;
	groupLabel: string | null;
	birthDate: string | null;
	bremenResident: boolean | null;
	role: ParticipantRole;
	juleica: boolean;
	/** Ausdrueckliche Zuschussberechtigung; `null` = automatisch (Alter + Wohnort) */
	subsidyEligible: boolean | null;
	/** Ergebnis nach Regel (Override, Alter zum Aktionsstart, Wohnort) */
	subsidyEffective: boolean;
	diet: Diet | null;
	allergies: string | null;
	notes: string | null;
	source: 'manual' | 'link';
	createdAt: string;
	updatedAt: string;
	/**
	 * Zahlstand des Beitrags laut Kasse. Fehlt das Feld, ist die Kasse nicht aktiv; `null` = keine
	 * Rechnung (z. B. kein Beitrag übernommen).
	 */
	payment?: import('$lib/modules/treasury/contract').ParticipantPayment | null;
}

// === Phase 2: Kalkulation ===================================================

export const CALC_CATEGORIES = [
	'food',
	'lodging',
	'lodging_extra',
	'materials',
	'other',
	'travel',
	'program'
] as const;
export type CalcCategory = (typeof CALC_CATEGORIES)[number];

export const CALC_CATEGORY_LABELS: Record<CalcCategory, string> = {
	food: 'Verpflegung',
	lodging: 'Unterkunft',
	lodging_extra: 'Weitere Unterkunftskosten',
	materials: 'Material',
	other: 'Sonstiges',
	travel: 'Fahrtkosten',
	program: 'Programm'
};

export const CALC_BASES = ['flat', 'per_person', 'per_person_night'] as const;
export type CalcBasis = (typeof CALC_BASES)[number];
/** Auswahl je Posten: wie wird der eingegebene Betrag hochgerechnet? */
export const CALC_BASIS_LABELS: Record<CalcBasis, string> = {
	flat: 'einmalig',
	per_person: 'pro Person',
	per_person_night: 'pro Person und Nacht'
};

/** Anzeigegruppen der Posten in der Oberflaeche (Reihenfolge = Anzeige). */
export const CALC_GROUPS: {
	id: string;
	label: string;
	hint: string;
	categories: CalcCategory[];
	/** Basis, die neue Posten dieser Gruppe standardmaessig erhalten */
	defaultBasis: CalcBasis;
}[] = [
	{
		id: 'stay',
		label: 'Verpflegung & Unterkunft',
		hint: 'Preis pro Person und Nacht',
		categories: ['food', 'lodging'],
		defaultBasis: 'per_person_night'
	},
	{
		id: 'lodging_extra',
		label: 'Weitere Unterkunftskosten',
		hint: 'Z. B. Endreinigung, Nebenkosten – einmalig',
		categories: ['lodging_extra'],
		defaultBasis: 'flat'
	},
	{
		id: 'misc',
		label: 'Material & Sonstiges',
		hint: 'Einmalige Beträge',
		categories: ['materials', 'other'],
		defaultBasis: 'flat'
	},
	{
		id: 'travel',
		label: 'Fahrtkosten',
		hint: 'Einmalige Beträge',
		categories: ['travel'],
		defaultBasis: 'flat'
	},
	{
		id: 'program',
		label: 'Programm',
		hint: 'Gesamtbetrag – der Preis pro Person wird auf volle Euro aufgerundet',
		categories: ['program'],
		defaultBasis: 'flat'
	}
];

export const LODGING_TYPES = ['external', 'parish_rooms'] as const;
export type LodgingType = (typeof LODGING_TYPES)[number];
export const LODGING_TYPE_LABELS: Record<LodgingType, string> = {
	external: 'Externe Unterkunft (Jugendherberge, Zeltplatz, Haus …)',
	parish_rooms: 'Gemeinderäume'
};

export const FREIZEIT_TYPES = ['kids', 'youth'] as const;
export type FreizeitType = (typeof FREIZEIT_TYPES)[number];
export const FREIZEIT_TYPE_LABELS: Record<FreizeitType, string> = {
	kids: 'Kinderfreizeit',
	youth: 'Jugendfreizeit'
};

/** Foerder-Checkliste (nur Hinweis, fliesst nicht in die Rechnung ein). */
export const CHECKLIST_ITEMS = [
	{
		key: 'training_hhh',
		label: 'Leitungsteam hat „Hinschauen – Helfen – Handeln“ besucht (oder Juleica)'
	},
	{
		key: 'training_basic',
		label: 'Alle ehrenamtlichen Teamer*innen haben eine Basisschulung (oder Juleica)'
	},
	{ key: 'mixed_team', label: 'Bei gemischtgeschlechtlicher Freizeit: gemischtes Leitungsteam' },
	{
		key: 'not_only_couples',
		label: 'Leitung nicht nur durch Partner*innen; mindestens eine weitere erwachsene Begleitperson'
	},
	{ key: 'application', label: 'Antrag spätestens sechs Wochen nach Freizeitende einreichen' }
] as const;
export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]['key'];

export const MAX_CALC_ITEMS = 100;
export const MAX_AMOUNT_CENTS = 100_000_000; // 1.000.000,00 EUR

const nonNegativeInt = (max: number, message: string) =>
	z.number(message).int(message).min(0, message).max(max, message);

export const calcItemInput = z.object({
	/** Client-ID oder vorhandene ID; der Server vergibt beim Speichern stets neue UUIDs */
	id: z.string().min(1).max(64),
	category: z.enum(CALC_CATEGORIES),
	label: text(100),
	amountCents: nonNegativeInt(MAX_AMOUNT_CENTS, 'Betrag zwischen 0 und 1.000.000 €'),
	basis: z.enum(CALC_BASES)
});
export type CalcItem = z.infer<typeof calcItemInput>;

export const calculationInput = z.object({
	participants: nonNegativeInt(1000, 'Teilnehmende: 0 bis 1000'),
	/** Anzahl Team (Leitende); sie verursachen Kosten und zahlen `teamPercent` % des Beitrags */
	team: nonNegativeInt(1000, 'Team: 0 bis 1000'),
	/** Wie viel Prozent des Teilnehmerbeitrags das Team zahlt (0 = zahlt nicht, 100 = voller Beitrag) */
	teamPercent: z
		.number('Team-Anteil: 0 bis 100 %')
		.min(0, 'Team-Anteil: 0 bis 100 %')
		.max(100, 'Team-Anteil: 0 bis 100 %')
		.transform((v) => Math.round(v * 100) / 100),
	nights: nonNegativeInt(60, 'Nächte: 0 bis 60'),
	/** Prozent der Zwischensumme, 0 – 100, hoechstens 2 Nachkommastellen */
	bufferPercent: z
		.number('Puffer: 0 bis 100 %')
		.min(0, 'Puffer: 0 bis 100 %')
		.max(100, 'Puffer: 0 bis 100 %')
		.transform((v) => Math.round(v * 100) / 100),
	includeSubsidy: z.boolean(),
	lodgingType: z.enum(LODGING_TYPES),
	konfi: z.boolean(),
	freizeitType: z.enum(FREIZEIT_TYPES),
	bremenChildren: nonNegativeInt(1000, '0 bis 1000'),
	bremenYouth: nonNegativeInt(1000, '0 bis 1000'),
	teamWithJuleica: nonNegativeInt(1000, '0 bis 1000'),
	teamWithoutJuleica: nonNegativeInt(1000, '0 bis 1000'),
	/** Teamer*innen 12–27 Jahre aus Bremen/Bremerhaven; zaehlen beim Zuschuss wie Teilnehmende */
	teamYouth: nonNegativeInt(1000, '0 bis 1000'),
	checklist: z.record(z.string().max(40), z.boolean()).default({}),
	items: z.array(calcItemInput).max(MAX_CALC_ITEMS, `Höchstens ${MAX_CALC_ITEMS} Posten`)
});
export type CalculationInput = z.infer<typeof calculationInput>;

/** Standardposten fuer eine neue Kalkulation (IDs vergibt der Aufrufer). */
export const DEFAULT_CALC_ITEMS: Omit<CalcItem, 'id'>[] = [
	{ category: 'food', label: 'Essen', basis: 'per_person_night', amountCents: 0 },
	{ category: 'lodging', label: 'Unterkunft', basis: 'per_person_night', amountCents: 0 },
	{ category: 'lodging_extra', label: 'Endreinigung', basis: 'flat', amountCents: 0 },
	{ category: 'lodging_extra', label: 'Nebenkosten', basis: 'flat', amountCents: 0 },
	{ category: 'materials', label: 'Material', basis: 'flat', amountCents: 0 },
	{ category: 'other', label: 'Sonstiges', basis: 'flat', amountCents: 0 },
	{ category: 'travel', label: 'Fahrtkosten', basis: 'flat', amountCents: 0 },
	{ category: 'program', label: 'Programm', basis: 'flat', amountCents: 0 }
];

export const DEFAULT_CALCULATION: Omit<CalculationInput, 'items'> = {
	participants: 10,
	team: 0,
	teamPercent: 0,
	nights: 3,
	bufferPercent: 5,
	includeSubsidy: false,
	lodgingType: 'external',
	konfi: false,
	freizeitType: 'kids',
	bremenChildren: 0,
	bremenYouth: 0,
	teamWithJuleica: 0,
	teamWithoutJuleica: 0,
	teamYouth: 0,
	checklist: {}
};

// --- Ergebnisse der Berechnung ----------------------------------------------

/** Eingabe fuer `computeSubsidy` (src/lib/modules/actions/subsidy.ts). */
export interface SubsidyInput {
	nights: number;
	lodgingType: LodgingType;
	konfi: boolean;
	freizeitType: FreizeitType;
	/** Teilnehmende aus Bremen/Bremerhaven, 0–11 Jahre (Teamer <= 27 zaehlen mit) */
	children: number;
	/** Teilnehmende aus Bremen/Bremerhaven, 12–27 Jahre (Teamer <= 27 zaehlen mit) */
	youth: number;
	teamWithJuleica: number;
	teamWithoutJuleica: number;
	/**
	 * Teamer*innen 12–27 Jahre aus Bremen/Bremerhaven: zaehlen wie Teilnehmende und werden bei
	 * `youth` (Zuschuss und 1:7-Grenze) mitgezaehlt.
	 */
	teamYouth: number;
}

export interface SubsidyLine {
	key: 'children' | 'youth';
	label: string;
	count: number;
	nights: number;
	rateCents: number;
	totalCents: number;
}

export interface SubsidyResult {
	/** Beruecksichtigte Naechte (max. 14) */
	cappedNights: number;
	lines: SubsidyLine[];
	/** Zuschuss fuer die Gemeinde; fliesst in die Kalkulation */
	subsidyCents: number;
	/** Taschengeld fuer ehrenamtliche Leitende (getrennt, senkt den Beitrag nicht) */
	allowance: {
		/** Hoechstzahl zuschussfaehiger Ehrenamtlicher (1 je 5 Kinder / 7 Jugendliche) */
		limit: number;
		withJuleica: number;
		withoutJuleica: number;
		nights: number;
		totalCents: number;
	};
	warnings: string[];
}

export interface CalcLine {
	id: string;
	category: CalcCategory;
	label: string;
	basis: CalcBasis;
	/** Eingegebener Einzelbetrag */
	amountCents: number;
	/** Gesamtbetrag der Zeile (ohne Programm-Aufrundung) */
	totalCents: number;
}

/** Eingabe fuer `calculate` (src/lib/modules/actions/calculation.ts). */
export interface CalculateInput {
	participants: number;
	team: number;
	/** Anteil des Beitrags, den das Team zahlt (0–100) */
	teamPercent: number;
	nights: number;
	items: CalcItem[];
	bufferPercent: number;
	/** Zuschuss, der von den Kosten abgezogen wird (0 ohne Zuschuss) */
	subsidyCents: number;
}

export interface CalculationResult {
	lines: CalcLine[];
	/** Teilnehmende (= participants) und alle Personen (participants + team) */
	payingParticipants: number;
	totalPersons: number;
	/** Zahlungsgewicht: participants + team × teamPercent / 100 (Umlage-Divisor) */
	payingWeight: number;
	/** Programm: Summe der Programm-Posten, Pro-Kopf aufgerundet auf volle Euro, resultierender Betrag */
	programRawCents: number;
	programPerPersonCents: number;
	programTotalCents: number;
	subtotalCents: number;
	bufferCents: number;
	totalCents: number;
	subsidyCents: number;
	netCents: number;
	/** Exakter Preis pro zahlender Person (kann Nachkommastellen in Cent haben) */
	perPersonCents: number;
	/** Empfohlener Beitrag, aufgerundet auf volle Euro (0 ohne zahlende Teilnehmende) */
	recommendedPerPersonCents: number;
	/** Beitrag je Teammitglied: teamPercent % des exakten bzw. des empfohlenen Beitrags */
	teamPerPersonCents: number;
	/** Auf volle Euro aufgerundet; 0, wenn das Team nicht zahlt */
	recommendedTeamPerPersonCents: number;
	/** Anteil je Kategorie an der Zwischensumme (Summe der Anteile = 1, falls Summe > 0) */
	byCategory: { category: CalcCategory; totalCents: number; share: number }[];
}

/** In die Aktion uebernommener Beitrag (wird u. a. fuer Anmeldung und Abrechnung genutzt). */
export interface AppliedFee {
	participantCents: number;
	teamCents: number;
	appliedAt: string;
	appliedBy: UserRef | null;
}

export interface CalculationDto {
	settings: CalculationInput;
	/** Uebernommener Beitrag der Aktion oder `null` */
	applied: AppliedFee | null;
	/** `true`, wenn die aktuelle Kalkulation einen anderen Beitrag ergibt als den uebernommenen */
	outdated: boolean;
	/** Wurde die Kalkulation schon gespeichert (sonst Standardwerte)? */
	persisted: boolean;
	updatedAt: string | null;
	subsidy: SubsidyResult | null;
	result: CalculationResult;
}

export interface CalculationSuggestions {
	/** Anzahl Personen mit Rolle Teilnehmer*in / Team */
	participants: number;
	team: number;
	/** Aus Bremen/Bremerhaven, Alter zum Aktionsstart; Team <= 27 zaehlt mit */
	children: number;
	youth: number;
	teamWithJuleica: number;
	teamWithoutJuleica: number;
	/** Team (Rolle Team) 12–27 Jahre aus Bremen/Bremerhaven; `children`/`youth` zaehlen nur Teilnehmende */
	teamYouth: number;
	/** Vorgeschlagene Naechte aus den Aktionsdaten (null, wenn kein Enddatum) */
	nights: number | null;
	/** Datensaetze, die nicht vollstaendig in die Zaehlung eingehen koennen */
	incomplete: { id: string; name: string; missing: ('birthDate' | 'bremenResident')[] }[];
}

// === Phase 3: Anmeldeformular ===============================================

export const FORM_PUBLIC_PREFIX = '/p/actions/anmeldung';

export const DEFAULT_DISCLAIMER_TEMPLATE = `Hiermit melde ich mein Kind verbindlich zu „{{aktion}}“ an und bestätige, dass ich den Beitrag in Höhe von {{beitrag}} schnellstmöglich auf das folgende Konto überweise.

Inhaber*in: {{kontoinhaber}}
IBAN: {{iban}}
BIC: {{bic}}
Bank: {{bank}}

Verwendungszweck: „{{verwendungszweck}}“`;

/** Platzhalter, die im Disclaimer ersetzt werden (Anzeige im Builder). */
export const DISCLAIMER_PLACEHOLDERS = [
	{ key: 'aktion', label: 'Name der Aktion' },
	{ key: 'beitrag', label: 'Beitrag (aus der Kalkulation)' },
	{ key: 'kontoinhaber', label: 'Kontoinhaber*in' },
	{ key: 'iban', label: 'IBAN' },
	{ key: 'bic', label: 'BIC' },
	{ key: 'bank', label: 'Bank' },
	{ key: 'verwendungszweck', label: 'Verwendungszweck' }
] as const;

/** Schlüssel der Standardfelder (werden auf Spalten der Teilnehmenden abgebildet). */
export const STANDARD_FORM_KEYS = {
	name: 'name',
	group: 'group',
	birthDate: 'birthDate',
	bremenResident: 'bremenResident',
	diet: 'diet',
	allergies: 'allergies',
	notes: 'notes',
	email: 'email',
	privacy: 'privacy',
	disclaimer: 'disclaimer'
} as const;

const isoDateTime = z
	.string()
	.max(40)
	.refine((v) => !Number.isNaN(new Date(v).getTime()), 'Ungültiges Datum')
	.nullish()
	.transform((v) => (v ? new Date(v).toISOString() : null));

const httpUrl = z
	.string()
	.trim()
	.max(500)
	.refine((v) => {
		try {
			const u = new URL(v);
			return u.protocol === 'https:' || u.protocol === 'http:';
		} catch {
			return false;
		}
	}, 'Bitte eine gültige URL mit https:// angeben')
	.nullish()
	.transform((v) => (v ? v : null));

export const formConfigInput = z
	.object({
		enabled: z.boolean(),
		opensAt: isoDateTime,
		closesAt: isoDateTime,
		maxParticipants: z
			.number()
			.int()
			.min(1, 'Mindestens 1')
			.max(1000, 'Höchstens 1000')
			.nullish()
			.transform((v) => v ?? null),
		intro: optionalText(2000, true),
		disclaimerTemplate: z.string().max(5000, 'Höchstens 5000 Zeichen'),
		privacyUrl: httpUrl,
		/** Anmeldung nur mit Login und verknüpftem Mitglied */
		requireLogin: z.boolean().default(false),
		definition: formDefinitionSchema
	})
	.superRefine((c, ctx) => {
		if (c.opensAt && c.closesAt && c.closesAt < c.opensAt) {
			ctx.addIssue({
				code: 'custom',
				path: ['closesAt'],
				message: 'Das Ende liegt vor dem Beginn'
			});
		}
	});
export type FormConfigInput = z.infer<typeof formConfigInput>;

export type FormStatus = 'open' | 'closed' | 'not_open' | 'full';

/** Konfiguration des Anmeldeformulars einer Aktion (intern). */
export interface FormConfig {
	/** Schon gespeichert (sonst Standardwerte mit Standardfeldern)? */
	persisted: boolean;
	token: string | null;
	/** Pfad der öffentlichen Seite, z. B. `/p/actions/anmeldung/<token>` (null ohne Token) */
	publicPath: string | null;
	enabled: boolean;
	opensAt: string | null;
	closesAt: string | null;
	maxParticipants: number | null;
	intro: string | null;
	disclaimerTemplate: string;
	privacyUrl: string | null;
	/** Login + Mitglied Pflicht (aus: optional, auch für Gäste anderer Stämme) */
	requireLogin: boolean;
	definition: FormDefinition;
	/** Aktueller Status laut Konfiguration (Zeitraum/Plätze) */
	status: FormStatus;
	/** Anzahl Eingänge über den Link */
	submissions: number;
	/** Übernommener Beitrag, der im Disclaimer als {{beitrag}} erscheint */
	fee: AppliedFee | null;
	/** Gerenderter Disclaimer (Vorschau) */
	disclaimerPreview: string;
}

/** Öffentliche Sicht auf das Formular (ohne interne Angaben). */
export interface PublicForm {
	actionName: string;
	location: string | null;
	startsOn: string;
	endsOn: string | null;
	intro: string | null;
	status: FormStatus;
	opensAt: string | null;
	closesAt: string | null;
	definition: FormDefinition;
	/** Gerenderter Disclaimer-Text (Platzhalter ersetzt) */
	disclaimer: string;
	privacyUrl: string | null;
	/** Login + Mitglied Pflicht */
	requireLogin: boolean;
	/** Angemeldete Person (Session) oder `null` */
	viewer: { name: string } | null;
	/** Mit dem Konto verknüpfte Mitglieder (nur mit Session) inkl. Vorbelegung */
	members: PublicMemberOption[];
}

export interface PublicMemberOption {
	id: string;
	/** Anzeigename, z. B. „Max Muster“ */
	name: string;
	/** Schon zu dieser Aktion angemeldet? */
	registered: boolean;
	/** Vorbelegte Werte je Formularfeld (`key`) aus den Zusatzfeldern des Mitglieds */
	prefill: Record<string, string | number | boolean | string[] | null>;
}

export const publicSubmitInput = z
	.object({
		values: z.record(
			z.string().max(40),
			z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
		),
		/** Mit verknüpftem Mitglied anmelden (Konto Pflicht) */
		memberId: z.uuid().optional(),
		/** Honeypot: muss leer bleiben */
		website: z.string().max(200).optional()
	})
	.strict();
export type PublicSubmitInput = z.infer<typeof publicSubmitInput>;

export const publicTokenParams = z.object({ token: z.string().min(16).max(80) });

export interface PublicSubmitResult {
	/** Name, wie er gespeichert wurde */
	name: string;
	emailSent: boolean;
	/** Gerenderter Disclaimer-Text zur Anzeige auf der Danke-Seite */
	disclaimer: string;
	/** Änderungen wurden im Mitgliedsprofil gespeichert (nur bei Anmeldung mit Mitglied) */
	memberUpdated?: boolean;
}

// === Phase 4: Abrechnung ====================================================

export const ENTRY_TYPES = ['income', 'expense'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
	income: 'Einnahme',
	expense: 'Ausgabe'
};

export const INCOME_CATEGORIES = ['contributions', 'subsidy', 'misc'] as const;
/** Nur systemseitig gebucht (Rueckzahlungsfunktion); keine Kalkulationskategorie, keine manuelle Buchung */
/**
 * Optionaler Body von POST .../accounting/refund; mit `names` = manueller Modus (Anzahl = Anzahl
 * der Namen). Namen getrimmt, 1-80 Zeichen, keine Steuerzeichen, 1-300 Namen, Duplikate erlaubt.
 */
export const refundNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[^\p{Cc}]*$/u, 'Steuerzeichen sind nicht erlaubt');
export const refundBodySchema = z
	.object({ names: z.array(refundNameSchema).min(1).max(300).optional() })
	.strict()
	.optional();

/** Query von GET .../accounting/refund. */
export const refundQuerySchema = z.object({
	count: z.coerce.number().int().min(1).max(1000).optional()
});

export const REFUND_CATEGORY = 'refund' as const;
export const ACCOUNTING_CATEGORIES = [
	...CALC_CATEGORIES,
	...INCOME_CATEGORIES,
	REFUND_CATEGORY
] as const;
export type AccountingCategory = (typeof ACCOUNTING_CATEGORIES)[number];
export const ACCOUNTING_CATEGORY_LABELS: Record<AccountingCategory, string> = {
	...CALC_CATEGORY_LABELS,
	contributions: 'Teilnehmerbeiträge',
	subsidy: 'Zuschuss',
	misc: 'Sonstige Einnahmen',
	refund: 'Rückzahlung an Teilnehmende'
};
export const isIncomeCategory = (c: string): boolean =>
	(INCOME_CATEGORIES as readonly string[]).includes(c);

export const PAID_BY = ['club', 'person'] as const;
export type PaidBy = (typeof PAID_BY)[number];
export const PAID_BY_LABELS: Record<PaidBy, string> = { club: 'Stamm', person: 'Person' };
export type ClubPaidVia = 'manual' | 'treasury';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_CONTENT_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp'
] as const;

const bicSchema = z
	.string()
	.trim()
	.toUpperCase()
	.max(11)
	.nullish()
	.transform((v) => (v ? v : null))
	.refine(
		(v) => v === null || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v),
		'Ungültige BIC (8 oder 11 Zeichen)'
	);

/** Verwendungszweck einer SEPA-Ueberweisung (max. 140 Zeichen). */
export const MAX_PURPOSE_LENGTH = 140;

export const entryInput = z
	.object({
		type: z.enum(ENTRY_TYPES, 'Bitte Einnahme oder Ausgabe wählen'),
		category: z.enum(ACCOUNTING_CATEGORIES, 'Bitte eine Kategorie wählen'),
		description: text(200),
		amountCents: z
			.number('Bitte einen Betrag angeben')
			.int('Bitte einen Betrag angeben')
			.min(1, 'Der Betrag muss größer als 0 sein')
			.max(MAX_AMOUNT_CENTS, 'Betrag zu groß'),
		entryDate: date,
		paidBy: z.enum(PAID_BY).default('club'),
		payeeId: id.nullish().transform((v) => v ?? null),
		/**
		 * Nur Ausgaben „bezahlt vom Stamm“: `true` = bereits bezahlt, `false` = offen, die Kasse ueberweist
		 * an den Empfaenger. Fehlt das Feld, gilt die Ausgabe als bezahlt (Verhalten vor der Kasse).
		 */
		clubPaid: z.boolean().default(true),
		/**
		 * Nur Auslagen (Ausgabe, bezahlt von Person): `true` = bereits erstattet (`reimbursed_at` wird beim
		 * Anlegen gesetzt). Beim Aendern wird das Feld ignoriert; die Erstattung aendert nur der Endpoint
		 * `DELETE …/payees/:id/reimburse`.
		 */
		reimbursed: z.boolean().default(false),
		recipientName: optionalText(100),
		/** Fehlt beim Bearbeiten = gespeicherte IBAN bleibt */
		iban: z
			.string()
			.trim()
			.max(50, 'IBAN zu lang')
			.nullish()
			.transform((v) => (v ? normalizeIban(v) : null))
			.refine((v) => v === null || isValidIban(v), 'Ungültige IBAN'),
		bic: bicSchema,
		purpose: optionalText(MAX_PURPOSE_LENGTH)
	})
	.superRefine((e, ctx) => {
		const income = isIncomeCategory(e.category);
		if (e.category === REFUND_CATEGORY) {
			ctx.addIssue({
				code: 'custom',
				path: ['category'],
				message: 'Rückzahlungen werden über die Rückzahlungsfunktion gebucht'
			});
		}
		if (e.type === 'income' && !income) {
			ctx.addIssue({
				code: 'custom',
				path: ['category'],
				message: 'Für Einnahmen: Teilnehmerbeiträge, Zuschuss oder Sonstige Einnahmen'
			});
		}
		if (e.type === 'expense' && income) {
			ctx.addIssue({
				code: 'custom',
				path: ['category'],
				message: 'Diese Kategorie gilt nur für Einnahmen'
			});
		}
		if (e.type === 'income' && (e.paidBy !== 'club' || e.payeeId)) {
			ctx.addIssue({
				code: 'custom',
				path: ['paidBy'],
				message: 'Einnahmen gehen an den Stamm'
			});
		}
		if (e.paidBy === 'person' && !e.payeeId) {
			ctx.addIssue({ code: 'custom', path: ['payeeId'], message: 'Bitte eine Person wählen' });
		}
		if (e.paidBy === 'club' && e.payeeId) {
			ctx.addIssue({
				code: 'custom',
				path: ['payeeId'],
				message: 'Nur bei „Person“ angeben'
			});
		}
		if (e.reimbursed && !(e.type === 'expense' && e.paidBy === 'person')) {
			ctx.addIssue({
				code: 'custom',
				path: ['reimbursed'],
				message: 'Nur Auslagen koennen bereits erstattet sein'
			});
		}
		if (e.type === 'expense' && e.paidBy === 'club' && !e.clubPaid) {
			if (!e.recipientName) {
				ctx.addIssue({
					code: 'custom',
					path: ['recipientName'],
					message: 'Bitte den Empfänger angeben'
				});
			}
			if (!e.purpose) {
				ctx.addIssue({
					code: 'custom',
					path: ['purpose'],
					message: 'Bitte einen Verwendungszweck angeben'
				});
			}
		}
	});
/** Offene Stamm-Ausgabe braucht Empfaengerdaten fuer die Ueberweisung. */
export const needsTransfer = (e: { type: string; paidBy: string; clubPaid: boolean }): boolean =>
	e.type === 'expense' && e.paidBy === 'club' && !e.clubPaid;
export type EntryInput = z.infer<typeof entryInput>;
export type EntryFormInput = z.input<typeof entryInput>;

export const payeeInput = z.object({
	name: text(100),
	iban: z
		.string('IBAN fehlt')
		.trim()
		.min(1, 'IBAN fehlt')
		.max(50, 'IBAN zu lang')
		.refine(isValidIban, 'Ungültige IBAN')
		.transform(normalizeIban),
	bic: bicSchema,
	note: optionalText(300)
});
export type PayeeInput = z.infer<typeof payeeInput>;
export type PayeeFormInput = z.input<typeof payeeInput>;
/** Beim Bearbeiten darf die IBAN fehlen (= unverändert lassen). */
export const payeeUpdateInput = payeeInput.extend({ iban: payeeInput.shape.iban.optional() });

export const closeInput = z.object({ acceptMissingReceipts: z.boolean().default(false) });
export const entryParams = z.object({ id, entryId: id });
export const payeeParams = z.object({ id, payeeId: id });

export interface AccountingEntry {
	id: string;
	type: EntryType;
	category: AccountingCategory;
	description: string;
	amountCents: number;
	/** JJJJ-MM-TT */
	entryDate: string;
	paidBy: PaidBy;
	payee: { id: string; name: string } | null;
	receipt: { name: string; contentType: string } | null;
	/** Auslage wurde ausgezahlt (nur bei paidBy = person) */
	reimbursedAt: string | null;
	/** Nur Ausgaben des Stammes: Empfaenger der Ueberweisung (IBAN maskiert) */
	recipient: { name: string; ibanMasked: string | null; bic: string | null } | null;
	purpose: string | null;
	/** Stamm-Ausgabe bezahlt (`null` = offen); `via` = manuell markiert oder von der Kasse ueberwiesen */
	clubPaidAt: string | null;
	clubPaidVia: ClubPaidVia | null;
	createdAt: string;
	updatedAt: string;
}

/** Person mit Auslagen. Bankdaten nur maskiert und nur mit `actions.payout.view`. */
export interface AccountingPayee {
	id: string;
	name: string;
	ibanMasked: string | null;
	bic: string | null;
	note: string | null;
	/** Summe offener (nicht ausgezahlter) Auslagen */
	openCents: number;
	reimbursedCents: number;
	openEntries: number;
}

/** Soll-Werte aus der Kalkulation (null, wenn keine Kalkulation gespeichert ist). */
export interface AccountingPlan {
	contributionsCents: number | null;
	subsidyCents: number | null;
	expenseByCategory: Partial<Record<CalcCategory, number>>;
	totalExpenseCents: number | null;
}

export interface AccountingCategorySummary {
	category: AccountingCategory;
	type: EntryType;
	plannedCents: number | null;
	actualCents: number;
}

export interface AccountingSummary {
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
	plannedIncomeCents: number | null;
	plannedExpenseCents: number | null;
	byCategory: AccountingCategorySummary[];
	/** Ausgaben ohne Beleg */
	missingReceipts: number;
	/** Summe offener Auslagen aller Personen */
	openReimbursementCents: number;
	/** Noch nicht ueberwiesene Ausgaben des Stammes */
	openClubPayments: { count: number; cents: number };
}

/** Automatische Einnahmen aus Teilnehmerliste und Kalkulation. */
export interface AutoIncome {
	contributions: {
		cents: number;
		payingCount: number;
		teamCount: number;
		feeCents: number;
		teamFeeCents: number;
		/** `treasury`: tatsaechlich eingegangene Zahlungen aus der Kasse (Ist statt Soll) */
		source?: 'calculated' | 'treasury';
		/** nur bei `treasury`: Soll, offen, Anzahl Rechnungen */
		dueCents?: number;
		openCents?: number;
		invoiceCount?: number;
	} | null;
	subsidy: { cents: number; eligibleCount: number } | null;
	/** Kategorien, fuer die manuelle Buchungen die Automatik ersetzen */
	overridden: ('contributions' | 'subsidy')[];
}

export interface AccountingState {
	closed: { at: string; by: UserRef | null } | null;
	entries: AccountingEntry[];
	summary: AccountingSummary;
	plan: AccountingPlan | null;
	autoIncome: AutoIncome;
	/** `null` ohne `actions.payout.view` */
	payees: AccountingPayee[] | null;
	canViewPayouts: boolean;
	/** Kasse aktiv: Auslagen werden dort ausgezahlt und hier automatisch markiert */
	payoutsViaTreasury?: boolean;
}

/** Eintrag fuer die reinen Funktionen in accounting.ts. */
export interface SummaryEntry {
	type: EntryType;
	category: AccountingCategory;
	amountCents: number;
	paidBy: PaidBy;
	payeeId: string | null;
	hasReceipt: boolean;
	reimbursed: boolean;
	/** Stamm-Ausgabe noch nicht bezahlt (fehlt = bezahlt) */
	clubOpen?: boolean;
}

export interface PayoutRow {
	payeeId: string;
	name: string;
	iban: string;
	bic: string | null;
	amountCents: number;
	purpose: string;
	entryCount: number;
}

export interface ReportInput {
	actionName: string;
	location: string | null;
	startsOn: string;
	endsOn: string | null;
	closedAt: string | null;
	entries: AccountingEntry[];
	summary: AccountingSummary;
	/** Automatische Einnahmen (bereits in `summary` enthalten, sofern nicht ueberschrieben) */
	autoIncome?: AutoIncome | null;
	/**
	 * Personen mit Auslagen. `iban` ist vom Endpoint bereits entschieden: Klartext (mit
	 * `actions.payout.view`) oder maskiert, sonst `null`.
	 */
	payees: {
		name: string;
		openCents: number;
		reimbursedCents: number;
		iban: string | null;
		bic: string | null;
	}[];
	/** Gebuchte Rueckzahlung an Teilnehmende (Snapshot) oder `null` */
	refund?: {
		items: { name: string; amountCents: number }[];
		totalCents: number;
		remainderCents: number;
		bookedAt: string;
	} | null;
	/** Anzahl Belege, die nicht angehaengt werden konnten (Abruf, Typ, Groesse) */
	missingAttachments?: number;
	/** Buchungen, deren Beleg angehaengt wurde; fehlt der Wert, gelten alle als angehaengt */
	attachedEntryIds?: string[];
}
