/**
 * Reine Hilfen fuer das Anmeldeformular (ohne Server-/Svelte-Imports, in Tests nutzbar):
 * Standarddefinition, Disclaimer-Rendering, Status, Antwort-Mapping, Duplikatschluessel, CSV.
 */
import type { FieldDefinition, FormDefinition, FormValues } from '$lib/forms/types';
import { DIETS, DIET_LABELS, STANDARD_FORM_KEYS, ageAt, type FormStatus } from './schemas';

const K = STANDARD_FORM_KEYS;

export const NO_FEE_TEXT = 'den noch festzulegenden Beitrag';

// --- Standarddefinition -----------------------------------------------------

/** Standardfelder, die an Zusatzfelder des Mitglieds gebunden sind (Vorbelegung + Rückschreiben) */
export const MEMBER_KEY_BY_STANDARD: Record<string, string> = {
	[K.diet]: 'ernaehrung',
	[K.allergies]: 'allergien'
};

/** Stammdatenfelder, die bei einer Anmeldung mit Mitglied aus dem Mitglied kommen (nicht abgefragt) */
export const IDENTITY_KEYS: string[] = [K.name, K.group, K.birthDate, K.bremenResident, K.email];

function yesNoOptions() {
	return [
		{ value: 'yes', label: 'Ja' },
		{ value: 'no', label: 'Nein' }
	];
}
function dietOptions() {
	return DIETS.map((d) => ({ value: d, label: DIET_LABELS[d] }));
}

export function buildDefaultFormDefinition(opts: { groupOptions?: string[] } = {}): FormDefinition {
	const groupOptions = [...new Set((opts.groupOptions ?? []).map((g) => g.trim()).filter(Boolean))];
	const fields: FieldDefinition[] = [
		{ id: K.name, key: K.name, type: 'text', label: 'Name', required: true, locked: true },
		{
			id: K.group,
			key: K.group,
			type: 'select',
			label: 'Gruppe',
			required: true,
			locked: true,
			allowOther: true,
			options: (groupOptions.length ? groupOptions : ['Sonstige']).map((g) => ({
				value: g,
				label: g
			}))
		},
		{
			id: K.birthDate,
			key: K.birthDate,
			type: 'date',
			label: 'Geburtsdatum',
			required: true,
			locked: true
		},
		{
			id: K.bremenResident,
			key: K.bremenResident,
			type: 'select',
			label: 'Wohnort Bremen/Bremerhaven',
			required: true,
			locked: true,
			options: yesNoOptions()
		},
		{
			id: K.diet,
			key: K.diet,
			type: 'select',
			label: 'Ernährung',
			required: true,
			locked: true,
			memberKey: MEMBER_KEY_BY_STANDARD[K.diet],
			options: dietOptions()
		},
		{
			id: K.allergies,
			key: K.allergies,
			type: 'textarea',
			label: 'Unverträglichkeiten und Allergien',
			required: false,
			locked: true,
			memberKey: MEMBER_KEY_BY_STANDARD[K.allergies]
		},
		{
			id: K.notes,
			key: K.notes,
			type: 'textarea',
			label: 'Sonstiges (Medikamente, Mitteilungen)',
			required: false,
			locked: true
		},
		{
			id: K.email,
			key: K.email,
			type: 'email',
			label: 'E-Mail-Adresse (für die Bestätigung)',
			required: true,
			locked: true
		},
		{
			id: K.privacy,
			key: K.privacy,
			type: 'consent',
			label: 'Datenschutz',
			text: 'Ich habe den Datenschutzhinweis gelesen und bin einverstanden.',
			required: true,
			locked: true
		},
		{
			id: K.disclaimer,
			key: K.disclaimer,
			type: 'consent',
			label: 'Verbindliche Anmeldung',
			text: 'Ich bestätige die verbindliche Anmeldung.',
			required: true,
			locked: true
		}
	];
	return { version: 1, fields };
}

/**
 * Stellt die Pflicht-Standardfelder sicher: fehlende werden ergaenzt, `locked` bleibt gesetzt,
 * der Typ gesperrter Felder aendert sich nicht (sonst Standardfeld), feste Optionen werden erzwungen.
 */
export function mergeStandardFields(
	def: FormDefinition,
	defaults?: FormDefinition
): FormDefinition {
	const base = defaults ?? buildDefaultFormDefinition();
	const byKey = new Map(base.fields.map((f) => [f.key, f]));
	const seen = new Set<string>();
	const fields: FieldDefinition[] = [];
	for (const f of def.fields) {
		if (seen.has(f.key)) continue;
		seen.add(f.key);
		const std = byKey.get(f.key);
		if (!std) {
			fields.push(f);
		} else if (f.type !== std.type) {
			fields.push(std);
		} else {
			const merged = { ...f, locked: true } as FieldDefinition;
			if (MEMBER_KEY_BY_STANDARD[f.key]) {
				merged.memberKey = MEMBER_KEY_BY_STANDARD[f.key];
			}
			if (f.key === K.diet || f.key === K.bremenResident) {
				(merged as { options: unknown }).options = (std as { options: unknown }).options;
			}
			if (f.key === K.name || f.key === K.email || f.key === K.birthDate) {
				merged.required = true;
				merged.hidden = false;
			}
			fields.push(merged);
		}
	}
	for (const std of base.fields) {
		if (!seen.has(std.key)) fields.push(std);
	}
	return { ...def, version: 1, fields };
}

