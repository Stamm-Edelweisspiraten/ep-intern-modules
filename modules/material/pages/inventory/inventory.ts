/**
 * Hilfen für den Reiter „Bestand“ (Lagerort-Baum, Auswahloptionen) – ohne Server-Imports.
 */
import type { SelectFieldOption } from '$lib/components/ui/select-field';
import type { Location } from '../../schemas';

export interface LocationRow {
	loc: Location;
	depth: number;
	/** Stücke an diesem Ort und allen Unterorten (ohne Kisteninhalt) */
	total: number;
	hasChildren: boolean;
}

function byPosition(a: Location, b: Location): number {
	return a.position - b.position || a.name.localeCompare(b.name, 'de');
}

/** Lagerorte als flache Liste in Baum-Reihenfolge mit Tiefe */
export function locationRows(list: readonly Location[]): LocationRow[] {
	const ids = new Set(list.map((l) => l.id));
	const children = new Map<string | null, Location[]>();
	for (const l of list) {
		// Verwaiste Einträge (Elternteil fehlt) oben einsortieren
		const parent = l.parentId && ids.has(l.parentId) ? l.parentId : null;
		const arr = children.get(parent) ?? [];
		arr.push(l);
		children.set(parent, arr);
	}
	for (const arr of children.values()) arr.sort(byPosition);

	const totals = new Map<string, number>();
	const total = (id: string, seen: Set<string>): number => {
		const cached = totals.get(id);
		if (cached !== undefined) return cached;
		if (seen.has(id)) return 0;
		seen.add(id);
		const own = list.find((l) => l.id === id)?.unitCount ?? 0;
		const sum = (children.get(id) ?? []).reduce((s, c) => s + total(c.id, seen), own);
		totals.set(id, sum);
		return sum;
	};

	const out: LocationRow[] = [];
	const walk = (parent: string | null, depth: number, seen: Set<string>) => {
		for (const loc of children.get(parent) ?? []) {
			if (seen.has(loc.id)) continue;
			seen.add(loc.id);
			out.push({
				loc,
				depth,
				total: total(loc.id, new Set()),
				hasChildren: (children.get(loc.id) ?? []).length > 0
			});
			walk(loc.id, depth + 1, seen);
		}
	};
	walk(null, 0, new Set());
	return out;
}

/** IDs eines Ortes und aller Unterorte */
export function subtreeIds(list: readonly Location[], id: string): Set<string> {
	const out = new Set<string>([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const l of list) {
			if (l.parentId && out.has(l.parentId) && !out.has(l.id)) {
				out.add(l.id);
				grew = true;
			}
		}
	}
	return out;
}

/** Auswahloptionen (Label = Pfad), sortiert wie der Baum; `exclude` = diese IDs weglassen */
export function locationOptions(
	list: readonly Location[],
	exclude: ReadonlySet<string> = new Set()
): SelectFieldOption[] {
	return locationRows(list)
		.filter((r) => !exclude.has(r.loc.id))
		.map((r) => ({ value: r.loc.id, label: r.loc.path }));
}

/** Datum für Eingabefelder (`JJJJ-MM-TT`) oder leer */
export function dateInput(v: string | null | undefined): string {
	return v ? v.slice(0, 10) : '';
}
