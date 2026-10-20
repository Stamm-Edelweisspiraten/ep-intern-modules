/**
 * Spalten-Katalog und Zeilen der Mitglieder-Listen (rein, ohne Server-Importe).
 * Basisspalten + je Zusatzfeld eine Spalte `field.<schlüssel>`; Voreinstellungen aus `LIST_PRESET_KEYS`.
 */
import {
	LIST_PRESET_KEYS,
	type ListCatalog,
	type ListColumn,
	type ListPreset,
	type ListRow
} from '$lib/pdf-lists/types';
import type { MemberFieldDefinition, MemberSheetData } from './contract';
import { ageOn, formatDateDe, formatFieldValue } from './member-list';

const COUNTRY_DEFAULT = 'DE';

/** Zusatzfelder mit Gesundheits-/Notfallbezug (andere eigene Felder gelten vorsichtshalber ebenfalls als sensibel) */
const NOT_SENSITIVE_FIELDS = new Set(['juleica']);
const WIDE_FIELDS = new Set(['allergien', 'medikamente', 'gesundheit']);

export const fieldColumnKey = (key: string) => `field.${key}`;

const BASE_COLUMNS: ListColumn[] = [
	{ key: 'name', label: 'Name', group: 'person', weight: 3 },
	{ key: 'scoutName', label: 'Pfadiname', group: 'person', weight: 1.8 },
	{ key: 'stage', label: 'Stand', group: 'person', weight: 1.5 },
	{ key: 'groups', label: 'Gruppe', group: 'person', weight: 2.2 },
	{ key: 'age', label: 'Alter', group: 'person', weight: 0.8, align: 'center' },
	{ key: 'birthDate', label: 'Geburtsdatum', group: 'person', weight: 1.4 },
	{ key: 'entryDate', label: 'Mitglied seit', group: 'person', weight: 1.4 },
	{ key: 'address', label: 'Anschrift', group: 'contact', weight: 3 },
	{ key: 'phone', label: 'Telefon', group: 'contact', weight: 2.4 },
	{ key: 'emergencyPhone', label: 'Telefon (Notfall/erstes)', group: 'contact', weight: 2.4 },
	{ key: 'email', label: 'E-Mail', group: 'contact', weight: 3 },
	{ key: 'consents', label: 'Einwilligungen', group: 'person', weight: 2 }
];

/** Katalog für Mitglieder: Basisspalten + eine Spalte je Zusatzfeld (Reihenfolge der Felddefinitionen) */
export function buildMemberCatalog(defs: MemberFieldDefinition[]): ListCatalog {
	const fieldColumns: ListColumn[] = defs.map((d) => ({
		key: fieldColumnKey(d.key),
		label: d.field.label,
		group: d.key === 'juleica' ? 'person' : 'health',
		weight: WIDE_FIELDS.has(d.key) ? 3 : d.field.type === 'textarea' ? 3 : 1.8,
		sensitive: !NOT_SENSITIVE_FIELDS.has(d.key)
	}));
	const columns = [...BASE_COLUMNS, ...fieldColumns];
	return { columns, presets: buildPresets(columns) };
}

const PRESET_META: Record<keyof typeof LIST_PRESET_KEYS, { label: string; description: string }> = {
	fahrt: {
		label: 'Fahrt',
		description: 'Name, Gruppe, Alter, Notfall-Telefon, Ernährung, Allergien, Medikamente'
	},
	kontakt: { label: 'Kontaktliste', description: 'Name, Gruppe, Telefon, E-Mail' },
	gesundheit: {
		label: 'Gesundheit',
		description: 'Fahrt plus Gesundheit, Notfallkontakt, Schwimmen, Zecken/Tetanus, Krankenkasse'
	},
	minimal: { label: 'Minimal', description: 'Name, Gruppe, Alter' }
};

/** Voreinstellungen auf die vorhandenen Spalten beschränkt (deaktivierte Zusatzfelder entfallen) */
export function buildPresets(
	columns: ListColumn[],
	extra: Record<string, string[]> = {}
): ListPreset[] {
	const known = new Set(columns.map((c) => c.key));
	return (Object.keys(LIST_PRESET_KEYS) as (keyof typeof LIST_PRESET_KEYS)[]).map((id) => ({
		id,
		...PRESET_META[id],
		keys: [...LIST_PRESET_KEYS[id], ...(extra[id] ?? [])].filter((k) => known.has(k))
	}));
}

/** Notfall-Telefon: Nummer, deren Bezeichnung „Notfall“ enthält, sonst die erste; „Bezeichnung: Nummer“ */
export function emergencyPhone(phones: { name: string | null; value: string }[]): string {
	const p = phones.find((x) => /notfall/i.test(x.name ?? '')) ?? phones[0];
	if (!p) return '';
	return p.name ? `${p.name}: ${p.value}` : p.value;
}

const yesNo = (v: boolean) => (v ? 'ja' : 'nein');
const contact = (items: { name: string | null; value: string }[]) =>
	items.map((p) => (p.name ? `${p.name}: ${p.value}` : p.value)).join('\n');

/** Eine Zeile je Mitglied (alle Spalten des Katalogs; Auswahl und Leerspalten entscheidet `$lib/pdf-lists`) */
export function rowFromMember(
	m: MemberSheetData,
	defs: MemberFieldDefinition[],
	today: string
): ListRow {
	const age = ageOn(m.birthDate, today);
	const address = [
		m.street,
		`${m.postalCode} ${m.city}`.trim(),
		m.country && m.country !== COUNTRY_DEFAULT ? m.country : ''
	].filter((l) => l && l.trim());
	const row: ListRow = {
		name: `${m.firstName} ${m.lastName}${m.scoutName ? `\n„${m.scoutName}“` : ''}`,
		scoutName: m.scoutName ?? '',
		stage: m.stage,
		groups: m.groups.map((g) => g.name).join(', '),
		age: age !== null ? String(age) : '',
		birthDate: formatDateDe(m.birthDate),
		entryDate: formatDateDe(m.entryDate),
		address: address.join('\n'),
		phone: contact(m.phones),
		emergencyPhone: emergencyPhone(m.phones),
		email: contact(m.emails),
		consents: `Social Media ${yesNo(m.consentSocialMedia)} · Website ${yesNo(m.consentWebsite)} · Druck ${yesNo(m.consentPrint)}`
	};
	for (const d of defs) {
		row[fieldColumnKey(d.key)] = formatFieldValue(d.field, m.custom[d.key] ?? null);
	}
	return row;
}