/** Oeffentliche Sicht: ohne `hidden`-Felder, Datenschutz-Link und gerenderter Disclaimer gesetzt. */
export function toPublicDefinition(
	def: FormDefinition,
	runtime: { privacyUrl: string | null; disclaimer: string }
): FormDefinition {
	const fields: FieldDefinition[] = [];
	for (const f of def.fields) {
		if (f.hidden) continue;
		if (f.type === 'consent' && f.key === K.privacy) {
			const { href: _href, ...rest } = f;
			fields.push(runtime.privacyUrl ? { ...rest, href: runtime.privacyUrl } : rest);
		} else if (f.type === 'consent' && f.key === K.disclaimer) {
			fields.push({ ...f, text: runtime.disclaimer });
		} else {
			fields.push(f);
		}
	}
	return { ...def, fields };
}

// --- Anmeldung mit Mitglied ---------------------------------------------------

/** Wohnort Bremen/Bremerhaven (Land DE, Ort ohne Beachtung der Gross-/Kleinschreibung) */
export function isBremenCity(city: string, country: string): boolean | null {
	if (!city.trim()) return null;
	if (country && country !== 'DE') return false;
	return /^(freie hansestadt )?(bremen|bremerhaven)$/i.test(city.trim());
}

/** Definition ohne die Stammdatenfelder, die aus dem Mitglied kommen (für Validierung/Anzeige). */
export function withoutIdentityFields(def: FormDefinition): FormDefinition {
	return { ...def, fields: def.fields.filter((f) => !IDENTITY_KEYS.includes(f.key)) };
}

export interface MemberForRegistration {
	firstName: string;
	lastName: string;
	birthDate: string;
	groups: { name: string }[];
	email: string | null;
	city: string;
	country: string;
	custom: Record<string, unknown>;
}

/** Werte der Stammdatenfelder, die der SERVER aus dem Mitglied setzt (Client-Angaben werden ignoriert). */
export function identityValues(m: MemberForRegistration, accountEmail: string | null): FormValues {
	const bremen = isBremenCity(m.city, m.country);
	const groups = m.groups.map((g) => g.name).join(', ');
	return {
		[K.name]: `${m.firstName} ${m.lastName}`.replace(/\s+/g, ' ').trim(),
		[K.group]: groups ? groups.slice(0, 150) : null,
		[K.birthDate]: m.birthDate,
		[K.bremenResident]: bremen === null ? null : bremen ? 'yes' : 'no',
		[K.email]: m.email ?? accountEmail
	};
}

/** Vorbelegung: Wert je Formularfeld aus den Zusatzfeldern des Mitglieds (`memberKey`). */
export function prefillValues(def: FormDefinition, custom: Record<string, unknown>): FormValues {
	const out: FormValues = {};
	for (const f of def.fields) {
		if (!f.memberKey || f.hidden || f.type === 'info') continue;
		const v = custom[f.memberKey];
		out[f.key] =
			typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)
				? (v as FormValues[string])
				: null;
	}
	return out;
}

/** Zu speichernde Zusatzfeld-Werte: je gebundenem, sichtbarem Feld der eingegebene Wert unter dem `memberKey`. */
export function memberUpdates(def: FormDefinition, values: FormValues): FormValues {
	const out: FormValues = {};
	for (const f of def.fields) {
		if (!f.memberKey || f.hidden || f.type === 'info' || !(f.key in values)) continue;
		out[f.memberKey] = values[f.key] ?? null;
	}
	return out;
}

// --- Disclaimer -------------------------------------------------------------

export interface DisclaimerVars {
	aktion: string;
	/** Beitrag je Teilnehmer*in in Cent oder `null` */
	feeCents: number | null;
	kontoinhaber?: string;
	iban?: string;
	bic?: string;
	bank?: string;
	/** Template des Verwendungszwecks (darf {{aktion}} enthalten) */
	purposeTemplate?: string;
}

export function formatEuro(cents: number): string {
	const abs = Math.abs(Math.round(cents));
	const whole = Math.floor(abs / 100)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
	return `${cents < 0 ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')} €`;
}

function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => values[k] ?? '');
}

/** Ersetzt Platzhalter in einem Durchgang; unbekannte bleiben leer. Nur Text. */
export function renderDisclaimer(template: string, vars: DisclaimerVars): string {
	const purpose = fill(vars.purposeTemplate ?? '', { aktion: vars.aktion }).trim();
	return fill(template, {
		aktion: vars.aktion,
		beitrag: vars.feeCents == null ? NO_FEE_TEXT : formatEuro(vars.feeCents),
		kontoinhaber: vars.kontoinhaber ?? '',
		iban: vars.iban ?? '',
		bic: vars.bic ?? '',
		bank: vars.bank ?? '',
		verwendungszweck: purpose
	});
}

