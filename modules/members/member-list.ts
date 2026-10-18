/**
 * Hilfen für die Mitglieder-/Teilnehmenden-Listen als PDF (rein, ohne Server-Importe):
 * Datum/Alter/Feldwert formatieren und die Quer-Vorlage wählen. Katalog und Zeilen: `sheet-columns.ts`,
 * Layout (Tabelle, Seitenumbruch): `$lib/pdf-lists`.
 */
import type { FieldDefinition, FormValue } from '$lib/forms';
import {
	buildSectionedListBlocks,
	normalizeSelection,
	selectedColumns,
	selectionHasSensitive,
	visibleColumns,
	type ListCatalog,
	type ListColumn,
	type ListSection,
	type ListSelection
} from '$lib/pdf-lists';
import type { PdfBlock } from '$lib/sdk/types';

/** Briefkopf quer (A4 quer, 247 mm Textbreite); fehlt die Vorlage, dient `compact` in Querformat */
export const LIST_TEMPLATE = 'stamm-briefkopf-quer';
export const LIST_TEMPLATE_FALLBACK = 'compact';

/** Vorlage und Ausrichtung für `core.pdf.generate` (feste Stamm-Vorlagen bestimmen die Ausrichtung selbst) */
export function listTemplateInput(availableIds: string[]): {
	template: string;
	orientation: 'landscape';
} {
	return {
		template: availableIds.includes(LIST_TEMPLATE) ? LIST_TEMPLATE : LIST_TEMPLATE_FALLBACK,
		orientation: 'landscape'
	};
}

/** `2026-03-07` → `07.03.2026` (alles andere unverändert) */
export function formatDateDe(iso: string | null | undefined): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
	return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** Alter in Jahren am Stichtag; `null` bei ungültigem Datum */
export function ageOn(birthDate: string | null | undefined, today: string): number | null {
	const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate ?? '');
	const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
	if (!b || !t) return null;
	let age = Number(t[1]) - Number(b[1]);
	if (t[2]! + t[3]! < b[2]! + b[3]!) age -= 1;
	return age >= 0 ? age : null;
}

/** Wert eines Zusatzfelds lesbar machen (Auswahl → Beschriftung, Ja/Nein, Listen mit Komma); leer → '' */
export function formatFieldValue(field: FieldDefinition | undefined, value: FormValue): string {
	if (value === null || value === undefined || value === '') return '';
	if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
	const label = (v: string) => {
		const options = field && 'options' in field ? field.options : [];
		return options.find((o) => o.value === v)?.label ?? v;
	};
	if (Array.isArray(value)) return value.map(label).join(', ');
	if (field?.type === 'date' && typeof value === 'string') return formatDateDe(value);
	return typeof value === 'string' ? label(value) : String(value);
}

/** `2026-10-17` (UTC) – Stichtag für Alter und „Stand“ */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Wählt die Spalten (Auswahl des Nutzers gegen den Katalog, ohne Auswahl „Fahrt“), blendet leere Spalten aus
 * und baut die Blöcke (je Abschnitt eine Tabelle, ab dem zweiten eine neue Seite).
 */
export function composeListBlocks(p: {
	catalog: ListCatalog;
	selection?: Partial<ListSelection>;
	sections: ListSection[];
	generatedOn: string;
}): { blocks: PdfBlock[]; selection: ListSelection; columns: ListColumn[] } {
	const selection = normalizeSelection(p.selection, p.catalog.columns, p.catalog.presets);
	const chosen = selectedColumns(selection, p.catalog.columns);
	const columns = visibleColumns(
		chosen,
		p.sections.flatMap((s) => s.rows),
		selection.hideEmpty
	);
	const blocks = buildSectionedListBlocks(p.sections, {
		columns,
		generatedOn: p.generatedOn,
		confidential: selectionHasSensitive({ columns: columns.map((c) => c.key) }, p.catalog.columns)
	});
	return { blocks, selection, columns };
}