// --- Status -----------------------------------------------------------------

export function computeFormStatus(
	cfg: {
		enabled: boolean;
		opensAt: string | null;
		closesAt: string | null;
		maxParticipants: number | null;
	},
	participantCount: number,
	now: Date = new Date()
): FormStatus {
	if (!cfg.enabled) return 'closed';
	if (cfg.opensAt && now < new Date(cfg.opensAt)) return 'not_open';
	if (cfg.closesAt && now >= new Date(cfg.closesAt)) return 'closed';
	if (cfg.maxParticipants != null && participantCount >= cfg.maxParticipants) return 'full';
	return 'open';
}

export const STATUS_CONFLICT_MESSAGES: Record<Exclude<FormStatus, 'open'>, string> = {
	closed: 'Die Anmeldung ist geschlossen.',
	not_open: 'Die Anmeldung ist noch nicht geöffnet.',
	full: 'Alle Plätze sind vergeben.'
};

// --- Antworten --------------------------------------------------------------

export interface MappedAnswers {
	name: string;
	groupLabel: string | null;
	birthDate: string | null;
	bremenResident: boolean | null;
	diet: string | null;
	allergies: string | null;
	notes: string | null;
	email: string | null;
	/** Alle uebrigen Antworten (nur Felder der Definition) */
	answers: Record<string, unknown>;
}

const text = (v: unknown, max: number): string | null => {
	if (typeof v !== 'string') return null;
	const t = v.trim().slice(0, max);
	return t ? t : null;
};

/** Standardfelder auf Spalten abbilden; der Rest landet in `answers`. */
export function mapStandardAnswers(def: FormDefinition, values: FormValues): MappedAnswers {
	const standard = new Set<string>(Object.values(K));
	const answers: Record<string, unknown> = {};
	for (const f of def.fields) {
		if (f.type === 'info' || f.hidden || standard.has(f.key)) continue;
		if (f.key in values) answers[f.key] = values[f.key];
	}
	const br = values[K.bremenResident];
	const diet = values[K.diet];
	return {
		name: (text(values[K.name], 150) ?? '').replace(/\s+/g, ' '),
		groupLabel: text(values[K.group], 150),
		birthDate: text(values[K.birthDate], 10),
		bremenResident: br === 'yes' ? true : br === 'no' ? false : null,
		diet: typeof diet === 'string' && (DIETS as readonly string[]).includes(diet) ? diet : null,
		allergies: text(values[K.allergies], 1000),
		notes: text(values[K.notes], 2000),
		email: text(values[K.email], 254)?.toLowerCase() ?? null,
		answers
	};
}

/** Geburtsdatum plausibel (nicht in der Zukunft, hoechstens 120 Jahre)? */
export function isPlausibleBirthDate(birthIso: string, todayIso: string): boolean {
	if (birthIso > todayIso) return false;
	const age = ageAt(birthIso, todayIso);
	return age !== null && age <= 120;
}

export function normalizeDedupeKey(name: string, birthDate: string): string {
	return `${name.trim().toLowerCase().replace(/\s+/g, ' ')}|${birthDate.trim()}`;
}

// --- Bestaetigungs-Mail -----------------------------------------------------

export function buildConfirmationMail(p: {
	actionName: string;
	name: string;
	groupLabel: string | null;
	birthDate: string | null;
	disclaimer: string;
}): { subject: string; text: string } {
	const birth = p.birthDate ? p.birthDate.split('-').reverse().join('.') : '';
	const lines = [
		`Hallo ${p.name},`,
		'',
		`vielen Dank für die Anmeldung zu „${p.actionName}“. Wir haben folgende Angaben erhalten:`,
		'',
		`Name: ${p.name}`,
		...(p.groupLabel ? [`Gruppe: ${p.groupLabel}`] : []),
		...(birth ? [`Geburtsdatum: ${birth}`] : []),
		'',
		p.disclaimer,
		'',
		'Herzliche Grüße',
		'Dein Team'
	];
	return {
		subject: `Anmeldebestätigung: ${p.actionName}`.replace(/[\r\n]+/g, ' ').slice(0, 200),
		text: lines.join('\n')
	};
}

// --- CSV --------------------------------------------------------------------

export interface CsvColumn {
	key: string;
	label: string;
}

const BOM = String.fromCharCode(0xfeff);

function csvCell(v: unknown): string {
	if (v == null) return '';
	let s = typeof v === 'string' ? v : String(v);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV mit UTF-8-BOM, `;` als Trenner, CRLF und Formel-Injection-Schutz. */
export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
	const lines = [columns.map((c) => csvCell(c.label)).join(';')];
	for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(';'));
	return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Dateiname aus dem Aktionsnamen (ASCII, ohne Sonderzeichen). */
export function safeFilename(name: string, suffix: string): string {
	const base = name
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/Ä/g, 'Ae')
		.replace(/Ö/g, 'Oe')
		.replace(/Ü/g, 'Ue')
		.replace(/ß/g, 'ss')
		.replace(/[^A-Za-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${base || 'aktion'}${suffix}`;
}
